/* =============================================================================
 * charts/money.js — cash flow against the market, the first-year monthly
 * outlay, the weather spread and the tornado.
 *
 * Both arms of the cash-flow chart are stated the same way — value relative
 * to having spent the money — so the crossing point is the honest answer to
 * "when does the roof overtake the index fund?".  Drawing the system's
 * cumulative cash on one axis and a portfolio balance on another would make
 * that crossing meaningless, so there is one scale.
 * ========================================================================== */

import { $, el, clear, T, alpha } from "../ui/dom.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from "../ui/format.js";
import { draw, baseOpts, lineChart, legendHTML } from "./base.js";

export function renderCashflow({ cell, fin }) {
  const f = cell && cell.finance;
  if (!f || !f.cumulative) return;
  const H = f.horizon || fin.horizon;
  const years = Array.from({ length: H + 1 }, (_, y) => y);

  // Every line is a change in wealth against the same starting point: holding
  // the pool of starting cash (`cashRef`, the same for every system in the sweep -
  // the dearest one's price) and doing nothing with it.
  //   market      leave it all invested
  //   system      spend `upfront` of it, keep the rest invested, and reinvest each
  //               year's net cash flow (savings less O&M, replacements, payments)
  //               from the day it arrives (mid-year, per `flowTimes`)
  //   cash in hand the running total of the system's own cash flows, undiscounted
  // Under a loan `upfront` is only the down payment, so the system line keeps
  // the market's growth on the principal that was never spent; a loan cheaper
  // than the market return therefore sits above cash, and a dearer one below.
  const r = 1 + fin.investReturn;
  const cashRef = f.cashRef !== undefined ? f.cashRef : f.netCost;
  const upfront = f.upfront !== undefined ? f.upfront : f.netCost;
  const at = (i) => (f.flowTimes ? f.flowTimes[i] : i);
  const system = years.map((y) => f.cumulative[y]);
  const market = years.map((y) => cashRef * (r ** y - 1));
  const reinvested = years.map((y) => {
    let w = (cashRef - upfront) * r ** y;
    for (let i = 1; i <= y; i++) w += (f.cashflows[i] || 0) * r ** (y - at(i));
    return w - cashRef;
  });

  lineChart("c-cash", years, [
    { label: "System, cash in hand", data: system, color: T.s1, fill: true },
    { label: "System, savings reinvested", data: reinvested, color: T.s3 },
    { label: "Starting cash left in the market", data: market, color: T.s2 },
  ], { yFmt: fmtCompact, xTitle: "years from install" });

  legendHTML("l-cash", [
    { label: "System, cash in hand", color: T.s1, line: true },
    { label: `System, savings reinvested at ${fmtPct(fin.investReturn, 1)}`, color: T.s3, line: true },
    { label: `${fmtCompact(cashRef)} starting cash left in the market`, color: T.s2, line: true },
  ]);

  const table = $("t-cash");
  if (!table) return;
  clear(table);
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: "Year" }), el("th.n", { text: "Savings" }), el("th.n", { text: "Payments" }),
    el("th.n", { text: "O&M" }), el("th.n", { text: "Replacements" }),
    el("th.n", { text: "Net" }), el("th.n", { text: "Cumulative" }),
  ])]));
  table.appendChild(el("tbody", {}, years.map((y) => el("tr", {}, [
    el("td.n", { text: String(y) }),
    el("td.n", { text: y ? fmtMoney(f.savingsByYear && f.savingsByYear[y]) : "—" }),
    el("td.n", { text: f.paymentsByYear && f.paymentsByYear[y] ? fmtMoney(-f.paymentsByYear[y]) : "—" }),
    el("td.n", { text: y ? fmtMoney(-(f.omByYear ? f.omByYear[y] : 0)) : "—" }),
    el("td.n", { text: y && f.extrasByYear && f.extrasByYear[y] ? fmtMoney(-f.extrasByYear[y]) : "—" }),
    el("td.n", { text: fmtMoney(f.cashflows[y]) }),
    el("td.n", { text: fmtMoney(f.cumulative[y]) }),
  ]))));
}

/**
 * The question a financed buyer actually asks: is my monthly outlay lower
 * than the bill I pay today?  Two bars a month — today's bill, and the new
 * bill plus whatever the loan or lease costs that month.
 */
