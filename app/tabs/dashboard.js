/* =============================================================================
 * tabs/dashboard.js — everything that moves when a knob moves, on one pane.
 *
 * The rail carries every control on the page in collapsible groups; the pane
 * carries the four things a person actually watches while dragging them: the
 * NPV verdict with its tiles, the panel × battery grid, a typical day hour by
 * hour, and the money over time.  Beneath those, where the panels went, what
 * flexible load is doing, and the next thing worth trying.
 *
 * Nothing here talks to the worker; it reads `ctx` and draws.
 * ========================================================================== */

import { el, clear, $, T } from "../ui/dom.js";
import { card, tiles, tile, DISCLAIMER } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtYears, fmtKwh, fmtHour, plural } from "../ui/format.js";
import { OBJ_LABEL, goodness, plateau, renderHeatmap, sliceFmt } from "../charts/heatmap.js";
import { renderTypicalDay } from "../charts/day.js";
import { renderCashflow } from "../charts/money.js";
import * as K from "../ui/knobs.js";
import { sizingCapFor } from "../../core/sizing.js";
import { evaluate } from "../../core/finance.js";

export const id = "dashboard";
export const label = "Dashboard";

export function rail(state, ctx) {
  return [
    K.goal(ctx, true),
    K.price(ctx, true),
    K.financing(true),
    K.hardware(false),
    K.existingSolar(false),
    K.dispatch(false),
    K.search(false),
    K.household(false),
    K.rate(ctx, false),
    K.incentives(false),
    K.future(ctx, false, state),
    K.wear(false),
  ];
}

export function mount(pane, state, ctx) {
  clear(pane);

  // The verdict.
  pane.appendChild(el("section.headline", { id: "headline" }, [
    el("div.hero-verdict", {}, [
      el("span.eyebrow", { id: "hl-title", text: "Net present value vs. investing the cash" }),
      // Number and verdict share a row when they fit, so the column stays short.
      el("div.hero-row", {}, [
        el("div.hero-num.num", { id: "hero-npv", text: "—" }),
        el("span.verdict-pill.pill-mid", { id: "hero-pill" }, [
          el("span.dot"), el("span", { id: "hero-pill-text", text: "waiting for the simulation" }),
        ]),
      ]),
      el("p.hero-band", { id: "hero-band", hidden: true }),
      el("p.hero-why", { id: "hero-why", hidden: true }),
      // The definition of the number is a paragraph most readers need once; it folds away
      // so the band is no taller than the tiles beside it.
      el("details.data-view.hero-more", {}, [
        el("summary", { text: "How this number is worked out" }),
        el("p.hero-note", { id: "hero-note" }),
      ]),
    ]),
    el("div.hero-figures", {}, [
      tiles("tiles"),
      el("p.note.config-line", { id: "config-line" }),
    ]),
  ]));

  const seasonSeg = el("div.seg.seg-inline", { role: "group", "aria-label": "Season", id: "day-season" }, [
    el("button", { type: "button", text: "Summer", "aria-pressed": String(state.ui.season === 0),
      on: { click: () => ctx.actions.setSeason(0) } }),
    el("button", { type: "button", text: "Winter", "aria-pressed": String(state.ui.season === 1),
      on: { click: () => ctx.actions.setSeason(1) } }),
  ]);

  const left = el("div.dash-col", {}, [
    card({
      id: "heat-card",
      title: "Which system size wins",
      tag: { id: "heat-obj", text: "max NPV" },
      sub: "Every cell is a full hourly simulation of your own meter history. Click one to override the "
        + "optimiser and price that system instead.",
      body: [
        el("div.heat-wrap", {}, [el("div.heat", { id: "heat", role: "grid", "aria-label": "Objective value by panel and battery count" })]),
        el("div.heat-legend", {}, [
          el("span", { id: "heat-lo", text: "—" }),
          el("span.heat-ramp", { id: "heat-ramp" }),
          el("span", { id: "heat-hi", text: "—" }),
          el("span", { style: "margin-left:auto", id: "heat-hint", text: "solid ring = optimum · thin ring = effectively tied · dashed = your pick · columns are panels" }),
        ]),
        el("div.heat-margin", { id: "heat-margin" }),
        el("div.heat-cap", { id: "heat-cap" }),
        el("div.slices", {}, [
          el("div.chart-box", { style: "height:110px" }, [el("canvas", { id: "c-slice-p" })]),
          el("div.chart-box", { style: "height:110px" }, [el("canvas", { id: "c-slice-b" })]),
        ]),
      ],
      dataView: { summary: "Show the full grid as a table", tableId: "t-heat" },
    }),
    card({
      id: "day-card",
      title: "A typical weekday, hour by hour",
      sub: "Average weekday shape for the selected system. The band under the axis is the tariff period in "
        + "force at that hour.",
      body: [
        el("div.chart-box", { style: "height:230px" }, [el("canvas", { id: "c-day" })]),
        el("div", { id: "period-ribbon", "aria-hidden": "true" }),
        el("div.legend", { id: "l-day" }),
        el("div.chart-box", { style: "height:90px;margin-top:6px" }, [el("canvas", { id: "c-soc" })]),
      ],
      dataView: { summary: "Show the hourly table", tableId: "t-day" },
    }),
  ]);
  // The season toggle lives in the card head, beside the chart it changes.
  const dayHead = left.querySelector("#day-card .card-head");
  if (dayHead) dayHead.appendChild(seasonSeg);

  const right = el("div.dash-col", {}, [
    card({
      id: "cash-card",
      title: "The money over time",
      tag: { id: "cash-mode-tag", text: "cash" },
      sub: "The system's running cash position against the same cash left in the market, plus what the system "
        + "is worth if every year's saving is reinvested at the same return. Both start from this system's own "
        + "price, so the lines compare cash, loan and lease for one system; a dearer system starts from more "
        + "cash, so compare systems by NPV, not by where the lines end.",
      body: [
        el("div.chart-box", { style: "height:230px" }, [el("canvas", { id: "c-cash" })]),
        el("div.legend", { id: "l-cash" }),
      ],
      dataView: { summary: "Show the year-by-year table", tableId: "t-cash" },
    }),
    card({
      id: "flex-card",
      title: "Flexible load",
      tag: { id: "flex-tag", text: "—" },
      sub: "Loads the household can run at a different hour. Moving them into the sun is often worth more "
        + "than an extra battery, and it costs nothing.",
      body: [
        el("dl.kv", { id: "flex-kv" }),
        el("div.retime", { id: "flex-retime", hidden: true }, [
          el("span.retime-k", { id: "flex-retime-k", text: "Re-time the EV, no hardware" }),
          el("span.retime-v.num", { id: "flex-retime-v" }),
          el("span.retime-d", { id: "flex-retime-d" }),
        ]),
        el("p.note", { id: "flex-note", style: "margin-top:8px" }),
        el("div.chips", {}, [
          el("button.chip-action", { type: "button", text: "Add or reschedule loads →",
            on: { click: () => ctx.actions.goTab("loads") } }),
        ]),
      ],
    }),
    card({
      id: "alloc-card",
      title: "Where the panels go",
      sub: "Panels are allocated face by face, greediest first: one more panel on each face, fill whichever "
        + "earns most, until that face runs out of room.",
      body: [el("div.table-scroll", {}, [el("table", { id: "t-alloc" })])],
    }),
    card({
      id: "next-card",
      title: "What to try next",
      sub: "Each of these is one click. None of them costs anything to find out.",
      body: [el("div.chips", { id: "next-chips" })],
    }),
  ]);

  pane.appendChild(el("div.dash-cols", {}, [left, right]));

  pane.appendChild(el("p.disclaimer", { id: "dash-disclaimer", text: DISCLAIMER }));
}


