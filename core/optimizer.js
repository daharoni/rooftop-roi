/* =============================================================================
 * core/optimizer.js - picks the configuration, and answers "how sure are we?"
 *
 * Split in two on purpose:
 *   searchGrid()  runs the expensive hourly physics (worker side, ~0.2 s)
 *   priceGrid()   re-prices already-simulated cells (main thread, ~15 ms)
 * so moving a cost or finance slider never re-runs a simulation.
 *
 * Panels are allocated across roof planes GREEDILY by marginal annual bill saving:
 * at each step one extra panel is simulated on every plane that still has room and
 * the best one is kept.  Value per added panel declines (the array outgrows
 * self-consumption), so the greedy path is monotone - the allocation for n panels is
 * always the allocation for n-1 plus one - which means the order can be computed once
 * per grid run and replayed for every battery count.
 * ========================================================================== */

import Engine from "./engine.js";
import Finance from "./finance.js";

/**
 * "Highest IRR" and "fastest payback" both rank among systems that actually make
 * money (NPV > 0).  IRR is the project IRR - the return the system earns on its
 * cash price, whoever pays it - so the objective means the same thing under cash,
 * a loan and a lease; the levered `irr` is undefined with nothing down and
 * inflated with a little down.  Without the NPV gate a lease would hand "highest
 * IRR" to the smallest array, whose fine project return the lessor keeps while the
 * lessee's payments outrun the savings.  Money-losers rank below every earner,
 * ordered by NPV so the least bad wins if nothing else does.
 */
function irrRank(c) {
  const v = c.projectIrr !== undefined ? c.projectIrr : c.irr;
  if (!(c.npv > 0) || typeof v !== "number") return -Infinity;
  return v;
}

/** Fewest years to pay for itself, among systems that make money; never = last. */
function paybackRank(c) {
  if (!(c.npv > 0) || typeof c.payback !== "number") return Infinity;
  return c.payback;
}

export const OBJECTIVES = {
  npv: { label: "Maximum NPV", better: (a, b) => a.npv > b.npv },
  lifetime: { label: "Lowest lifetime cost", better: (a, b) => a.lifetimeCost < b.lifetimeCost },
  irr: {
    label: "Highest IRR",
    better: function (a, b) {
      const ra = irrRank(a), rb = irrRank(b);
      // Ties are the undefined ends of the scale (and, with no outlay, every cell
      // that pays for itself from year one sits there): money decides.
      return ra === rb ? a.npv > b.npv : ra > rb;
    },
  },
  payback: {
    label: "Fastest payback",
    better: function (a, b) {
      const ra = paybackRank(a), rb = paybackRank(b);
      return ra === rb ? a.npv > b.npv : ra < rb;
    },
  },
};

/** Per-plane panel caps: explicit opts.planeCaps (array or {id: cap}), else plane.maxPanels. */
export function resolveCaps(planes, planeCaps) {
  return planes.map(function (pl, k) {
    let cap;
    if (Array.isArray(planeCaps)) cap = planeCaps[k];
    else if (planeCaps && typeof planeCaps === "object") cap = planeCaps[pl.id];
    if (cap === undefined || cap === null) cap = pl.maxPanels;
    if (cap === undefined || cap === null) cap = Infinity;
    return Math.max(0, cap);
  });
}

/** alloc after `n` greedy steps. */
export function allocAt(order, nPlanes, n) {
  const a = new Array(nPlanes).fill(0);
  for (let i = 0; i < n && i < order.length; i++) a[order[i]]++;
  return a;
}

/**
 * The greedy fill order: order[i] is the plane that gets the (i+1)-th panel.
 * `cells` is filled with the winning simulation of each step, so the sweep never
 * re-simulates the battery count the ordering was computed at.
 */
