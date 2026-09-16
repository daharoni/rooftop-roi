/* =============================================================================
 * tests/optimizer.test.mjs - node --test tests/
 *
 * The prototype's optimizer assertions, plus the greedy allocation of panels across
 * roof planes and the two performance budgets the UI depends on (a grid sweep the
 * worker can finish between slider drags, and a re-price fast enough to run on the
 * main thread while a cost slider moves).
 * ========================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import Engine from "../core/engine.js";
import Optimizer from "../core/optimizer.js";
import { loadSet, plane, refParams, TARIFF, REFERENCE } from "./fixtures/agoura.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);

const ctx = Engine.prepare({ load: loadSet(), tariffs: TARIFF });
const ESC = { escalation: TARIFF.meta.escalation.recommended_default };

// A small sweep is enough for every structural assertion.
const SMALL = Optimizer.searchGrid(ctx, refParams(0, 0), { maxPanelsTotal: 20, maxBatteries: 2, step: 2 });

test("each objective selects its own extremum", () => {
  const priced = Optimizer.priceGrid(SMALL, {}, "npv", "sameFlex");
  const real = priced.cells.filter((c) => !(c.panels === 0 && c.batteries === 0));
  near(priced.best.npv, Math.max(...real.map((c) => c.npv)), 1e-9,
       `max-NPV objective selects the maximum cell (${priced.best.panels}p/${priced.best.batteries}b)`);

  const byIrr = Optimizer.priceGrid(SMALL, {}, "irr", "sameFlex");
  near(byIrr.best.irr, Math.max(...real.map((c) => (c.irr === null ? -9 : c.irr))), 1e-9,
       "max-IRR objective selects the maximum IRR cell");

  const byPay = Optimizer.priceGrid(SMALL, {}, "payback", "sameFlex");
  near(byPay.best.payback, Math.min(...real.map((c) => (c.payback === null ? 999 : c.payback))), 1e-9,
       "shortest-payback objective selects the minimum payback cell");

  const byLife = Optimizer.priceGrid(SMALL, {}, "lifetime", "sameFlex");
  near(byLife.best.lifetimeCost, Math.min(...real.map((c) => c.lifetimeCost)), 1e-6,
       "lowest-lifetime-cost objective selects the minimum cost cell");
});

test("the do-nothing cell, and when it wins", () => {
  const priced = Optimizer.priceGrid(SMALL, {}, "npv", "sameFlex");
  assert.equal(Optimizer.findCell(priced, 0, 0).netCost, 0, "the do-nothing cell costs nothing");
  near(Optimizer.findCell(priced, 0, 0).savings, 0, 1e-9,
       "against the same-flex baseline the do-nothing cell saves nothing");

  const vsToday = Optimizer.priceGrid(SMALL, {}, "npv", "asRecorded");
  near(Optimizer.findCell(vsToday, 0, 0).savings, SMALL.flexShiftOnlySavings, 1e-9,
       "against today's bill it captures exactly the free re-timing saving");
  assert.equal(vsToday.basis, "asRecorded", "the basis is reported back");

  const dear = Optimizer.priceGrid(SMALL, { costPerW: 40, costPerKwh: 20000 }, "npv", "sameFlex");
  assert.ok(dear.best.npv < 0 && dear.best.beatenByDoingNothing,
            "at $40/W every configuration loses to doing nothing");

  // priceGrid(grid, fin, basis) - the three-argument spelling in ARCHITECTURE.md.
  const three = Optimizer.priceGrid(SMALL, {}, "asRecorded");
  assert.equal(three.basis, "asRecorded", "a basis in the objective slot is understood");
  assert.equal(three.objective, "npv", "and the objective falls back to NPV");
});

test("PV generation is monotone in panel count", () => {
  const priced = Optimizer.priceGrid(SMALL, {}, "npv", "sameFlex");
  const byPanels = {};
  priced.cells.forEach((c) => { if (c.batteries === 0) byPanels[c.panels] = c.pvKwh; });
  const keys = Object.keys(byPanels).map(Number).sort((a, b) => a - b);
  assert.ok(keys.every((k, i) => i === 0 || byPanels[k] > byPanels[keys[i - 1]] - 1e-9),
            "PV generation is monotone in panel count");
});

test("tornado rows are sorted by impact", () => {
  const priced = Optimizer.priceGrid(SMALL, {}, "npv", "sameFlex");
  const tor = Optimizer.tornado(priced.best, {}, priced.baseline.bill, null);
  assert.equal(tor.rows.length, 4, "four price-side rows");
  assert.ok(Math.abs(tor.rows[0].low) >= Math.abs(tor.rows[3].low), "sorted by impact");
});

test("the optimum shrinks when export credits stop escalating", () => {
  const grid = Optimizer.searchGrid(ctx, refParams(0, 0), { maxPanelsTotal: 60, maxBatteries: 2, step: 2 });
  const oldWay = Optimizer.priceGrid(grid, { ...ESC, exportEscalation: ESC.escalation }, "npv", "sameFlex").best;
  const newWay = Optimizer.priceGrid(grid, { ...ESC, exportEscalation: 0 }, "npv", "sameFlex").best;
  assert.ok(newWay.panels <= oldWay.panels,
            `optimum shrinks or holds: ${oldWay.panels} panels -> ${newWay.panels}`);
  assert.ok(newWay.npv < oldWay.npv, "and its NPV is lower");
  near(newWay.importSavings + newWay.exportRevenue, newWay.savings, 1e-9,
       "priced cells carry a consistent import/export split");
});

// ================================================================== planes
test("panels are allocated greedily to the better plane, and caps are respected", () => {
  const good = plane(0, { id: "good", maxPanels: 3 });
  const poor = plane(0, { id: "poor", maxPanels: 5, shading: { annual: 0.5 } });
  const params = refParams(0, 0, { planes: [good, poor] });
  const grid = Optimizer.searchGrid(ctx, params, { maxPanelsTotal: 8, maxBatteries: 1 });

  assert.deepEqual(grid.allocationOrder, [0, 0, 0, 1, 1, 1, 1, 1],
                   "the unshaded plane fills to its cap first, then the shaded one");
  const at = (n, b) => grid.cells.find((c) => c.panels === n && c.batteries === b);
  assert.deepEqual(at(2, 0).panelsByPlane, [2, 0], "two panels both go on the good plane");
  assert.deepEqual(at(4, 0).panelsByPlane, [3, 1], "the fourth spills onto the poor plane");
  assert.deepEqual(at(8, 0).panelsByPlane, [3, 5], "and both caps bind at the end");
  assert.equal(grid.panelList[grid.panelList.length - 1], 8, "the sweep stops at the total cap");

  // An explicit planeCaps option overrides plane.maxPanels.
  const capped = Optimizer.searchGrid(ctx, params, { maxPanelsTotal: 10, maxBatteries: 0,
                                                     planeCaps: { good: 2, poor: 1 } });
  assert.deepEqual(capped.allocationOrder, [0, 0, 1], "planeCaps wins over plane.maxPanels");
  assert.equal(capped.panelList[capped.panelList.length - 1], 3, "so the sweep is only three panels long");
  assert.deepEqual(capped.planes.map((p) => p.cap), [2, 1], "the caps come back with the grid");

  // The greedy path is monotone: every allocation is the previous one plus one panel.
  for (let n = 1; n < grid.panelList.length; n++) {
    const a = at(grid.panelList[n - 1], 0).panelsByPlane, b = at(grid.panelList[n], 0).panelsByPlane;
    assert.ok(a.every((v, k) => b[k] >= v), "allocations only ever grow");
  }
  // ...and it is reused unchanged for every battery count.
  for (const b of [0, 1]) {
    assert.deepEqual(at(5, b).panelsByPlane, [3, 2], `battery count ${b} reuses the same allocation`);
  }
});

test("a plane allocation really is the best of the one-panel-more options", () => {
  const a = plane(0, { id: "a", maxPanels: 10 });
  const b = plane(0, { id: "b", maxPanels: 10, shading: { annual: 0.2 } });
  const params = Engine.withDefaults(refParams(0, 0, { planes: [a, b] }));
  const scn = Engine.buildScenario(ctx, params);
  const order = Optimizer.allocationOrder(scn, params, 6, [10, 10], 0, null);
  // Independently check the first three picks by brute force.
  let alloc = [0, 0];
  for (let step = 0; step < 3; step++) {
    const bills = [0, 1].map((k) => {
      const cand = alloc.slice(); cand[k]++;
      return Engine.runHours(scn, Object.assign({}, params, { panelsByPlane: cand, batteries: 0 }), false).bill;
    });
    const want = bills[0] <= bills[1] ? 0 : 1;
    assert.equal(order[step], want, `step ${step + 1} picks the plane with the lower bill`);
    alloc[order[step]]++;
  }
  assert.deepEqual(Optimizer.allocAt(order, 2, 4), alloc.map((v, k) => v + (order[3] === k ? 1 : 0)),
                   "allocAt replays the order");
});

test("pvKwhByPlane survives the sweep", () => {
  const good = plane(0, { id: "good", maxPanels: 4 });
  const poor = plane(0, { id: "poor", maxPanels: 4, shading: { annual: 0.5 } });
  const grid = Optimizer.searchGrid(ctx, refParams(0, 0, { planes: [good, poor] }),
                                    { maxPanelsTotal: 8, maxBatteries: 0 });
  for (const c of grid.cells) {
    near(c.pvKwhByPlane.reduce((x, y) => x + y, 0), c.pvKwh, 1e-9,
         `pvKwhByPlane reconciles at ${c.panels} panels`);
    assert.equal(c.pvKwhByPlane.length, 2, "one entry per plane");
  }
  const full = grid.cells.find((c) => c.panels === 8);
  assert.ok(full.pvKwhByPlane[0] > full.pvKwhByPlane[1] * 1.5,
            "the unshaded plane produces much more from the same panel count");
});

// ================================================================== reference
test("the reference optimum survives the new API", async () => {
  const R = REFERENCE.optimum;
  const src = Engine.flexReshapeSource();
  const grid = Optimizer.searchGrid(ctx, refParams(0, 0), { maxPanelsTotal: 60, maxBatteries: 6 });
  const best = Optimizer.priceGrid(grid, { escalation: R.escalation }, "npv", "sameFlex").best;
  assert.equal(best.panels, R.panels, "27 panels");
  assert.equal(best.batteries, R.batteries, "1 battery");
  assert.deepEqual(best.panelsByPlane, [R.panels], "all of them on the single roof plane");
  near(best.npv, R.npv, 60, "NPV ~ $45.2k");
  near(best.irr, R.irr, 0.0005, "IRR ~ 17.9%");
  near(best.payback, R.payback, 0.02, "payback ~ 6.1 years");
  assert.ok(best.finance.financingMode === "cash", "priced in cash, as the prototype was");

  // With the engine's own reshape the prototype's numbers come back to the dollar.
  try {
    Engine.setFlexReshape(null);
    const g2 = Optimizer.searchGrid(ctx, refParams(0, 0), { maxPanelsTotal: 60, maxBatteries: 6 });
    const b2 = Optimizer.priceGrid(g2, { escalation: R.escalation }, "npv", "sameFlex").best;
    assert.equal(b2.panels, R.panels, "same 27 panels");
    assert.equal(b2.batteries, R.batteries, "same 1 battery");
    near(b2.npv, R.npv, 0.6, "and the prototype's NPV to the dollar");
    near(b2.irr, R.irr, 1e-6, "its IRR to six digits");
    near(b2.payback, R.payback, 1e-4, "and its payback to four");
  } finally {
    if (src === "flexload") {
      const m = await import("../core/flexload.js");
      Engine.setFlexReshape(m.reshape);
    }
  }
});

// ================================================================== performance
test("the sweep and the re-price stay inside their budgets", () => {
  const params = refParams(0, 0, {
    planes: [plane(0, { id: "s", maxPanels: 30 }),
             plane(0, { id: "w", azimuth: 240, maxPanels: 20 }),
             plane(0, { id: "e", azimuth: 100, maxPanels: 20 })],
  });
  const t0 = process.hrtime.bigint();
  const grid = Optimizer.searchGrid(ctx, params, { maxPanelsTotal: 60, maxBatteries: 6 });
  const sweepMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const priced = Optimizer.priceGrid(grid, ESC, "npv", "sameFlex");
  const priceMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`      3 planes x 61 panel counts x 7 battery counts over ${ctx.N} hours: ` +
              `sweep ${sweepMs.toFixed(0)} ms, re-price ${priceMs.toFixed(1)} ms`);
  assert.equal(grid.cells.length, 61 * 7, "every cell simulated");
  assert.ok(priced.best.panelsByPlane.reduce((a, b) => a + b, 0) === priced.best.panels,
            "the winner's per-plane allocation adds up");
  // Budgets: ~300 ms and ~15 ms on a dev machine; loosened for shared CI runners.
  assert.ok(sweepMs < 1500, `grid sweep took ${sweepMs.toFixed(0)} ms`);
  assert.ok(priceMs < 200, `re-price took ${priceMs.toFixed(1)} ms`);
});