export function render(state, ctx) {
  const cell = ctx.selected;
  if (!cell) return renderWaiting(ctx);

  renderHeadline(state, ctx, cell);

  const cap = capFor(state, ctx);
  if (ctx.priced) {
    renderHeatmap({
      hostId: "heat",
      priced: ctx.priced,
      selected: ctx.selected,
      objective: ctx.objective || state.ui.objective,
      fin: state.fin,
      onPick: (panels, batteries) => ctx.actions.pickCell(panels, batteries),
      cap: cap ? cap.panelsAt150 : null,
    });
  }
  renderCapLine(state, ctx, cap);
  renderMarginLine(state, ctx);
  renderBand(state, ctx, cell);
  renderWhy(state, ctx, cap);

  const seg = $("day-season");
  if (seg) Array.from(seg.children).forEach((b, i) => b.setAttribute("aria-pressed", String(i === state.ui.season)));

  const detail = ctx.detail;
  if (detail && detail.typicalDay) {
    renderTypicalDay({
      day: detail.typicalDay[state.ui.season],
      schedule: detail.schedule && detail.schedule[state.ui.season === 0 ? "summer" : "winter"],
      flexLabel: state.flex.length ? state.flex[0].name : "Flexible load",
    });
  }

  const cashTag = $("cash-mode-tag");
  if (cashTag) cashTag.textContent = { cash: "paid in cash", loan: "on a loan", lease: "leased" }[state.fin.financing.mode];
  renderCashflow({ cell, fin: state.fin });

  renderFlex(state, ctx);
  renderAllocation(state, ctx);
  renderChips(state, ctx);
}

// ------------------------------------------------------------------ headline