export function allocationOrder(scn, p, maxPanelsTotal, caps, batteries, cells) {
  const nP = scn.planes.length;
  const alloc = new Array(nP).fill(0);
  const order = [];
  for (let n = 1; n <= maxPanelsTotal; n++) {
    let bestVal = -Infinity, bestK = -1, bestRes = null;
    for (let k = 0; k < nP; k++) {
      if (alloc[k] + 1 > caps[k]) continue;
      alloc[k]++;
      const res = Engine.runHours(scn, Object.assign({}, p, { panelsByPlane: alloc.slice(), batteries }), false);
      alloc[k]--;
      if (-res.bill > bestVal) { bestVal = -res.bill; bestK = k; bestRes = res; }
    }
    if (bestK < 0) break;                       // every plane is full
    alloc[bestK]++;
    order.push(bestK);
    if (cells) cells.set(n, bestRes);
  }
  return order;
}

/** Hard caps on the search grid, whatever the caller asks for. */
export const MAX_SEARCH_PANELS = 200;
export const MAX_SEARCH_BATTERIES = 20;

/**
 * Sweep total panels x batteries, allocating panels across planes greedily.
 * opts = { maxPanelsTotal, maxBatteries, planeCaps, step, greedyBatteries, onProgress }
 */
export function searchGrid(ctx, params, opts) {
  opts = opts || {};
  const p = Engine.withDefaults(params);
  let maxPanelsTotal = opts.maxPanelsTotal;
  if (maxPanelsTotal === undefined) maxPanelsTotal = opts.maxPanels;   // older spelling
  if (maxPanelsTotal === undefined) maxPanelsTotal = 60;
  let maxBatteries = opts.maxBatteries === undefined ? 6 : opts.maxBatteries;
  // A crafted share link (`#maxb=100000`) must not hang the worker: the sweep is
  // (panels + 1) x (batteries + 1) full-year simulations, so both axes are capped.
  const capAxis = (v, cap, d, name) => {
    let n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) n = d;
    if (n > cap) {
      if (typeof console !== "undefined") console.warn(`searchGrid: ${name} ${n} clamped to ${cap}`);
      n = cap;
    }
    return n;
  };
  maxPanelsTotal = capAxis(maxPanelsTotal, MAX_SEARCH_PANELS, 60, "maxPanelsTotal");
  maxBatteries = capAxis(maxBatteries, MAX_SEARCH_BATTERIES, 6, "maxBatteries");
  const step = opts.step || 1;
  const gb = Math.max(0, Math.min(maxBatteries, opts.greedyBatteries === undefined ? 0 : opts.greedyBatteries));

  const b = Engine.baselines(ctx, p, false);
  const scn = b.scnSame;
  const nP = scn.planes.length;
  const caps = resolveCaps(scn.planes, opts.planeCaps);
  let capTotal = 0;
  for (const c of caps) capTotal += c;
  const nMax = Math.min(maxPanelsTotal, capTotal);

  const cache = new Map();
  const order = nP ? allocationOrder(scn, p, nMax, caps, gb, cache) : [];

  const panelList = [];
  for (let n = 0; n <= order.length; n += step) panelList.push(n);
  if (panelList[panelList.length - 1] !== order.length) panelList.push(order.length);
  const battList = [];
  for (let i = 0; i <= maxBatteries; i++) battList.push(i);

  const cells = [];
  let done = 0;
  const total = panelList.length * battList.length;
  for (let pi = 0; pi < panelList.length; pi++) {
    const n = panelList[pi];
    const alloc = allocAt(order, nP, n);
    for (let bi = 0; bi < battList.length; bi++) {
      const nb = battList[bi];
      const res = (nb === gb && cache.has(n)) ? cache.get(n)
        : Engine.runHours(scn, Object.assign({}, p, { panelsByPlane: alloc, batteries: nb }), false);
      Engine.attachSavings(res, b.sameFlex.bill, b.asRecorded.bill);
      cells.push(res);
      if (opts.onProgress && (++done % 40 === 0)) opts.onProgress(done, total);
    }
  }
  if (opts.onProgress) opts.onProgress(total, total);
  return {
    cells, panelList, battList,
    planes: scn.planes.map((pl, k) => ({ id: pl.id, name: pl.name, cap: caps[k] })),
    allocationOrder: order, greedyBatteries: gb,
    baselineSameFlex: b.sameFlex, baselineAsRecorded: b.asRecorded,
    flexShiftOnlySavings: b.asRecorded.bill - b.sameFlex.bill,
    weatherKey: scn.weatherKey,
    years: ctx.years !== undefined ? ctx.years : ctx.nDays / 365, hours: ctx.N,
  };
}

