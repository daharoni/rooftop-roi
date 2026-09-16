/* =============================================================================
 * tabs/home.js — the answer, and nothing that is not the answer.
 *
 * One figure at the top with a verdict beside it, eight tiles of the numbers
 * people actually repeat to each other, a sentence saying what the optimiser
 * chose and why, and a row of chips for the next thing worth trying.
 * ========================================================================== */

import { el, clear, $, T } from "../ui/dom.js";
import { card, tiles, tile } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtYears, plural } from "../ui/format.js";
import { OBJ_LABEL } from "../charts/heatmap.js";

export const id = "home";
export const label = "Home";

export function rail(state, ctx) {
  return [
    { group: "What counts as a win", open: true, items: [
      { path: "ui.objective", kind: "select", label: "Optimise for", opts: [
        { v: "npv", t: "Most NPV vs. investing" }, { v: "lifetime", t: "Lowest lifetime cost" },
        { v: "irr", t: "Highest IRR" }, { v: "payback", t: "Fastest payback" }] },
      { path: "ui.basis", kind: "select", label: "Compare the bill against", opts: [
        { v: "sameFlex", t: "No system, same load schedule" },
        { v: "asRecorded", t: "Today's actual bill" }],
        note: "The first isolates what the hardware does. The second also credits moving flexible load into daylight, which is free." },
      { path: "ui.weatherKey", kind: "select", label: "Weather scenario", opts: ctx.weatherOptions || [{ v: "tmy", t: "TMY (typical year)" }] },
    ] },
    { group: "The system", open: true, items: [
      { path: "system.panelW", kind: "range", label: "Panel wattage", min: 350, max: 560, step: 5, unit: " W" },
      { path: "system.battKWh", kind: "range", label: "Battery size, usable", min: 5, max: 20, step: 0.5, unit: " kWh each" },
      { path: "system.override.batteries", kind: "number", label: "Override: batteries", min: -1, max: 12, step: 1,
        note: "−1 lets the optimiser choose. Clicking a heat-map cell on the System tab fills this in." },
    ] },
    { group: "Price", open: true, items: [
      { path: "fin.costPerW", kind: "range", label: "Solar, installed", min: 0.5, max: 6, step: 0.05, money: 2, unit: " /W" },
      { path: "fin.costPerKwh", kind: "range", label: "Storage, installed", min: 200, max: 2000, step: 25, money: 0, unit: " /kWh" },
      { path: "fin.horizon", kind: "range", label: "Analysis horizon", min: 10, max: 40, step: 1, unit: " yr" },
      { path: "fin.investReturn", kind: "range", label: "Return if invested instead", min: 0, max: 0.15, step: 0.005, pct: 1, unit: " /yr" },
    ] },
  ];
}

export function mount(pane) {
  clear(pane);
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

  pane.appendChild(card({
    id: "next-card",
    title: "What to try next",
    sub: "Each of these is one click and a fresh simulation. None of them costs anything to find out.",
    body: [el("div.chips", { id: "next-chips" })],
  }));

  pane.appendChild(card({
    id: "home-quality",
    title: "What this is built on",
    sub: "The answer above is only as good as these four things.",
    body: [el("dl.kv", { id: "home-quality-kv" })],
  }));
}

export function render(state, ctx) {
  const cell = ctx.selected;
  if (!cell) return renderWaiting(ctx);

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
    + (ctx.flexShiftOnlySavings > 5
      ? ` Re-timing flexible load alone, with no hardware, is worth ${fmtMoney(ctx.flexShiftOnlySavings)}/yr.`
      : "")
    + (ctx.detail && ctx.detail.forfeitedCredit > 1
      ? ` Note: ${fmtMoney(ctx.detail.forfeitedCredit)}/yr of export credit never gets used and is written off at `
        + "true-up — the tariff will not pay for production beyond what this house can absorb."
      : "")));

  renderChips(state, ctx);
  renderQuality(state, ctx);
}

function renderChips(state, ctx) {
  const host = clear($("next-chips"));
  const chips = [];

  if (ctx.bestProvider && ctx.bestProvider.id !== state.tariff.providerId) {
    chips.push({
      text: `Switch generation to ${ctx.bestProvider.name} — saves ${fmtMoney(ctx.bestProviderGain)}/yr`,
      run: () => ctx.actions.setProvider(ctx.bestProvider.id),
    });
  }
  if (ctx.bestPlan && ctx.bestPlan.planId !== state.tariff.planId) {
    chips.push({
      text: `Try rate plan ${ctx.bestPlan.name}`,
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
  }
  chips.push({ text: "Check it against a paper bill", run: () => ctx.actions.goTab("bills") });

  for (const c of chips) {
    host.appendChild(el("button.chip-action", { type: "button", text: c.text, on: { click: c.run } }));
  }
}

function renderQuality(state, ctx) {
  const node = clear($("home-quality-kv"));
  const meta = (ctx.loadSet && ctx.loadSet.meta) || {};
  const pairs = [
    ["Your meter", meta.nHours ? `${fmtNum(meta.nHours, 0)} hours, ${meta.start || "?"} → ${meta.end || "?"}` : "not loaded"],
    ["Consumption", meta.totalKwh ? `${fmtNum(meta.totalKwh / Math.max(1, (meta.nHours || 8760) / 8760), 0)} kWh/yr` : "—"],
    ["Roof", state.roof.planes.length
      ? state.roof.planes.map((p) => `${p.name} ${p.tilt}°/${p.azimuth}°, ≤${p.maxPanels} panels`).join(" · ")
      : "no faces defined yet"],
    ["Sunlight", ctx.solarNote || "not computed yet"],
    ["Rates", ctx.tariffNote || "—"],
  ];
  for (const [k, v] of pairs) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { text: v }));
  }
}

function renderWaiting(ctx) {
  const note = $("hero-note");
  if (note) note.textContent = ctx.statusText || "Waiting for a roof and a weather profile before the first simulation.";
}

export default { id, label, rail, mount, render };
