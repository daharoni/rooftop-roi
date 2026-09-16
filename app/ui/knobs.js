/* =============================================================================
 * knobs.js — every control on the page, declared once.
 *
 * A tab's rail is a list of the groups below.  The dashboard shows all of
 * them, so a person can move any input and watch every result move; the
 * secondary tabs pick the few that matter to what they show.  Declaring the
 * groups here rather than inside each tab keeps one slider from drifting into
 * two different ranges on two different pages.
 *
 * `reason` is inferred from the path (see controls.js): "fin." re-prices in
 * ~15 ms, "ui." redraws, anything else re-simulates.
 * ========================================================================== */

const mode = (s) => s.fin.financing.mode;

export const OBJECTIVE_OPTS = [
  { v: "npv", t: "Most NPV vs. investing" }, { v: "lifetime", t: "Lowest lifetime cost" },
  { v: "irr", t: "Highest IRR" }, { v: "payback", t: "Fastest payback" },
];

export const BASIS_OPTS = [
  { v: "sameFlex", t: "No system, same load schedule" },
  { v: "asRecorded", t: "Today's actual bill" },
];

/**
 * The controls that appear on more than one rail, declared once so a slider
 * cannot drift into two different ranges on two different pages.  A call site
 * that needs its own wording spreads the declaration and adds a note.
 */
export const item = {
  weatherKey: (ctx) => ({
    path: "ui.weatherKey", kind: "select", label: "Weather scenario", reason: "sim",
    opts: ctx.weatherOptions || [{ v: "tmy", t: "TMY (typical year)" }],
  }),
  basis: () => ({
    path: "ui.basis", kind: "select", label: "Compare the bill against", opts: BASIS_OPTS, reason: "finance",
  }),
  panelW: () => ({ path: "system.panelW", kind: "range", label: "Panel wattage", min: 350, max: 560, step: 5, unit: " W" }),
  maxPanels: () => ({ path: "system.maxPanels", kind: "range", label: "Most panels to consider", min: 4, max: 80, step: 1 }),
  baseLoadScale: () => ({
    path: "baseLoadScale", kind: "range", label: "Everything else, vs. today", min: 0.5, max: 2, step: 0.05, pct: 0,
  }),
};

export function goal(ctx, open = true) {
  return { group: "What counts as a win", open, items: [
    // Objective and basis change how the cached grid is priced; weather changes the simulation.
    { path: "ui.objective", kind: "select", label: "Optimise for", opts: OBJECTIVE_OPTS, reason: "finance",
      footnote: (s) => (ctx.objective && ctx.objective !== s.ui.objective
        ? (s.ui.objective === "irr"
          ? "No system here has an IRR: nothing is paid up front and savings beat the payments from day one. Optimising for NPV instead."
          : "Every system here pays back on day one, so payback cannot rank them. Optimising for NPV instead.")
        : "") },
    { ...item.basis(),
      note: "The first isolates what the hardware does. The second also credits moving flexible load into daylight, which is free." },
    item.weatherKey(ctx),
  ] };
}

export function price(ctx, open = true) {
  const effective = (s, which) => {
    const d = ctx.effectiveDiscount || 0;
    if (!d) return "";
    return which === "w"
      ? `Effective after incentives: $${(s.fin.costPerW * (1 - d)).toFixed(2)}/W`
      : `Effective after incentives: $${Math.round(s.fin.costPerKwh * (1 - d))}/kWh`;
  };
  return { group: "Price", open, items: [
    { path: "fin.costPerW", kind: "range", label: "Solar, installed", min: 0.5, max: 6, step: 0.05, money: 2, unit: " /W",
      footnote: (s) => effective(s, "w") },
    { path: "fin.costPerKwh", kind: "range", label: "Storage, installed", min: 200, max: 2000, step: 25, money: 0, unit: " /kWh",
      footnote: (s) => effective(s, "kwh") },
    { path: "fin.adder", kind: "range", label: "Fixed install adder", min: 0, max: 20000, step: 250, money: 0,
      note: "Panel upgrade, trenching, re-roof — anything quoted as a lump sum." },
  ] };
}

