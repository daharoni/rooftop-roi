/* =============================================================================
 * tabs/money.js — price, incentives, how it is paid for, and what the answer
 * hangs on.
 *
 * Every control here is finance-only: it re-prices simulations that already
 * ran, in about 15 ms, so the charts move while the slider is still under the
 * finger.  Nothing on this tab queues a simulation.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from "../ui/format.js";
import { renderCashflow, renderMonthlyOutlay, renderWeatherBars, renderTornado } from "../charts/money.js";

export const id = "money";
export const label = "Money";

const mode = (s) => s.fin.financing.mode;

export function rail(state, ctx) {
  return [
    { group: "Price", open: true, items: [
      { path: "fin.costPerW", kind: "range", label: "Solar, installed", min: 0.5, max: 6, step: 0.05, money: 2, unit: " /W",
        footnote: (s) => effectiveNote(s, ctx, "w") },
      { path: "fin.costPerKwh", kind: "range", label: "Storage, installed", min: 200, max: 2000, step: 25, money: 0, unit: " /kWh",
        footnote: (s) => effectiveNote(s, ctx, "kwh") },
      { path: "fin.adder", kind: "range", label: "Fixed install adder", min: 0, max: 20000, step: 250, money: 0,
        note: "Panel upgrade, trenching, re-roof — anything quoted as a lump sum." },
    ] },
    { group: "Incentives", open: true, items: [
      { path: "fin.incentiveMode", kind: "select", label: "Incentive treatment", opts: [
        { v: "none", t: "None" },
        { v: "discount", t: "Direct discount off price" },
        { v: "vendor", t: "Vendor credit pass-through" }] },
      { path: "fin.discountPct", kind: "range", label: "Discount", min: 0, max: 0.4, step: 0.01, pct: 0,
        show: (s) => s.fin.incentiveMode === "discount" },
      { path: "fin.passThroughPct", kind: "range", label: "Vendor discount off total price", min: 0, max: 0.45, step: 0.01, pct: 0,
        show: (s) => s.fin.incentiveMode === "vendor",
        note: "A third party who owns the system can claim a commercial credit and pass part of it on as a "
          + "lower price. It is a pricing decision, not an entitlement — model the price you were quoted." },
      { path: "fin.taxCreditPct", kind: "range", label: "Credit you claim yourself", min: 0, max: 0.3, step: 0.01, pct: 0,
        note: "Section 25D is terminated for a 2026 homeowner-owned install. Leave at 0 unless you know otherwise." },
      { path: "fin.sgipPerKwh", kind: "range", label: "Storage rebate", min: 0, max: 1100, step: 25, money: 0, unit: " /kWh" },
      { path: "fin.rebates", kind: "range", label: "Other rebates", min: 0, max: 10000, step: 100, money: 0 },
    ] },
    { group: "How it is paid for", open: true, items: [
      { path: "fin.financing.mode", kind: "seg", label: "Financing", opts: [
        { v: "cash", t: "Cash" }, { v: "loan", t: "Loan" }, { v: "lease", t: "Lease / PPA" }] },
      { path: "fin.financing.loan.sharePct", kind: "range", label: "Share financed", min: 0, max: 1, step: 0.05, pct: 0,
        show: (s) => mode(s) === "loan" },
      { path: "fin.financing.loan.apr", kind: "range", label: "APR", min: 0, max: 0.15, step: 0.0025, pct: 2, unit: " /yr",
        show: (s) => mode(s) === "loan" },
      { path: "fin.financing.loan.termYears", kind: "range", label: "Term", min: 5, max: 25, step: 1, unit: " yr",
        show: (s) => mode(s) === "loan" },
      { path: "fin.financing.loan.dealerFeePct", kind: "range", label: "Dealer fee", min: 0, max: 0.35, step: 0.01, pct: 0,
        show: (s) => mode(s) === "loan",
        note: "A low advertised APR is usually paid for with a dealer fee rolled into the principal. Ask what it is." },
      { path: "fin.financing.lease.monthly", kind: "range", label: "Lease payment", min: 0, max: 500, step: 5, money: 0, unit: " /mo",
        show: (s) => mode(s) === "lease" },
      { path: "fin.financing.lease.escalatorPct", kind: "range", label: "Annual escalator", min: 0, max: 0.06, step: 0.001, pct: 1, unit: " /yr",
        show: (s) => mode(s) === "lease" },
      { path: "fin.financing.lease.termYears", kind: "range", label: "Lease term", min: 5, max: 30, step: 1, unit: " yr",
        show: (s) => mode(s) === "lease" },
      { path: "fin.financing.lease.buyout", kind: "range", label: "Buyout at the end", min: 0, max: 20000, step: 250, money: 0,
        show: (s) => mode(s) === "lease" },
    ] },
    { group: "The world for the next 25 years", open: true, items: [
      { path: "fin.horizon", kind: "range", label: "Analysis horizon", min: 10, max: 40, step: 1, unit: " yr" },
      { path: "fin.escalation", kind: "range", label: "Utility rate escalation", min: 0, max: 0.1, step: 0.005, pct: 1, unit: " /yr",
        note: ctx.escalationNote || "5%/yr is the usual planning figure; 3% low and 8% high are the defensible bands." },
      { path: "fin.exportEscalation", kind: "range", label: "Export credit escalation", min: 0, max: 0.05, step: 0.0025, pct: 2, unit: " /yr",
        note: "Export prices are locked to a fixed avoided-cost vintage for nine years and are not tied to "
          + "retail rates. Leave at 0 unless you think the post-lock-in vintage will be richer." },
      { path: "fin.investReturn", kind: "range", label: "Return if invested instead", min: 0, max: 0.15, step: 0.005, pct: 1, unit: " /yr" },
      { path: "fin.discountRate", kind: "range", label: "Inflation / discount rate", min: 0, max: 0.08, step: 0.005, pct: 1, unit: " /yr" },
    ] },
    { group: "Wear and tear", open: false, items: [
      { path: "fin.panelDeg", kind: "range", label: "Panel degradation", min: 0, max: 0.015, step: 0.001, pct: 2, unit: " /yr" },
      { path: "fin.battDeg", kind: "range", label: "Battery degradation", min: 0, max: 0.05, step: 0.002, pct: 1, unit: " /yr" },
      { path: "fin.battReplYear", kind: "range", label: "Replace the battery in year", min: 10, max: 30, step: 1 },
      { path: "fin.battReplFraction", kind: "range", label: "Replacement costs", min: 0, max: 1, step: 0.05, pct: 0, unit: " of today's price" },
      { path: "fin.inverterYear", kind: "range", label: "Replace the inverter in year", min: 5, max: 30, step: 1 },
      { path: "fin.inverterPerW", kind: "range", label: "Inverter replacement", min: 0, max: 0.5, step: 0.01, money: 2, unit: " /W" },
      { path: "fin.omPerYear", kind: "range", label: "O&M + insurance", min: 0, max: 1000, step: 25, money: 0, unit: " /yr" },
      { path: "fin.resaleValue", kind: "range", label: "Value left in the house", min: 0, max: 40000, step: 500, money: 0 },
    ] },
  ];
}

function effectiveNote(state, ctx, which) {
  const d = ctx.effectiveDiscount || 0;
  if (!d) return "";
  return which === "w"
    ? `Effective after incentives: $${(state.fin.costPerW * (1 - d)).toFixed(2)}/W`
    : `Effective after incentives: $${Math.round(state.fin.costPerKwh * (1 - d))}/kWh`;
}

export function mount(pane) {
  clear(pane);

  pane.appendChild(card({
    id: "cash-card",
    title: "The money over time",
    tag: { id: "cash-mode-tag", text: "cash" },
    sub: "The system's running cash position against the same cash left in the market, plus what the system "
      + "is worth if every year's saving is reinvested at the same return.",
    body: [
      el("div.chart-box", { style: "height:280px" }, [el("canvas", { id: "c-cash" })]),
      el("div.legend", { id: "l-cash" }),
    ],
    dataView: { summary: "Show the year-by-year table", tableId: "t-cash" },
  }));

  pane.appendChild(card({
    id: "outlay-card",
    title: "Your first year, month by month",
    sub: "The question a financed buyer actually asks: is what I pay each month lower than the bill I pay today?",
    body: [
      el("div.chart-box", { style: "height:210px" }, [el("canvas", { id: "c-outlay" })]),
      el("div.legend", { id: "l-outlay" }),
      el("p.note", { id: "outlay-note" }),
    ],
  }));

  pane.appendChild(el("div.row2", {}, [
    card({
      id: "weather-card",
      title: "If the weather disagrees",
      sub: "The same system run against every modelled weather year. P90 is the conservative low-sun case, "
        + "P10 the optimistic one — the solar industry's exceedance convention.",
      body: [
        el("div.chart-box", { style: "height:230px" }, [el("canvas", { id: "c-weather" })]),
        el("div.legend", { id: "l-weather" }),
      ],
      dataView: { summary: "Show the weather table", tableId: "t-weather" },
    }),
    card({
      id: "tornado-card",
      title: "What the answer hangs on",
      sub: "Change one input by ±20% and see what happens to NPV. Everything else stays where you set it.",
      body: [
        el("div.chart-box", { style: "height:230px" }, [el("canvas", { id: "c-tornado" })]),
        el("div.legend", { id: "l-tornado" }),
        el("dl.kv", { id: "breakeven", style: "margin-top:14px" }),
      ],
    }),
  ]));
}

export function render(state, ctx) {
  const cell = ctx.selected;
  if (!cell) return;

  const tag = $("cash-mode-tag");
  if (tag) {
    tag.textContent = { cash: "paid in cash", loan: "on a loan", lease: "leased" }[mode(state)];
  }

  renderCashflow({ cell, fin: state.fin });

  if (ctx.detail && ctx.detail.monthly && ctx.baselineMonthly) {
    const payment = cell.finance ? cell.finance.monthlyPayment || 0 : 0;
    renderMonthlyOutlay({
      monthlyBefore: ctx.baselineMonthly,
      monthlyAfter: ctx.detail.monthly,
      monthlyPayment: payment,
    });
    const before = ctx.baselineMonthly.reduce((a, m) => a + m.bill, 0) / 12;
    const after = ctx.detail.monthly.reduce((a, m) => a + m.bill, 0) / 12 + payment;
    const note = $("outlay-note");
    if (note) {
      note.textContent = after < before
        ? `Average month: ${fmtMoney(before, 0)} today, ${fmtMoney(after, 0)} with the system and its payment — `
          + `${fmtMoney(before - after, 0)} a month lighter from day one.`
        : `Average month: ${fmtMoney(before, 0)} today, ${fmtMoney(after, 0)} with the system and its payment — `
          + `${fmtMoney(after - before, 0)} a month heavier at first. The saving arrives later, as rates rise `
          + "and the payment does not.";
    }
  }

  if (ctx.weatherRows) renderWeatherBars({ rows: ctx.weatherRows, selectedKey: state.ui.weatherKey });
  if (ctx.tornado) renderTornado({ tornado: ctx.tornado });

  renderBreakEven(state, ctx, cell);
}

function renderBreakEven(state, ctx, cell) {
  const node = $("breakeven");
  if (!node) return;
  clear(node);

  const disc = ctx.effectiveDiscount || 0;
  const pair = (v, dp, unit) => {
    if (v === null || v === undefined || v < 0) return "any price loses";
    return `$${v.toFixed(dp)}${unit} sticker` + (disc > 0 ? ` · $${(v * (1 - disc)).toFixed(dp)}${unit} net` : "");
  };
  const rows = [
    ["Break-even solar price", pair(ctx.breakEvenPerW, 2, "/W")],
    ["Break-even storage price", cell.battKWhTotal === 0 ? "— no storage" : pair(ctx.breakEvenPerKwh, 0, "/kWh")],
    ["LCOE of the solar", fmtMoney(cell.lcoe, 3) + "/kWh"],
    ["Lifetime cost, with system", fmtCompact(cell.lifetimeCost)],
    ["Lifetime cost, no system", fmtCompact(cell.finance && cell.finance.lifetimeCostNoSystem)],
  ];
  if (state.fin.financing.mode === "loan" && cell.finance) {
    rows.push(["Total interest paid", fmtCompact(cell.finance.totalInterest)]);
  }
  if (state.fin.financing.mode === "lease" && cell.finance) {
    rows.push(["Total lease payments", fmtCompact(cell.finance.totalLeasePayments)]);
  }
  for (const [k, v] of rows) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { text: v }));
  }
}

export default { id, label, rail, mount, render };
