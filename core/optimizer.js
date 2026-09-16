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
 * A null IRR means one of two OPPOSITE things, so it cannot be ranked with a single
 * sentinel.  With money down (cash, a loan with a deposit) it means the cash flow
 * never turns positive - the worst case.  With nothing down (a lease, a fully
 * financed loan) a stream that is cash positive from year one has no rate of return
 * to solve for because nothing was invested - the best case.  The sign of NPV
 * separates them; without this the sweep hands "highest IRR" a cell that loses money
 * every year in preference to one that makes money from day one.
 */
function irrRank(c) {
  if (typeof c.irr === "number") return c.irr;
  return c.npv > 0 ? Infinity : -Infinity;
}

/** A cell that never pays back ranks last. */
function paybackRank(c) {
  return typeof c.payback === "number" ? c.payback : Infinity;
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
  const maxBatteries = opts.maxBatteries === undefined ? 6 : opts.maxBatteries;
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
    years: ctx.nDays / 365, hours: ctx.N,
  };
}

/** Attach financial metrics to every simulated cell and pick the winner. */
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
    let importSav = asRec ? c.importSavingsVsAsRecorded : c.importSavingsVsSameFlex;
    if (importSav === undefined) importSav = savings - exportRev;
    const fin = Finance.evaluate({
      savings, importSavings: importSav, exportRevenue: exportRev,
      bill: c.bill, baselineBill: baseline.bill,
      pvKwh: c.pvKwh, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal,
    }, finance);
    return {
      panels: c.panels, panelsByPlane: c.panelsByPlane, planeIds: c.planeIds,
      batteries: c.batteries, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal,
      savings, importSavings: importSav, exportRevenue: exportRev,
      bill: c.bill, importKwh: c.importKwh, exportKwh: c.exportKwh,
      pvKwh: c.pvKwh, pvKwhByPlane: c.pvKwhByPlane,
      cycles: c.cycles, selfSufficiency: c.selfSufficiency,
      solarFraction: c.solarFraction, clippedKwh: c.clippedKwh,
      npv: fin.npv, irr: fin.irr, payback: fin.payback, discountedPayback: fin.discountedPayback,
      netCost: fin.netCost, lifetimeCost: fin.lifetimeCost, lcoe: fin.lcoe,
      wealthSystem: fin.wealthSystem, wealthInvest: fin.wealthInvest,
      firstYearSavings: fin.firstYearSavings,
      firstYearMonthlyOutlay: fin.firstYearMonthlyOutlay,
      currentMonthlyBill: fin.currentMonthlyBill,
      financingMode: fin.financingMode, monthlyPayment: fin.monthlyPayment,
      finance: fin,
    };
  });
  let best = null;
  const better = OBJECTIVES[obj].better;
  cells.forEach(function (c) {
    if (c.panels === 0 && c.batteries === 0) return;   // "do nothing" is the baseline, not a candidate
    if (!best || better(c, best)) best = c;
  });
  // Doing nothing still wins if every real option destroys value.
  const doNothing = cells.find((c) => c.panels === 0 && c.batteries === 0);
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
    bill: o.bill, baselineBill: o.baselineBill === undefined ? baselineBill : o.baselineBill,
    pvKwh: cell.pvKwh, kwdc: cell.kwdc, battKWhTotal: cell.battKWhTotal,
  });
  const sim = simOf(cell);
  const base = Finance.evaluate(sim, finance).npv;
  const f = Finance.withDefaults(finance);
  const rows = [
    ["Solar $/W", "costPerW"], ["Storage $/kWh", "costPerKwh"],
    ["Rate escalation", "escalation"], ["Investment return", "investReturn"],
  ].map(function (r) {
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