function renderHeadline(state, ctx, cell) {
  const f = cell.finance || {};
  const fin = state.fin;

  const npvNode = $("hero-npv");
  npvNode.textContent = fmtCompact(cell.npv);
  npvNode.style.color = cell.npv >= 0 ? T["good-text"] : T.critical;

  const verdict = verdictFor(cell.npv);
  $("hero-pill").className = "verdict-pill " + verdict.pill;
  $("hero-pill-text").textContent = verdict.text;

  const existing = ctx.existingMode || null;
  const title = $("hl-title");
  if (title) {
    title.textContent = existing
      ? `Adding a battery to your existing ${fmtNum(existing.kwDc, 1)} kW system (${nemLabel(existing.nem)})`
      : "Net present value vs. investing the cash";
  }

  const mode = fin.financing && fin.financing.mode;
  const extra = f.extraRevenue > 0 ? f.extraRevenue : 0;
  $("hero-note").textContent =
    `Present value of ${fin.horizon} years of bill savings, minus what the system costs, discounted at the `
    + `${fmtPct(fin.investReturn, 1)} you could earn on the same money. `
    + (cell.npv > 0 ? "Positive means the roof wins." : "Negative means the market wins.")
    + (cell.exportRevenue > 0
      ? ` Of the ${fmtMoney(cell.savings)} saved in year 1, ${fmtMoney(cell.importSavings)} is power you no longer `
        + `buy and rises with your rates; ${fmtMoney(cell.exportRevenue)} is export credit, locked at today's ACC prices.`
      : "")
    + (extra > 0
      ? ` Backup and grid-services value (${fmtMoney(extra)}/yr) is your own valuation, not a bill saving, and `
        + "does not rise with rates."
      : "");

  // First row: the figures that rank one system against another (the accented two
  // are scale-free, so they compare across systems directly - though IRR favours
  // small arrays, which is why NPV above is the verdict).  Second row: what this
  // particular system is.  No absolute "wealth at the horizon" here: it starts from
  // the system's own price, so a dearer system reads richer for that reason alone.
  // The money-over-time card shows it, with that caveat, for the chosen system.
  const list = [
    Object.assign(irrTile(cell, fin, f), { key: true }),
    Object.assign(paybackTile(cell, fin, f), { key: true }),
    { k: "Savings, year 1", v: fmtMoney(cell.firstYearSavings ?? cell.savings),
      d: (cell.exportRevenue > 0
        ? `${fmtMoney(cell.importSavings)} import + ${fmtMoney(cell.exportRevenue)} export`
        : `bill ${fmtMoney(ctx.baselineBill)} → ${fmtMoney(cell.bill)}`)
        + (extra > 0 ? ` + ${fmtMoney(extra)} backup value` : "") },
    outlayTile(mode, fin, f, cell, ctx),
    existing
      ? { k: "System", v: `${fmtNum(existing.kwDc, 1)} kW existing + 0 new`, d: "panel count is fixed" }
      : { k: "System", v: fmtNum(cell.kwdc, 2) + " kW", d: plural(cell.panels, "panel", "panels") + " @ " + state.system.panelW + " W" },
    { k: "Storage", v: fmtNum(cell.battKWhTotal, 0) + " kWh", d: cell.batteries + " × " + state.system.battKWh + " kWh usable" },
    backupTile(cell, f),
    { k: "Self-sufficiency", v: fmtPct(cell.selfSufficiency, 0), d: fmtNum(cell.importKwh, 0) + " kWh still bought" },
  ];
  const host = clear($("tiles"));
  for (const t of list) host.appendChild(tile(t));

  const ov = state.system.override;
  const manual = (typeof ov.batteries === "number" && ov.batteries >= 0) || !!ov.panelsByPlane;
  const note = $("config-line");
  clear(note);
  note.appendChild(el("strong", { text: manual ? "Manual selection." : `Optimiser's pick (${OBJ_LABEL[ctx.objective || state.ui.objective]}).` }));
  note.appendChild(document.createTextNode(
    (existing ? " The panel count is fixed at your existing system; only the battery changes." : "")
    + ` Produces ${fmtNum(cell.pvKwh, 0)} kWh/yr, keeps ${fmtPct(cell.solarFraction, 0)} of it on site, exports `
    + `${fmtNum(cell.exportKwh, 0)} kWh, cycles the pack ${fmtNum(cell.cycles, 0)}×/yr.`
    // LCOE divides new hardware by the whole array's output, so it means nothing when
    // the array was already there.
    + (ctx.existingMode ? "" : ` LCOE ${fmtMoney(cell.lcoe, 3)}/kWh.`)
    + (ctx.detail && ctx.detail.forfeitedCredit > 1
      ? ` Note: ${fmtMoney(ctx.detail.forfeitedCredit)}/yr of export credit never gets used and is written off at `
        + "true-up — the tariff will not pay for production beyond what this house can absorb."
      : "")));
  if (manual) {
    note.appendChild(document.createTextNode(" "));
    note.appendChild(el("button.chip-action", { type: "button", text: "Back to the optimiser's pick",
      style: "font-size:11px;padding:2px 9px", on: { click: () => ctx.actions.clearOverride() } }));
  }
}

/**
 * How long a full pack carries the house in an outage, at the house's average
 * draw with the flexible loads off - nobody charges two cars from a battery in a
 * blackout.  A rough figure by design: a real outage has the panels recharging
 * the pack by day and the household trimming load, so the truth is longer; but
 * a pack against the averaged base load is the honest starting point, and
 * without a pack a grid-tied array gives nothing.
 */