export function financing(open = true) {
  return { group: "How it is paid for", open, items: [
    { path: "fin.financing.mode", kind: "seg", label: "Financing", opts: [
      { v: "cash", t: "Cash" }, { v: "loan", t: "Loan" }, { v: "lease", t: "Lease / PPA" }] },
    { path: "fin.financing.loan.sharePct", kind: "range", label: "Share financed", min: 0, max: 1, step: 0.05, pct: 0,
      show: (s) => mode(s) === "loan" },
    { path: "fin.financing.loan.apr", kind: "range", label: "APR", min: 0, max: 0.15, step: 0.0025, pct: 2, unit: " /yr",
      show: (s) => mode(s) === "loan" },
    { path: "fin.financing.loan.termYears", kind: "range", label: "Term", min: 1, max: 25, step: 1, unit: " yr",
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
  ] };
}

export function incentives(open = false) {
  return { group: "Incentives", open, items: [
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
  ] };
}

export function hardware(open = false) {
  return { group: "Hardware", open, items: [
    item.panelW(),
    { path: "system.battKWh", kind: "range", label: "Battery size, usable", min: 5, max: 20, step: 0.5, unit: " kWh each" },
    { path: "system.battKW", kind: "range", label: "Battery power", min: 2.5, max: 11.5, step: 0.5, unit: " kW each" },
    { path: "system.minReserve", kind: "range", label: "Reserved for backup", min: 0, max: 0.5, step: 0.05, pct: 0 },
    { path: "system.rte", kind: "range", label: "Round-trip efficiency", min: 0.8, max: 0.98, step: 0.01, pct: 0 },
  ] };
}

export function dispatch(open = false) {
  return { group: "Battery dispatch", open, items: [
    { path: "system.strategy", kind: "select", label: "Battery strategy", opts: [
      { v: "self_consumption", t: "Self-consumption" },
      { v: "tou_arbitrage", t: "Time-of-use arbitrage" },
      { v: "export_arbitrage", t: "Export arbitrage" },
      { v: "backup_only", t: "Backup only (never cycles)" }] },
    { path: "system.gridCharge", kind: "check", label: "Charge from the grid when the sun will not fill the pack",
      show: (s) => s.system.strategy === "tou_arbitrage" || s.system.strategy === "export_arbitrage",
      warn: (s) => (s.system.gridCharge
        ? "Not permitted under California's Net Billing paired-storage agreement; shown for comparison only. "
          + "Battery export is disabled while this is on, because grid energy cannot earn an export credit."
        : null) },
    { path: "system.exportThreshold", kind: "range", label: "Sell to the grid above", min: 0, max: 2, step: 0.05, money: 2, unit: " /kWh",
      show: (s) => s.system.strategy === "export_arbitrage" },
    { path: "system.ngom", kind: "check", label: "Net Generation Output Meter (removes the export cap)",
      note: "Without one, paired storage under 10 kW has its monthly export credit capped at the utility's "
        + "estimate of PV production, and the excess is forfeited from the most expensive hours first. "
        + "Worth it if the battery is meant to sell into the evening." },
  ] };
}

export function search(open = false) {
  return { group: "Search space", open, items: [
    { ...item.maxPanels(),
      footnote: (s) => {
        const cap = s.roof.planes.reduce((a, p) => a + p.maxPanels, 0);
        return cap ? `Your roof faces hold ${cap} panels in total.` : "";
      } },
    { path: "system.maxBatteries", kind: "range", label: "Most batteries to consider", min: 0, max: 8, step: 1 },
    { path: "system.override.batteries", kind: "number", label: "Override: batteries", min: -1, max: 12, step: 1,
      // Only picks a different cell out of the grid already simulated, exactly
      // as clicking one does, so it re-prices instead of queueing a new sweep.
      reason: "finance",
      note: "−1 lets the optimiser choose. Clicking a cell in the grid fills this in." },
  ] };
}

export function household(open = false) {
  return { group: "Household", open, items: [
    { ...item.baseLoadScale(),
      note: "Scales the household load left after the flexible loads are taken out — a bigger family, "
        + "a heat pump swap, a lighter year." },
    { path: "ui.goLoads", kind: "button", label: "Add or reschedule flexible loads →" },
  ] };
}

export function rate(ctx, open = false) {
  return { group: "Your rate", open, items: [
    { path: "tariff.planId", kind: "select", label: "Rate plan",
      opts: ctx.planOptions && ctx.planOptions.length ? ctx.planOptions : [{ v: "", t: "Loading the tariff library…" }] },
    { path: "tariff.providerId", kind: "select", label: "Generation provider",
      opts: ctx.providerOptions && ctx.providerOptions.length ? ctx.providerOptions : [{ v: "", t: "—" }],
      note: "In much of California a community choice aggregator supplies the generation half of the bill "
        + "while the utility still delivers it. Switching is free and changes the answer." },
    { path: "site.utilityId", kind: "select", label: "Utility",
      opts: ctx.utilityOptions && ctx.utilityOptions.length ? ctx.utilityOptions : [{ v: "sce", t: "Southern California Edison" }] },
  ] };
}

export function future(ctx, open = false) {
  return { group: "The next 25 years", open, items: [
    { path: "fin.horizon", kind: "range", label: "Analysis horizon", min: 10, max: 40, step: 1, unit: " yr" },
    { path: "fin.investReturn", kind: "range", label: "Return if invested instead", min: 0, max: 0.15, step: 0.005, pct: 1, unit: " /yr" },
    { path: "fin.escalation", kind: "range", label: "Utility rate escalation", min: 0, max: 0.1, step: 0.005, pct: 1, unit: " /yr",
      note: ctx.escalationNote || "5%/yr is the usual planning figure; 3% low and 8% high are the defensible bands." },
    { path: "fin.exportEscalation", kind: "range", label: "Export credit escalation", min: 0, max: 0.05, step: 0.0025, pct: 2, unit: " /yr",
      note: "Export prices are locked to a fixed avoided-cost vintage for nine years and are not tied to "
        + "retail rates. Leave at 0 unless you think the post-lock-in vintage will be richer." },
    { path: "fin.discountRate", kind: "range", label: "Inflation / discount rate", min: 0, max: 0.08, step: 0.005, pct: 1, unit: " /yr" },
  ] };
}

export function wear(open = false) {
  return { group: "Wear and tear", open, items: [
    { path: "fin.panelDeg", kind: "range", label: "Panel degradation", min: 0, max: 0.015, step: 0.001, pct: 2, unit: " /yr" },
    { path: "fin.battDeg", kind: "range", label: "Battery degradation", min: 0, max: 0.05, step: 0.002, pct: 1, unit: " /yr" },
    { path: "fin.battReplYear", kind: "range", label: "Replace the battery in year", min: 10, max: 30, step: 1 },
    { path: "fin.battReplFraction", kind: "range", label: "Replacement costs", min: 0, max: 1, step: 0.05, pct: 0, unit: " of today's price" },
    { path: "fin.inverterYear", kind: "range", label: "Replace the inverter in year", min: 5, max: 30, step: 1 },
    { path: "fin.inverterPerW", kind: "range", label: "Inverter replacement", min: 0, max: 0.5, step: 0.01, money: 2, unit: " /W" },
    { path: "fin.omPerYear", kind: "range", label: "O&M + insurance", min: 0, max: 1000, step: 25, money: 0, unit: " /yr" },
    { path: "fin.resaleValue", kind: "range", label: "Value left in the house", min: 0, max: 40000, step: 500, money: 0 },
  ] };
}

export function replay(open = true) {
  return { group: "Check it against a paper bill", open, items: [
    { path: "ui.replayStart", kind: "date", label: "Billing period starts" },
    { path: "ui.replayEnd", kind: "date", label: "Billing period ends" },
    { path: "ui.replayActual", kind: "number", label: "Total new charges, $", min: 0, step: 0.01 },
    { path: "ui.runReplay", kind: "button", label: "Replay this period" },
  ] };
}

export default {
  goal, price, financing, incentives, hardware, dispatch, search, household, rate, future, wear, replay,
  item, OBJECTIVE_OPTS, BASIS_OPTS,
};