/** Attach financial metrics to every simulated cell and pick the winner. */
/** No new panels and no battery.  With an existing array, `panels` counts it, so `newPanels` decides. */
const isDoNothing = (c) => (c.newPanels !== undefined && c.newPanels !== null ? c.newPanels : c.panels) === 0 && c.batteries === 0;

/**
 * The Net Billing stream of an existing-array cell (worker existingGrid's `cell.after`)
 * on the chosen basis, in the shape Finance.evaluate reads as `sim.after`; null when
 * the cell has none.
 */
function afterFor(c, grid, asRec) {
  const a = c.after;
  if (!a) return null;
  const savings = asRec ? a.savingsVsAsRecorded : a.savingsVsSameFlex;
  // The battery's export increment over the no-battery baseline on this basis (the
  // existing array already exports without it), falling back to the total for old cells.
  const perBasis = asRec ? a.exportRevenueVsAsRecorded : a.exportRevenueVsSameFlex;
  const exportRevenue = perBasis !== undefined ? perBasis : (a.exportRevenue || 0);
  let importSavings = asRec ? a.importSavingsVsAsRecorded : a.importSavingsVsSameFlex;
  if (importSavings === undefined) importSavings = savings - exportRevenue;
  const base = asRec ? grid.afterBaselineAsRecorded : grid.afterBaselineSameFlex;
  return { savings, importSavings, exportRevenue, accPlusRevenue: a.accPlusRevenue || 0,
           bill: a.bill, baselineBill: base ? base.bill : undefined };
}

export function priceGrid(grid, finance, objective, basis) {
  // Tolerate priceGrid(grid, fin, basis) as the architecture doc writes it.
  if (basis === undefined && (objective === "sameFlex" || objective === "asRecorded")) {
    basis = objective; objective = "npv";
  }
  const obj = OBJECTIVES[objective] ? objective : "npv";
  // Default basis is "sameFlex": the no-system bill with the SAME flexible-load
  // schedule, so the numbers credit the hardware only.  Re-timing an EV to midday is
  // free and is reported separately as grid.flexShiftOnlySavings.
  const asRec = basis === "asRecorded";
  const baseline = asRec ? grid.baselineAsRecorded : grid.baselineSameFlex;
  const cells = grid.cells.map(function (c) {
    const savings = asRec ? c.savingsVsAsRecorded : c.savingsVsSameFlex;
    // The two halves of the saving escalate at different rates, so they travel apart.
    const exportRev = c.exportRevenue || 0;
    // The ACC Plus share of exportRev: finance stops it after the nine-year lock.
    const accPlusRev = c.accPlusRevenue || 0;
    let importSav = asRec ? c.importSavingsVsAsRecorded : c.importSavingsVsSameFlex;
    if (importSav === undefined) importSav = savings - exportRev;
    const after = afterFor(c, grid, asRec);
    const sim = {
      savings, importSavings: importSav, exportRevenue: exportRev, accPlusRevenue: accPlusRev,
      bill: c.bill, baselineBill: baseline.bill,
      pvKwh: c.pvKwh, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal, batteries: c.batteries,
    };
    if (after) sim.after = after;
    const fin = Finance.evaluate(sim, finance);
    return {
      panels: c.panels, panelsByPlane: c.panelsByPlane, planeIds: c.planeIds,
      batteries: c.batteries, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal,
      savings, importSavings: importSav, exportRevenue: exportRev, accPlusRevenue: accPlusRev,
      bill: c.bill, importKwh: c.importKwh, exportKwh: c.exportKwh,
      pvKwh: c.pvKwh, pvKwhByPlane: c.pvKwhByPlane, loadKwh: c.loadKwh, baseLoadKwh: c.baseLoadKwh,
      cycles: c.cycles, selfSufficiency: c.selfSufficiency,
      solarFraction: c.solarFraction, clippedKwh: c.clippedKwh,
      npv: fin.npv, irr: fin.irr, projectIrr: fin.projectIrr,
      payback: fin.payback, discountedPayback: fin.discountedPayback,
      cashFlowPayback: fin.cashFlowPayback, totalCost: fin.totalCost,
      netCost: fin.netCost, lifetimeCost: fin.lifetimeCost, lcoe: fin.lcoe,
      wealthSystem: fin.wealthSystem, wealthInvest: fin.wealthInvest,
      firstYearSavings: fin.firstYearSavings, extraRevenue: fin.extraRevenue,
      firstYearMonthlyOutlay: fin.firstYearMonthlyOutlay,
      currentMonthlyBill: fin.currentMonthlyBill,
      financingMode: fin.financingMode, monthlyPayment: fin.monthlyPayment,
      after, regimeChangeYear: fin.regimeChangeYear,
      finance: fin,
    };
  });
  let best = null;
  const better = OBJECTIVES[obj].better;
  cells.forEach(function (c) {
    if (isDoNothing(c)) return;   // "do nothing" is the baseline, not a candidate
    if (!best || better(c, best)) best = c;
  });
  // Doing nothing still wins if every real option destroys value.
  const doNothing = cells.find(isDoNothing);
  if (best && best.npv <= 0 && obj === "npv") best.beatenByDoingNothing = true;
  return { cells, best, doNothing,
           panelList: grid.panelList, battList: grid.battList, planes: grid.planes,
           baseline, objective: obj, basis: asRec ? "asRecorded" : "sameFlex" };
}