export function renderMonthlyOutlay({ monthlyBefore, monthlyAfter, monthlyPayment }) {
  if (!monthlyBefore || !monthlyAfter) return;
  const labels = monthlyBefore.map((m) => m.label || m.key || "");
  const payment = Array.from({ length: labels.length }, () => monthlyPayment || 0);

  draw("c-outlay", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Bill today", stack: "before", data: monthlyBefore.map((m) => m.bill),
          backgroundColor: alpha(T["ink-3"], 0.55), borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: false, borderColor: T.surface, borderWidth: { left: 1, right: 1 },
        },
        {
          label: "Bill with the system", stack: "after", data: monthlyAfter.map((m) => m.bill),
          backgroundColor: T.s1, borderSkipped: false,
          borderColor: T.surface, borderWidth: { top: 2, left: 1, right: 1 },
        },
        {
          label: "Loan or lease payment", stack: "after", data: payment,
          backgroundColor: T.s2, borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: false, borderColor: T.surface, borderWidth: { top: 2, left: 1, right: 1 },
        },
      ],
    },
    options: baseOpts({
      scales: {
        x: { stacked: true, ticks: { font: { size: 9 } } },
        y: { stacked: true, ticks: { callback: fmtCompact } },
      },
      plugins: {
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtMoney(c.parsed.y, 2) } },
      },
    }),
  });

  legendHTML("l-outlay", [
    { label: "Bill today", color: alpha(T["ink-3"], 0.55) },
    { label: "Bill with the system", color: T.s1 },
    { label: "Loan or lease payment", color: T.s2 },
  ]);
}

export function renderWeatherBars({ rows, selectedKey }) {
  if (!rows || !rows.length) return;
  draw("c-weather", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        label: "NPV", data: rows.map((r) => r.npv),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 22,
        backgroundColor: rows.map((r) => (r.key === selectedKey ? T.s1 : alpha(T.s1, 0.3))),
      }],
    },
    options: baseOpts({
      scales: { y: { ticks: { callback: fmtCompact } }, x: { ticks: { font: { size: 9 } } } },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex];
              return [` NPV ${fmtMoney(r.npv)}`, ` savings ${fmtMoney(r.savings)}/yr`,
                ` ${Math.round(r.perKw || 0)} kWh/kW-yr`];
            },
          },
        },
      },
    }),
  });
  legendHTML("l-weather", [
    { label: "selected scenario", color: T.s1 },
    { label: "other modelled years", color: alpha(T.s1, 0.3) },
  ]);

  const table = $("t-weather");
  if (!table) return;
  clear(table);
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: "Scenario" }), el("th.n", { text: "kWh/kW-yr" }), el("th.n", { text: "Production" }),
    el("th.n", { text: "Savings/yr" }), el("th.n", { text: "NPV" }),
  ])]));
  table.appendChild(el("tbody", {}, rows.map((r) => el("tr" + (r.key === selectedKey ? ".is-best" : ""), {}, [
    el("td", { text: r.label }),
    el("td.n", { text: fmtNum(r.perKw || 0, 0) }),
    el("td.n", { text: fmtNum(r.pv || 0, 0) + " kWh" }),
    el("td.n", { text: fmtMoney(r.savings) }),
    el("td.n", { text: fmtMoney(r.npv) }),
  ]))));
}

export function renderTornado({ tornado }) {
  if (!tornado || !tornado.rows || !tornado.rows.length) return;
  draw("c-tornado", {
    type: "bar",
    data: {
      labels: tornado.rows.map((r) => r.label),
      datasets: [
        { label: "−20%", data: tornado.rows.map((r) => r.low), backgroundColor: T.s8, borderRadius: 3, borderSkipped: false, barThickness: 16 },
        { label: "+20%", data: tornado.rows.map((r) => r.high), backgroundColor: T.s1, borderRadius: 3, borderSkipped: false, barThickness: 16 },
      ],
    },
    options: baseOpts({
      indexAxis: "y",
      scales: {
        x: {
          grid: { color: T.grid, drawTicks: false }, border: { display: false },
          ticks: { color: T["ink-3"], font: { size: 10 }, callback: fmtCompact },
          title: { display: true, text: "change in NPV", color: T["ink-3"], font: { size: 10 } },
        },
        y: { grid: { display: false }, border: { color: T.rule }, ticks: { color: T["ink-2"], font: { size: 11 } } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtMoney(c.parsed.x) } } },
    }),
  });
  legendHTML("l-tornado", [
    { label: "input 20% lower", color: T.s8 },
    { label: "input 20% higher", color: T.s1 },
  ]);
}

export default { renderCashflow, renderMonthlyOutlay, renderWeatherBars, renderTornado };
