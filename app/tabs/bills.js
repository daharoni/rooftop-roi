/* =============================================================================
 * tabs/bills.js — the bill, before and after, and everything that depends on
 * how it is paid for.
 *
 * The dashboard shows the verdict; this tab shows its receipts.  The bill
 * month by month, the same system on every plan and every generation
 * provider, the first year's monthly outlay under a loan or lease, what the
 * weather does to it, what the answer hangs on, and a way to check the tariff
 * model against a paper bill.  A model that cannot reproduce a bill you are
 * holding has no business telling you what a battery is worth.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct } from "../ui/format.js";
import { renderMonthlyBills, renderComparisonTable } from "../charts/bills.js";
import { renderMonthlyOutlay, renderWeatherBars, renderTornado } from "../charts/money.js";
import * as K from "../ui/knobs.js";

export const id = "bills";
export const label = "Bills & money";

export function rail(state, ctx) {
  const custom = state.tariff.planId === "custom";
  return [
    K.rate(ctx, true),
    K.financing(true),
    K.replay(true),
    { group: "Build a rate from your bill", open: false, items: [
      { path: "ui.customEnabled", kind: "check", label: "Use rates I type in instead" },
      { path: "tariff.custom.fixedPerDay", kind: "number", label: "Base charge, $/day", min: 0, step: 0.01, show: () => custom },
      { path: "tariff.custom.onPeak", kind: "number", label: "On-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
      { path: "tariff.custom.midPeak", kind: "number", label: "Mid-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
      { path: "tariff.custom.offPeak", kind: "number", label: "Off-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
    ] },
    K.price(ctx, false),
    K.incentives(false),
  ];
}

export function mount(pane) {
  clear(pane);

  pane.appendChild(card({
    id: "bill-card",
    title: "Where the bill goes",
    tag: { id: "bill-plan", text: "—" },
    sub: "Each month, the bill you would pay today next to the bill with the selected system, broken into "
      + "what the tariff actually charges for.",
    body: [
      el("div.chart-box", { style: "height:260px" }, [el("canvas", { id: "c-month" })]),
      el("div.legend", { id: "l-month" }),
    ],
    dataView: { summary: "Show the monthly bill table", tableId: "t-month" },
  }));

  pane.appendChild(el("div.row2", {}, [
    card({
      id: "outlay-card",
      title: "Your first year, month by month",
      sub: "The question a financed buyer actually asks: is what I pay each month lower than the bill I pay today?",
      body: [
        el("div.chart-box", { style: "height:210px" }, [el("canvas", { id: "c-outlay" })]),
        el("div.legend", { id: "l-outlay" }),
        el("p.note", { id: "outlay-note" }),
      ],
    }),
    card({
      id: "weather-card",
      title: "If the weather disagrees",
      sub: "The same system run against every modelled weather year. P90 is the conservative low-sun case, "
        + "P10 the optimistic one — the solar industry's exceedance convention.",
      body: [
        el("div.chart-box", { style: "height:210px" }, [el("canvas", { id: "c-weather" })]),
        el("div.legend", { id: "l-weather" }),
      ],
      dataView: { summary: "Show the weather table", tableId: "t-weather" },
    }),
  ]));

  pane.appendChild(el("div.row2", {}, [
    card({
      id: "plans-card",
      title: "Same system, every rate plan",
      sub: "Your meter, your system, every plan you are eligible for. The cheapest with-system bill is highlighted.",
      body: [el("div.table-scroll", {}, [el("table", { id: "t-plans" })])],
    }),
    card({
      id: "providers-card",
      title: "Same system, every generation provider",
      sub: "The generation half of the bill, priced by each supplier serving your address.",
      body: [
        el("div.table-scroll", {}, [el("table", { id: "t-providers" })]),
        el("p.note", { id: "provider-note", style: "margin-top:8px" }),
      ],
    }),
  ]));

  pane.appendChild(el("div.row2", {}, [
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
    card({
      id: "replay-card",
      title: "Does the model match your paper bill?",
      sub: "Enter a billing period from a real bill in the left rail and the model replays it out of your own "
        + "meter readings. The kWh split should match almost exactly; the dollar gap is whatever the published "
        + "rates leave out — taxes, franchise fees, a rate vintage.",
      body: [
        el("div.table-scroll", {}, [el("table", { id: "t-validate" })]),
        el("p.note", { id: "validate-note", style: "margin-top:8px", text: "No period replayed yet." }),
        el("p.note", { id: "climate-note", style: "margin-top:8px", text: "" }),
      ],
    }),
  ]));
}

export function render(state, ctx) {
  const detail = ctx.detail;
  const cell = ctx.selected;

  if (detail && detail.monthly && ctx.baselineMonthly) {
    renderMonthlyBills({ before: ctx.baselineMonthly, after: detail.monthly, planLabel: ctx.planLabel });

    const payment = cell && cell.finance ? cell.finance.monthlyPayment || 0 : 0;
    renderMonthlyOutlay({ monthlyBefore: ctx.baselineMonthly, monthlyAfter: detail.monthly, monthlyPayment: payment });
    const before = ctx.baselineMonthly.reduce((a, m) => a + m.bill, 0) / 12;
    const after = detail.monthly.reduce((a, m) => a + m.bill, 0) / 12 + payment;
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

  const baselineKey = state.ui.basis === "asRecorded" ? "baselineAsRecorded" : "baselineSameFlex";
  if (detail && detail.plans) {
    renderComparisonTable("t-plans", detail.plans.map((p) => ({
      id: p.planId, name: p.name || p.planId, bill: p.bill, baselineBill: p[baselineKey],
    })), { selectedId: state.tariff.planId, bestBy: (r) => -(r.bill || 0), labelHead: "Rate plan" });
  }

  if (detail && detail.providers) {
    const rows = detail.providers.map((p) => ({
      id: p.id, name: p.name || p.id, bill: p.bill, baselineBill: p[baselineKey],
    }));
    const best = renderComparisonTable("t-providers", rows, {
      selectedId: state.tariff.providerId, bestBy: (r) => -(r.bill || 0), labelHead: "Generation",
    });
    const mine = rows.find((r) => r.id === state.tariff.providerId);
    const note = $("provider-note");
    if (note) {
      note.textContent = mine && best && best.id !== mine.id
        ? `Switching generation from ${mine.name} to ${best.name} would cut the with-system bill by `
          + `${fmtMoney(mine.bill - best.bill)}/yr on its own — no hardware involved.`
        : "You are already on the cheapest generation option modelled here.";
    }
  }

  if (ctx.weatherRows) renderWeatherBars({ rows: ctx.weatherRows, selectedKey: state.ui.weatherKey });
  if (ctx.tornado) renderTornado({ tornado: ctx.tornado });
  if (cell) renderBreakEven(state, ctx, cell);

  renderReplay(ctx);

  const climate = $("climate-note");
  if (climate) {
    climate.textContent = ctx.climateCredit
      ? `California Climate Credit: ${fmtMoney(ctx.climateCredit.amount)} per credited bill, in ${(ctx.climateCredit.months || [])
          .map((m) => ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1])
          .join(" and ")}. It is in both bills above, so it cancels out of the savings.`
      : "";
  }
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
  if (state.fin.financing.mode === "loan" && cell.finance) rows.push(["Total interest paid", fmtCompact(cell.finance.totalInterest)]);
  if (state.fin.financing.mode === "lease" && cell.finance) rows.push(["Total lease payments", fmtCompact(cell.finance.totalLeasePayments)]);
  for (const [k, v] of rows) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { text: v }));
  }
}

function renderReplay(ctx) {
  const table = $("t-validate");
  const note = $("validate-note");
  if (!table) return;
  clear(table);

  const v = ctx.replay;
  if (!v) {
    table.appendChild(el("tbody", {}, [el("tr", {}, [
      el("td", { text: "Enter a billing period in the left rail and press Replay this period." }),
    ])]));
    return;
  }

  const actual = v.actual || {};
  const row = (name, model, act, fmt) => {
    const diff = act === null || act === undefined ? null : model - act;
    return el("tr", {}, [
      el("td", { text: name }),
      el("td.n", { text: fmt(model) }),
      el("td.n", { text: act === null || act === undefined ? "—" : fmt(act) }),
      el("td.n", { text: diff === null ? "—" : act ? ((diff / act) * 100).toFixed(1) + "%" : fmt(diff) }),
    ]);
  };
  const kwh = (x) => fmtNum(x, 0) + " kWh";
  const byPeriod = v.byPeriod || {};

  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: `${v.start} → ${v.end} (${v.days} days)` }),
    el("th.n", { text: "Model" }), el("th.n", { text: "Your bill" }), el("th.n", { text: "Diff" }),
  ])]));
  table.appendChild(el("tbody", {}, [
    byPeriod.on ? row("On-peak", byPeriod.on.kwh, actual.onKwh, kwh) : null,
    byPeriod.mid ? row("Mid-peak", byPeriod.mid.kwh, actual.midKwh, kwh) : null,
    byPeriod.off ? row("Off-peak", (byPeriod.off.kwh || 0) + (byPeriod.super_off ? byPeriod.super_off.kwh : 0), actual.offKwh, kwh) : null,
    row("Total energy", v.totalKwh, actual.totalKwh, kwh),
    row("Total charges", v.total, actual.total, (x) => fmtMoney(x, 2)),
  ].filter(Boolean)));

  if (note) {
    const on = `Replayed on ${ctx.planLabel || v.planId}. `;
    const gap = actual.total ? Math.abs(v.total - actual.total) / actual.total : null;
    const dollars = actual.total ? Math.abs(v.total - actual.total) : 0;
    note.textContent = gap === null
      ? on + "Enter the total from the bill to see the gap. The kWh split alone is worth checking: it is the "
        + "model reading your own meter through this tariff's hour definitions, so it should match to a few kWh."
      : gap < 0.01
        ? on + `Within ${fmtMoney(dollars, 2)} of your bill — the rate file is right for this address, and the `
          + "residual is kWh rounding."
        : gap < 0.03
          ? on + `${fmtMoney(dollars, 2)} apart (${fmtPct(gap, 1)}). Close enough that the difference is the taxes `
            + "and franchise fees the published rates leave out."
          : on + `${fmtPct(gap, 1)} off your bill. First check that the plan and generation provider above are the `
            + "ones on the bill — switching either moves the total by hundreds. If they match, the rate file is "
            + "stale or wrong for your address; the Assumptions tab has its effective date.";
  }
}

export default { id, label, rail, mount, render };