function backupTile(cell, f) {
  f = f || {};
  const kwh = cell.battKWhTotal || 0;
  const annual = cell.baseLoadKwh || cell.loadKwh || 0;
  const perDay = annual / 365;
  if (kwh <= 0) return { k: "Backup power", v: "none", d: "no battery · a grid-tied array shuts off in an outage" };
  // The household's own valuation of backup (and any grid-services payment), when set.
  const valued = f.extraRevenue > 0
    ? [f.resilienceValue > 0 ? `valued at ${fmtMoney(f.resilienceValue)}/yr` : "", f.vppRevenue > 0 ? `${fmtMoney(f.vppRevenue)}/yr grid services` : ""]
      .filter(Boolean).map((t) => ` · ${t}`).join("")
    : "";
  if (!perDay) return { k: "Backup power", v: fmtNum(kwh, 0) + " kWh", d: "usable storage" + valued };
  const hours = kwh / perDay * 24;
  const v = hours < 48 ? fmtNum(hours, hours < 10 ? 1 : 0) + " h" : fmtNum(hours / 24, 1) + " days";
  const flexOff = cell.baseLoadKwh && cell.loadKwh > cell.baseLoadKwh + 1 ? ", cars and pool off" : "";
  return { k: "Backup power", v,
    d: `${fmtNum(kwh, 0)} kWh pack · house draws ${fmtNum(perDay, 0)} kWh/day${flexOff} · more with daytime sun` + valued };
}

/** Above zero the roof won, below it the market did; zero is a real midpoint. */
function verdictFor(npv) {
  if (npv > 0) return { pill: "pill-good", text: "Beats investing the cash" };
  if (npv < 0) return { pill: "pill-bad", text: "Investing the cash wins" };
  return { pill: "pill-mid", text: "A wash" };
}

/**
 * What the household actually hands over: a cheque, or a payment every month.
 * Under a loan or lease the small print states the financing decision as money:
 * this system's NPV minus the same system bought outright.  Positive means the
 * financing beats cash (its rate is below the investment return); negative is
 * what the convenience of not paying up front costs.
 */
function outlayTile(mode, fin, f, cell, ctx) {
  // The roof faces' "Extra cost $" for the faces this system uses (main.js roofAdderFor),
  // already inside f.gross / f.netCost; named here so the price is not a mystery.
  const roof = cell.roofCostAdder > 0 && cell.panels > 0 ? ` · incl. ${fmtCompact(cell.roofCostAdder)} roof work` : "";
  if (mode === "cash") {
    return { k: "Cash up front", v: fmtCompact(f.netCost),
      d: (f.effectiveDiscount > 0 ? `${fmtPct(f.effectiveDiscount, 1)} off ${fmtCompact(f.gross)}` : "no incentive applied") + roof };
  }
  const gap = typeof ctx.cashNpv === "number" ? cell.npv - ctx.cashNpv : null;
  const vsCash = gap === null ? "" : ` · vs paying cash ${gap >= 0 ? "+" : "−"}${fmtCompact(Math.abs(gap))}`;
  if (mode === "lease") {
    return { k: "Lease payment", v: fmtMoney(f.monthlyPayment || fin.financing.lease.monthly) + "/mo",
      d: `${fin.financing.lease.termYears} yr, ${fmtPct(fin.financing.lease.escalatorPct, 1)} escalator${vsCash}` };
  }
  return { k: "Loan payment", v: fmtMoney(f.monthlyPayment || 0) + "/mo",
    d: `${fmtMoney(f.downPayment || 0)} down · ${fmtPct(fin.financing.loan.apr, 2)} APR · ${fin.financing.loan.termYears} yr${vsCash}${roof}` };
}

function nemLabel(nem) { return nem === "nem1" ? "NEM 1" : "NEM 2"; }

/**
 * The hero's band line: the selected system re-priced at a low and a high rate
 * escalation, since the future of retail rates is the biggest thing nobody knows.
 * Only the import savings escalate (finance.js), so this is the honest range.
 */
function renderBand(state, ctx, cell) {
  const node = $("hero-band");
  if (!node) return;
  node.hidden = true;
  if (!cell || !cell.finance) return;
  const lo = ctx.escalationBand && ctx.escalationBand.lo !== undefined ? ctx.escalationBand.lo : 0.03;
  const hi = ctx.escalationBand && ctx.escalationBand.hi !== undefined ? ctx.escalationBand.hi : 0.08;
  let a, b;
  try {
    const sim = {
      savings: cell.savings, importSavings: cell.importSavings, exportRevenue: cell.exportRevenue,
      accPlusRevenue: cell.accPlusRevenue, bill: cell.bill, baselineBill: ctx.baselineBill,
      pvKwh: cell.pvKwh, kwdc: cell.kwdc, battKWhTotal: cell.battKWhTotal, batteries: cell.batteries,
      after: cell.after || null,          // the Net Billing stream once a NEM 1/2 term ends
    };
    // main.js's finEff carries the NGOM adder, the roof adder rule and the existing-array
    // watts; pricing from raw state.fin would buy an existing array all over again.
    const base = typeof ctx.finEff === "function" ? ctx.finEff(cell.roofCostAdder || 0) : { ...state.fin, roofCostAdder: cell.roofCostAdder || 0 };
    const at = (escalation) => evaluate(sim, { ...base, escalation }).npv;
    a = at(lo); b = at(hi);
  } catch (e) { return; }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;
  const pct = (v) => fmtPct(v, 0).replace(/\s/g, "");
  let text = `${fmtCompact(Math.min(a, b))} to ${fmtCompact(Math.max(a, b))} if rates rise ${pct(lo)} to ${pct(hi)} a year; `;
  const rows = Array.isArray(ctx.weatherRows) ? ctx.weatherRows : [];
  const p90 = rows.find((r) => r.key === "p90"), p10 = rows.find((r) => r.key === "p10");
  if (p90 && p10 && Number.isFinite(p90.npv) && Number.isFinite(p10.npv)) {
    text += `${fmtCompact(Math.min(p90.npv, p10.npv))} to ${fmtCompact(Math.max(p90.npv, p10.npv))} from a dull to a sunny year.`;
  } else {
    text += "weather years move it less.";
  }
  node.textContent = text;
  node.hidden = false;
}

