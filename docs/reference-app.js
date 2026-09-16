/* =============================================================================
 * app.js - controls, state, charts.
 *
 * Division of labour:
 *   worker  runs every hourly simulation (the grid sweep, the detail run, the
 *           weather sweep, the bill replay)
 *   here    re-prices cached simulation results and draws.  Cost and finance
 *           controls therefore never touch a simulation and update in ~15 ms;
 *           system and household controls queue a worker round-trip (~0.2 s) and
 *           the old render is held at reduced opacity until it returns.
 * ========================================================================== */
(function () {
  "use strict";

  var DATA = JSON.parse(document.getElementById("app-data").textContent);
  var E = SolarEngine, F = SolarFinance, O = SolarOptimizer;
  var $ = function (id) { return document.getElementById(id); };
  /** Escape strings that come out of the data files before they meet innerHTML. */
  function esc(v) {
    return String(v === undefined || v === null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ------------------------------------------------------------------ format
  var fmtMoney = function (v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var s = Math.abs(v) >= 1000 && !dp
      ? Math.round(v).toLocaleString("en-US")
      : Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
    return (v < 0 ? "−$" : "$") + s;
  };
  var fmtCompact = function (v) {
    if (!isFinite(v)) return "—";
    var a = Math.abs(v), sign = v < 0 ? "−" : "";
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(a >= 1e7 ? 0 : 2) + "M";
    if (a >= 1e4) return sign + "$" + Math.round(a / 1e3) + "k";
    return sign + "$" + Math.round(a).toLocaleString("en-US");
  };
  var fmtNum = function (v, dp) {
    return (v === null || v === undefined || !isFinite(v)) ? "—"
      : v.toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  };
  var fmtPct = function (v, dp) { return (v === null || v === undefined || !isFinite(v)) ? "—" : (v * 100).toFixed(dp === undefined ? 1 : dp) + "%"; };
  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many); };
  var fmtYears = function (v) { return (v === null || v === undefined || !isFinite(v)) ? "never" : v.toFixed(1) + " yr"; };

  // ------------------------------------------------------------------ theme
  function tok(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  var T = {};
  function readTokens() {
    ["--ink", "--ink-2", "--ink-3", "--grid", "--rule", "--surface", "--page", "--neutral-mid",
     "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8", "--good-text", "--critical"]
      .forEach(function (k) { T[k.replace("--", "")] = tok(k); });
  }
  readTokens();
  function hexToRgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function alpha(hex, a) { var c = hexToRgb(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return "rgb(" + Math.round(x[0] + (y[0] - x[0]) * t) + "," + Math.round(x[1] + (y[1] - x[1]) * t) + "," + Math.round(x[2] + (y[2] - x[2]) * t) + ")";
  }

  // ------------------------------------------------------------------ state
  var WEATHER_OPTS = (function () {
    var m = DATA.solar.meta, pc = m.percentiles || {}, out = [{ v: "tmy", t: "TMY (typical year)" }];
    if (pc.p90_year) out.push({ v: "p90", t: "P90 – conservative, low sun (" + pc.p90_year + ")" });
    if (pc.p50_year) out.push({ v: "p50", t: "P50 – median year (" + pc.p50_year + ")" });
    if (pc.p10_year) out.push({ v: "p10", t: "P10 – optimistic, high sun (" + pc.p10_year + ")" });
    Object.keys(DATA.solar.profiles).filter(function (k) { return k !== "tmy"; }).sort()
      .forEach(function (k) { out.push({ v: k, t: "Weather year " + k }); });
    return out;
  })();

  var PLAN_OPTS = DATA.tariffs.plans.map(function (p) { return { v: p.id, t: p.name || p.id }; });
  var PROVIDER_OPTS = Object.keys(DATA.tariffs.providers).map(function (k) {
    return { v: k, t: DATA.tariffs.providers[k].name || k };
  });

  var DETECTED_EV = (DATA.load.meta && DATA.load.meta.ev_kwh_per_year) || 3582;
  var DETECTED_CHARGER = (DATA.load.meta && DATA.load.meta.ev_charger_kw) || 8;
  var ESC_DEFAULT = ((DATA.tariffs.meta || {}).escalation || {}).recommended_default;

  var NGOM_COST = 600;   // SCE caps the metering charge at $600 one-time
  var CLIMATE = (DATA.tariffs.meta || {}).climate_credit || { amount: 36, months: [8, 9] };
  var SIM_DEFAULTS = Object.assign({}, E.DEFAULTS, {
    evChargerKW: Math.round(DETECTED_CHARGER * 10) / 10,
    secondEVKwhPerYear: Math.round(DETECTED_EV),
    // The engine treats null as "use the tariff file's value"; the slider needs a real
    // number or it renders 0 and misreports a credit the model is actually applying.
    climateCredit: CLIMATE.amount,
    maxPanels: 60, maxBatteries: 6,
  });
  var FIN_DEFAULTS = Object.assign({}, F.DEFAULTS, {
    escalation: ESC_DEFAULT === undefined ? F.DEFAULTS.escalation : ESC_DEFAULT,
  });
  var UI_DEFAULTS = { objective: "npv", basis: "sameEV", season: 0, ovPanels: -1, ovBatteries: -1 };

  var state = { sim: Object.assign({}, SIM_DEFAULTS), fin: Object.assign({}, FIN_DEFAULTS), ui: Object.assign({}, UI_DEFAULTS) };

  /** Finance inputs plus the costs that are decided on the system side of the page. */
  function finEff() {
    return Object.assign({}, state.fin, { adder: state.fin.adder + (state.sim.ngom ? NGOM_COST : 0) });
  }

  // ------------------------------------------------------------------ controls
  // kind: range | select | check | seg | number
  var CONTROLS = [
    { group: "System", open: true, items: [
      { k: "panelW", t: "sim", kind: "range", label: "Panel wattage", min: 350, max: 560, step: 5, unit: " W" },
      { k: "battKWh", t: "sim", kind: "range", label: "Battery size, usable", min: 5, max: 20, step: 0.5, unit: " kWh each" },
      { k: "battKW", t: "sim", kind: "range", label: "Battery power", min: 2.5, max: 11.5, step: 0.5, unit: " kW each" },
      { k: "minReserve", t: "sim", kind: "range", label: "Reserved for backup", min: 0, max: 0.5, step: 0.05, pct: 1 },
      { k: "rte", t: "sim", kind: "range", label: "Round-trip efficiency", min: 0.8, max: 0.98, step: 0.01, pct: 1 },
      { k: "tilt", t: "sim", kind: "range", label: "Roof tilt", min: 5, max: 45, step: 1, unit: "°" },
      { k: "azimuth", t: "sim", kind: "range", label: "Roof azimuth", min: 90, max: 270, step: 1, unit: "°",
        note: "180° = due south. Measured roof: 169°." },
      { k: "weather", t: "sim", kind: "select", label: "Weather scenario", opts: WEATHER_OPTS },
      { k: "maxPanels", t: "sim", kind: "range", label: "Most panels to consider", min: 10, max: 80, step: 1 },
      { k: "maxBatteries", t: "sim", kind: "range", label: "Most batteries to consider", min: 0, max: 8, step: 1 },
    ] },
    { group: "Prices & incentives", open: true, items: [
      { k: "costPerW", t: "fin", kind: "range", label: "Solar, installed", min: 0.5, max: 6, step: 0.05, money: 2, unit: " /W" },
      { k: "costPerKwh", t: "fin", kind: "range", label: "Storage, installed", min: 200, max: 2000, step: 25, money: 0, unit: " /kWh" },
      { k: "adder", t: "fin", kind: "range", label: "Fixed install adder", min: 0, max: 20000, step: 250, money: 0,
        note: "Panel upgrade, trenching, re-roof — anything quoted as a lump sum." },
      { k: "incentiveMode", t: "fin", kind: "select", label: "Incentive treatment",
        opts: [{ v: "none", t: "None" }, { v: "discount", t: "Direct discount off price" }, { v: "vendor", t: "Vendor credit pass-through" }] },
      { k: "discountPct", t: "fin", kind: "range", label: "Discount", min: 0, max: 0.4, step: 0.01, pct: 0, show: function (s) { return s.fin.incentiveMode === "discount"; } },
      { k: "passThroughPct", t: "fin", kind: "range", label: "Vendor discount off total price", min: 0, max: 0.45, step: 0.01, pct: 0, show: function (s) { return s.fin.incentiveMode === "vendor"; },
        note: "The lease-to-own vendor claims a ~40% commercial credit (48E plus adders) and passes this share of the total system price to you." },
      { k: "taxCreditPct", t: "fin", kind: "range", label: "Credit you claim yourself", min: 0, max: 0.3, step: 0.01, pct: 0,
        note: "Section 25D is terminated for a 2026 homeowner-owned install. Leave at 0 unless you know otherwise." },
      { k: "sgipPerKwh", t: "fin", kind: "range", label: "SGIP storage rebate", min: 0, max: 1100, step: 25, money: 0, unit: " /kWh",
        note: "SGIP stopped taking applications 2025-12-30. Modelled at $0." },
      { k: "rebates", t: "fin", kind: "range", label: "Other rebates", min: 0, max: 10000, step: 100, money: 0,
        note: "e.g. CPA Sun Storage: $2,000 base, up to $3,500 with adders." },
    ] },
    { group: "Finance", open: true, items: [
      { k: "horizon", t: "fin", kind: "range", label: "Analysis horizon", min: 10, max: 40, step: 1, unit: " yr" },
      { k: "escalation", t: "fin", kind: "range", label: "Utility rate escalation", min: 0, max: 0.10, step: 0.005, pct: 1, unit: " /yr",
        note: "5% recommended; 3% low and 8% high are the defensible bands. History says 6.3%/yr since 2015, but the last three years were flat." },
      { k: "exportEscalation", t: "fin", kind: "range", label: "Export credit escalation", min: 0, max: 0.05, step: 0.0025, pct: 2, unit: " /yr",
        note: "Export prices are locked at the 2026 ACC vintage for nine years and are not tied to retail rates; the tariff notes show the locked trajectory averages 11-18% below 2026 in the hours that actually pay. Leave at 0 unless you think the post-lock-in vintage will be richer." },
      { k: "investReturn", t: "fin", kind: "range", label: "Return if invested instead", min: 0, max: 0.15, step: 0.005, pct: 1, unit: " /yr" },
      { k: "discountRate", t: "fin", kind: "range", label: "Inflation / discount rate", min: 0, max: 0.08, step: 0.005, pct: 1, unit: " /yr" },
      { k: "panelDeg", t: "fin", kind: "range", label: "Panel degradation", min: 0, max: 0.015, step: 0.001, pct: 2, unit: " /yr" },
      { k: "battDeg", t: "fin", kind: "range", label: "Battery degradation", min: 0, max: 0.05, step: 0.002, pct: 1, unit: " /yr" },
      { k: "battReplYear", t: "fin", kind: "range", label: "Replace the battery in year", min: 10, max: 30, step: 1 },
      { k: "battReplFraction", t: "fin", kind: "range", label: "Replacement costs", min: 0, max: 1, step: 0.05, pct: 0, unit: " of today’s price" },
      { k: "omPerYear", t: "fin", kind: "range", label: "O&M + insurance", min: 0, max: 1000, step: 25, money: 0, unit: " /yr" },
      { k: "inverterYear", t: "fin", kind: "range", label: "Replace the inverter in year", min: 5, max: 30, step: 1 },
      { k: "inverterPerW", t: "fin", kind: "range", label: "Inverter replacement", min: 0, max: 0.5, step: 0.01, money: 2, unit: " /W" },
      { k: "resaleValue", t: "fin", kind: "range", label: "Value left in the house", min: 0, max: 40000, step: 500, money: 0 },
    ] },
    { group: "Household & dispatch", open: true, items: [
      { k: "planId", t: "sim", kind: "select", label: "Rate plan", opts: PLAN_OPTS },
      { k: "providerId", t: "sim", kind: "select", label: "Generation provider", opts: PROVIDER_OPTS },
      { k: "strategy", t: "sim", kind: "select", label: "Battery strategy", opts: [
        { v: "self_consumption", t: "Self-consumption" }, { v: "tou_arbitrage", t: "Time-of-use arbitrage" },
        { v: "export_arbitrage", t: "Export arbitrage" }, { v: "backup_only", t: "Backup only (never cycles)" }] },
      { k: "gridCharge", t: "sim", kind: "check", label: "Allow charging from the grid when the sun will not fill the pack",
        warn: function (s) { return s.sim.gridCharge ? "Not permitted under SCE's Net Billing paired-storage agreement; shown for comparison only. Battery export is disabled while this is on, because grid energy cannot earn an export credit." : null; },
        show: function (s) { return s.sim.strategy === "tou_arbitrage" || s.sim.strategy === "export_arbitrage"; } },
      { k: "exportThreshold", t: "sim", kind: "range", label: "Sell to the grid above", min: 0, max: 2, step: 0.05, money: 2, unit: " /kWh",
        show: function (s) { return s.sim.strategy === "export_arbitrage"; } },
      { k: "evMode", t: "sim", kind: "select", label: "EV charging", opts: [
        { v: "spread", t: "Spread over N days a week, charged in daylight" },
        { v: "baseline", t: "As recorded (overnight, ~2.4 sessions/week)" }] },
      { k: "evDaysPerWeek", t: "sim", kind: "range", label: "Days per week the car charges", min: 1, max: 7, step: 1,
        show: function (s) { return s.sim.evMode === "spread"; },
        note: "5 = weekdays, 7 = every day. Each week's recorded kWh is divided evenly across these days, so fewer days means a bigger daily charge." },
      { k: "dayShiftFraction", t: "sim", kind: "range", label: "How much of each day's charge happens in daylight", min: 0, max: 1, step: 0.05, pct: 0,
        show: function (s) { return s.sim.evMode === "spread"; } },
      { k: "evWindowStart", t: "sim", kind: "range", label: "Daytime window starts", min: 5, max: 14, step: 1, hour: 1, show: function (s) { return s.sim.evMode === "spread"; } },
      { k: "evWindowEnd", t: "sim", kind: "range", label: "Daytime window ends", min: 10, max: 21, step: 1, hour: 1, show: function (s) { return s.sim.evMode === "spread"; } },
      { k: "evChargerKW", t: "sim", kind: "range", label: "Charger power", min: 3, max: 11.5, step: 0.1, unit: " kW" },
      { k: "ev1Scale", t: "sim", kind: "range", label: "Car 1, vs. today’s driving", min: 0.25, max: 2, step: 0.05, pct: 0 },
      { k: "secondEV", t: "sim", kind: "check", label: "Add a second EV" },
      { k: "secondEVKwhPerYear", t: "sim", kind: "range", label: "Car 2 charging", min: 0, max: 8000, step: 100, unit: " kWh/yr", show: function (s) { return s.sim.secondEV; } },
      { k: "secondEVOffset", t: "sim", kind: "range", label: "Car 2 plugs in later by", min: 0, max: 6, step: 1, unit: " h",
        show: function (s) { return s.sim.secondEV && s.sim.evMode !== "spread"; } },
      { k: "poolPump", t: "sim", kind: "check", label: "Add a pool pump" },
      { k: "poolKW", t: "sim", kind: "range", label: "Pump power", min: 0.1, max: 3, step: 0.1, unit: " kW", show: function (s) { return s.sim.poolPump; } },
      { k: "poolHours", t: "sim", kind: "range", label: "Pump runs", min: 1, max: 16, step: 1, unit: " h/day", show: function (s) { return s.sim.poolPump; } },
      { k: "poolStartHour", t: "sim", kind: "range", label: "Pump starts at", min: 0, max: 18, step: 1, hour: 1, show: function (s) { return s.sim.poolPump; } },
      { k: "climateCredit", t: "sim", kind: "range", label: "CA Climate Credit", min: 0, max: 120, step: 1, money: 0, unit: " per credited month",
        note: "Flat credit on the August and September bills, in both the with-system and no-system cases." },
      { k: "accPlusAdder", t: "sim", kind: "range", label: "ACC Plus export adder", min: 0, max: 0.05, step: 0.001, money: 3, unit: " /kWh",
        note: "$0.016/kWh for a 2026 PTO date, locked 9 years, then zero. Unlike ordinary export credits it may offset the fixed charge." },
      { k: "ngom", t: "sim", kind: "check",
        label: "Net Generation Output Meter (+$600 once, removes the export cap)",
        note: "Without an NGOM, paired storage under 10 kW has its monthly export credit capped at SCE's estimate of PV production and the excess is forfeited from the most expensive hours first. Worth it if the battery is meant to sell into the evening." },
    ] },
    { group: "What counts as a win", open: true, items: [
      { k: "objective", t: "ui", kind: "select", label: "Optimise for", opts: [
        { v: "npv", t: "Most NPV vs. investing" }, { v: "lifetime", t: "Lowest lifetime cost" },
        { v: "irr", t: "Highest IRR" }, { v: "payback", t: "Fastest payback" }] },
      { k: "basis", t: "ui", kind: "select", label: "Compare the bill against", opts: [
        { v: "sameEV", t: "No system, same charging schedule" },
        { v: "trueEV", t: "Today’s actual bill" }],
        note: "The first isolates what the hardware does. The second also credits moving EV charging to midday, which is free." },
      { k: "ovPanels", t: "ui", kind: "number", label: "Override: panels", min: -1, max: 120, step: 1 },
      { k: "ovBatteries", t: "ui", kind: "number", label: "Override: batteries", min: -1, max: 12, step: 1,
        note: "−1 on either means “let the optimiser choose”. Clicking a heat-map cell fills these in." },
    ] },
  ];

  function fmtCtl(c, v) {
    if (c.pct !== undefined) return (v * 100).toFixed(c.pct) + "%" + (c.unit || "");
    if (c.money !== undefined) return "$" + Number(v).toFixed(c.money) + (c.unit || "");
    if (c.hour) return String(v).padStart(2, "0") + ":00";
    return fmtNum(v, (c.step && c.step < 1) ? 1 : 0) + (c.unit || "");
  }

  function buildControls() {
    var root = $("controls");
    root.innerHTML = "";
    CONTROLS.forEach(function (g) {
      var d = document.createElement("details");
      d.className = "group";
      // On a phone the control rail sits above the results, so it starts collapsed -
      // otherwise forty sliders stand between the reader and the answer.
      d.open = (g.open !== false) && window.innerWidth > 1080;
      var sum = document.createElement("summary"); sum.textContent = g.group; d.appendChild(sum);
      var body = document.createElement("div"); body.className = "group-body";
      g.items.forEach(function (c) { body.appendChild(makeCtl(c)); });
      d.appendChild(body); root.appendChild(d);
    });
    refreshControls();
  }

  function makeCtl(c) {
    var wrap = document.createElement("div");
    wrap.className = "ctl"; wrap.dataset.key = c.t + "." + c.k;
    var id = "ctl-" + c.t + "-" + c.k;
    var val = state[c.t][c.k];

    if (c.kind === "check") {
      var lab = document.createElement("label");
      lab.className = "switch"; lab.htmlFor = id;
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.id = id; cb.checked = !!val;
      cb.addEventListener("change", function () { set(c, cb.checked); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(c.label));
      wrap.appendChild(lab);
    } else if (c.kind === "seg") {
      var head = ctlHead(c, id, ""); wrap.appendChild(head.el);
      var seg = document.createElement("div"); seg.className = "seg"; seg.id = id;
      c.opts.forEach(function (o) {
        var b = document.createElement("button");
        b.type = "button"; b.textContent = o.t;
        b.setAttribute("aria-pressed", String(o.v === val));
        b.addEventListener("click", function () { set(c, o.v); });
        seg.appendChild(b);
      });
      wrap.appendChild(seg);
    } else if (c.kind === "select") {
      var h2 = ctlHead(c, id, ""); wrap.appendChild(h2.el);
      var sel = document.createElement("select"); sel.id = id;
      c.opts.forEach(function (o) {
        var op = document.createElement("option"); op.value = String(o.v); op.textContent = o.t; sel.appendChild(op);
      });
      sel.value = String(val);
      sel.addEventListener("change", function () { set(c, sel.value); });
      wrap.appendChild(sel);
    } else if (c.kind === "number") {
      var h3 = ctlHead(c, id, ""); wrap.appendChild(h3.el);
      var n = document.createElement("input");
      n.type = "number"; n.id = id; n.min = c.min; n.max = c.max; n.step = c.step; n.value = val;
      n.addEventListener("change", function () { set(c, +n.value); });
      wrap.appendChild(n);
    } else {
      var h = ctlHead(c, id, fmtCtl(c, val)); wrap.appendChild(h.el);
      var r = document.createElement("input");
      r.type = "range"; r.id = id; r.min = c.min; r.max = c.max; r.step = c.step; r.value = val;
      r.addEventListener("input", function () {
        h.val.textContent = fmtCtl(c, +r.value);
        set(c, +r.value);
      });
      wrap.appendChild(r);
    }
    if (c.note) {
      var nt = document.createElement("div"); nt.className = "ctl-note"; nt.textContent = c.note; wrap.appendChild(nt);
    }
    if (c.warn) {
      var wn = document.createElement("div");
      wn.className = "ctl-warn"; wn.id = "warn-" + c.t + "-" + c.k; wn.hidden = true;
      wrap.appendChild(wn);
    }
    if (c.k === "costPerW" || c.k === "costPerKwh") {
      var eff = document.createElement("div"); eff.className = "ctl-note"; eff.id = "eff-" + c.k; wrap.appendChild(eff);
    }
    return wrap;
  }

  function ctlHead(c, id, valText) {
    var el = document.createElement("div"); el.className = "ctl-head";
    var l = document.createElement("label"); l.htmlFor = id; l.textContent = c.label;
    var v = document.createElement("span"); v.className = "ctl-val"; v.textContent = valText;
    el.appendChild(l); el.appendChild(v);
    return { el: el, val: v };
  }

  var simTimer = null;
  function set(c, v) {
    if (c.t === "sim" && c.k === "evSpread") v = String(v);
    if (typeof state[c.t][c.k] === "boolean" && typeof v !== "boolean") v = (v === "true" || v === true);
    if (typeof state[c.t][c.k] === "number" && typeof v === "string") v = +v;
    state[c.t][c.k] = v;
    // An export-arbitrage battery only pays if its exports are actually credited, so
    // selecting that strategy turns the meter on by default.
    if (c.k === "strategy" && v === "export_arbitrage") state.sim.ngom = true;
    if (c.k === "ovPanels" || c.k === "ovBatteries") { refreshControls(); repriceAndRender(); writeHash(); return; }
    refreshControls();
    writeHash();
    if (c.t === "fin" || c.t === "ui") repriceAndRender();
    else { markStale(); clearTimeout(simTimer); simTimer = setTimeout(runGrid, 150); }
  }

  /** Re-sync every widget's displayed value and visibility after any change. */
  function refreshControls() {
    CONTROLS.forEach(function (g) {
      g.items.forEach(function (c) {
        var wrap = document.querySelector('[data-key="' + c.t + "." + c.k + '"]');
        if (!wrap) return;
        wrap.hidden = !!(c.show && !c.show(state));
        if (c.warn) {
          var wEl = $("warn-" + c.t + "-" + c.k), msg = c.warn(state);
          if (wEl) { wEl.textContent = msg || ""; wEl.hidden = !msg; }
        }
        var el = $("ctl-" + c.t + "-" + c.k), v = state[c.t][c.k];
        if (!el) return;
        if (c.kind === "check") el.checked = !!v;
        else if (c.kind === "seg") Array.prototype.forEach.call(el.children, function (b, i) {
          b.setAttribute("aria-pressed", String(c.opts[i].v === v));
        });
        else if (c.kind === "select") el.value = String(v);
        else { el.value = v; var lab = wrap.querySelector(".ctl-val"); if (lab && c.kind === "range") lab.textContent = fmtCtl(c, v); }
      });
    });
  }

  // ------------------------------------------------------------------ hash
  var HASH_MAP = [];
  CONTROLS.forEach(function (g) { g.items.forEach(function (c) { HASH_MAP.push(c); }); });
  function writeHash() {
    var parts = [];
    HASH_MAP.forEach(function (c) {
      var v = state[c.t][c.k], d = (c.t === "sim" ? SIM_DEFAULTS : c.t === "fin" ? FIN_DEFAULTS : UI_DEFAULTS)[c.k];
      if (v !== d) parts.push(c.k + "=" + encodeURIComponent(String(v)));
    });
    history.replaceState(null, "", parts.length ? "#" + parts.join("&") : location.pathname + location.search);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return;
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("="); if (i < 0) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      var c = HASH_MAP.find(function (x) { return x.k === k; });
      if (!c) return;
      var cur = state[c.t][c.k];
      state[c.t][c.k] = typeof cur === "boolean" ? (v === "true") : (typeof cur === "number" ? +v : v);
    });
  }

  // ------------------------------------------------------------------ worker
  var worker = null, reqId = 0, pendingGrid = 0, pendingDetail = 0;
  var grid = null, priced = null, detail = null, validation = null;

  /**
   * The simulation normally runs in a Blob-URL Web Worker so slider drags never block.
   * Some hosts (sandboxed embeds with a strict CSP) refuse Blob workers; there the same
   * script is evaluated on the main thread behind a postMessage-shaped shim, so the page
   * still works - it just pauses ~200 ms per sweep instead of animating a progress bar.
   */
  function makeInlineWorker(src) {
    var shim = { onmessage: null, postMessage: null }, fake = { onmessage: null, onerror: null };
    shim.postMessage = function (msg) { if (fake.onmessage) fake.onmessage({ data: msg }); };
    new Function("self", src)(shim);
    fake.postMessage = function (msg) {
      setTimeout(function () {
        try { shim.onmessage({ data: msg }); }
        catch (err) { if (fake.onerror) fake.onerror(err); }
      }, 0);
    };
    return fake;
  }

  function bootWorker() {
    var src = document.getElementById("worker-src").textContent;
    var forceInline = /[?&#]noworker\b/.test(location.href);
    try {
      if (forceInline) throw new Error("inline worker forced via ?noworker");
      var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (e) {
      console.warn("Blob worker unavailable, simulating on the main thread:", e && e.message);
      worker = makeInlineWorker(src);
    }
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === "ready") { status("Ready", 1); runGrid(); }
      else if (m.type === "progress" && m.id === pendingGrid) status("Simulating " + m.done + " of " + m.total + " systems", m.done / m.total);
      else if (m.type === "grid" && m.id === pendingGrid) { grid = m.grid; status("", 1); repriceAndRender(); runValidation(); }
      else if (m.type === "detail" && m.id === pendingDetail) { detail = m.detail; renderDetail(); }
      else if (m.type === "validate") { validation = m.result; renderValidation(); }
      else if (m.type === "error") { status("Simulation error — see console", 1); console.error(m.message); }
    };
    worker.onerror = function (err) { status("Worker failed — see console", 1); console.error(err); };
    worker.postMessage({ type: "init", data: DATA });
  }

  function status(text, frac) {
    $("status-text").textContent = text || "";
    $("status-bar").firstElementChild.style.width = Math.round((frac || 0) * 100) + "%";
    $("status-bar").style.visibility = (frac >= 1 || !text) ? "hidden" : "visible";
  }
  function markStale() {
    document.querySelectorAll(".card, .headline").forEach(function (el) { el.classList.add("stale"); });
  }
  function clearStale() {
    document.querySelectorAll(".stale").forEach(function (el) { el.classList.remove("stale"); });
  }

  function simParams() {
    var p = {};
    Object.keys(E.DEFAULTS).forEach(function (k) { if (state.sim[k] !== undefined) p[k] = state.sim[k]; });
    return p;
  }
  function runGrid() {
    if (!worker) return;
    pendingGrid = ++reqId;
    status("Simulating…", 0.02);
    worker.postMessage({ type: "grid", id: pendingGrid, params: simParams(),
                         maxPanels: state.sim.maxPanels, maxBatteries: state.sim.maxBatteries, step: 1 });
  }
  function runDetail(panels, batteries) {
    pendingDetail = ++reqId;
    var keys = [{ key: "tmy", label: "TMY", group: "ref" }];
    var pc = DATA.solar.meta.percentiles || {};
    if (pc.p90_year) keys.push({ key: "p90", label: "P90 low", group: "ref" });
    if (pc.p50_year) keys.push({ key: "p50", label: "P50 med", group: "ref" });
    if (pc.p10_year) keys.push({ key: "p10", label: "P10 high", group: "ref" });
    Object.keys(DATA.solar.profiles).filter(function (k) { return k !== "tmy"; }).sort()
      .forEach(function (k) { keys.push({ key: k, label: k, group: "year" }); });
    worker.postMessage({ type: "detail", id: pendingDetail, params: simParams(),
                         panels: panels, batteries: batteries, weatherKeys: keys });
  }
  function runValidation() {
    var bv = (DATA.tariffs.meta || {}).bill_validation || {};
    worker.postMessage({ type: "validate", id: ++reqId,
                         params: { planId: bv.plan || "TOU-D-PRIME", providerId: bv.provider || "cpa_green" },
                         start: bv.period_start || "2026-07-23", end: bv.period_end || "2026-08-20" });
  }

  // ------------------------------------------------------------------ pricing
  var OBJ_LABEL = { npv: "max NPV", lifetime: "lowest lifetime cost", irr: "max IRR", payback: "fastest payback" };

  /** Every objective expressed as "higher is better, 0 = no better than doing nothing". */
  function goodness(c) {
    if (state.ui.objective === "npv") return c.npv;
    if (state.ui.objective === "irr") return c.irr === null ? -1 : (c.irr - state.fin.investReturn);
    if (state.ui.objective === "payback") return (c.payback === null ? -state.fin.horizon : state.fin.horizon - c.payback);
    return c.finance.lifetimeCostNoSystem - c.lifetimeCost;
  }

  function selectedCell() {
    if (!priced) return null;
    var p = state.ui.ovPanels, b = state.ui.ovBatteries;
    if (p >= 0 && b >= 0) {
      var hit = O.findCell(priced, p, b);
      if (hit) return hit;
    }
    return priced.best;
  }

  var lastDetailKey = "";
  function repriceAndRender() {
    if (!grid) return;
    priced = O.priceGrid(grid, finEff(), state.ui.objective, state.ui.basis);
    var cell = selectedCell();
    clearStale();
    renderHeadline(cell);
    renderHeat(cell);
    renderCash(cell);
    renderTornado(cell);
    renderEffectivePrices();
    renderQuality();
    renderMethod();
    var key = JSON.stringify(simParams()) + "|" + cell.panels + "|" + cell.batteries;
    if (key !== lastDetailKey) { lastDetailKey = key; runDetail(cell.panels, cell.batteries); }
    else renderDetail();
  }

  // ------------------------------------------------------------------ headline
  function renderHeadline(c) {
    var f = c.finance;
    $("hero-npv").textContent = fmtCompact(c.npv);
    $("hero-npv").style.color = c.npv >= 0 ? T["good-text"] : T.critical;
    var pill = $("hero-pill");
    pill.className = "verdict-pill " + (c.npv > 0 ? "pill-good" : c.npv < 0 ? "pill-bad" : "pill-mid");
    $("hero-pill-text").textContent = c.npv > 0 ? "Beats investing the cash" : c.npv < 0 ? "Investing the cash wins" : "A wash";
    $("hero-note").textContent = "Present value of " + state.fin.horizon + " years of bill savings, minus what the system costs, "
      + "discounted at the " + fmtPct(state.fin.investReturn, 1) + " you could earn on the same money. "
      + (c.npv > 0 ? "Positive means the roof wins." : "Negative means the market wins.")
      + (c.exportRevenue > 0
         ? " Of the " + fmtMoney(c.savings) + " saved in year 1, " + fmtMoney(c.importSavings)
           + " is power you no longer buy and rises with your rates; " + fmtMoney(c.exportRevenue)
           + " is export credit, locked at today\u2019s ACC prices."
         : "");

    var tiles = [
      { k: "System", v: c.kwdc.toFixed(2) + " kW", d: plural(c.panels, "panel", "panels") + " @ " + state.sim.panelW + " W" },
      { k: "Storage", v: c.battKWhTotal.toFixed(0) + " kWh", d: c.batteries + " × " + state.sim.battKWh + " kWh usable" },
      { k: "Cash up front", v: fmtCompact(f.netCost), d: f.effectiveDiscount > 0 ? fmtPct(f.effectiveDiscount, 1) + " off " + fmtCompact(f.gross) : "no incentive applied" },
      { k: "Savings, year 1", v: fmtMoney(c.firstYearSavings),
        d: c.exportRevenue > 0 ? fmtMoney(c.exportRevenue) + " of it export credit"
                               : "bill " + fmtMoney(priced.baseline.bill) + " → " + fmtMoney(c.bill) },
      { k: "IRR", v: c.irr === null ? "—" : fmtPct(c.irr, 1), d: "vs " + fmtPct(state.fin.investReturn, 1) + " invested" },
      { k: "Payback", v: fmtYears(c.payback), d: "discounted " + fmtYears(c.discountedPayback) },
      { k: "Wealth at " + state.fin.horizon + " yr", v: fmtCompact(f.wealthSystem), d: "investing: " + fmtCompact(f.wealthInvest) },
      { k: "Self-sufficiency", v: fmtPct(c.selfSufficiency, 0), d: fmtNum(c.importKwh, 0) + " kWh still bought" },
    ];
    $("tiles").innerHTML = tiles.map(function (t) {
      return '<div class="tile"><span class="k">' + t.k + '</span><span class="v num">' + t.v + '</span><span class="d">' + t.d + "</span></div>";
    }).join("");

    var manual = state.ui.ovPanels >= 0 && state.ui.ovBatteries >= 0;
    $("config-line").innerHTML = (manual ? "<strong>Manual selection.</strong> " : "<strong>Optimiser's pick</strong> (" + OBJ_LABEL[state.ui.objective] + "). ")
      + "Produces " + fmtNum(c.pvKwh, 0) + " kWh/yr, keeps " + fmtPct(c.solarFraction, 0) + " of it on site, exports "
      + fmtNum(c.exportKwh, 0) + " kWh, cycles the pack " + fmtNum(c.cycles, 0) + "×/yr. LCOE " + fmtMoney(c.lcoe, 3) + "/kWh."
      + (grid && grid.evShiftOnlySavings > 5 ? " Re-timing EV charging alone, with no hardware, is worth " + fmtMoney(grid.evShiftOnlySavings) + "/yr." : "")
      + (detail && detail.forfeitedCredit > 1 ? " Note: " + fmtMoney(detail.forfeitedCredit) + "/yr of export credit never gets used and is written off at true-up \u2014 the tariff will not pay for production beyond what this house can absorb." : "");
    $("heat-obj").textContent = OBJ_LABEL[state.ui.objective];
  }

  function renderEffectivePrices() {
    var f = F.withDefaults(finEff()), d = F.effectiveDiscount(f);
    var a = $("eff-costPerW"), b = $("eff-costPerKwh");
    if (a) a.textContent = d > 0 ? "Effective after incentives: $" + (f.costPerW * (1 - d)).toFixed(2) + "/W" : "";
    if (b) b.textContent = d > 0 ? "Effective after incentives: $" + Math.round(f.costPerKwh * (1 - d)) + "/kWh" : "";
  }

  // ------------------------------------------------------------------ heatmap
  function renderHeat(sel) {
    var host = $("heat");
    var vals = priced.cells.map(goodness).filter(function (v) { return isFinite(v); });
    var hi = Math.max(1e-6, Math.max.apply(null, vals)), lo = Math.min(-1e-6, Math.min.apply(null, vals));
    var norm = function (g) { return g >= 0 ? g / hi : g / -lo; };   // -1 .. +1, each arm on its own scale
    var pl = priced.panelList, bl = priced.battList;
    host.style.gridTemplateColumns = "34px repeat(" + pl.length + ", minmax(8px, 1fr))";
    var html = ['<div class="heat-axis v"></div>'];
    pl.forEach(function (p) { html.push('<div class="heat-axis h">' + (p % 5 === 0 ? p : "") + "</div>"); });
    bl.slice().reverse().forEach(function (b) {
      html.push('<div class="heat-axis v">' + b + "b</div>");
      pl.forEach(function (p) {
        var c = O.findCell(priced, p, b);
        if (!c) { html.push("<div></div>"); return; }
        var g = goodness(c), t = Math.min(1, Math.abs(norm(g)));
        var col = mix(T["neutral-mid"], g >= 0 ? T.s1 : T.s8, 0.10 + 0.90 * t);
        var isBest = c.panels === priced.best.panels && c.batteries === priced.best.batteries;
        var isSel = c.panels === sel.panels && c.batteries === sel.batteries;
        html.push('<button class="heat-cell" style="background:' + col + '" data-p="' + p + '" data-b="' + b + '"'
          + (isBest ? ' data-best="1"' : "") + (isSel ? ' data-sel="1"' : "")
          + ' title="' + p + " panels, " + b + " batteries — NPV " + fmtMoney(c.npv) + ", payback " + fmtYears(c.payback) + '"'
          + ' aria-label="' + p + " panels, " + b + " batteries, NPV " + fmtMoney(c.npv) + '"></button>');
      });
    });
    host.innerHTML = html.join("");
    host.onclick = function (e) {
      var b = e.target.closest(".heat-cell"); if (!b) return;
      state.ui.ovPanels = +b.dataset.p; state.ui.ovBatteries = +b.dataset.b;
      refreshControls(); writeHash(); repriceAndRender();
    };

    $("heat-ramp").innerHTML = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map(function (t) {
      return '<span style="background:' + mix(T["neutral-mid"], t >= 0 ? T.s1 : T.s8, 0.10 + 0.90 * Math.abs(t)) + '"></span>';
    }).join("");
    var unit = state.ui.objective === "irr" ? "" : state.ui.objective === "payback" ? " yr" : "";
    $("heat-hint").textContent = "solid ring = optimum \u00b7 dashed = your pick \u00b7 columns are panels";
    $("heat-lo").textContent = "worst " + sliceFmt(lo);
    $("heat-hi").textContent = "best " + sliceFmt(hi);

    // 1-D slices through the chosen cell
    var alongP = pl.map(function (p) { var c = O.findCell(priced, p, sel.batteries); return c ? goodness(c) : null; });
    var alongB = bl.map(function (b) { var c = O.findCell(priced, sel.panels, b); return c ? goodness(c) : null; });
    lineChart("c-slice-p", pl, [{ label: "panels", data: alongP, color: T.s1 }], {
      xTitle: "panels, holding storage at " + plural(sel.batteries, "battery", "batteries"), yFmt: sliceFmt, marker: pl.indexOf(sel.panels),
    });
    lineChart("c-slice-b", bl, [{ label: "batteries", data: alongB, color: T.s2 }], {
      xTitle: "batteries, holding the array at " + plural(sel.panels, "panel", "panels"), yFmt: sliceFmt, marker: bl.indexOf(sel.batteries),
    });

    // Table twin of the heat map: the whole surface as NPV, readable without hovering.
    var th = ["<thead><tr><th>Panels</th>"];
    bl.forEach(function (b) { th.push("<th class='n'>" + b + " batt</th>"); });
    th.push("</tr></thead><tbody>");
    pl.forEach(function (p) {
      th.push("<tr><td class='n'>" + p + "</td>");
      bl.forEach(function (b) {
        var cc = O.findCell(priced, p, b);
        var on = cc && cc.panels === sel.panels && cc.batteries === sel.batteries;
        th.push("<td class='n'" + (on ? " style='font-weight:600'" : "") + ">" + (cc ? fmtCompact(cc.npv) : "\u2014") + "</td>");
      });
      th.push("</tr>");
    });
    $("t-heat").innerHTML = th.join("") + "</tbody>";
  }
  function sliceFmt(v) {
    if (state.ui.objective === "irr") return fmtPct(v, 0);
    if (state.ui.objective === "payback") return v.toFixed(0) + " yr";
    return fmtCompact(v);
  }

  // ------------------------------------------------------------------ charts
  var charts = {};
  function baseOpts(extra) {
    var o = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: T.surface, titleColor: T.ink, bodyColor: T["ink-2"],
          borderColor: T.rule, borderWidth: 1, padding: 9, cornerRadius: 4,
          titleFont: { weight: "600" }, displayColors: true, boxWidth: 9, boxHeight: 9, usePointStyle: false,
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: T.rule },
             ticks: { color: T["ink-3"], font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: T.grid, drawTicks: false }, border: { display: false },
             ticks: { color: T["ink-3"], font: { size: 10 }, padding: 6 } },
      },
      elements: { line: { borderWidth: 2, tension: 0.15 }, point: { radius: 0, hitRadius: 12, hoverRadius: 4 } },
    };
    return deepMerge(o, extra || {});
  }
  function deepMerge(a, b) {
    Object.keys(b).forEach(function (k) {
      if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) { a[k] = deepMerge(a[k] || {}, b[k]); }
      else a[k] = b[k];
    });
    return a;
  }
  function draw(id, cfg) {
    if (charts[id]) charts[id].destroy();
    var el = $(id); if (!el) return;
    charts[id] = new Chart(el.getContext("2d"), cfg);
  }
  function legendHTML(target, items) {
    $(target).innerHTML = items.map(function (i) {
      return '<span class="key"><span class="sw' + (i.line ? " line" : "") + '" style="background:' + i.color + '"></span>' + i.label + "</span>";
    }).join("");
  }

  function lineChart(id, labels, series, opt) {
    opt = opt || {};
    draw(id, {
      type: "line",
      data: { labels: labels, datasets: series.map(function (s) {
        return { label: s.label, data: s.data, borderColor: s.color,
                 backgroundColor: s.fill ? alpha(s.color, 0.10) : "transparent", fill: !!s.fill,
                 borderDash: s.dash || undefined, spanGaps: true,
                 pointRadius: opt.marker === undefined ? 0 : function (c) { return c.dataIndex === opt.marker ? 4 : 0; },
                 pointBackgroundColor: s.color, pointBorderColor: T.surface, pointBorderWidth: 2 };
      }) },
      options: baseOpts({
        plugins: { tooltip: { callbacks: { label: function (c) {
          return " " + c.dataset.label + ": " + (opt.yFmt ? opt.yFmt(c.parsed.y) : fmtNum(c.parsed.y, 1));
        } } } },
        scales: { x: { title: opt.xTitle ? { display: true, text: opt.xTitle, color: T["ink-3"], font: { size: 10 } } : undefined },
                  y: { ticks: { callback: function (v) { return opt.yFmt ? opt.yFmt(v) : v; } } } },
      }),
    });
  }

  // ------------------------------------------------------------------ cash flow
  function renderCash(c) {
    var f = c.finance, H = f.horizon, years = [], sys = [];
    for (var y = 0; y <= H; y++) { years.push(y); sys.push(f.cumulative[y]); }
    // Both arms are stated the same way: value relative to having spent the cash.
    // The market arm starts at zero and grows; the system arm starts at minus the
    // outlay and climbs as the bills it avoids accumulate.
    var inv = years.map(function (y) { return f.netCost * (Math.pow(1 + state.fin.investReturn, y) - 1); });
    var wealth = years.map(function (y) {
      var w = 0;
      for (var i = 1; i <= y; i++) w += f.cashflows[i] * Math.pow(1 + state.fin.investReturn, y - i);
      return w - f.netCost;
    });
    lineChart("c-cash", years, [
      { label: "System, cash in hand", data: sys, color: T.s1, fill: true },
      { label: "System, savings reinvested", data: wealth, color: T.s3 },
      { label: "Cash left in the market", data: inv, color: T.s2 },
    ], { yFmt: fmtCompact, xTitle: "years from install" });
    legendHTML("l-cash", [
      { label: "System, cash in hand", color: T.s1, line: true },
      { label: "System, savings reinvested at " + fmtPct(state.fin.investReturn, 1), color: T.s3, line: true },
      { label: "Same cash left in the market", color: T.s2, line: true },
    ]);

    var rows = ["<thead><tr><th>Year</th><th class='n'>Savings</th><th class='n'>O&amp;M</th><th class='n'>Replacements</th><th class='n'>Net</th><th class='n'>Cumulative</th></tr></thead><tbody>"];
    for (y = 0; y <= H; y++) {
      rows.push("<tr><td class='n'>" + y + "</td><td class='n'>" + (y ? fmtMoney(f.savingsByYear[y]) : "—")
        + "</td><td class='n'>" + (y ? fmtMoney(-f.omByYear[y]) : "—")
        + "</td><td class='n'>" + (y && f.extrasByYear[y] ? fmtMoney(-f.extrasByYear[y]) : "—")
        + "</td><td class='n'>" + fmtMoney(f.cashflows[y]) + "</td><td class='n'>" + fmtMoney(f.cumulative[y]) + "</td></tr>");
    }
    $("t-cash").innerHTML = rows.join("") + "</tbody>";
  }

  // ------------------------------------------------------------------ tornado
  function evSim(v) {
    var sav = state.ui.basis === "trueEV" ? v.savingsTrue : v.savingsSameEV;
    return { savings: sav, exportRevenue: v.exportRevenue, importSavings: sav - (v.exportRevenue || 0),
             bill: v.bill, baselineBill: state.ui.basis === "trueEV" ? v.baselineTrueEV : v.baselineSameEV };
  }

  function renderTornado(c) {
    var evV = detail && detail.evVariants ? {
      low: evSim(detail.evVariants.low), high: evSim(detail.evVariants.high),
    } : null;
    var t = O.tornado(c, finEff(), priced.baseline.bill, evV);
    var labels = t.rows.map(function (r) { return r.label; });
    draw("c-tornado", {
      type: "bar",
      data: { labels: labels, datasets: [
        { label: "−20%", data: t.rows.map(function (r) { return r.low; }), backgroundColor: T.s8, borderRadius: 3, borderSkipped: false, barThickness: 16 },
        { label: "+20%", data: t.rows.map(function (r) { return r.high; }), backgroundColor: T.s1, borderRadius: 3, borderSkipped: false, barThickness: 16 },
      ] },
      options: baseOpts({
        indexAxis: "y",
        scales: { x: { grid: { color: T.grid, drawTicks: false }, border: { display: false },
                       ticks: { color: T["ink-3"], font: { size: 10 }, callback: fmtCompact },
                       title: { display: true, text: "change in NPV", color: T["ink-3"], font: { size: 10 } } },
                  y: { grid: { display: false }, border: { color: T.rule }, ticks: { color: T["ink-2"], font: { size: 11 } } } },
        plugins: { tooltip: { callbacks: { label: function (x) { return " " + x.dataset.label + ": " + fmtMoney(x.parsed.x); } } } },
      }),
    });
    legendHTML("l-tornado", [{ label: "input 20% lower", color: T.s8 }, { label: "input 20% higher", color: T.s1 }]);

    var beSim = { savings: c.savings, importSavings: c.importSavings, exportRevenue: c.exportRevenue,
                  bill: c.bill, baselineBill: priced.baseline.bill,
                  pvKwh: c.pvKwh, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal };
    var bw = F.breakEven(beSim, finEff(), "costPerW");
    var bk = F.breakEven(beSim, finEff(), "costPerKwh");
    // Break-even solves for the STICKER price, since that is the slider it inverts;
    // show the post-incentive figure beside it so $13.60/W is not read as a net price.
    var disc = F.effectiveDiscount(F.withDefaults(finEff()));
    var pair = function (v, dp, unit) {
      if (v === null || v < 0) return "any price loses";
      return "$" + v.toFixed(dp) + unit + " sticker"
        + (disc > 0 ? " · $" + (v * (1 - disc)).toFixed(dp) + unit + " net" : "");
    };
    $("breakeven").innerHTML =
      "<dt>Break-even solar price</dt><dd>" + pair(bw, 2, "/W") + "</dd>"
      + "<dt>Break-even storage price</dt><dd>" + (c.battKWhTotal === 0 ? "— no storage" : pair(bk, 0, "/kWh")) + "</dd>"
      + "<dt>LCOE of the solar</dt><dd>" + fmtMoney(c.lcoe, 3) + "/kWh</dd>"
      + "<dt>Lifetime cost, with system</dt><dd>" + fmtCompact(c.lifetimeCost) + "</dd>"
      + "<dt>Lifetime cost, no system</dt><dd>" + fmtCompact(c.finance.lifetimeCostNoSystem) + "</dd>";
  }

  // ------------------------------------------------------------------ detail
  function renderDetail() {
    if (!detail || !priced) return;
    clearStale();
    renderMonthly();
    renderDay();
    renderWeather();
    renderPlans();
  }

  var BILL_PARTS = [
    { k: "fixed", label: "Base services charge", color: function () { return T["ink-3"]; } },
    { k: "on", label: "On-peak energy", color: function () { return T.s8; } },
    { k: "mid", label: "Mid-peak energy", color: function () { return T.s2; } },
    { k: "off", label: "Off-peak energy", color: function () { return T.s4; } },
    { k: "super_off", label: "Super-off-peak energy", color: function () { return T.s3; } },
    { k: "exportCreditUsed", label: "Export credit", color: function () { return T.s1; } },
    { k: "climateCredit", label: "CA Climate Credit", color: function () { return T.s7; } },
  ];

  function monthParts(m) {
    // The monthly rows carry total energy, not a period split; the period split is
    // only meaningful on the whole-year totals, so the bars show energy as one block
    // when a split is unavailable.
    return { fixed: m.fixed, energy: m.energy, baselineCredit: m.baselineCredit,
             exportCreditUsed: m.exportCreditUsed, climateCredit: m.climateCredit, trueUp: m.trueUp };
  }

  function renderMonthly() {
    var base = state.ui.basis === "trueEV" ? detail.baselineTrueEV : detail.baselineSameEV;
    var labels = detail.monthly.map(function (m) { return m.key.slice(2); });
    var parts = [
      { k: "fixed", label: "Base services charge", color: T["ink-3"] },
      { k: "energy", label: "Energy charges", color: T.s2 },
      { k: "exportCreditUsed", label: "Export credit", color: T.s1 },
      { k: "baselineCredit", label: "Baseline credit", color: T.s3 },
      { k: "climateCredit", label: "Climate credit", color: T.s7 },
      { k: "trueUp", label: "Annual true-up", color: T.s7 },
    ];
    var ds = [];
    parts.forEach(function (p) {
      ds.push({ label: "Today · " + p.label, stack: "before", backgroundColor: p.color,
                data: base.monthly.map(function (m) { return monthParts(m)[p.k] || 0; }),
                borderColor: T.surface, borderWidth: { top: 2, bottom: 0, left: 0, right: 0 }, borderSkipped: false });
    });
    parts.forEach(function (p) {
      ds.push({ label: "With system · " + p.label, stack: "after", backgroundColor: p.color,
                data: detail.monthly.map(function (m) { return monthParts(m)[p.k] || 0; }),
                borderColor: T.surface, borderWidth: { top: 2, bottom: 0, left: 0, right: 0 }, borderSkipped: false });
    });
    draw("c-month", {
      type: "bar",
      data: { labels: labels, datasets: ds },
      options: baseOpts({
        scales: { x: { stacked: true, ticks: { font: { size: 9 } } },
                  y: { stacked: true, ticks: { callback: function (v) { return fmtCompact(v); } } } },
        plugins: { tooltip: { filter: function (c) { return Math.abs(c.parsed.y) > 0.5; },
                              callbacks: { label: function (c) { return " " + c.dataset.label + ": " + fmtMoney(c.parsed.y); } } } },
      }),
    });
    legendHTML("l-month", parts.map(function (p) { return { label: p.label, color: p.color }; }));
    $("l-month").insertAdjacentHTML("beforeend",
      '<span style="color:var(--ink-3)">left bar of each pair = today &middot; right bar = with the system</span>');

    var rows = ["<thead><tr><th>Month</th><th class='n'>Bill today</th><th class='n'>Bill with system</th><th class='n'>Saved</th><th class='n'>Import kWh</th><th class='n'>Export kWh</th></tr></thead><tbody>"];
    detail.monthly.forEach(function (m, i) {
      var b = base.monthly[i];
      rows.push("<tr><td>" + m.key + "</td><td class='n'>" + fmtMoney(b.bill, 2) + "</td><td class='n'>" + fmtMoney(m.bill, 2)
        + "</td><td class='n'>" + fmtMoney(b.bill - m.bill, 2) + "</td><td class='n'>" + fmtNum(m.importKwh, 0)
        + "</td><td class='n'>" + fmtNum(m.exportKwh, 0) + "</td></tr>");
    });
    $("t-month").innerHTML = rows.join("") + "</tbody>";
    $("bill-plan").textContent = (E.planById(DATA.tariffs, state.sim.planId).name || state.sim.planId) + " · "
      + (DATA.tariffs.providers[state.sim.providerId] || {}).name;
  }

  function renderPlans() {
    var rows = ["<thead><tr><th>Rate plan</th><th class='n'>Bill today</th><th class='n'>With system</th><th class='n'>Saved / yr</th></tr></thead><tbody>"];
    var best = detail.plans.reduce(function (a, b) {
      var av = (state.ui.basis === "trueEV" ? a.baselineTrueEV : a.baselineSameEV) - a.bill;
      var bv = (state.ui.basis === "trueEV" ? b.baselineTrueEV : b.baselineSameEV) - b.bill;
      return bv > av ? b : a;
    });
    detail.plans.forEach(function (p) {
      var baseBill = state.ui.basis === "trueEV" ? p.baselineTrueEV : p.baselineSameEV;
      rows.push("<tr class='" + (p === best ? "is-best" : "") + "'><td>" + esc(p.name)
        + (p.planId === state.sim.planId ? " <span class='tag'>selected</span>" : "")
        + "</td><td class='n'>" + fmtMoney(baseBill) + "</td><td class='n'>" + fmtMoney(p.bill)
        + "</td><td class='n'>" + fmtMoney(baseBill - p.bill) + "</td></tr>");
    });
    $("t-plans").innerHTML = rows.join("") + "</tbody>";

    if (detail.providers) {
      var pr = ["<thead><tr><th>Generation</th><th class='n'>Bill today</th><th class='n'>With system</th><th class='n'>Saved / yr</th></tr></thead><tbody>"];
      var bestP = detail.providers.reduce(function (a, b) { return b.bill < a.bill ? b : a; });
      detail.providers.forEach(function (x) {
        var baseBill = state.ui.basis === "trueEV" ? x.baselineTrueEV : x.baselineSameEV;
        pr.push("<tr class='" + (x === bestP ? "is-best" : "") + "'><td>" + esc(x.name)
          + (x.id === state.sim.providerId ? " <span class='tag'>yours</span>" : "")
          + "</td><td class='n'>" + fmtMoney(baseBill) + "</td><td class='n'>" + fmtMoney(x.bill)
          + "</td><td class='n'>" + fmtMoney(baseBill - x.bill) + "</td></tr>");
      });
      $("t-providers").innerHTML = pr.join("") + "</tbody>";
      var mine = detail.providers.find(function (x) { return x.id === state.sim.providerId; });
      $("provider-note").textContent = (mine && bestP.id !== mine.id)
        ? "Switching generation from " + mine.name + " to " + bestP.name + " would cut the with-system bill by "
          + fmtMoney(mine.bill - bestP.bill) + "/yr on its own \u2014 no hardware involved. CPA's cleaner tiers cost more per kWh "
          + "because the CCA surcharge stack on this bill is $0.03535/kWh, higher than the $0.02433 SCE's own comparison assumes."
        : "You are already on the cheapest generation option modelled here.";
    }
  }

  var PERIOD_COLOR = function () { return { on: T.s8, mid: T.s2, off: T.s4, super_off: T.s3 }; };
  function renderDay() {
    var si = state.ui.season, day = detail.typicalDay[si];
    var h = day.hours, labels = h.map(function (x) { return String(x.hour).padStart(2, "0"); });
    var pvToLoad = h.map(function (x) { return Math.min(x.pv, x.load); });
    var battToLoad = h.map(function (x) { return Math.min(x.discharge, Math.max(0, x.load - Math.min(x.pv, x.load))); });
    var gridToLoad = h.map(function (x, i) { return Math.max(0, x.load - pvToLoad[i] - battToLoad[i]); });
    // Chart.js fills between a dataset and the one below it, so the three bands carry
    // RUNNING TOTALS; the raw band value is kept alongside for the tooltip.
    var cum1 = pvToLoad.slice();
    var cum2 = pvToLoad.map(function (v, i) { return v + battToLoad[i]; });
    var cum3 = cum2.map(function (v, i) { return v + gridToLoad[i]; });
    draw("c-day", {
      type: "line",
      data: { labels: labels, datasets: [
        { label: "Load served by solar", data: cum1, _raw: pvToLoad, borderColor: "transparent", backgroundColor: alpha(T.s4, 0.5), fill: "origin", pointRadius: 0 },
        { label: "Load served by battery", data: cum2, _raw: battToLoad, borderColor: "transparent", backgroundColor: alpha(T.s3, 0.5), fill: "-1", pointRadius: 0 },
        { label: "Load served by the grid", data: cum3, _raw: gridToLoad, borderColor: "transparent", backgroundColor: alpha(T["ink-3"], 0.34), fill: "-1", pointRadius: 0 },
        { label: "Solar produced", data: h.map(function (x) { return x.pv; }), borderColor: T.s2, fill: false, borderWidth: 2 },
        { label: "Exported", data: h.map(function (x) { return x.gridExport; }), borderColor: T.s1, borderDash: [4, 3], fill: false, borderWidth: 2 },
        { label: "EV charging", data: h.map(function (x) { return x.ev; }), borderColor: T.s7, fill: false, borderWidth: 2 },
      ] },
      options: baseOpts({
        scales: { y: { beginAtZero: true, ticks: { callback: function (v) { return v + " kWh"; } } } },
        plugins: { tooltip: { callbacks: { label: function (c) {
          var raw = c.dataset._raw ? c.dataset._raw[c.dataIndex] : c.parsed.y;
          return " " + c.dataset.label + ": " + fmtNum(raw, 2) + " kWh";
        } } } },
      }),
    });
    legendHTML("l-day", [
      { label: "Load served by solar", color: alpha(T.s4, 0.55) },
      { label: "by battery", color: alpha(T.s3, 0.55) },
      { label: "by the grid", color: alpha(T["ink-3"], 0.4) },
      { label: "Solar produced", color: T.s2, line: true },
      { label: "Exported", color: T.s1, line: true },
      { label: "EV charging", color: T.s7, line: true },
    ]);

    draw("c-soc", {
      type: "line",
      data: { labels: labels, datasets: [{ label: "Battery state of charge", data: h.map(function (x) { return x.soc * 100; }),
              borderColor: T.s3, backgroundColor: alpha(T.s3, 0.12), fill: true, borderWidth: 2 }] },
      options: baseOpts({
        scales: { y: { min: 0, max: 100, ticks: { stepSize: 50, callback: function (v) { return v + "%"; } } } },
        plugins: { tooltip: { callbacks: { label: function (c) { return " state of charge: " + c.parsed.y.toFixed(0) + "%"; } } } },
      }),
    });

    var sched = detail.schedule[si === 0 ? "summer" : "winter"], cols = PERIOD_COLOR();
    var names = { on: "On-peak", mid: "Mid-peak", off: "Off-peak", super_off: "Super-off-peak" };
    $("period-ribbon").innerHTML = sched.map(function (p) {
      return '<span title="' + (names[p] || p) + '" style="flex:1;background:' + (cols[p] || T.grid) + '"></span>';
    }).join("");

    var rows = ["<thead><tr><th>Hour</th><th class='n'>Load</th><th class='n'>EV</th><th class='n'>Solar</th><th class='n'>Batt in</th><th class='n'>Batt out</th><th class='n'>Import</th><th class='n'>Export</th><th class='n'>SOC</th></tr></thead><tbody>"];
    h.forEach(function (x) {
      rows.push("<tr><td class='n'>" + String(x.hour).padStart(2, "0") + ":00</td>"
        + [x.load, x.ev, x.pv, x.charge, x.discharge, x.gridImport, x.gridExport].map(function (v) { return "<td class='n'>" + fmtNum(v, 2) + "</td>"; }).join("")
        + "<td class='n'>" + fmtPct(x.soc, 0) + "</td></tr>");
    });
    $("t-day").innerHTML = rows.join("") + "</tbody>";
  }

  function renderWeather() {
    var sel = state.sim.weather;
    var rows = detail.weather;
    var vals = rows.map(function (w) {
      var f = F.evaluate({ savings: state.ui.basis === "trueEV" ? w.savingsVsTrue : w.savingsVsSameEV,
                           importSavings: state.ui.basis === "trueEV" ? w.importSavingsVsTrue : w.importSavingsVsSameEV,
                           exportRevenue: w.exportRevenue,
                           bill: w.bill, baselineBill: priced.baseline.bill,
                           pvKwh: w.pvKwh, kwdc: detail.kwdc, battKWhTotal: detail.battKWhTotal }, finEff());
      return { label: w.label, key: w.key, npv: f.npv, savings: f.firstYearSavings, perKw: w.annualPerKw, pv: w.pvKwh };
    });
    draw("c-weather", {
      type: "bar",
      data: { labels: vals.map(function (v) { return v.label; }), datasets: [{
        label: "NPV", data: vals.map(function (v) { return v.npv; }), borderRadius: 4, borderSkipped: false,
        maxBarThickness: 22,
        backgroundColor: vals.map(function (v) { return v.key === sel ? T.s1 : alpha(T.s1, 0.30); }),
      }] },
      options: baseOpts({
        scales: { y: { ticks: { callback: fmtCompact } }, x: { ticks: { font: { size: 9 } } } },
        plugins: { tooltip: { callbacks: { label: function (c) {
          var v = vals[c.dataIndex];
          return [" NPV " + fmtMoney(v.npv), " savings " + fmtMoney(v.savings) + "/yr", " " + fmtNum(v.perKw, 0) + " kWh/kW-yr"];
        } } } },
      }),
    });
    legendHTML("l-weather", [{ label: "selected scenario", color: T.s1 }, { label: "other scenarios", color: alpha(T.s1, 0.30) }]);
    var rr = ["<thead><tr><th>Scenario</th><th class='n'>kWh/kW-yr</th><th class='n'>Production</th><th class='n'>Savings/yr</th><th class='n'>NPV</th></tr></thead><tbody>"];
    vals.forEach(function (v) {
      rr.push("<tr class='" + (v.key === sel ? "is-best" : "") + "'><td>" + v.label + "</td><td class='n'>" + fmtNum(v.perKw, 0)
        + "</td><td class='n'>" + fmtNum(v.pv, 0) + " kWh</td><td class='n'>" + fmtMoney(v.savings) + "</td><td class='n'>" + fmtMoney(v.npv) + "</td></tr>");
    });
    $("t-weather").innerHTML = rr.join("") + "</tbody>";
  }

  // ------------------------------------------------------------------ method
  function renderValidation() {
    if (!validation) return;
    var bv = (DATA.tariffs.meta || {}).bill_validation || {};
    var actual = bv.actual || { on_kwh: 436, mid_kwh: 176, off_kwh: 1362, total_kwh: 1974, total_charges: 749.37 };
    var v = validation;
    var line = function (name, model, act, fmt) {
      var d = (act === null || act === undefined) ? null : model - act;
      return "<tr><td>" + name + "</td><td class='n'>" + fmt(model) + "</td><td class='n'>" + (act == null ? "—" : fmt(act))
        + "</td><td class='n'>" + (d === null ? "—" : (act ? ((d / act) * 100).toFixed(1) + "%" : fmt(d))) + "</td></tr>";
    };
    var kwh = function (x) { return fmtNum(x, 0) + " kWh"; };
    $("t-validate").innerHTML = "<thead><tr><th>" + v.start + " → " + v.end + " (" + v.days + " days)</th><th class='n'>Model</th><th class='n'>Your bill</th><th class='n'>Diff</th></tr></thead><tbody>"
      + line("On-peak", v.byPeriod.on.kwh, actual.on_kwh, kwh)
      + line("Mid-peak", v.byPeriod.mid.kwh, actual.mid_kwh, kwh)
      + line("Off-peak", v.byPeriod.off.kwh + v.byPeriod.super_off.kwh, actual.off_kwh, kwh)
      + line("Total energy", v.totalKwh, actual.total_kwh, kwh)
      + line("Total charges", v.total, actual.total_charges, function (x) { return fmtMoney(x, 2); })
      + "</tbody>";
    $("validate-note").textContent = "Replayed on " + v.planId + " with " + ((DATA.tariffs.providers[v.providerId] || {}).name || v.providerId)
      + " generation, including the " + fmtMoney(-v.climateCredit, 0) + " CA Climate Credit. "
      + "The kWh split is the model reading your own meter through the tariff's hour definitions, so it should match almost exactly; "
      + "the dollar difference is whatever the published $/kWh leaves out (taxes, franchise fees, rate vintage).";
  }

  function renderQuality() {
    var lm = DATA.load.meta || {}, sm = DATA.solar.meta || {}, tm = DATA.tariffs.meta || {};
    var days = grid ? Math.round(grid.years * 365) : 0;
    var perKw = (sm.annual_kwh_per_kw || {})[grid ? grid.weatherKey : "tmy"];
    var stub = (DATA.tariffs.nbt || {}).notes === "STUB";
    var items = [
      ["Meter history", (grid ? fmtNum(grid.hours, 0) : "—") + " hours, " + days + " days"],
      ["Consumption", fmtNum((lm.total_kwh || 0) / (days / 365), 0) + " kWh/yr"],
      ["EV detected", fmtNum(lm.ev_kwh_per_year, 0) + " kWh/yr · " + fmtNum(lm.ev_sessions_count, 0) + " sessions · "
        + fmtNum(lm.ev_sessions_per_week, 2) + "/week · median " + fmtNum(lm.ev_session_median_kwh, 1) + " kWh"],
      ["Charger", fmtNum(lm.ev_charger_kw, 2) + " kW inferred"],
      ["Solar scenario", (grid ? grid.weatherKey : "—") + " · " + fmtNum(perKw, 0) + " kWh/kW-yr at 20°/180°"],
      ["Orientation applied", state.sim.tilt + "° tilt, " + state.sim.azimuth + "° azimuth (interpolated)"],
      ["Rates effective", (tm.rates_effective || "—") + (tm.as_of ? " · compiled " + tm.as_of : "")],
      ["Baseline allocation", tm.baseline_kwh_per_day
        ? tm.baseline_kwh_per_day.summer + " kWh/day summer, " + tm.baseline_kwh_per_day.winter + " winter (region " + (tm.baseline_region || "?") + ")" : "—"],
      ["Export prices", stub ? "PLACEHOLDER — flat $" + (DATA.tariffs.nbt.export_rates.weekday[0][0]).toFixed(3) + "/kWh, not real ACC values"
        : "NBT " + ((DATA.tariffs.nbt || {}).vintage || "") + " avoided-cost schedule"],
    ];
    $("quality").innerHTML = items.map(function (i) { return "<dt>" + esc(i[0]) + "</dt><dd>" + esc(i[1]) + "</dd>"; }).join("")
      + (stub ? "<dt>Warning</dt><dd><span class='tag tag-warn'>export rates are a stub</span></dd>" : "");
  }

  /**
   * Where export revenue actually lives, counted straight out of the rate matrices:
   * a handful of late-summer evening hours, and essentially nothing else.
   */
  function exportHoursCallout() {
    var er = (DATA.tariffs.nbt || {}).export_rates;
    if (!er) return "";
    var DM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var count = function (th) {
      var h = 0, months = {}, hours = {};
      for (var m = 0; m < 12; m++) {
        for (var x = 0; x < 24; x++) {
          if (er.weekday[m][x] >= th) { h += DM[m] * 5 / 7; months[m] = 1; hours[x] = 1; }
          if (er.weekend[m][x] >= th) { h += DM[m] * 2 / 7; months[m] = 1; hours[x] = 1; }
        }
      }
      var hs = Object.keys(hours).map(Number).sort(function (a, b) { return a - b; });
      return { hours: Math.round(h), months: Object.keys(months).map(function (i) { return MN[i]; }),
               span: hs.length ? hs[0] + ":00\u2013" + (hs[hs.length - 1] + 1) + ":00" : "" };
    };
    var mid = 0, n = 0;
    for (var m = 0; m < 12; m++) for (var x = 9; x < 16; x++) { mid += er.weekday[m][x]; n++; }
    var a = count(0.30), b = count(0.50), c = count(1.00);
    return "<p><strong>Almost all export revenue is in a few dozen evenings.</strong> Counting the rate "
      + "matrices hour by hour: <strong>" + a.hours + " hours a year</strong> pay $0.30/kWh or better, "
      + b.hours + " pay $0.50 or better, and " + c.hours + " pay $1.00 or better \u2014 all of them in "
      + a.months.join(" and ") + ", " + a.span + ". Every other daylight hour of the year exports at about $"
      + (mid / n).toFixed(2) + "/kWh, roughly a fifth of what the same kWh costs to buy back. That is the whole "
      + "argument for a battery, and the whole argument against sizing the array to annual kWh offset.</p>";
  }

  /** Abbreviate a long research note to its first couple of sentences. */
  function brief(text, n) {
    if (!text) return "";
    var parts = String(text).split(/(?<=\.)\s+/);
    return parts.slice(0, n || 2).join(" ");
  }

  var methodDone = false;
  function renderMethod() {
    if (methodDone) return;
    methodDone = true;
    var inc = DATA.tariffs.incentives || {};
    var others = (inc.other || []).slice(0, 5);
    $("incentive-notes").innerHTML =
      "<p><strong>Federal credit you can claim: " + fmtPct(inc.federal_itc_residential_pct || 0, 0) + ".</strong> "
      + esc(brief(inc.federal_itc_note, 2)) + " A third party who owns the system can still claim Section 48E at 30% or more; that is the credit the lease-to-own vendor is claiming, and the only way it reaches this household is as a lower price. Pass-through is a pricing decision, not an entitlement, and it is not disclosed on customer paperwork \u2014 so model the price you are actually quoted, not the credit.</p>"
      + "<p><strong>SGIP storage rebate: $" + fmtNum(inc.sgip_residential_per_kwh || 0, 0) + "/kWh.</strong> "
      + esc(brief(inc.sgip_note, 2)) + "</p>"
      + (others.length ? "<p><strong>Still open, and worth asking about:</strong></p><ul>"
          + others.map(function (o) { return "<li><strong>" + esc(o.name) + "</strong> \u2014 " + esc(o.value) + ". " + esc(brief(o.note, 1)) + "</li>"; }).join("")
          + "</ul>" : "");
    var tm = DATA.tariffs.meta || {}, sm = DATA.solar.meta || {}, lm = DATA.load.meta || {};
    $("method-body").innerHTML = [
      "<h3>What is simulated</h3>",
      "<p>Every hour of your actual meter history — " + fmtNum(lm.n_hours, 0) + " hours from " + lm.start + " to " + lm.end +
      " — is replayed with a solar array and battery bolted on. Results are divided by elapsed days over 365 to give a per-year figure, so the two-year record is not double counted.</p>",
      "<p>Load timestamps are the meter's local clock time and shift with daylight saving; the solar profiles are in local standard time. Summer hours are shifted back one hour before they are paired, and the tariff clock is left alone, because the tariff is defined in clock time too. Spring-forward days have 23 hours and are handled as such.</p>",

      "<h3>How the battery decides</h3>",
      "<ul>",
      "<li><strong>Self-consumption.</strong> Solar serves the house, the surplus charges the pack, the rest exports. At night the pack serves the house down to the backup reserve. Never charges from the grid.</li>",
      "<li><strong>Time-of-use arbitrage.</strong> Same, but during off-peak hours the pack holds back whatever tonight's (or tomorrow's) peak needs and tomorrow's sun cannot refill. When the forecast is sunny the pack is free to run the house overnight, because a kWh kept off an off-peak import beats a kWh exported at avoided-cost prices.</li>",
      "<li><strong>Export arbitrage.</strong> Time-of-use arbitrage plus: in any hour where the export price beats your threshold, the pack sells whatever is above the reserve after the house is served.</li>",
      "<li><strong>Backup only.</strong> The pack sits full and never cycles. Solar still self-consumes and exports. This is the honest zero-arbitrage comparison.</li>",
      "</ul>",
      "<p>The lookahead is one day and it uses the <em>actual</em> next-day profile as its forecast, which flatters every rule by exactly the amount a real forecast is wrong. There is no linear program and no perfect foresight beyond that day. Charge and discharge each pay the square root of round-trip efficiency; the pack never crosses the reserve floor, its usable capacity, or its kW rating.</p>",

      "<h3>How the bill is computed</h3>",
      "<p>Under the Net Billing Tariff there is no netting: each hour, imports are billed at that hour's retail rate for your plan, season and day type, and exports are credited at that hour's avoided-cost export price. Holidays use the weekend schedule.</p>",
      "<ul>",
      "<li>Monthly: base services charge + energy − baseline credit, floored at the minimum charge (or the fixed charge, whichever is higher).</li>",
      "<li>Export credits then offset that subtotal down to the floor and no further. What is left rolls to next month.</li>",
      "<li>At annual true-up the leftover balance is cashed out at net surplus compensation, applied to the kWh those credits came from.</li>",
      "<li>The CA Climate Credit is a flat credit in its months, in both the with-system and no-system bills, so it cancels out of savings but still shows in the bill chart.</li>",
      "<li>Non-bypassable charges ($" + fmtNum((DATA.tariffs.nbt || {}).nonbypassable_charges_per_kwh || 0, 5) + "/kWh) are already inside the published retail rates. They are not added on top \u2014 they are just the part of the import price solar cannot escape.</li>",
      "<li>Two bill lines sit outside the rate tables and are added back: the generation municipal surcharge (levied on generation only, with the CCA surcharge stack backed out) and CPA's flat energy surcharge. Together under 0.4% of the bill \u2014 but they are what makes the replay above land within a nickel.</li>",
      "<li>The ACC Plus adder is paid on every exported kWh and is the one export credit that may reduce the fixed charge. It is <em>not</em> inside the export-rate matrices, so it is added separately.</li>",
      "<li>Without a Net Generation Output Meter, paired storage under 10 kW has its monthly export credit capped at SCE's estimate of PV production, and Schedule NBT SC 5.c.vii deems the forfeited kWh to have happened in the customer's highest-priced hours. SCE does not publish the production-factor table, so the cap here is <em>approximated</em> as this model's own monthly PV output, and credit is stripped from the most expensive price band downward. Switching the NGOM control on removes the cap and adds $600 to the install.</li>",
      "<li>Grid-charging a paired-storage battery is prohibited outright (Schedule NBT SC 5.b.ii.B). The control is left in for comparison, and while it is on the battery is barred from exporting, since grid energy cannot earn an export credit.</li>",
      "<li>At annual true-up, in this order: the credit bank is first reduced by the Average Retail Export Compensation Rate (about $0.0598/kWh) applied to the net surplus kWh, and only then are those kWh paid at net surplus compensation ($" + fmtNum((DATA.tariffs.nbt || {}).net_surplus_compensation_per_kwh || 0, 5) + "/kWh) \u2014 roughly a third of the rate at which the credits were just removed. A bank built out of cheap midday export is therefore wiped out and the customer keeps only the NSC payment. That asymmetry is the tariff's penalty for oversizing, and it is why this model will not recommend an array sized to annual kWh offset.</li>",
      "</ul>",
      exportHoursCallout(),
      "<p><strong>The export prices are a 2026 snapshot of a nine-year trajectory.</strong> A 2026 permission-to-operate date locks the NBT26 vintage for nine years, but that vintage specifies a different 12\u00d724 matrix every year. Across all hours the 2026 matrix runs about 25-30% below the nine-year mean \u2014 but in the August and September 4-9 p.m. hours that actually earn a battery its money, 2026 is 11-18% <em>higher</em> than the nine-year mean, because the summer-evening capacity spike decays after 2028. So this model, using 2026 flat, slightly overstates battery export revenue and understates everything else. There is no single correction factor that fixes both.</p>",

      "<h3>How EV charging moves</h3>",
      "<p>Today the car is plugged in about 2.4 nights a week in roughly 27 kWh sessions, because without solar there is no reason to plug in more often. With an array on the roof the sensible habit inverts: plug in every day you are home, so each day's charge fits inside that day's solar surplus instead of arriving in one lump no array can cover. The default <strong>spread</strong> mode models that habit rather than the recorded pattern:</p>",
      "<ul>",
      "<li>Each Monday-to-Sunday week's recorded EV energy is taken as given, then divided evenly across the chosen number of charging days.</li>",
      "<li>Charging days are picked in the order Mon, Tue, Wed, Thu, Fri, Sat, Sun \u2014 five days means weekdays, seven means every day.</li>",
      "<li>On each charging day the daylight share goes into the daytime window weighted by the solar profile's own shape, so the car follows the array; the remainder charges overnight between 01:00 and 05:00.</li>",
      "<li>No hour ever exceeds the charger's kW rating; anything a cap blocks spills to the nearest hours of the same day.</li>",
      "<li>A week with no recorded charging stays empty, and the weekly and annual kWh totals are unchanged to the last decimal \u2014 only the timing moves.</li>",
      "<li>A second car runs the identical schedule \u2014 same days, same window, same split \u2014 sized to its own annual kWh, on its own charger.</li>",
      "</ul>",
      "<p>The \u201cas recorded\u201d option leaves the metered pattern untouched; it is what the no-system comparison bill is built from. The split between house load and EV load is itself an estimate (" + fmtNum(lm.ev_kwh_per_year, 0) + " kWh/yr, " + fmtNum(lm.ev_sessions_count, 0) + " sessions, " + fmtNum(lm.ev_charger_kw, 2) + " kW charger inferred), not a submeter reading. It is 27% of the house's energy and the most schedulable load on site, which is why the sensitivity panel varies it.</p>",

      "<h3>How the money is computed</h3>",
      "<p>The dispatch is simulated once at year-1 condition and the resulting saving is then scaled — but it is split in two first, because its halves do not grow at the same rate:</p>",
      "<p><code>savings_y = importSavings × escalation^(y−1) × degradation(y) + exportRevenue × exportEscalation^(y−1) × degradation(y)</code></p>",
      "<p><strong>Import savings</strong> are power you no longer buy: they ride retail rates and escalate with them. <strong>Export revenue</strong> is every dollar sourced from an exported kWh — credits actually applied to a bill, the ACC Plus adder and the net-surplus payout — and it does <em>not</em> ride retail rates, because a 2026 permission-to-operate date locks the ACC vintage for nine years. Escalating export credits alongside the bill would inflate the value of every exported kWh and push the optimiser toward an oversized array, so export escalation defaults to zero. Degradation blends the panel and battery rates by their share of system cost and resets when the pack is replaced.</p>",
      "<p>Re-simulating a slightly smaller array every year would move the answer by a fraction of a percent and cost a thousandfold more compute; this approximation is what lets the optimiser sweep hundreds of configurations while you drag a slider.</p>",
      "<ul>",
      "<li><strong>NPV</strong> discounts the cash flows at the return you could have earned on the same money. NPV above zero means the roof beat the market; that is the same statement as the two wealth numbers on the headline.</li>",
      "<li><strong>IRR</strong> is the discount rate at which NPV is zero, found by bisection. If savings never repay the outlay there is no IRR and none is shown.</li>",
      "<li><strong>Payback</strong> is the first year the running total turns positive, interpolated within the year; the discounted version uses the same investment return.</li>",
      "<li><strong>LCOE</strong> divides present-value lifetime cost by present-value lifetime generation, at the inflation/discount rate.</li>",
      "<li><strong>Break-even price</strong> is the $/W or $/kWh at which NPV is exactly zero, solved directly — NPV is linear in both.</li>",
      "</ul>",
      "<p>The vendor pass-through discount is modelled as a straight percentage off the total system price (default 34%, per the vendor’s pitch of passing on part of a ~40% commercial credit). It is a pricing promise, not an entitlement, and is not disclosed on customer paperwork — confirm the net price in the contract.</p>",

      "<h3>Where the numbers come from</h3>",
      "<ul>",
      "<li><strong>Load:</strong> " + esc((lm.source_files || []).join(", ") || "SCE Green Button export") + ".</li>",
      "<li><strong>Solar:</strong> " + esc((sm.sources || []).map(function (x) { return typeof x === "string" ? x : (x.title || x.name || ""); }).join("; ") || "modelled hourly profiles") + ".</li>",
      "<li><strong>Tariffs:</strong> " + esc((tm.sources || []).length ? tm.sources.length + " published SCE and CPA sources, rates effective " + tm.rates_effective : "see tariffs.json") + ".</li>",
      "</ul>",
      "<p>Known limits: no shading or horizon model, no snow or soiling beyond the standard loss bundle; the load history contains no PV, so it cannot show how the household would actually behave once it has a battery; and a two-year record is a short sample of a 25-year decision.</p>",
    ].join("");
  }

  // ------------------------------------------------------------------ summary
  function summaryText() {
    var c = selectedCell(), f = c.finance;
    var L = [];
    L.push("SOLAR + STORAGE SCENARIO — Agoura Hills 91301");
    L.push("Generated from " + fmtNum(grid.hours, 0) + " hours of SCE meter data (" + DATA.load.meta.start + " to " + DATA.load.meta.end + ")");
    L.push("");
    L.push("SYSTEM   " + c.panels + " panels @ " + state.sim.panelW + " W = " + c.kwdc.toFixed(2) + " kW DC, "
      + c.batteries + " battery x " + state.sim.battKWh + " kWh = " + c.battKWhTotal + " kWh usable");
    L.push("         " + state.sim.tilt + " deg tilt / " + state.sim.azimuth + " deg azimuth, weather " + grid.weatherKey
      + " (" + fmtNum(grid.annualPerKw, 0) + " kWh/kW-yr)");
    L.push("         strategy " + state.sim.strategy + ", " + fmtPct(state.sim.minReserve, 0) + " backup reserve");
    L.push("PLAN     " + state.sim.planId + " with " + ((DATA.tariffs.providers[state.sim.providerId] || {}).name || state.sim.providerId));
    L.push("EV       " + (state.sim.evMode === "spread"
      ? "spread over " + state.sim.evDaysPerWeek + " days/week, " + fmtPct(state.sim.dayShiftFraction, 0)
        + " of each day's charge in " + state.sim.evWindowStart + ":00-" + state.sim.evWindowEnd + ":00 (solar-weighted), rest 01:00-05:00"
      : "left as recorded (~2.4 sessions/week)") + (state.sim.secondEV ? ", second EV " + state.sim.secondEVKwhPerYear + " kWh/yr" : "")
      + (state.sim.poolPump ? ", pool pump " + state.sim.poolKW + " kW x " + state.sim.poolHours + " h/day" : ""));
    L.push("");
    L.push("PRICE    $" + state.fin.costPerW.toFixed(2) + "/W solar, $" + state.fin.costPerKwh + "/kWh storage"
      + (f.effectiveDiscount > 0 ? ", " + fmtPct(f.effectiveDiscount, 1) + " incentive discount" : ""));
    L.push("         gross " + fmtMoney(f.gross) + "  ->  cash up front " + fmtMoney(f.netCost));
    L.push("FINANCE  " + state.fin.horizon + " yr horizon, " + fmtPct(state.fin.escalation, 1) + " rate escalation, "
      + fmtPct(state.fin.investReturn, 1) + " investment return, " + fmtPct(state.fin.discountRate, 1) + " inflation");
    L.push("");
    L.push("RESULT   bill " + fmtMoney(priced.baseline.bill) + "/yr  ->  " + fmtMoney(c.bill) + "/yr   (saves " + fmtMoney(c.savings) + "/yr)");
    L.push("         of which           " + fmtMoney(c.importSavings) + " avoided import (escalates) + " + fmtMoney(c.exportRevenue) + " export credit (locked)");
    L.push("         NPV vs investing   " + fmtMoney(c.npv));
    L.push("         IRR                " + (c.irr === null ? "n/a" : fmtPct(c.irr, 1)));
    L.push("         payback            " + fmtYears(c.payback) + " (discounted " + fmtYears(c.discountedPayback) + ")");
    L.push("         wealth at " + state.fin.horizon + " yr   system " + fmtMoney(f.wealthSystem) + "  vs  invested " + fmtMoney(f.wealthInvest));
    L.push("         LCOE               " + fmtMoney(c.lcoe, 3) + "/kWh");
    L.push("         production         " + fmtNum(c.pvKwh, 0) + " kWh/yr, " + fmtPct(c.selfSufficiency, 0) + " self-sufficient, "
      + fmtNum(c.exportKwh, 0) + " kWh exported, " + fmtNum(c.cycles, 0) + " cycles/yr");
    L.push("");
    L.push("Share this exact scenario: " + location.href);
    return L.join("\n");
  }

  // ------------------------------------------------------------------ boot
  function bindUI() {
    $("season-seg").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      state.ui.season = +b.dataset.season;
      Array.prototype.forEach.call(e.currentTarget.children, function (x) {
        x.setAttribute("aria-pressed", String(+x.dataset.season === state.ui.season));
      });
      if (detail) renderDay();
    });
    $("btn-reset").addEventListener("click", function () {
      state = { sim: Object.assign({}, SIM_DEFAULTS), fin: Object.assign({}, FIN_DEFAULTS), ui: Object.assign({}, UI_DEFAULTS) };
      refreshControls(); writeHash(); markStale(); runGrid();
    });
    $("btn-copy").addEventListener("click", function () {
      var txt = summaryText(), btn = $("btn-copy");
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy summary"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback);
      else fallback();
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { btn.textContent = "Press Ctrl+C"; }
        document.body.removeChild(ta);
      }
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        readTokens(); if (priced) repriceAndRender();
      });
    }
    window.addEventListener("hashchange", function () { readHash(); refreshControls(); markStale(); runGrid(); });
  }

  readHash();
  buildControls();
  bindUI();
  status("Loading simulation engine…", 0.01);
  bootWorker();
})();