export function findCell(priced, panels, batteries) {
  return priced.cells.find((c) => c.panels === panels && c.batteries === batteries);
}

/**
 * +-20% tornado on the inputs that actually move the answer.  Price-side factors
 * re-price the cached cell; a flexible-load factor is a simulation input, so the
 * caller supplies the two extra simulated savings numbers (or we skip that bar).
 */
export function tornado(cell, finance, baselineBill, flexVariants) {
  const simOf = (o) => ({
    savings: o.savings, importSavings: o.importSavings, exportRevenue: o.exportRevenue,
    accPlusRevenue: o.accPlusRevenue === undefined ? cell.accPlusRevenue : o.accPlusRevenue,
    bill: o.bill, baselineBill: o.baselineBill === undefined ? baselineBill : o.baselineBill,
    pvKwh: cell.pvKwh, kwdc: cell.kwdc, battKWhTotal: cell.battKWhTotal, batteries: cell.batteries,
    // The Net Billing stream after a legacy term ends rides along unchanged (the
    // flex variants are simulated on the legacy regime only).
    after: cell.after,
  });
  const sim = simOf(cell);
  const base = Finance.evaluate(sim, finance).npv;
  const f = Finance.withDefaults(finance);
  let rows = [
    ["Solar $/W", "costPerW"], ["Storage $/kWh", "costPerKwh"],
    ["Rate escalation", "escalation"], ["Investment return", "investReturn"],
  ];
  // Only worth a bar when there is a fixed battery price to wiggle.
  if (f.costPerBattery > 0) rows.splice(2, 0, ["Battery $/unit", "costPerBattery"]);
  rows = rows.map(function (r) {
    const lo = Object.assign({}, f); lo[r[1]] = f[r[1]] * 0.8;
    const hi = Object.assign({}, f); hi[r[1]] = f[r[1]] * 1.2;
    return { label: r[0], low: Finance.evaluate(sim, lo).npv - base,
             high: Finance.evaluate(sim, hi).npv - base };
  });
  if (flexVariants) {
    const mk = (v) => Finance.evaluate(simOf(v), f).npv - base;
    rows.push({ label: flexVariants.label || "Flexible load kWh/yr",
                low: mk(flexVariants.low), high: mk(flexVariants.high) });
  }
  rows.sort((a, b) => Math.max(Math.abs(b.low), Math.abs(b.high)) - Math.max(Math.abs(a.low), Math.abs(a.high)));
  return { base, rows };
}

const SolarOptimizer = { searchGrid, priceGrid, findCell, tornado, allocationOrder,
                         allocAt, resolveCaps, OBJECTIVES };
export default SolarOptimizer;