/**
 * One sentence on why the optimum is this size: the first limit it runs into,
 * else the flat-region verdict on the battery, else the marginal panel.
 * With an existing array only the battery is in play, so only the battery is explained.
 */
function renderWhy(state, ctx, cap) {
  const node = $("hero-why");
  if (!node) return;
  node.hidden = true;
  const priced = ctx.priced;
  if (!priced || !priced.cells || !priced.best) return;
  const text = [whySentence(state, ctx, cap), termSentence(state, ctx)].filter(Boolean).join(" ");
  if (!text) return;
  node.textContent = text;
  node.hidden = false;
}

/**
 * Existing-solar mode only: what happens when the NEM 1/2 term ends. Reads the priced best cell's
 * regimeChangeYear and after.savings (first-year dollars on each agreement) and the finance
 * legacyYears; every field may be absent, in which case there is nothing to say.
 */
function termSentence(state, ctx) {
  const ex = ctx.existingMode;
  if (!ex) return null;
  const plan = nemLabel(ex.nem);
  const fin = (ctx.finEff && ctx.finEff(0)) || {};
  const legacyYears = fin.legacyYears !== undefined ? fin.legacyYears : ex.legacyYears;
  // The comparison is about the battery, so use the best cell that has one (1 battery when the best is none).
  const pr = ctx.priced || {};
  const best = pr.best && pr.best.batteries > 0 ? pr.best
    : (pr.cells || []).find((c) => c.batteries === 1) || null;
  const since = state.existing ? state.existing.since : null;
  if (since === null || since === undefined) {
    return "Enter the year the array was switched on (rail, Your existing solar) to model the end of its 20-year term.";
  }
  if (legacyYears === null || legacyYears === undefined) return null;
  if (legacyYears === 0) return `Your ${plan} agreement has ended; everything here is priced under Net Billing.`;
  const year = best && best.regimeChangeYear;
  if (!year) return null;
  const ends = ex.termEndsYear;
  const head = ends ? `Your ${plan} agreement runs to ${ends}. ` : `Your ${plan} agreement is in its last years. `;
  const now = Number(best.savings), then = best.after ? Number(best.after.savings) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(then)) return `${head}From year ${year} the battery is valued under Net Billing.`;
  const tol = Math.max(25, 0.05 * Math.abs(now));
  const cmp = then > now + tol ? "more" : then < now - tol ? "less" : "about the same";
  return `${head}From year ${year} the battery is valued under Net Billing, where it earns ${cmp} `
    + `(${fmtMoney(then, 0)} a year against ${fmtMoney(now, 0)} under ${plan}).`;
}

function whySentence(state, ctx, cap) {
  const priced = ctx.priced, best = priced.best;
  const objective = ctx.objective || state.ui.objective;
  const flat = plateau(priced, objective, state.fin);
  const g = (c) => goodness(c, objective, state.fin);
  const gBest = g(best);
  const gap = (c) => sliceFmt(Math.max(0, gBest - g(c)), objective);
  const horizon = objective === "irr" || objective === "payback" ? "" : ` over ${state.fin.horizon} years`;
  const cells = priced.cells;
  const find = (p, b) => cells.find((c) => c.panels === p && c.batteries === b);
  const bestOf = (list) => list.reduce((a, c) => (!a || g(c) > g(a) ? c : a), null);

  const batterySentence = () => {
    if (best.batteries === 0) {
      const alt = bestOf(cells.filter((c) => c.batteries === 1 && (ctx.existingMode || c.panels === best.panels)));
      if (!alt) return null;
      if (flat && gBest - g(alt) <= flat.tol) return "A battery is roughly a wash here: within " + gap(alt) + " either way, so choose on backup value.";
      return `A battery loses ${gap(alt)}${horizon}.`;
    }
    const none = find(best.panels, 0);
    if (ctx.existingMode && none) return `The ${plural(best.batteries, "battery", "batteries")} beat${best.batteries === 1 ? "s" : ""} no battery by ${gap(none)}${horizon}.`;
    return null;
  };

  if (ctx.existingMode) return batterySentence() || "Your existing panels are fixed; the battery count is the only thing the search changes.";

  const roofCap = (state.roof && state.roof.planes || []).reduce((n, p) => n + (p.maxPanels || 0), 0);
  if (roofCap > 0 && best.panels >= roofCap) return "Limited by the roof: every face is full.";
  if (state.system.maxPanels > 0 && best.panels >= state.system.maxPanels) return "Limited by the search: raise 'Most panels to consider'.";
  if (cap && best.panels === cap.panelsAt150) return `Limited by SCE's sizing rule: ${cap.panelsAt150} panels is the 150% line for your usage.`;
  if (cap && best.panels > cap.panelsAt150) {
    return `Above SCE's 150% line of ${cap.panelsAt150} panels: SCE would refuse the application as sized. `
      + "Cap the search below the heat map to see the largest system it would accept.";
  }
  const b = batterySentence();
  if (b) return b;

  const next = priced.panelList.find((p) => p > best.panels);
  const nextCell = next !== undefined ? find(next, best.batteries) : null;
  if (best.panels === 0) return "At these prices no solar size beats leaving the roof bare.";
  if (!nextCell) return null;
  const mostlyExports = best.pvKwh > 0 && best.exportKwh / best.pvKwh > 0.3;
  return `${next === best.panels + 1 ? `Panel ${next}` : `Going to ${next} panels`} would lose ${gap(nextCell)}${horizon}: `
    + (mostlyExports ? "it mostly exports at a few cents a kWh." : "what it adds is worth less than it costs.");
}

