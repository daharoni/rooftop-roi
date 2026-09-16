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
import { card, tiles, tile } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtYears, fmtKwh, fmtHour, plural } from "../ui/format.js";
import { OBJ_LABEL, renderHeatmap } from "../charts/heatmap.js";
import { renderTypicalDay } from "../charts/day.js";
import { renderCashflow } from "../charts/money.js";
import * as K from "../ui/knobs.js";

export const id = "dashboard";
export const label = "Dashboard";

export function rail(state, ctx) {
  return [
    K.goal(ctx, true),
    K.price(ctx, true),
    K.financing(true),
    K.hardware(false),
    K.dispatch(false),
    K.search(false),
    K.household(false),
    K.rate(ctx, false),
    K.incentives(false),
    K.future(ctx, false),
    K.wear(false),
  ];
}

export function mount(pane, state, ctx) {
  clear(pane);

  // The verdict.
  pane.appendChild(el("section.headline", { id: "headline" }, [
    el("div.hero-verdict", {}, [
      el("span.eyebrow", { id: "hl-title", text: "Net present value vs. investing the cash" }),
      el("div.hero-num.num", { id: "hero-npv", text: "—" }),
      el("span.verdict-pill.pill-mid", { id: "hero-pill" }, [
        el("span.dot"), el("span", { id: "hero-pill-text", text: "waiting for the simulation" }),
      ]),
      el("p.hero-note", { id: "hero-note" }),
    ]),
    el("div", {}, [
      tiles("tiles"),
      el("p.note", { id: "config-line", style: "margin:10px 0 0" }),
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
          el("span", { style: "margin-left:auto", id: "heat-hint", text: "solid ring = optimum · dashed = your pick · columns are panels" }),
        ]),
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
        + "is worth if every year's saving is reinvested at the same return.",
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
}

export function render(state, ctx) {
  const cell = ctx.selected;
  if (!cell) return renderWaiting(ctx);

  renderHeadline(state, ctx, cell);

  if (ctx.priced) {
    renderHeatmap({
      hostId: "heat",
      priced: ctx.priced,
      selected: ctx.selected,
      objective: state.ui.objective,
      fin: state.fin,
      onPick: (panels, batteries) => ctx.actions.pickCell(panels, batteries),
    });
  }

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

  const pill = $("hero-pill");
  pill.className = "verdict-pill " + (cell.npv > 0 ? "pill-good" : cell.npv < 0 ? "pill-bad" : "pill-mid");
  $("hero-pill-text").textContent = cell.npv > 0 ? "Beats investing the cash"
    : cell.npv < 0 ? "Investing the cash wins" : "A wash";

  const mode = fin.financing && fin.financing.mode;
  $("hero-note").textContent =
    `Present value of ${fin.horizon} years of bill savings, minus what the system costs, discounted at the `
    + `${fmtPct(fin.investReturn, 1)} you could earn on the same money. `
    + (cell.npv > 0 ? "Positive means the roof wins." : "Negative means the market wins.")
    + (cell.exportRevenue > 0
      ? ` Of the ${fmtMoney(cell.savings)} saved in year 1, ${fmtMoney(cell.importSavings)} is power you no longer `
        + `buy and rises with your rates; ${fmtMoney(cell.exportRevenue)} is export credit, locked at today's ACC prices.`
      : "");

  const upfront = mode === "cash"
    ? { k: "Cash up front", v: fmtCompact(f.netCost), d: f.effectiveDiscount > 0 ? `${fmtPct(f.effectiveDiscount, 1)} off ${fmtCompact(f.gross)}` : "no incentive applied" }
    : { k: mode === "lease" ? "Lease payment" : "Loan payment",
        v: fmtMoney(f.monthlyPayment || (mode === "lease" ? fin.financing.lease.monthly : 0)) + "/mo",
        d: mode === "lease"
          ? `${fin.financing.lease.termYears} yr, ${fmtPct(fin.financing.lease.escalatorPct, 1)} escalator`
          : `${fmtMoney(f.downPayment || 0)} down · ${fmtPct(fin.financing.loan.apr, 2)} APR · ${fin.financing.loan.termYears} yr` };

  const list = [
    { k: "System", v: fmtNum(cell.kwdc, 2) + " kW", d: plural(cell.panels, "panel", "panels") + " @ " + state.system.panelW + " W" },
    { k: "Storage", v: fmtNum(cell.battKWhTotal, 0) + " kWh", d: cell.batteries + " × " + state.system.battKWh + " kWh usable" },
    upfront,
    { k: "Savings, year 1", v: fmtMoney(cell.firstYearSavings ?? cell.savings),
      d: cell.exportRevenue > 0
        ? `${fmtMoney(cell.importSavings)} import + ${fmtMoney(cell.exportRevenue)} export`
        : `bill ${fmtMoney(ctx.baselineBill)} → ${fmtMoney(cell.bill)}` },
    { k: "IRR", v: cell.irr === null || cell.irr === undefined ? "—" : fmtPct(cell.irr, 1), d: "vs " + fmtPct(fin.investReturn, 1) + " invested" },
    { k: "Payback", v: fmtYears(cell.payback), d: "discounted " + fmtYears(cell.discountedPayback) },
    { k: "Wealth at " + fin.horizon + " yr", v: fmtCompact(f.wealthSystem), d: "investing: " + fmtCompact(f.wealthInvest) },
    { k: "Self-sufficiency", v: fmtPct(cell.selfSufficiency, 0), d: fmtNum(cell.importKwh, 0) + " kWh still bought" },
  ];
  const host = clear($("tiles"));
  for (const t of list) host.appendChild(tile(t));

  const ov = state.system.override;
  const manual = (typeof ov.batteries === "number" && ov.batteries >= 0) || !!ov.panelsByPlane;
  const note = $("config-line");
  clear(note);
  note.appendChild(el("strong", { text: manual ? "Manual selection." : `Optimiser's pick (${OBJ_LABEL[state.ui.objective]}).` }));
  note.appendChild(document.createTextNode(
    ` Produces ${fmtNum(cell.pvKwh, 0)} kWh/yr, keeps ${fmtPct(cell.solarFraction, 0)} of it on site, exports `
    + `${fmtNum(cell.exportKwh, 0)} kWh, cycles the pack ${fmtNum(cell.cycles, 0)}×/yr. LCOE ${fmtMoney(cell.lcoe, 3)}/kWh.`
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
      : `${fmtKwh(f.annualKwh * (f.scale ?? 1), 0)}/yr · as recorded`;
    host.appendChild(el("dt", { text: f.name }));
    host.appendChild(el("dd", { text: when }));
  }
  if (state.baseLoadScale !== 1) {
    host.appendChild(el("dt", { text: "Rest of the house" }));
    host.appendChild(el("dd", { text: fmtPct(state.baseLoadScale, 0) + " of today" }));
  }
  const note = $("flex-note");
  if (note) {
    note.textContent = !flex.length
      ? "Nothing flexible was detected in your meter history. Solar still pays against the load you have; "
        + "flexible loads just make it pay more."
      : ctx.flexShiftOnlySavings > 5
        ? `Re-timing these loads alone, with no hardware at all, is worth ${fmtMoney(ctx.flexShiftOnlySavings)}/yr `
          + `on ${ctx.planLabel || "this plan"}.`
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
