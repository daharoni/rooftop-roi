/* =============================================================================
 * tabs/bills.js — the bill, before and after, and a way to check the model.
 *
 * The bill-replay panel is the tab's centre of gravity: a model that cannot
 * reproduce a bill you are holding has no business telling you what a battery
 * is worth.  Type in a billing period and its total, and the model replays
 * that period out of your own meter data and prints the gap.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtMoney, fmtNum, fmtPct } from "../ui/format.js";
import { renderMonthlyBills, renderComparisonTable } from "../charts/bills.js";

export const id = "bills";
export const label = "Bills";

export function rail(state, ctx) {
  const custom = state.tariff.planId === "custom";
  return [
    { group: "Your rate", open: true, items: [
      { path: "tariff.planId", kind: "select", label: "Rate plan",
        opts: ctx.planOptions || [{ v: "", t: "Loading the tariff library…" }] },
      { path: "tariff.providerId", kind: "select", label: "Generation provider",
        opts: ctx.providerOptions || [{ v: "", t: "—" }],
        note: "In much of California a community choice aggregator supplies the generation half of the bill "
          + "while the utility still delivers it. Switching is free and changes the answer." },
      { path: "site.utilityId", kind: "select", label: "Utility",
        opts: ctx.utilityOptions || [{ v: "sce", t: "Southern California Edison" }] },
    ] },
    { group: "Build a rate from your bill", open: false, items: [
      { path: "ui.customEnabled", kind: "check", label: "Use rates I type in instead" },
      { path: "tariff.custom.fixedPerDay", kind: "number", label: "Base charge, $/day", min: 0, step: 0.01, show: () => custom },
      { path: "tariff.custom.onPeak", kind: "number", label: "On-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
      { path: "tariff.custom.midPeak", kind: "number", label: "Mid-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
      { path: "tariff.custom.offPeak", kind: "number", label: "Off-peak, $/kWh", min: 0, step: 0.001, show: () => custom },
    ] },
    { group: "Check it against a paper bill", open: true, items: [
      { path: "ui.replayStart", kind: "date", label: "Billing period starts" },
      { path: "ui.replayEnd", kind: "date", label: "Billing period ends" },
      { path: "ui.replayActual", kind: "number", label: "Total new charges, $", min: 0, step: 0.01 },
      { path: "ui.runReplay", kind: "button", label: "Replay this period" },
    ] },
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
      el("div.chart-box", { style: "height:270px" }, [el("canvas", { id: "c-month" })]),
      el("div.legend", { id: "l-month" }),
    ],
    dataView: { summary: "Show the monthly bill table", tableId: "t-month" },
  }));

  pane.appendChild(el("div.row2", {}, [
    card({
      id: "plans-card",
      title: "Same system, every rate plan",
      sub: "Your meter, your system, every plan you are eligible for.",
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

  pane.appendChild(card({
    id: "replay-card",
    title: "Does the model match your paper bill?",
    sub: "Enter a billing period from a real bill in the left rail and the model replays it out of your own "
      + "meter readings. The kWh split should match almost exactly; the dollar gap is whatever the published "
      + "rates leave out — taxes, franchise fees, a rate vintage.",
    body: [
      el("div.table-scroll", {}, [el("table", { id: "t-validate" })]),
      el("p.note", { id: "validate-note", style: "margin-top:8px",
        text: "No period replayed yet." }),
    ],
  }));

  pane.appendChild(card({
    id: "credit-card",
    title: "California Climate Credit",
    sub: "A flat credit applied twice a year, in both the with-system and the no-system bill, so it cancels "
      + "out of your savings but still shows up in the chart above.",
    body: [el("p.note", { id: "climate-note", text: "—" })],
  }));
}

export function render(state, ctx) {
  const detail = ctx.detail;

  if (detail && detail.monthly && ctx.baselineMonthly) {
    renderMonthlyBills({
      before: ctx.baselineMonthly,
      after: detail.monthly,
      planLabel: ctx.planLabel,
    });
  }

  if (detail && detail.plans) {
    const best = renderComparisonTable("t-plans", detail.plans.map((p) => ({
      id: p.planId, name: p.name || p.planId,
      bill: p.bill, baselineBill: state.ui.basis === "asRecorded" ? p.baselineAsRecorded : p.baselineSameFlex,
    })), {
      selectedId: state.tariff.planId,
      bestBy: (r) => (r.baselineBill || 0) - (r.bill || 0),
      labelHead: "Rate plan",
    });
    ctx.bestPlan = best;
  }

  if (detail && detail.providers) {
    const rows = detail.providers.map((p) => ({
      id: p.id, name: p.name || p.id,
      bill: p.bill, baselineBill: state.ui.basis === "asRecorded" ? p.baselineAsRecorded : p.baselineSameFlex,
    }));
    const best = renderComparisonTable("t-providers", rows, {
      selectedId: state.tariff.providerId,
      bestBy: (r) => -(r.bill || 0),
      labelHead: "Generation",
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

  renderReplay(ctx);

  const climate = $("climate-note");
  if (climate) {
    climate.textContent = ctx.climateCredit
      ? `${fmtMoney(ctx.climateCredit.amount)} per credited bill, in ${(ctx.climateCredit.months || [])
          .map((m) => ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1])
          .join(" and ")}. It is in both bills above.`
      : "Not modelled for this utility.";
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