/** SCE's sizing lines for this household; null for other utilities or before any meter data is loaded. */
function capFor(state, ctx) {
  if (ctx.existingMode) return null;   // the array is already up; SCE's sizing line is for a new application
  return sizingCapFor(state.site.utilityId, ctx.recentAnnualKwh, { panelW: state.system.panelW, acFactor: state.system.acFactor });
}

/**
 * How decisive the optimum is.  The heat map rings every cell inside the tolerance;
 * this line puts a number on it and answers the question people actually have:
 * "do I need the battery (or the next one)?".
 */
function renderMarginLine(state, ctx) {
  const node = $("heat-margin");
  if (!node) return;
  clear(node);
  const objective = ctx.objective || state.ui.objective;
  const flat = ctx.priced ? plateau(ctx.priced, objective, state.fin) : null;
  if (!flat) { node.hidden = true; return; }
  node.hidden = false;
  const unit = objective === "irr" ? "" : objective === "payback" ? "" : ` over ${state.fin.horizon} years`;
  const tol = sliceFmt(flat.tol, objective);
  const best = flat.best;
  const sizeOf = (c) => (ctx.existingMode
    ? plural(c.batteries, "battery", "batteries")
    : `${c.panels} panels, ${plural(c.batteries, "battery", "batteries")}`);

  if (flat.count === 0) {
    node.appendChild(el("span", { text: `A clear winner: no other size comes within ${tol} of ${sizeOf(best)}.` }));
    return;
  }
  node.appendChild(el("strong", { text: `Flat region: ${flat.count} other ${flat.count === 1 ? "size is" : "sizes are"} within ${tol} of the best.` }));
  if (flat.altBattery) {
    const alt = flat.altBattery;
    const gap = sliceFmt(Math.abs(flat.altGap), objective);
    node.appendChild(el("span", {
      text: flat.altWithinTol
        ? ` With ${plural(alt.batteries, "battery", "batteries")} instead of ${best.batteries}, the best is ${alt.panels} panels, only ${gap} behind${unit}: effectively a tie, so choose on backup value, roof space or budget rather than on this number.`
        : ` The best with a different battery count (${sizeOf(alt)}) is ${gap} behind${unit}, so the battery count is the decisive part of this answer.`,
    }));
  }
}

function renderCapLine(state, ctx, cap) {
  const node = $("heat-cap");
  if (!node) return;
  clear(node);
  if (!cap) { node.hidden = true; return; }
  node.hidden = false;
  const best = ctx.priced && ctx.priced.best;
  node.appendChild(el("strong", { text: `SCE sizing line: ${cap.panelsAt150} panels.` }));
  node.appendChild(document.createTextNode(
    ` Your last 12 months used ${fmtKwh(cap.annualKwh, 0)}; SCE counts each ${state.system.panelW} W panel as `
    + `${fmtKwh(cap.kwhPerPanel, 0)}/yr and refuses an application above 150%. Up to ${cap.panelsAt100} panels needs no `
    + `paperwork; ${cap.panelsAt100 + 1} to ${cap.panelsAt150} needs an affidavit that your usage will grow to match.`
    + (best && best.panels > cap.panelsAt150 ? ` The optimiser's pick of ${best.panels} is above the line.` : "")));
  if (state.system.maxPanels > cap.panelsAt150) {
    node.appendChild(document.createTextNode(" "));
    node.appendChild(el("button.chip-action", { type: "button", text: `Cap the search at ${cap.panelsAt150}`,
      style: "font-size:11px;padding:2px 9px", on: { click: () => ctx.actions.setMaxPanels(cap.panelsAt150) } }));
  }
}

/** core/finance's `irrReason` codes, as the tile's small print. */
const IRR_REASON = {
  "never repays": "savings never repay the price",
  "no money down": "no money down, so no rate of return",
  "no unique rate": "cash flow changes sign more than once, so no single rate",
};

/**
 * The IRR shown is the project IRR: what the system earns on its cash price,
 * whoever pays it.  Under a loan the useful comparison is the APR - if the
 * system earns more than the loan costs, financing it does not drag the return
 * below the loan rate (whether cash or the loan has the higher NPV is a separate question).  The
 * levered IRR on the household's own cash flows is undefined with nothing down
 * and inflated with a little down, so it is not shown as a tile.
 */
function irrTile(cell, fin, f) {
  const v = cell.projectIrr;
  const mode = fin.financing.mode;
  // No IRR (null, undefined, NaN): never print a number.  core/finance says why
  // in `irrReason`, a short code about the levered `irr`; for cash the levered and
  // project returns are the same cash flow, so its reason stands for this tile.
  // Under a loan or lease "no money down" is about the household's cash, not the
  // system, so only a `projectIrrReason` (if finance ever adds one) is used there.
  if (typeof v !== "number" || !Number.isFinite(v)) {
    const code = f.projectIrrReason || (mode === "cash" ? f.irrReason || cell.irrReason : null);
    const why = !(f.netCost > 0) && mode !== "lease" ? "nothing is paid for the system, so no rate of return"
      : IRR_REASON[code] || (typeof code === "string" && code) || "savings never repay the price";
    return { k: mode === "cash" ? "IRR" : "IRR, system itself", v: "—", d: why };
  }
  if (mode === "loan") {
    const apr = fin.financing.loan.apr;
    return { k: "IRR, system itself", v: fmtPct(v, 1),
      d: `loan APR ${fmtPct(apr, 2)} · earns ${v > apr ? "more" : "less"} than the loan costs` };
  }
  return { k: mode === "lease" ? "IRR, system itself" : "IRR", v: fmtPct(v, 1), d: "vs " + fmtPct(fin.investReturn, 1) + " invested" };
}

/**
 * "Pays for itself": the year the system's earnings have covered everything it
 * will ever cost, financing included.  The small print carries the financing
 * fact that used to masquerade as the payback: when the loan is gone, or that
 * the household is cash-positive from day one.
 */
function paybackTile(cell, fin, f) {
  const mode = fin.financing.mode;
  const v = cell.payback === null || cell.payback === undefined ? "never" : fmtYears(cell.payback);
  if (mode === "cash") return { k: "Pays for itself", v, d: "discounted " + fmtYears(cell.discountedPayback) };
  const cashPos = cell.cashFlowPayback === 0 ? "cash-positive from day one" : `cash-positive after ${fmtYears(cell.cashFlowPayback)}`;
  if (mode === "loan") {
    return { k: "Pays for itself", v,
      d: `incl. ${fmtCompact(f.totalInterest)} interest · loan gone yr ${f.loanPaidOffYear} · ${cashPos}` };
  }
  return { k: "Pays for itself", v, d: `${fin.financing.lease.termYears}-yr lease · ${cashPos}` };
}

// ------------------------------------------------------------ flexible loads

function renderFlex(state, ctx) {
  const host = $("flex-kv");
  if (!host) return;
  clear(host);
  const flex = state.flex || [];
  const tag = $("flex-tag");
  if (tag) {
    const detected = flex.filter((f) => f.source === "detected").length;
    tag.textContent = flex.length ? `${flex.length} total · ${detected} detected` : "none";
  }
  for (const f of flex) {
    const s = f.schedule || {};
    const when = s.mode === "spread"
      ? `${fmtKwh(f.annualKwh * (f.scale ?? 1), 0)}/yr · ${s.daysPerWeek ?? 5} of 7 days · `
        + `${fmtPct(s.daylightFraction ?? 0.9, 0)} inside ${fmtHour(s.window?.[0] ?? 8)}–${fmtHour(s.window?.[1] ?? 15)}`
      : f.kind === "heatpump"
        ? `${fmtKwh(f.annualKwh * (f.scale ?? 1), 0)}/yr · shaped by your site's outdoor temperature`
        : `${fmtKwh(f.annualKwh * (f.scale ?? 1), 0)}/yr · as recorded`;
    host.appendChild(el("dt", { text: f.name }));
    host.appendChild(el("dd", { text: when }));
  }
  if (state.baseLoadScale !== 1) {
    host.appendChild(el("dt", { text: "Rest of the house" }));
    host.appendChild(el("dd", { text: fmtPct(state.baseLoadScale, 0) + " of today" }));
  }
  const note = $("flex-note");
  const retime = $("flex-retime");
  const worth = ctx.flexShiftOnlySavings;
  const showFigure = flex.length > 0 && typeof worth === "number" && worth > 5;
  if (retime) {
    retime.hidden = !showFigure;
    if (showFigure) {
      const evName = flex.some((f) => f.kind === "ev") ? "the EV" : "these loads";
      $("flex-retime-k").textContent = `Re-time ${evName}, no hardware`;
      $("flex-retime-v").textContent = "+" + fmtMoney(worth) + " /yr";
      $("flex-retime-d").textContent = `free, on ${ctx.planLabel || "this plan"}`;
    }
  }
  if (note) {
    note.hidden = false;
    note.textContent = !flex.length
      ? "Nothing flexible was detected in your meter history. Solar still pays against the load you have; "
        + "flexible loads just make it pay more."
      : showFigure
        ? "Moving the load costs nothing; the figure is what the move alone saves, before any panel or battery."
        : "On this schedule the re-timing itself is roughly neutral; its value is in soaking up midday solar.";
  }
}

// --------------------------------------------------------------- allocation

function renderAllocation(state, ctx) {
  const table = $("t-alloc");
  const cardNode = $("alloc-card");
  if (!table) return;
  clear(table);

  const cell = ctx.selected;
  const planes = state.roof.planes;
  // One face needs no table: the headline already says how many panels.
  if (cardNode) cardNode.hidden = planes.length < 2;
  if (planes.length < 2) return;

  const alloc = {};
  const byPlane = cell && cell.panelsByPlane;
  if (Array.isArray(byPlane)) {
    const ids = cell.planeIds || planes.map((p) => p.id);
    ids.forEach((pid, i) => { alloc[pid] = byPlane[i] || 0; });
  } else if (byPlane && typeof byPlane === "object") {
    Object.assign(alloc, byPlane);
  }
  const pvByPlane = {};
  if (cell && Array.isArray(cell.pvKwhByPlane)) {
    (cell.planeIds || planes.map((p) => p.id)).forEach((pid, i) => { pvByPlane[pid] = cell.pvKwhByPlane[i]; });
  }

  table.appendChild(el("thead", {}, [el("tr", {}, [
    "Face", "Tilt / direction", "Panels", "of capacity", "kW DC", "kWh/yr",
  ].map((h, i) => el(i === 0 ? "th" : "th.n", { text: h })))]));

  table.appendChild(el("tbody", {}, planes.map((p) => {
    const n = alloc[p.id] ?? 0;
    const kwdc = (n * state.system.panelW) / 1000;
    const pv = pvByPlane[p.id];
    return el("tr", {}, [
      el("td", { text: p.name }),
      el("td.n", { text: `${p.tilt}° / ${p.azimuth}°` }),
      el("td.n", { text: String(n) }),
      el("td.n", { text: fmtPct(p.maxPanels ? n / p.maxPanels : 0, 0) }),
      el("td.n", { text: fmtNum(kwdc, 2) }),
      el("td.n", { text: pv === null || pv === undefined ? "—" : fmtNum(pv, 0) }),
    ]);
  })));

  const total = Object.values(alloc).reduce((a, b) => a + b, 0) || (cell ? cell.panels : 0);
  table.appendChild(el("tfoot", {}, [el("tr", {}, [
    el("td", { text: "Total" }), el("td.n", { text: "" }),
    el("td.n", { text: plural(total, "panel", "panels") }), el("td.n", { text: "" }),
    el("td.n", { text: cell ? fmtNum(cell.kwdc, 2) : "—" }),
    el("td.n", { text: cell ? fmtNum(cell.pvKwh, 0) : "—" }),
  ])]));
}

// -------------------------------------------------------------------- chips

function renderChips(state, ctx) {
  const host = $("next-chips");
  if (!host) return;
  clear(host);
  const chips = [];

  if (ctx.bestProvider && ctx.bestProvider.id !== state.tariff.providerId && ctx.bestProviderGain > 1) {
    chips.push({
      text: `Switch generation to ${ctx.bestProvider.name} — saves ${fmtMoney(ctx.bestProviderGain)}/yr`,
      run: () => ctx.actions.setProvider(ctx.bestProvider.id),
    });
  }
  if (ctx.bestPlan && ctx.bestPlan.planId !== state.tariff.planId && ctx.bestPlanGain > 1) {
    chips.push({
      text: `Try rate plan ${ctx.bestPlan.name} — saves ${fmtMoney(ctx.bestPlanGain)}/yr`,
      run: () => ctx.actions.setPlan(ctx.bestPlan.planId),
    });
  }
  if (!state.flex.some((f) => f.kind === "ev" && f.source === "manual")) {
    chips.push({ text: "Add a second EV", run: () => ctx.actions.addPreset("ev2") });
  }
  if (state.fin.financing.mode === "cash") {
    chips.push({ text: "Price it as a loan instead", run: () => ctx.actions.setFinancing("loan") });
    chips.push({ text: "Price it as a lease instead", run: () => ctx.actions.setFinancing("lease") });
  } else {
    chips.push({ text: "Price it as cash instead", run: () => ctx.actions.setFinancing("cash") });
  }
  if (state.system.strategy !== "backup_only") {
    chips.push({ text: "What if the battery never cycles?", run: () => ctx.actions.setStrategy("backup_only") });
  } else {
    chips.push({ text: "Let the battery arbitrage time-of-use", run: () => ctx.actions.setStrategy("tou_arbitrage") });
  }
  chips.push({ text: "Check it against a paper bill", run: () => ctx.actions.goTab("bills") });

  for (const c of chips) {
    host.appendChild(el("button.chip-action", { type: "button", text: c.text, on: { click: c.run } }));
  }
}

function renderWaiting(ctx) {
  const note = $("hero-note");
  if (note) note.textContent = ctx.statusText || "Waiting for a roof and a weather profile before the first simulation.";
}

export default { id, label, rail, mount, render };
