/* =============================================================================
 * main.js — orchestration.
 *
 * The pipeline, end to end:
 *
 *   file(s) ─► core/greenbutton.parse + mergeLoadSets ─► LoadSet
 *           ─► core/flexload.detectEV / detectPool     ─► FlexLoad[]
 *           ─► core/tariff.utilityForZip               ─► which rate book
 *           ─► roof planes ─► core/weather.fetchYears ─► core/pv.profilesForPlane
 *           ─► worker (app/worker-bundle.js): searchGrid, then one detail run
 *           ─► core/optimizer.priceGrid + core/finance ─► render
 *
 * Division of labour, which is what keeps the page responsive: the worker runs
 * every hourly simulation; this file re-prices cached results and draws.  A
 * price or finance control therefore never touches a simulation and updates in
 * about 15 ms; a system or household control queues a debounced worker
 * round-trip and the previous render is held at reduced opacity until it
 * returns.
 *
 * Every core module is loaded through `loadCore()` rather than a static import,
 * so one module failing to parse degrades that feature instead of blanking the
 * page.  Where a module is genuinely absent the call site carries an
 * `// INTEGRATION:` note saying what happens instead.
 * ========================================================================== */

import * as State from "./state.js";
import { $, el, clear, readTokens, toast } from "./ui/dom.js";
import { ControlRail, defaultReason } from "./ui/controls.js";
import { renderLanding, landingError, landingNotice, userMessageOf } from "./ui/landing.js";
import { futureTitle } from "./ui/knobs.js";
import { summaryText, copyToClipboard } from "./ui/summary.js";
import { destroyAll } from "./charts/base.js";
import { fmtKwh } from "./ui/format.js";
import { adoptGeocodeNote } from "./privacy.js";

import * as dashboardTab from "./tabs/dashboard.js";
import * as roofTab from "./tabs/roof.js";
import * as loadsTab from "./tabs/loads.js";
import * as billsTab from "./tabs/bills.js";
import * as assumptionsTab from "./tabs/assumptions.js";

/** Hash- and storage-supplied ids are looked up in plain objects; never walk the prototype chain. */
const hasOwn = (obj, key) => !!obj && typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
const utilityOf = (id) => (ctx.tariffLib && hasOwn(ctx.tariffLib.utilities, id) ? ctx.tariffLib.utilities[id] : null);

const TAB_MODULES = {
  dashboard: dashboardTab, roof: roofTab, loads: loadsTab, bills: billsTab, assumptions: assumptionsTab,
};

/** Tab ids from links and sessions saved before the dashboard existed. */
const LEGACY_TABS = { home: "dashboard", system: "dashboard", money: "bills" };
const normalizeTab = (id) => (State.TABS.includes(id) ? id : LEGACY_TABS[id] || "dashboard");

const NGOM_COST_DEFAULT = 600;   // one-time metering charge; overridden from the tariff file

// --------------------------------------------------------------------- core

/** Every core module, or null where it could not be loaded. */
const Core = {
  greenbutton: null, flexload: null, tariff: null, pv: null, weather: null,
  geocode: null, engine: null, finance: null, optimizer: null, sizing: null, coverage: null,
};

async function loadCore() {
  const wanted = {
    greenbutton: "../core/greenbutton.js", flexload: "../core/flexload.js",
    tariff: "../core/tariff.js", pv: "../core/pv.js", weather: "../core/weather.js",
    geocode: "../core/geocode.js", engine: "../core/engine.js",
    finance: "../core/finance.js", optimizer: "../core/optimizer.js",
    sizing: "../core/sizing.js", coverage: "../core/coverage.js",
  };
  await Promise.all(Object.entries(wanted).map(async ([key, path]) => {
    try { Core[key] = await import(path); }
    catch (err) { console.error(`core/${key}.js did not load:`, err && err.message); Core[key] = null; }
  }));
  // The reshaper lives in flexload; the engine asks for it by injection so the
  // two can ship independently.
  if (Core.engine && Core.flexload && Core.engine.setFlexReshape) {
    Core.engine.setFlexReshape(Core.flexload.reshape);
  }
  return Core;
}

// -------------------------------------------------------------- app context

/** Everything the tabs read. Rebuilt on every render; never mutated by them. */
const ctx = {
  linkKeys: new Set(),            // hash keys a shared link set (and that parsed): onDemo must not overwrite them
  loadSet: null, tariffLib: null, tariff: null,
  grid: null, priced: null, selected: null, detail: null, replay: null,
  weatherRows: null, tornado: null, week: null,
  baselineBill: 0, baselineMonthly: null,
  planLabel: "", solarStatusText: "", solarProgress: 0,
  statusText: "", effectiveDiscount: 0,
  breakEvenPerW: null, breakEvenPerKwh: null,
  flexShiftOnlySavings: 0, annualPerKw: null, weeks: 52,
  objective: null, installerAnnualKwh: null,
  bestPlan: null, bestPlanGain: 0, bestProvider: null, bestProviderGain: 0,
  weatherOptions: [{ v: "tmy", t: "TMY (typical year)" }],
  planOptions: [], providerOptions: [], utilityOptions: [], baselineRegionOptions: [],
  dataWarnings: [],
  // From the engine's "ready" message (see onWorkerMessage): the record's length in
  // years (usableDays / 365) and the household's annual kWh over it.  null until
  // the engine has seen this LoadSet; householdAnnualKwh() falls back until then.
  engineYears: null, engineAnnualKwh: null, householdAnnualKwh: null,
  escalationNote: "",
  climateCredit: null,
  // Gates that stop the optimiser from running at all (P0 #3, #6, short files):
  coverage: null,            // last core/coverage.js answer for this location
  coverageOk: false,         // a modelled IOU has been chosen, by ZIP or explicitly by the user
  blockReason: "",           // non-empty: the reason no simulation runs, shown in the banner
  coverageBlocked: false,    // the block is about the utility; only an explicit UI pick lifts it
  siteNotice: "",            // one-line note after a roof-tab location change
  getState: State.get,
  actions: {},
};

// ------------------------------------------------------------------- worker

let worker = null;
let lastDetailKey = "";
let reqId = 0, pendingGrid = 0, pendingDetail = 0, pendingReplay = 0;
let workerReady = false;

/**
 * The simulation runs in a Blob-URL worker so slider drags never block. Some
 * hosts (a sandboxed embed with a strict CSP) refuse Blob workers; there the
 * same script is evaluated on the main thread behind a postMessage-shaped
 * shim, so the page still works — it just pauses for a fraction of a second
 * per sweep instead of animating a progress bar.
 */
function makeInlineWorker(src) {
  const shim = { onmessage: null, postMessage: null };
  const fake = { onmessage: null, onerror: null };
  shim.postMessage = (msg) => { if (fake.onmessage) fake.onmessage({ data: msg }); };
  // eslint-disable-next-line no-new-func
  new Function("self", src)(shim);
  fake.postMessage = (msg) => {
    setTimeout(() => {
      try { shim.onmessage({ data: msg }); }
      catch (err) { if (fake.onerror) fake.onerror(err); }
    }, 0);
  };
  fake.terminate = () => {};
  return fake;
}

let bootGen = 0;
let workerSrc = null;

async function bootWorker() {
  // Overlapping boots (a roof edit while a utility switch is still booting) must
  // not leak workers: only the newest call gets to create one.
  const gen = ++bootGen;
  if (worker) { worker.terminate(); worker = null; }
  workerReady = false;
  lastDetailKey = "";              // a new worker has run no detail yet
  if (ctx.blockReason) { status(ctx.blockReason, 1); return; }
  let src = workerSrc || "";
  try {
    if (!src) {
      const res = await fetch(new URL("./worker-bundle.js", import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      src = await res.text();
      workerSrc = src;
    }
  } catch (err) {
    // INTEGRATION: app/worker-bundle.js is generated by `node core/bundle-for-worker.mjs`.
    // Without it there is no simulation at all, so say so rather than showing zeros.
    status("Simulation engine missing — run: node core/bundle-for-worker.mjs", 1);
    console.error("worker-bundle.js could not be fetched:", err && err.message);
    return;
  }

  if (gen !== bootGen) return;      // superseded while the bundle was loading
  if (worker) { worker.terminate(); worker = null; }

  // Prefer a same-origin file worker: it is what the page's CSP (`worker-src 'self'
  // blob:`) is written for and the browser already has the bundle cached from the
  // fetch above.  A Blob worker is the fallback for hosts that serve the bundle with
  // an odd MIME type; the main-thread shim is last and needs `unsafe-eval`, so under
  // the shipped CSP only `?noworker` on a relaxed host ever reaches it.
  const forceInline = /[?&]noworker\b/.test(location.search);
  try {
    if (forceInline) throw new Error("inline worker forced with ?noworker");
    try {
      worker = new Worker(new URL("./worker-bundle.js", import.meta.url));
    } catch (err) {
      console.warn("File worker unavailable, trying a Blob worker:", err && err.message);
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    }
  } catch (err) {
    console.warn("Worker unavailable, simulating on the main thread:", err && err.message);
    try {
      worker = makeInlineWorker(src);
    } catch (evalErr) {
      // Under the shipped CSP (no 'unsafe-eval') the main-thread fallback is refused too.
      console.error("The main-thread engine could not start:", evalErr && evalErr.message);
      worker = null;
      status("This browser blocked the simulation engine (no worker and no eval). Try another browser.", 1);
      return;
    }
  }

  worker.onmessage = (e) => onWorkerMessage(e.data || {});
  worker.onerror = (err) => { status("Simulation failed — see the console", 1); console.error(err); };

  const state = State.get();
  status("Starting the simulation engine…", 0.05);
  worker.postMessage({
    type: "init",
    load: ctx.loadSet,
    tariffs: ctx.tariff,
    solar: { byPlane: state.solar.byPlane },
  });
}

function onWorkerMessage(m) {
  if (m.type === "ready") {
    workerReady = true;
    ctx.planOptions = (m.plans || []).map((p) => ({ v: p.id, t: p.name || p.id }));
    ctx.providerOptions = (m.providers || []).map((p) => ({ v: p.id, t: p.name || p.id }));
    ctx.weeks = Math.max(1, Math.round((m.days || 365) / 7));
    // The engine's own annualisation: fractional usable days / 365.  Every "per
    // year" figure the page prints about the household divides by this, so the
    // top-bar chip and the Assumptions tab agree with the simulated bills.
    ctx.engineYears = Number.isFinite(m.years) && m.years > 0 ? m.years : null;
    ctx.engineAnnualKwh = m.quality && Number.isFinite(m.quality.annualKwh) ? m.quality.annualKwh : null;
    status("", 1);
    runGrid();
    return;
  }
  if (m.type === "progress" && m.id === pendingGrid) {
    status(`Simulating ${m.done} of ${m.total} systems`, m.done / m.total);
    return;
  }
  if (m.type === "grid" && m.id === pendingGrid) {
    ctx.grid = m.grid;
    ctx.flexShiftOnlySavings = m.grid.flexShiftOnlySavings || 0;
    status("", 1);
    repriceAndRender();
    return;
  }
  if (m.type === "detail" && m.id === pendingDetail) {
    ctx.detail = m.detail;
    afterDetail();
    render();
    return;
  }
  if (m.type === "validate" && m.id === pendingReplay) {
    const state = State.get();
    ctx.replay = Object.assign({}, m.result, {
      actual: {
        total: Number(state.ui.replayActual) || null,
        onKwh: null, midKwh: null, offKwh: null, totalKwh: null,
      },
    });
    render();
    return;
  }
  if (m.type === "error") {
    console.error(m.message, m.stack);
    if (m.phase === "init" || m.code === "INSUFFICIENT_DATA") {
      // The engine refused the data itself (e.g. fewer than 300 usable days):
      // say exactly why, and hand the person back a working landing page.
      workerReady = false;
      const msg = m.userMessage || m.message || "The simulation engine could not start with this data.";
      status(msg, 1);
      if (m.code === "INSUFFICIENT_DATA") {
        // The file itself is unusable: drop it from memory and from IndexedDB, so a
        // ZIP typed next does not bounce straight back off the same short file.
        ctx.loadSet = null;
        State.update((s) => { s.load = null; }, "silent");
        State.clearLoadSet();
        ctx.blockReason = "";
      } else {
        ctx.blockReason = msg;
      }
      backToLanding(msg);
      return;
    }
    status("Simulation error — see the console", 1);
    toast(m.userMessage || m.message || "The simulation hit an error. The console has the details.");
  }
}

// ---------------------------------------------------------------- simulation

function simParams() {
  const s = State.get();
  return {
    planes: s.roof.planes.map((p) => ({
      id: p.id, name: p.name, tilt: p.tilt, azimuth: p.azimuth,
      panels: p.maxPanels, maxPanels: p.maxPanels, shading: p.shading,
    })),
    panelW: s.system.panelW, battKWh: s.system.battKWh, battKW: s.system.battKW,
    rte: s.system.rte, minReserve: s.system.minReserve,
    flex: s.flex, baseLoadScale: s.baseLoadScale,
    planId: s.tariff.planId, providerId: s.tariff.providerId,
    weatherKey: s.ui.weatherKey,
    strategy: s.system.strategy, gridCharge: s.system.gridCharge,
    exportThreshold: s.system.exportThreshold, ngom: s.system.ngom,
    // accPlusAdder is deliberately absent: the engine reads it from the tariff file.
    // null for these two means "the tariff file's default".
    baselineRegion: s.site.baselineRegion || null,
    trueUpMonth: s.fin.trueUpMonth || null,
  };
}

function runGrid() {
  if (ctx.blockReason) { status(ctx.blockReason, 1); return; }
  if (!worker || !workerReady) return;
  const s = State.get();
  if (!s.roof.planes.length) { status("Add a roof face on the Roof tab to simulate.", 1); return; }
  pendingGrid = ++reqId;
  markStale();
  status("Simulating…", 0.02);
  worker.postMessage({
    type: "grid", id: pendingGrid, params: simParams(),
    maxPanelsTotal: s.system.maxPanels, maxBatteries: s.system.maxBatteries, step: 1,
  });
}

function runDetail(cell) {
  if (!worker || !workerReady || !cell) return;
  const key = JSON.stringify(simParams()) + "|" + JSON.stringify(cell.panelsByPlane) + "|" + cell.batteries;
  if (key === lastDetailKey) return;
  lastDetailKey = key;
  pendingDetail = ++reqId;
  worker.postMessage({
    type: "detail", id: pendingDetail, params: simParams(),
    panelsByPlane: cell.panelsByPlane, batteries: cell.batteries,
    weatherKeys: weatherKeysForDetail(State.get()),
  });
}

/**
 * Which weather scenarios the fetched profiles support, in the order they are
 * offered: the typical year, then whichever exceedance percentiles the
 * percentile pass found, then every individual year.  The two callers below
 * label the same list differently — a rail option and a worker request.
 */
function weatherScenarios(s) {
  const out = [{ key: "tmy", year: null }];
  const first = Object.values(s.solar.byPlane)[0];
  if (!first) return out;
  const pc = first.percentiles || {};
  for (const p of ["p90", "p50", "p10"]) {
    if (pc[p + "Year"]) out.push({ key: p, year: pc[p + "Year"] });
  }
  for (const k of Object.keys(first.profiles || {}).filter((k) => k !== "tmy").sort()) {
    out.push({ key: k, year: k });
  }
  return out;
}

const PERCENTILES = {
  p90: { option: "P90 — conservative, low sun", detail: "P90 low" },
  p50: { option: "P50 — median year", detail: "P50 med" },
  p10: { option: "P10 — optimistic, high sun", detail: "P10 high" },
};

function weatherKeysForDetail(s) {
  return weatherScenarios(s).map(({ key, year }) => {
    if (key === "tmy") return { key, label: "TMY", group: "ref" };
    const pc = PERCENTILES[key];
    if (pc) return { key, label: `${pc.detail} (${year})`, group: "ref" };
    return { key, label: key, group: "year" };
  });
}

function runReplay() {
  const s = State.get();
  if (!worker || !workerReady) return;
  if (!s.ui.replayStart || !s.ui.replayEnd) { toast("Enter both dates of the billing period first."); return; }
  pendingReplay = ++reqId;
  worker.postMessage({
    type: "validate", id: pendingReplay,
    params: { planId: s.tariff.planId, providerId: s.tariff.providerId },
    start: s.ui.replayStart, end: s.ui.replayEnd,
  });
}

// ------------------------------------------------------------------ pricing

/**
 * Finance inputs as priced.  `roofCostAdder` is the one-time "Extra cost $" of
 * every roof face the system being priced actually puts panels on (a re-roof
 * under that face, a long conduit run); core/finance adds it to the gross cost
 * when the system has panels.  It differs from cell to cell, so callers pass the
 * cell's own figure from roofAdderFor(); priceGridWithRoof does it per cell.
 */
function finEff(roofCostAdder = 0) {
  const s = State.get();
  const ngomCost = (ctx.tariff && ctx.tariff.meta && ctx.tariff.meta.ngom_cost) || NGOM_COST_DEFAULT;
  return Object.assign({}, s.fin, {
    adder: s.fin.adder + (s.system.ngom ? ngomCost : 0),
    roofCostAdder: Number.isFinite(roofCostAdder) && roofCostAdder > 0 ? roofCostAdder : 0,
  });
}

/**
 * Sum of `costAdder` over the faces this cell puts at least one panel on.  The
 * optimiser fills faces greedily, so the allocation per cell is known exactly
 * (cell.panelsByPlane, aligned with cell.planeIds); a face the optimiser leaves
 * empty costs nothing.  An override cell from the map carries the same arrays.
 */
export function roofAdderFor(cell, planes = State.get().roof.planes) {
  if (!cell || !cell.panels) return 0;
  const byId = new Map(planes.map((p) => [p.id, Number(p.costAdder) || 0]));
  const alloc = cell.panelsByPlane;
  let sum = 0;
  if (Array.isArray(alloc)) {
    const ids = cell.planeIds || planes.map((p) => p.id);
    ids.forEach((id, k) => { if ((alloc[k] || 0) > 0) sum += Math.max(0, byId.get(id) || 0); });
  } else if (alloc && typeof alloc === "object") {
    for (const [id, n] of Object.entries(alloc)) if (n > 0 && byId.has(id)) sum += Math.max(0, byId.get(id));
  } else {
    // No allocation on the cell: every face with room is assumed used (an overestimate).
    for (const p of planes) if (p.maxPanels > 0) sum += Math.max(0, Number(p.costAdder) || 0);
  }
  return sum;
}

/**
 * core/optimizer.priceGrid prices every cell with one finance object, but the
 * roof adder depends on which faces a cell uses.  The greedy allocation means
 * there are at most (faces + 1) distinct adders, usually one or two, so the grid
 * is priced once per distinct adder and each cell taken from its own pricing;
 * the winner is then picked exactly as priceGrid picks it.  With no adders set
 * (the common case) this is a single priceGrid call.
 */
function priceGridWithRoof(grid, obj, basis) {
  const O = Core.optimizer;
  const planes = State.get().roof.planes;
  const groups = new Map();                       // adder -> cell indices
  grid.cells.forEach((c, i) => {
    const a = roofAdderFor(c, planes);
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(i);
  });
  if (groups.size <= 1) {
    const a = groups.size ? groups.keys().next().value : 0;
    const priced = O.priceGrid(grid, finEff(a), obj, basis);
    for (const c of priced.cells) c.roofCostAdder = c.panels ? a : 0;
    return priced;
  }
  let first = null;
  const cells = new Array(grid.cells.length);
  for (const [a, idx] of groups) {
    const sub = O.priceGrid(Object.assign({}, grid, { cells: idx.map((i) => grid.cells[i]) }), finEff(a), obj, basis);
    idx.forEach((i, k) => { cells[i] = sub.cells[k]; cells[i].roofCostAdder = a; });
    if (!first) first = sub;
  }
  const better = (O.OBJECTIVES[first.objective] || O.OBJECTIVES.npv).better;
  let best = null;
  for (const c of cells) {
    if (c.panels === 0 && c.batteries === 0) continue;   // "do nothing" is the baseline, not a candidate
    if (!best || better(c, best)) best = c;
  }
  if (best && best.npv <= 0 && first.objective === "npv") best.beatenByDoingNothing = true;
  return Object.assign({}, first, {
    cells, best, doNothing: cells.find((c) => c.panels === 0 && c.batteries === 0),
  });
}

/** null (not −1, and certainly not `null >= 0`) means "let the optimiser choose". */
export function overrideBatteries(s) {
  const b = s.system.override.batteries;
  return typeof b === "number" && Number.isFinite(b) && b >= 0 ? b : null;
}

function selectedCell(priced) {
  const s = State.get();
  const b = overrideBatteries(s);
  if (b !== null && Core.optimizer) {
    // An override names a battery count; the panel count comes from the map if
    // the user clicked a cell, else from the optimum for that many batteries.
    const p = s.system.override.panelsByPlane;
    if (p && p.__total !== undefined) {
      const hit = Core.optimizer.findCell(priced, p.__total, b);
      if (hit) return hit;
    }
    const row = priced.cells.filter((c) => c.batteries === b);
    if (row.length) return row.reduce((a, c) => (c.npv > a.npv ? c : a));
  }
  return priced.best;
}

/**
 * IRR and payback can fail to rank systems: with nothing paid up front and
 * savings above the payments from year one, every cell's cash flow never
 * changes sign, so IRR is undefined and payback is zero everywhere.  When the
 * chosen objective cannot separate the cells the optimiser falls back to NPV
 * and the page says so beside the objective control (ctx.objective).
 */
function priceWithFallback(s) {
  let obj = s.ui.objective;
  let priced = priceGridWithRoof(ctx.grid, obj, s.ui.basis);
  const cells = priced.cells || [];
  const useless = (obj === "irr" && cells.every((c) => c.projectIrr === null || c.projectIrr === undefined))
    || (obj === "payback" && cells.every((c) => !c.payback));
  if (useless) { obj = "npv"; priced = priceGridWithRoof(ctx.grid, obj, s.ui.basis); }
  ctx.objective = obj;
  return priced;
}

function repriceAndRender() {
  if (!ctx.grid || !Core.optimizer) return;
  const s = State.get();
  ctx.priced = priceWithFallback(s);
  ctx.selected = selectedCell(ctx.priced);
  ctx.baselineBill = ctx.priced.baseline ? ctx.priced.baseline.bill : 0;

  if (Core.finance && ctx.selected) {
    const finSel = finEff(roofAdderFor(ctx.selected));
    const f = Core.finance.withDefaults(finSel);
    ctx.effectiveDiscount = Core.finance.effectiveDiscount(f);
    const sim = {
      savings: ctx.selected.savings, importSavings: ctx.selected.importSavings,
      exportRevenue: ctx.selected.exportRevenue, accPlusRevenue: ctx.selected.accPlusRevenue, bill: ctx.selected.bill,
      baselineBill: ctx.baselineBill, pvKwh: ctx.selected.pvKwh,
      kwdc: ctx.selected.kwdc, battKWhTotal: ctx.selected.battKWhTotal,
    };
    ctx.breakEvenPerW = Core.finance.breakEven(sim, finSel, "costPerW");
    ctx.breakEvenPerKwh = Core.finance.breakEven(sim, finSel, "costPerKwh");
    // The same system bought outright, so a loan or lease tile can state the
    // financing decision as a dollar gap rather than leave it to the IRR/APR hint.
    ctx.cashNpv = f.financing.mode === "cash" ? null
      : Core.finance.evaluate(sim, Object.assign({}, finSel, { financing: Object.assign({}, f.financing, { mode: "cash" }) })).npv;
  }

  clearStale();
  afterDetail();
  render();
  runDetail(ctx.selected);
}

/** Derived views that need both the priced grid and the detail run. */
function afterDetail() {
  const s = State.get();
  if (!ctx.selected) return;

  // The grid sweep runs without `detail`, so its baselines carry no monthly
  // breakdown; only the single detail run does. The month-by-month chart
  // therefore reads its "before" bars from the detail run's own baseline.
  if (ctx.detail) {
    const base = s.ui.basis === "asRecorded" ? ctx.detail.baselineAsRecorded : ctx.detail.baselineSameFlex;
    ctx.baselineMonthly = base && base.monthly ? base.monthly : null;
  }

  if (Core.optimizer && ctx.priced) {
    ctx.tornado = Core.optimizer.tornado(
      ctx.selected, finEff(roofAdderFor(ctx.selected)), ctx.baselineBill,
      ctx.detail ? ctx.detail.flexVariants : null,
    );
  }

  if (ctx.detail && ctx.detail.weather && Core.finance) {
    const finSel = finEff(roofAdderFor(ctx.selected));
    ctx.weatherRows = ctx.detail.weather.map((w) => {
      const f = Core.finance.evaluate({
        savings: w.savings, importSavings: w.importSavings, exportRevenue: w.exportRevenue,
        accPlusRevenue: w.accPlusRevenue, bill: w.bill, baselineBill: w.baselineBill,
        pvKwh: w.pvKwh, kwdc: ctx.selected.kwdc, battKWhTotal: ctx.selected.battKWhTotal,
      }, finSel);
      return { key: w.key, label: w.label, npv: f.npv, savings: f.firstYearSavings,
               pv: w.pvKwh, perKw: ctx.selected.kwdc ? w.pvKwh / ctx.selected.kwdc : null };
    });
    const mine = ctx.weatherRows.find((r) => r.key === s.ui.weatherKey);
    ctx.annualPerKw = mine ? mine.perKw : null;
  }

  // The cheapest plan and provider for this system, for the dashboard's
  // "what to try next" chips. Cheapest with-system bill, not biggest saving:
  // a plan with a ruinous baseline can show a huge saving and still cost more.
  ctx.bestPlan = null; ctx.bestPlanGain = 0;
  ctx.bestProvider = null; ctx.bestProviderGain = 0;
  if (ctx.detail && Array.isArray(ctx.detail.plans) && ctx.detail.plans.length) {
    const best = ctx.detail.plans.reduce((a, p) => (p.bill < a.bill ? p : a));
    const mine = ctx.detail.plans.find((p) => p.planId === s.tariff.planId);
    ctx.bestPlan = { planId: best.planId, name: best.name || best.planId };
    ctx.bestPlanGain = mine ? mine.bill - best.bill : 0;
  }
  if (ctx.detail && Array.isArray(ctx.detail.providers) && ctx.detail.providers.length) {
    const best = ctx.detail.providers.reduce((a, p) => (p.bill < a.bill ? p : a));
    const mine = ctx.detail.providers.find((p) => p.id === s.tariff.providerId);
    ctx.bestProvider = { id: best.id, name: best.name || best.id };
    ctx.bestProviderGain = mine ? mine.bill - best.bill : 0;
  }

  ctx.week = buildWeek();
  ctx.planLabel = planLabel();
}

/**
 * The Loads tab's before/after week: the average weekday-to-Sunday shape of the
 * recorded load against the shape the simulation actually charges for.
 */
function buildWeek() {
  const s = State.get();
  if (!ctx.loadSet || !ctx.loadSet.ts) return null;
  if (!Core.flexload || !Core.engine) return null;

  try {
    const cal = Core.flexload.buildCalendar(ctx.loadSet);
    const before = new Float64Array(168);
    const after = new Float64Array(168);
    const count = new Float64Array(168);
    const recorded = ctx.loadSet.kwh;

    const reshaped = s.flex.map((f) => Core.flexload.reshape(f, cal, null));
    const detectedTotal = new Float64Array(recorded.length);
    for (const f of s.flex) {
      if (f.kwhByHour) for (let i = 0; i < recorded.length; i++) detectedTotal[i] += f.kwhByHour[i] || 0;
    }

    for (let i = 0; i < recorded.length; i++) {
      const v = recorded[i];
      if (!Number.isFinite(v)) continue;
      // cal.dayDow is per day and JS-ordered (0 = Sunday); the chart reads Mon..Sun.
      const dow = (cal.dayDow[cal.dayIdx[i]] + 6) % 7;
      const slot = (dow * 24) + cal.hourA[i];
      before[slot] += v;
      let scheduled = (v - detectedTotal[i]) * s.baseLoadScale;
      for (const r of reshaped) scheduled += (r && r[i]) || 0;
      after[slot] += scheduled;
      count[slot] += 1;
    }
    let totalBefore = 0, totalAfter = 0;
    for (let k = 0; k < 168; k++) {
      const n = count[k] || 1;
      before[k] /= n; after[k] /= n;
      totalBefore += before[k]; totalAfter += after[k];
    }
    const labels = Array.from({ length: 168 }, (_, i) =>
      (i % 24 === 12 ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(i / 24)] : ""));
    return { before: Array.from(before), after: Array.from(after), labels,
             totalBefore, totalAfter, label: "average across your whole record" };
  } catch (err) {
    console.warn("Could not build the week comparison:", err && err.message);
    return null;
  }
}

function planLabel() {
  const s = State.get();
  if (!ctx.tariff) return s.tariff.planId || "";
  const plan = Core.tariff ? Core.tariff.plan(ctx.tariff, s.tariff.planId) : null;
  const prov = hasOwn(ctx.tariff.providers, s.tariff.providerId) ? ctx.tariff.providers[s.tariff.providerId] : null;
  return [(plan && plan.name) || s.tariff.planId, prov && prov.name].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------- status

function status(text, frac) {
  ctx.statusText = text || "";
  const label = $("status-text");
  const bar = $("status-bar");
  if (label) label.textContent = text || "";
  if (bar) {
    bar.firstElementChild.style.width = Math.round((frac || 0) * 100) + "%";
    bar.style.visibility = (frac >= 1 || !text) ? "hidden" : "visible";
  }
}

const markStale = () => document.querySelectorAll(".card, .headline").forEach((n) => n.classList.add("stale"));
const clearStale = () => document.querySelectorAll(".stale").forEach((n) => n.classList.remove("stale"));

// --------------------------------------------------------------- tabs + rail

let rail = null;
let mountedTab = null;

/**
 * The tab strip follows the ARIA tabs pattern: one tab in the Tab order (the
 * selected one, roving tabindex), Left/Right/Home/End move between tabs and
 * select them as they go, and a click (or Enter/Space on the focused tab) moves
 * focus into the pane so a keyboard or screen-reader user lands on the content.
 */
function buildTabStrip() {
  const strip = clear($("tabs"));
  for (const id of State.TABS) {
    const mod = TAB_MODULES[id];
    const selected = State.get().ui.tab === id;
    strip.appendChild(el("button", {
      type: "button", role: "tab", id: "tab-" + id,
      "aria-selected": String(selected), tabindex: selected ? "0" : "-1",
      "aria-controls": "pane", text: mod.label,
      on: { click: () => goTab(id) },
    }));
  }
  if (!strip.dataset.keys) {
    strip.dataset.keys = "1";
    strip.addEventListener("keydown", onTabKey);
  }
}

function onTabKey(e) {
  const ids = State.TABS;
  const at = ids.indexOf(normalizeTab(State.get().ui.tab));
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = ids[(to + ids.length) % ids.length];
  goTab(next, { focusPane: false });
  const btn = $("tab-" + next);
  if (btn) btn.focus();
}

/** Set by goTab, read once by the next mountTab: whether focus follows into the pane. */
let focusPaneOnMount = false;

function goTab(id, opts = {}) {
  focusPaneOnMount = opts.focusPane !== false;
  State.setAt("ui.tab", normalizeTab(id), "tab");
}

function mountTab() {
  const s = State.get();
  if (!State.TABS.includes(s.ui.tab)) s.ui.tab = normalizeTab(s.ui.tab);
  const mod = TAB_MODULES[s.ui.tab] || TAB_MODULES.dashboard;
  if (mountedTab === mod) return;
  if (mountedTab && typeof mountedTab.unmount === "function") mountedTab.unmount();
  destroyAll();
  mountedTab = mod;

  for (const id of State.TABS) {
    const btn = $("tab-" + id);
    if (btn) {
      btn.setAttribute("aria-selected", String(id === s.ui.tab));
      btn.tabIndex = id === s.ui.tab ? 0 : -1;
      // A phone's strip scrolls sideways: keep the selected tab on screen.
      if (id === s.ui.tab && btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  const pane = $("pane");
  pane.scrollTop = 0;
  pane.setAttribute("aria-labelledby", "tab-" + s.ui.tab);
  mod.mount(pane, s, ctx);
  rail.build(mod.rail(s, ctx), s);
  if (focusPaneOnMount) {
    focusPaneOnMount = false;
    pane.focus({ preventScroll: true });
    // On a phone the page itself scrolls: bring the new tab's top into view
    // (the sticky tab strip stays above it; see .pane scroll-margin-top).
    if (pane.getBoundingClientRect().top < 0) pane.scrollIntoView({ block: "start" });
  }
}

/**
 * Phones and narrow windows stack the results first and the controls after them
 * (styles.css, max-width 1000px), so one floating button jumps between the two:
 * "Settings" while the results are on screen, "Results" once the rail is.  Wide
 * screens hide it; the rail is always beside the pane there.
 */
function buildRailJump() {
  if ($("rail-jump")) return;
  const railNode = document.querySelector(".rail");
  const pane = $("pane");
  if (!railNode || !pane) return;
  let railInView = false;
  const btn = el("button.rail-jump", { id: "rail-jump", type: "button", text: "Settings",
    "aria-label": "Jump to the settings" });
  const paint = () => {
    btn.textContent = railInView ? "Results ↑" : "Settings ↓";
    btn.setAttribute("aria-label", railInView ? "Jump back to the results" : "Jump to the settings");
  };
  btn.addEventListener("click", () => {
    const target = railInView ? pane : railNode;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (railInView) pane.focus({ preventScroll: true });
    else {
      const first = railNode.querySelector("summary, input, select, button");
      if (first) first.focus({ preventScroll: true });
    }
  });
  // "In view" once the rail's top has scrolled into the upper 60% of the screen.
  let queued = false;
  const check = () => {
    queued = false;
    const now = railNode.getBoundingClientRect().top < window.innerHeight * 0.6;
    if (now !== railInView) { railInView = now; paint(); }
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(check); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  paint();
  onScroll();
  $("shell").appendChild(btn);
}

function render() {
  const s = State.get();
  if (!mountedTab) return;
  ctx.householdAnnualKwh = householdAnnualKwh();
  refreshOptions(s);
  rail.refresh(s);
  try { mountedTab.render(s, ctx); }
  catch (err) { console.error(`The ${s.ui.tab} tab could not render:`, err); }
  renderTopBar(s);
}

function refreshOptions(s) {
  if (ctx.planOptions.length) rail.setOptions("tariff.planId", ctx.planOptions, s);
  if (ctx.providerOptions.length) rail.setOptions("tariff.providerId", ctx.providerOptions, s);
  if (ctx.utilityOptions.length) rail.setOptions("site.utilityId", ctx.utilityOptions, s);
  ctx.baselineRegionOptions = baselineRegionOptions();
  rail.setOptions("site.baselineRegion", ctx.baselineRegionOptions, s);
  if (ctx.weatherOptions.length) rail.setOptions("ui.weatherKey", ctx.weatherOptions, s);
}

/** Hours with a reading: the parser's quality count when it has one, else the finite kWh. */
function usableHours(loadSet) {
  if (!loadSet) return 0;
  const q = loadSet.meta && loadSet.meta.quality;
  if (q && Number.isFinite(q.usableHours) && q.usableHours > 0) return q.usableHours;
  let n = 0;
  const k = loadSet.kwh || [];
  for (let i = 0; i < k.length; i++) if (Number.isFinite(k[i])) n++;
  return n;
}

/** The baseline-region picker for the current rate book; "" = the tariff file's default. */
function baselineRegionOptions() {
  const list = ctx.tariff && Core.tariff && Core.tariff.baselineRegionList
    ? Core.tariff.baselineRegionList(ctx.tariff) : [];
  const def = list.find((r) => r.isDefault);
  return [{ v: "", t: def ? `Utility default (${def.label})` : "Utility default" }]
    .concat(list.map((r) => ({ v: r.id, t: r.label })));
}

/**
 * The household's annual kWh as the engine counts it (sum of readings over
 * usableDays / 365).  Before the engine has reported, the same total over the
 * engine's years if known, else over usable hours / 8760 - which can differ by
 * a day's worth on a record with partial days, so it is only a placeholder.
 */
function householdAnnualKwh() {
  if (!ctx.loadSet) return null;
  if (ctx.engineAnnualKwh !== null) return ctx.engineAnnualKwh;
  const meta = ctx.loadSet.meta || {};
  const years = ctx.engineYears || usableHours(ctx.loadSet) / 8760;
  return meta.totalKwh && years ? meta.totalKwh / years : null;
}

/** The rail's "The next N years" group follows the horizon slider (the rail is only rebuilt on a tab change). */
function syncHorizonTitle(s) {
  const years = s.fin && s.fin.horizon;
  if (!Number.isFinite(years)) return;
  for (const sum of document.querySelectorAll(".rail details.group > summary")) {
    if (/^The next \d+ years$/.test(sum.textContent)) sum.textContent = futureTitle(years);
  }
}

function renderTopBar(s) {
  const chip = $("household-chip");
  if (!chip) return;
  const annual = ctx.householdAnnualKwh;
  const bits = [];
  if (annual) bits.push(fmtKwh(annual, 0) + "/yr");
  if (s.site.utilityId) bits.push(UTILITY_SHORT[s.site.utilityId] || utilityName(s.site.utilityId));
  if (s.flex.length) bits.push(s.flex.length === 1 ? s.flex[0].name : `${s.flex.length} flexible loads`);
  if (s.roof.planes.length) bits.push(`${s.roof.planes.length} roof ${s.roof.planes.length === 1 ? "face" : "faces"}`);
  clear(chip);
  chip.appendChild(el("span.mono", { text: bits[0] || "no data" }));
  if (bits.length > 1) chip.appendChild(el("span", { text: bits.slice(1).join(" · ") }));
}

// ------------------------------------------------------------------ actions

const debounce = (fn, ms) => {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};
const queueSim = debounce(runGrid, 160);

function onControlSet(path, value, spec) {
  // A handful of rail entries are verbs, not values.
  if (path === "ui.runReplay") { runReplay(); return; }
  if (path === "ui.goLoads") { goTab("loads"); return; }
  if (path === "ui.addPreset") { if (value) addPreset(value); return; }
  if (path === "ui.assumptionsJump") { const n = $(value); if (n) n.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  // The person picked it in the rail: an explicit choice, which may lift a coverage block.
  if (path === "site.utilityId") { switchUtility(value, { explicit: true }); return; }
  // "" in these two selects means "let the tariff file decide".
  if (path === "site.baselineRegion" || path === "fin.trueUpMonth") {
    const v = value === "" || value === null || value === undefined ? null
      : (path === "fin.trueUpMonth" ? Number(value) : String(value));
    State.update((s) => { State.setPath(s, path, v); }, "sim");
    return;
  }

  const reason = spec.reason || defaultReason(path);
  State.update((s) => {
    State.setPath(s, path, value);
    // Choosing export arbitrage without the meter that makes it billable is a
    // trap, so the meter comes on with it.
    if (path === "system.strategy" && value === "export_arbitrage") s.system.ngom = true;
    if (path === "system.override.batteries") {
      // Anything negative (or blank) means "back to the optimiser".
      if (!Number.isFinite(value) || value < 0) {
        s.system.override.batteries = null;
        s.system.override.panelsByPlane = null;
      }
    }
  }, reason);
}

/**
 * A different utility is a different rate book: the worker was initialised
 * with the old one, so it has to be re-booted with the new tariffs, and the
 * plan and provider fall back to that utility's defaults.
 */
async function switchUtility(utilityId, opts = {}) {
  if (!utilityOf(utilityId)) return;
  // A programmatic switch while a muni / out-of-state block stands changes nothing.
  if (ctx.coverageBlocked && !opts.explicit) return;
  State.update((s) => {
    s.site.utilityId = utilityId;
    s.tariff.planId = null;
    s.tariff.providerId = null;
    s.site.baselineRegion = null;
  }, "silent");
  const ok = await chooseTariff(null, { explicit: !!opts.explicit });
  if (ok) ctx.siteNotice = "";
  renderBanner();
  markStale();
  await bootWorker();
  render();
}

/**
 * Coordinates typed or clicked on the Roof tab.  They never consult coverage by
 * themselves (there is no reverse geocoder offline), so the utility is kept and
 * the person is told so in one line; when a geocoder did supply a city, that
 * city goes through coverage like a landing-page lookup.  A coverage block
 * stands either way: a new point never restores a run on a blocked utility.
 */
async function onSiteChange(site) {
  if (!site || !Number.isFinite(Number(site.lat)) || !Number.isFinite(Number(site.lon))) return;
  const before = State.get().site;
  const moved = before.lat === null || before.lon === null
    || State.roundCoord(before.lat) !== State.roundCoord(site.lat)
    || State.roundCoord(before.lon) !== State.roundCoord(site.lon);
  if (site.city || site.state) {
    const prior = utilityOf(before.utilityId) ? before.utilityId : null;
    await chooseTariff(null, { geo: { city: site.city, state: site.state }, prior });
  } else if (moved && ctx.loadSet && ctx.coverageOk && !ctx.coverageBlocked && before.utilityId) {
    ctx.siteNotice = `Location changed; utility still ${utilityName(before.utilityId)}. `
      + "Change it on the Bills tab if that is wrong.";
  }
  State.update((s) => {
    s.site.lat = Number(site.lat);
    s.site.lon = Number(site.lon);
  }, "site");
  if (inApp) renderBanner();
}

function pickCell(panels, batteries) {
  State.update((s) => {
    s.system.override.batteries = batteries;
    s.system.override.panelsByPlane = { __total: panels };
  }, "finance");
}

function addPreset(kind) {
  if (!Core.flexload) { toast("The load library is not loaded."); return; }
  const templates = Core.flexload.presets();
  const tpl = templates.find((t) => t.id === kind) || templates[0];
  const s = State.get();
  const detectedEv = s.flex.find((f) => f.kind === "ev" && f.source === "detected");
  const next = JSON.parse(JSON.stringify(tpl));
  next.id = kind + "-" + Date.now().toString(36);
  if (kind === "ev2" && detectedEv) {
    next.annualKwh = detectedEv.annualKwh;
    next.schedule.maxKW = detectedEv.schedule.maxKW;
  }
  State.update((st) => { st.flex = st.flex.concat([next]); }, "sim");
  toast(`${next.name} added.`);
}

const ACTIONS = {
  goTab,
  pickCell,
  addPreset,
  setSeason: (v) => State.setAt("ui.season", Number(v), "ui"),
  clearOverride: () => State.update((s) => {
    s.system.override.batteries = null;
    s.system.override.panelsByPlane = null;
  }, "finance"),
  setProvider: (id) => State.setAt("tariff.providerId", id, "sim"),
  setPlan: (id) => State.setAt("tariff.planId", id, "sim"),
  setStrategy: (v) => State.setAt("system.strategy", v, "sim"),
  setFinancing: (mode) => State.setAt("fin.financing.mode", mode, "finance"),
  setMaxPanels: (n) => State.setAt("system.maxPanels", n, "sim"),
  setSite: (site) => onSiteChange(site),
  setPlanes: (planes) => State.update((s) => { s.roof.planes = planes; }, "roof"),
  /**
   * The installer-proposal path hands back the annual kWh on the quote. It is
   * a cross-check on the model, not an input to it: the ratio between the two
   * is shown on the Roof tab so a wildly optimistic proposal is visible.
   */
  setCalibration: (cal) => {
    ctx.installerAnnualKwh = cal && cal.installerAnnualKwh ? Number(cal.installerAnnualKwh) : null;
    render();
  },
  updatePlane: (id, key, value) => State.update((s) => {
    const p = s.roof.planes.find((x) => x.id === id);
    if (p) p[key] = value;
  }, "roof"),
  addPlane: () => State.update((s) => {
    const n = s.roof.planes.length + 1;
    // Never reuse an id: after deleting p2 of [p1, p2, p3], "p" + length would be p3 again.
    const used = new Set(s.roof.planes.map((p) => p.id));
    let k = n;
    while (used.has("p" + k)) k++;
    s.roof.planes.push(defaultPlane("p" + k, n === 1 ? "South face" : `Roof face ${n}`));
  }, "roof"),
  removePlane: (id) => State.update((s) => { s.roof.planes = s.roof.planes.filter((p) => p.id !== id); }, "roof"),
  resetPlanes: () => State.update((s) => { s.roof.planes = [defaultPlane("p1", "South face")]; }, "roof"),
  updateFlex: (id, path, value) => State.update((s) => {
    const f = s.flex.find((x) => x.id === id);
    if (f) State.setPath(f, path, value);
  }, "sim"),
  removeFlex: (id) => State.update((s) => { s.flex = s.flex.filter((f) => f.id !== id); }, "sim"),
};

ctx.actions = ACTIONS;

function defaultPlane(id, name) {
  return {
    id, name, tilt: 20, azimuth: 180, maxPanels: 24,
    shading: { annual: 0 }, costAdder: 0, polygon: null, gutterEdge: null,
  };
}

// --------------------------------------------------------------- state wiring

let solarSeq = 0;

/**
 * Nothing is written to the URL or to localStorage until there is actually a
 * session to keep: a visitor who lands, reads the privacy panel and leaves
 * should find the address bar exactly as they left it and this origin's
 * storage empty.
 */
let persist = false;

/**
 * Roof and location edits arrive at keystroke rate; sunlight is re-modelled and
 * the grid re-run once the edits stop for 160 ms (the same pause as queueSim),
 * and only by the newest call - a superseded ensureSolar resolves false and
 * never touches the worker.
 */
async function refreshSolarAndGrid() {
  const latest = await ensureSolar();
  if (latest) { markStale(); runGrid(); }
}
const queueSolar = debounce(refreshSolarAndGrid, 160);

State.subscribe((s, reason, info) => {
  // Debounced (300 ms) and wrapped in try/catch inside state.js: a slider drag
  // used to call replaceState 60 times a second and Safari throws after ~100.
  if (persist) State.persistSoon();
  // Everything below needs the shell; during boot and intake there is none yet.
  if (!rail || reason === "silent") return;

  if (reason === "tab" || info.tabChanged) { mountTab(); render(); return; }
  syncHorizonTitle(s);

  if (reason === "roof" || reason === "site") {
    rail.refresh(s);
    queueSolar();
    render();
    return;
  }
  if (reason === "sim") { markStale(); rail.refresh(s); queueSim(); return; }
  if (reason === "finance") { repriceAndRender(); return; }
  render();
});

// ------------------------------------------------------------------- solar

/**
 * Weather depends only on the site, never on tilt or azimuth, so one fetch set
 * per rounded location serves every roof edit.  Concurrent callers for the
 * same site share the one in-flight promise; a failure is not memoised.
 */
let weatherMemo = { key: "", promise: null };
/** Aborts the in-flight sunlight fetch ("Forget my data", or a new site). */
let weatherAbort = null;
const siteKey = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;

function weatherFor(s) {
  const key = siteKey(s.site.lat, s.site.lon);
  if (weatherMemo.key === key && weatherMemo.promise) return weatherMemo.promise;
  let fromCache = true;
  if (weatherAbort) weatherAbort.abort();        // the old site's fetch is no longer wanted
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  weatherAbort = ac;
  const promise = Core.weather.tryFetchYears({
    lat: s.site.lat, lon: s.site.lon, elevationM: s.site.elevationM ?? undefined,
    signal: ac ? ac.signal : undefined,
    onProgress: ({ index, total, fromCache: cached }) => {
      if (!cached) fromCache = false;
      ctx.solarProgress = Math.max(0.05, (index + 1) / (total || 11));
      ctx.solarStatusText = `Sunlight: year ${index + 1} of ${total}${cached ? " (cached)" : ""}`;
      renderRoofOnly();
    },
  }).then((result) => {
    if (!result.ok && weatherMemo.promise === promise) weatherMemo = { key: "", promise: null };
    return Object.assign({ fromCache }, result);
  });
  weatherMemo = { key, promise };
  return promise;
}

/**
 * Sunlight for every roof face. This is the one place the app goes to the
 * network on the user's behalf, so it is loud about it: a status line, a
 * cache indicator on the Roof tab, and a failure that never blocks anything
 * else on the page.
 *
 * Resolves true only when this call is still the newest one and the profiles
 * are ready; callers run the grid only then.
 */
async function ensureSolar() {
  const s = State.get();
  const seq = ++solarSeq;
  if (!s.roof.planes.length) { ctx.solarStatusText = "Add a roof face."; return false; }
  if (s.site.lat === null || s.site.lon === null) {
    ctx.solarStatusText = "Set a location on the Roof tab before the sunlight can be fetched.";
    s.solar.status = "idle";
    return false;
  }
  if (!Core.weather || !Core.pv) {
    ctx.solarStatusText = "The sunlight model is not available in this build.";
    return false;
  }

  const key = siteKey(s.site.lat, s.site.lon);
  const stale = s.roof.planes.filter((p) => ctx.solarSiteKey !== key || !s.solar.byPlane[p.id]
    || s.solar.byPlane[p.id].tilt !== p.tilt || s.solar.byPlane[p.id].azimuth !== p.azimuth);
  if (!stale.length && (s.solar.weatherYears || []).length) { ctx.solarProgress = 1; return seq === solarSeq; }

  s.solar.status = "loading";
  ctx.solarProgress = 0.05;
  ctx.solarStatusText = "Fetching hourly sunlight for your coordinates…";
  renderRoofOnly();

  const result = await weatherFor(s);
  if (seq !== solarSeq) return false;

  if (!result.ok) {
    s.solar.status = "error";
    s.solar.note = result.message || "";
    ctx.solarProgress = 0;
    ctx.solarStatusText = result.message || "Sunlight could not be fetched.";
    ctx.dataWarnings = ctx.dataWarnings.filter((w) => !/^Sunlight: /.test(w.text));
    addWarning({ severity: "bad", text: `Sunlight: ${result.message}` });
    renderRoofOnly();
    return false;
  }

  ctx.solarStatusText = "Modelling each roof face…";
  renderRoofOnly();
  const years = result.years;
  const now = State.get();             // planes as they are now, not when the fetch began
  for (const plane of now.roof.planes) {
    now.solar.byPlane[plane.id] = Core.pv.profilesForPlane(years, plane, {
      lat: now.site.lat, lon: now.site.lon, elevationM: now.site.elevationM ?? undefined,
    });
  }
  ctx.solarSiteKey = key;
  now.solar.weatherYears = years.map((y) => y.year).filter(Boolean);
  now.solar.status = "ready";
  now.solar.cached = !!result.fromCache;
  ctx.solarProgress = 1;
  ctx.solarStatusText = `Ready — ${now.solar.weatherYears.length} weather years, ${now.roof.planes.length} `
    + `${now.roof.planes.length === 1 ? "face" : "faces"} modelled.`;
  ctx.weatherOptions = buildWeatherOptions(now);

  // The worker caches the profiles at init, so a live (or still-booting) worker
  // has to be re-initialised with the new ones.
  if (worker || bootGen) await bootWorker();
  return seq === solarSeq;
}

function renderRoofOnly() {
  if (mountedTab === roofTab) { try { roofTab.render(State.get(), ctx); } catch { /* mid-mount */ } }
}

function buildWeatherOptions(s) {
  return weatherScenarios(s).map(({ key, year }) => {
    if (key === "tmy") return { v: key, t: "TMY (typical year)" };
    const pc = PERCENTILES[key];
    if (pc) return { v: key, t: `${pc.option} (${year})` };
    return { v: key, t: "Weather year " + key };
  });
}

// ------------------------------------------------------------------- intake

/** An Error whose message is written for the person, which userMessageOf will show. */
function userError(text) { const e = new Error(text); e.userMessage = text; return e; }

async function readFiles(files) {
  if (!Core.greenbutton) throw userError("The Green Button parser is not available in this build.");
  const sets = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      throw userError(`${file.name} is a zip. Unzip it first and drop the CSV or XML inside.`);
    }
    const text = await file.text();
    sets.push(Core.greenbutton.parse(text, { filename: file.name }));
  }
  return sets.length === 1 ? sets[0] : Core.greenbutton.mergeLoadSets(sets);
}

async function onFiles(files) {
  if (!files || !files.length) return;
  supersedeQuestion();
  landingError("");
  landingNotice(null);
  try {
    const loadSet = await readFiles(files);
    // New data: a previous file's "continue anyway" does not carry over.
    State.update((s) => { s.ui.demo = false; s.ui.existingSolarAck = false; }, "silent");
    await adoptLoadSet(loadSet);
  } catch (err) {
    console.error(err);
    // LoadFileError (greenbutton) carries a userMessage written for people.
    landingError(userMessageOf(err, "That file could not be read as Green Button data."));
  }
}

/**
 * The demo household.  A plain click loads it as it is.  Opened from a shared
 * link (`fromLink`), the link is authoritative: only what the link did not set
 * (site, roof, utility/plan/provider, flexible loads) is filled from the demo.
 */
async function onDemo(opts = {}) {
  const fromLink = !!opts.fromLink;
  const has = (k) => fromLink && ctx.linkKeys.has(k);
  supersedeQuestion();
  landingError("");
  landingNotice(null);
  try {
    const names = ["demo-sce-usage-2024-09.csv", "demo-sce-usage-2025-09.csv"];
    const texts = await Promise.all(names.map(async (n) => {
      const res = await fetch(`data/demo/${n}`);
      if (!res.ok) throw userError(`The demo data could not be loaded (data/demo/${n}, HTTP ${res.status}).`);
      return res.text();
    }));
    const sets = texts.map((t, i) => Core.greenbutton.parse(t, { filename: names[i] }));
    const loadSet = Core.greenbutton.mergeLoadSets(sets);
    // A link naming a utility the tariff library has keeps it; the demo's ZIP must not flip it.
    const linkUtil = has("util") && utilityOf(State.get().site.utilityId) ? State.get().site.utilityId : null;
    State.update((s) => {
      // Flagged in the hash so a shared link built on the demo loads the demo.
      s.ui.demo = true;
      s.ui.existingSolarAck = false;
      if (!has("lat")) s.site.lat = 34.15;
      if (!has("lon")) s.site.lon = -118.75;
      if (!has("elev")) s.site.elevationM = 280;
      if (!has("tz")) s.site.tz = "America/Los_Angeles";
      s.site.addressLabel = "Demo household, Agoura Hills CA 91301";
      // The demo is a real house: SCE delivery with Clean Power Alliance 100% Green
      // generation on TOU-D-PRIME, a south-facing roof at 169 degrees with room for far
      // more panels than the optimiser will ever want.
      if (!linkUtil) {
        s.site.utilityId = "sce";
        s.tariff.utilityId = "sce"; s.tariff.planId = "TOU-D-PRIME"; s.tariff.providerId = "cpa_green";
      } else {
        s.tariff.utilityId = linkUtil;
        if (linkUtil === "sce") {
          if (!has("plan")) s.tariff.planId = "TOU-D-PRIME";
          if (!has("prov")) s.tariff.providerId = "cpa_green";
          if (!has("breg") && Core.tariff && Core.tariff.baselineRegionForZip) {
            const r = Core.tariff.baselineRegionForZip(utilityOf("sce"), "91301");
            if (r && r.region && !r.ambiguous) s.site.baselineRegion = String(r.region);
          }
        }
      }
      if (!has("roof") && (!s.roof.planes.length || (s.roof.planes.length === 1 && !s.roof.planes[0].polygon))) {
        s.roof.planes = [Object.assign(defaultPlane("p1", "South face"), { azimuth: 169, maxPanels: 40 })];
      }
    }, "silent");
    await adoptLoadSet(loadSet, linkUtil ? null : "91301", { skipZip: !!linkUtil, keepFlex: has("flex") });
  } catch (err) {
    console.error(err);
    landingError(userMessageOf(err, "The demo data could not be loaded."));
  }
}

/** The service ZIP a meter file names in its own header, if any. */
function fileZipOf(loadSet) {
  const meta = (loadSet && loadSet.meta) || {};
  const z = String(meta.zip || meta.serviceZip || "").slice(0, 5);
  return /^\d{5}$/.test(z) ? z : null;
}

/** Everything that happens once there is a LoadSet, however it arrived. */
async function adoptLoadSet(loadSet, zipHint, opts = {}) {
  ctx.loadSet = loadSet;
  ctx.engineYears = null; ctx.engineAnnualKwh = null;   // until the engine has seen this file
  // What SCE will size against: the metered kWh of the most recent 12 months.
  ctx.recentAnnualKwh = Core.sizing ? Core.sizing.recentAnnualKwh(loadSet) : null;
  const meta = loadSet.meta || {};

  State.update((s) => {
    if (!s.site.tz && meta.tz) s.site.tz = meta.tz;
    s.load = { meta };                       // the arrays live in ctx and IndexedDB
    if (!s.roof.planes.length) s.roof.planes = [defaultPlane("p1", "South face")];
  }, "silent");

  // Flexible loads, detected out of the meter history.
  if (Core.flexload) {
    try {
      const ev = Core.flexload.detectEV(loadSet);
      const pool = Core.flexload.detectPool(loadSet, { evKwhByHour: ev ? ev.kwhByHour : null });
      const found = [ev, pool].filter(Boolean);
      State.update((s) => {
        if (opts.keepFlex) {
          // A link listed the flexible loads: keep exactly that list and only
          // re-attach the detector's hourly slice to the detected entries.
          for (const f of s.flex) {
            const d = f.source === "detected" && found.find((x) => x.kind === f.kind);
            if (d) { f.kwhByHour = d.kwhByHour; f.detection = d.detection; }
          }
          return;
        }
        // A share link (or a saved session) may already describe this household's
        // detected loads with the schedule the person chose.  The detector owns the
        // hourly slice and its provenance; the schedule, scale and name stay theirs.
        const prior = s.flex.filter((f) => f.source === "detected");
        const merged = found.map((d) => {
          const keep = prior.find((f) => f.kind === d.kind && (f.id === d.id || prior.filter((g) => g.kind === d.kind).length === 1));
          return keep ? { ...d, id: keep.id, name: keep.name || d.name, schedule: keep.schedule || d.schedule, scale: keep.scale ?? d.scale } : d;
        });
        const manual = s.flex.filter((f) => f.source === "manual");
        s.flex = merged.concat(manual);
      }, "silent");
    } catch (err) { console.warn("Flexible-load detection failed:", err && err.message); }
  }

  // Which rate book. A ZIP out of the file header beats anything we guessed.
  const zip = opts.skipZip ? null : (zipHint || fileZipOf(loadSet));
  State.saveLoadSet(loadSet);
  // A new file after a coverage block: its utility is asked, never inherited.
  await chooseTariff(zip, { ask: true, forceAsk: !zip && ctx.coverageBlocked });
  await proceedIfClear();
}

/**
 * How much the meter already exports. A file with real export is from a home
 * that already has solar on NEM 1 or 2; the engine reads only import, so the
 * results would describe a different house under a different tariff.
 */
export function existingSolarShare(loadSet) {
  if (!loadSet || !loadSet.exportKwh || !loadSet.kwh) return 0;
  let imp = 0, exp = 0;
  for (let i = 0; i < loadSet.kwh.length; i++) { const v = loadSet.kwh[i]; if (Number.isFinite(v)) imp += v; }
  for (let i = 0; i < loadSet.exportKwh.length; i++) { const v = loadSet.exportKwh[i]; if (Number.isFinite(v) && v > 0) exp += v; }
  return imp > 0 ? exp / imp : (exp > 0 ? 1 : 0);
}
const EXISTING_SOLAR_THRESHOLD = 0.01;
const hasExistingSolar = (ls) => existingSolarShare(ls) > EXISTING_SOLAR_THRESHOLD;

const EXISTING_SOLAR_BLOCK = "This meter already exports power, so it is on NEM 1 or 2 and this tool's Net "
  + "Billing model does not apply yet; results would be wrong.";
const EXISTING_SOLAR_BANNER = "This meter already exports power (NEM 1 or 2). You chose to continue, so import "
  + "is treated as your full usage and your existing panels are ignored. These results are not your real bill.";

/**
 * The single place that decides whether the app may run: there must be data,
 * a modelled utility, and no unacknowledged existing-solar export. Anything
 * missing shows its blocking notice on the landing page instead.
 */
async function proceedIfClear() {
  if (!ctx.loadSet) return false;
  const s = State.get();
  if (!ctx.coverageOk) return false;              // chooseTariff has already said why
  if (hasExistingSolar(ctx.loadSet) && !s.ui.existingSolarAck) {
    showLanding();
    landingNotice({
      tone: "bad",
      text: EXISTING_SOLAR_BLOCK,
      actions: [{
        label: "Continue anyway, treating import as my full usage",
        onClick: () => {
          State.update((st) => { st.ui.existingSolarAck = true; }, "silent");
          landingNotice(null);
          proceedIfClear();
        },
      }],
    });
    return false;
  }
  ctx.blockReason = "";
  if (!inApp) await enterApp();
  else { renderBanner(); await refreshSolarAndGrid(); }
  return true;
}

/**
 * Pick the rate book. With a ZIP (or a geocoder's city) this first asks
 * core/coverage.js whether the model applies there at all:
 *   iou      -> that utility; a ZIP whose prefix two IOUs share (926, 931, 932,
 *               935, 936 - 92672 San Clemente is SDG&E, 92630 Lake Forest SCE)
 *               ASKS which one, through the same question as a split muni ZIP.
 *   muni     -> blocked: a publicly owned utility is not on Net Billing.  A ZIP that
 *               is split with an IOU asks instead, with an explicit IOU choice.
 *   outside  -> blocked: California only.
 *   unknown  -> the person picks the utility explicitly, with a warning.
 * Never silently falls back to the first utility in the library.
 *
 * opts.ask       with no location, ask for a utility rather than give up
 * opts.geo       { city, state } from a geocoder
 * opts.prior     a utility chosen for this same location in an earlier session
 *                (reload only): settles a question it is a valid answer to
 * opts.forceAsk  ask even though a utility is set (new data after a block)
 * opts.explicit  the person picked this utility in the UI.  Only an explicit
 *                pick may lift a coverage block; a programmatic call never does.
 * Resolves true when a modelled utility is in place (ctx.coverageOk).
 */
async function chooseTariff(zip, opts = {}) {
  if (!Core.tariff) return false;
  if (!ctx.tariffLib) {
    try { ctx.tariffLib = await Core.tariff.loadLibrary("data/tariffs"); }
    catch (err) { console.error("The tariff library did not load:", err && err.message); return false; }
  }
  ctx.utilityOptions = (ctx.tariffLib.ids || []).map((id) => ({
    v: id, t: utilityName(id),
  }));

  const s = State.get();
  let utilityId = utilityOf(s.site.utilityId) ? s.site.utilityId : null;
  const geo = opts.geo || {};
  if (zip || geo.city || geo.state) {
    // A new location is undecided until it is decided: nothing may run on the
    // previous location's utility while the question is open.
    ctx.coverageOk = false;
    const cov = Core.coverage
      ? Core.coverage.coverageForZip(zip, ctx.tariffLib, { city: geo.city, state: geo.state })
      : legacyCoverage(zip);
    ctx.coverage = cov;
    const decided = await decideCoverage(cov, zip, opts.prior || null);
    if (!decided) return false;
    utilityId = decided;
  } else if (ctx.coverageBlocked && !opts.explicit && !opts.forceAsk) {
    // A muni or out-of-state block stands until the person picks a utility by hand.
    return false;
  } else if (!utilityId || opts.forceAsk) {
    if (!opts.ask) { ctx.coverageOk = false; return false; }
    const picked = await askUtility("Which utility sends your electricity bill? This file does not say, and no location has been set.");
    if (!picked) return false;
    utilityId = picked;
  }

  const t = utilityOf(utilityId);
  if (!t) { ctx.coverageOk = false; return false; }
  ctx.coverageOk = true;
  ctx.coverageBlocked = false;
  ctx.blockReason = "";
  ctx.tariff = t;
  ctx.climateCredit = Core.tariff.climateCredit(t);
  ctx.escalationNote = (t.meta && t.meta.escalation && t.meta.escalation.note)
    ? shorten(t.meta.escalation.note, 2) : "";
  const region = zip && Core.tariff.baselineRegionForZip ? Core.tariff.baselineRegionForZip(t, zip) : null;

  State.update((s2) => {
    const switched = s2.site.utilityId !== utilityId;
    s2.site.utilityId = utilityId;
    s2.tariff.utilityId = utilityId;
    // A ZIP that straddles two baseline regions leaves the choice to the tariff file's default.
    if (region && region.region && !region.ambiguous) s2.site.baselineRegion = String(region.region);
    else if (switched) s2.site.baselineRegion = null;
    const plan = Core.tariff.defaultPlan(t);
    if (!s2.tariff.planId || !Core.tariff.plan(t, s2.tariff.planId)) s2.tariff.planId = plan.id;
    const prov = Core.tariff.defaultProvider(t);
    if (!s2.tariff.providerId || !(t.providers || {})[s2.tariff.providerId]) s2.tariff.providerId = prov;
    if (t.meta && t.meta.escalation && t.meta.escalation.recommended_default !== undefined
        && s2.fin.escalation === State.DEFAULTS.fin.escalation) {
      s2.fin.escalation = t.meta.escalation.recommended_default;
    }
  }, "silent");
  return true;
}

/** What a bill calls each utility; the chip has no room for the full legal name. */
const UTILITY_SHORT = { pge: "PG&E", sce: "SCE", sdge: "SDG&E" };

const utilityName = (id) => ((utilityOf(id) || {}).utility || {}).name
  || String(id).toUpperCase();

/** If core/coverage.js failed to load, still never guess: unknown unless the tariff prefixes match. */
function legacyCoverage(zip) {
  const hit = zip ? Core.tariff.utilityForZip(zip, ctx.tariffLib) : null;
  if (!hit) return { kind: "unknown" };
  return { kind: "iou", utilityId: hit.ambiguous ? null : hit.utilityId, ambiguous: !!hit.ambiguous,
    candidates: hit.candidates || [hit.utilityId] };
}

/**
 * Turn a coverage answer into a utility id, or null (blocked, declined, or the
 * question was superseded by a newer one).  The decision itself is the pure
 * core/coverage.coverageDecision; this only puts its question on screen.
 */
async function decideCoverage(cov, zip, prior) {
  const ids = ctx.tariffLib.ids || [];
  const C = Core.coverage;
  const d = C && C.coverageDecision
    ? C.coverageDecision(cov, { zip, ids, nameOf: utilityName, prior })
    : (cov.kind === "iou" && !cov.ambiguous ? { utilityId: cov.utilityId }
      : { ask: { tone: "warn", text: "Which utility sends your electricity bill?",
        options: [...ids.map((id) => ({ label: utilityName(id), value: id })), { label: "Another utility", value: "__other" }],
        handPicked: true } });
  if (d.utilityId) return d.utilityId;
  if (d.block) { block(d.block, { coverage: true }); return null; }
  const answer = await ask({ tone: d.ask.tone, text: d.ask.text,
    actions: d.ask.options.map((o) => ({ label: o.label, value: o.value, primary: o.primary })) });
  const a = C && C.answerCoverage ? C.answerCoverage(cov, answer)
    : (answer === null ? { superseded: true } : answer === "__other" || answer === "__muni"
      ? { block: "This tool only models SCE, PG&E and SDG&E under Net Billing for now." } : { utilityId: answer });
  if (a.superseded) return null;                  // a newer question owns the outcome now
  if (a.block) { block(a.block, { coverage: true }); return null; }
  if (d.ask.handPicked) {
    addWarning({ text: `Utility chosen by hand (${utilityName(a.utilityId)}); the ZIP did not identify it.` });
  }
  return a.utilityId;
}

function askUtility(text) {
  return ask({
    tone: "warn",
    text,
    actions: [
      ...(ctx.tariffLib.ids || []).map((id) => ({ label: utilityName(id), value: id })),
      { label: "Another utility", value: "__other" },
    ],
  }).then((v) => {
    if (v === null) return null;                  // superseded
    if (v === "__other") {
      block("This tool only models SCE, PG&E and SDG&E under Net Billing for now.", { coverage: true });
      return null;
    }
    addWarning({ text: `Utility chosen by hand (${utilityName(v)}); the ZIP did not identify it.` });
    return v;
  });
}

/** Add a data warning unless one with the same text is already listed. */
function addWarning(w) {
  if (!ctx.dataWarnings.some((x) => x.text === w.text)) ctx.dataWarnings.push(w);
}

/**
 * The question on screen, if any.  Only one can be open: a newer ask(), a
 * banner re-render without it, or a fresh intake (another ZIP, another file)
 * supersedes it, and the superseded promise resolves null so whatever chain
 * was awaiting it ends instead of hanging forever.
 */
let openQuestion = null;   // { spec, finish }

function supersedeQuestion() {
  const q = openQuestion;
  openQuestion = null;
  if (q) q.finish(null);
}

/** Show a choice on whichever surface is visible and resolve with the picked value (null if superseded). */
function ask(spec) {
  supersedeQuestion();
  return new Promise((resolve) => {
    let done = false;
    const q = { spec: null, finish: null };
    q.finish = (v) => {
      if (done) return;
      done = true;
      if (openQuestion === q) openQuestion = null;
      resolve(v);
    };
    q.spec = {
      tone: spec.tone, text: spec.text,
      actions: spec.actions.map((a) => ({
        label: a.label, primary: a.primary,
        onClick: () => {
          if (openQuestion !== q) return;          // a stale button from a superseded question
          openQuestion = null;
          landingNotice(null);
          renderBanner();
          q.finish(a.value);
        },
      })),
    };
    openQuestion = q;
    if (inApp) renderBanner(q.spec);
    else landingNotice(q.spec);
  });
}

/**
 * Stop the optimiser and say why, on the landing page and in the app banner.
 * opts.coverage marks a utility-coverage block (muni, out of state, "another
 * utility"), which only an explicit utility pick in the UI may lift.
 */
function block(message, opts = {}) {
  ctx.blockReason = message;
  ctx.coverageOk = false;
  if (opts.coverage) ctx.coverageBlocked = true;
  if (inApp) {
    if (worker) { worker.terminate(); worker = null; workerReady = false; }
    ctx.grid = null; ctx.priced = null; ctx.selected = null; ctx.detail = null;
    status(message, 1);
    renderBanner();
    render();
  } else {
    landingNotice({ tone: "bad", text: message });
  }
}

/**
 * First N sentences. Splitting on ". " alone shatters a note full of figures
 * like "16.51 c/kWh", so a sentence only ends where a capital or a quote
 * starts the next one.
 */
function shorten(text, sentences) {
  return String(text || "").split(/(?<=[.!?])\s+(?=[A-Z“"(])/).slice(0, sentences).join(" ");
}

// ------------------------------------------------------------------ location

async function onAddress(query) {
  if (!query || !query.trim()) { landingError("Type an address first, or use the ZIP field."); return; }
  if (!Core.geocode) { landingError("The geocoder is not available in this build. Use the ZIP field."); return; }
  supersedeQuestion();
  landingError("");
  try {
    const hit = await Core.geocode.geocode(query.trim());
    await applyLocation(hit);
  } catch (err) {
    landingError(userMessageOf(err, "That address could not be found. Try a ZIP code instead."));
  }
}

async function onZip(zip) {
  const clean = String(zip || "").trim();
  if (!/^\d{5}$/.test(clean)) { landingError("A ZIP code is five digits."); return; }
  if (!Core.geocode) { landingError("The geocoder is not available in this build."); return; }
  supersedeQuestion();
  landingError("");
  try {
    const hit = await Core.geocode.zipCentroid(clean);
    await applyLocation(Object.assign({ zip: clean }, hit));
  } catch (err) {
    landingError(userMessageOf(err, "That ZIP could not be located."));
  }
}

async function applyLocation(hit) {
  landingNotice(null);
  // Coverage first: a location the model does not apply to is not adopted at all.
  if (hit.zip || hit.city || hit.state) {
    const ok = await chooseTariff(hit.zip || null, { geo: { city: hit.city, state: hit.state } });
    if (!ok) return;
  }
  let elevation = null;
  if (Core.geocode && Core.geocode.elevationFor) {
    elevation = await Core.geocode.elevationFor(hit.lat, hit.lon).catch(() => null);
  }
  State.update((s) => {
    // A geocoder answers to the metre; the solar model cannot tell 1 km apart and
    // weather is fetched on a 5 km grid.  Rounding here keeps the exact house out
    // of localStorage and out of every share link.
    s.site.lat = State.roundCoord(hit.lat);
    s.site.lon = State.roundCoord(hit.lon);
    if (elevation !== null) s.site.elevationM = elevation;
    s.site.addressLabel = hit.label || null;      // memory only; never persisted
  }, "silent");
  toast(`Location set to ${hit.label || `${hit.lat.toFixed(3)}, ${hit.lon.toFixed(3)}`}.`);
  if (ctx.loadSet) {
    if (!inApp) { await proceedIfClear(); return; }
    // A new utility is a new rate book, so the worker is re-initialised.
    if (worker || bootGen) await bootWorker();
    await refreshSolarAndGrid();
  }
}

function onMap() {
  if (ctx.loadSet) { goTab("roof"); return; }
  landingError("Drop your meter file first — the map lives on the Roof tab, next to the rest of the roof.");
}

// --------------------------------------------------------------------- shell

let inApp = false;

function showLanding() {
  inApp = false;
  $("landing").hidden = false;
  $("shell").hidden = true;
  document.body.classList.remove("in-app");
}

/** Back to a working landing page with the reason on it (e.g. the engine refused the file). */
function backToLanding(message) {
  if (worker) { worker.terminate(); worker = null; workerReady = false; }
  showLanding();
  landingNotice({ tone: "bad", text: message });
}

/**
 * The persistent strip above the workbench: a block reason, the existing-solar
 * warning once acknowledged, or a question from ask().
 */
function renderBanner(question) {
  // Redrawing without the open question removes its buttons, so it is superseded.
  if (!question) supersedeQuestion();
  const shell = $("shell");
  if (!shell) return;
  let node = $("app-banner");
  if (!node) {
    node = el("div", { id: "app-banner", role: "alert", style: "margin:8px 16px 0" });
    const bench = shell.querySelector(".workbench");
    shell.insertBefore(node, bench || null);
  }
  clear(node);
  const items = [];
  if (question) items.push(question);
  else if (ctx.blockReason) items.push({ tone: "bad", text: ctx.blockReason });
  if (!question && !ctx.blockReason && ctx.siteNotice) {
    items.push({ tone: "warn", text: ctx.siteNotice,
      actions: [{ label: "Dismiss", onClick: () => { ctx.siteNotice = ""; renderBanner(); } }] });
  }
  if (ctx.loadSet && State.get().ui.existingSolarAck && hasExistingSolar(ctx.loadSet)) {
    items.push({ tone: "bad", text: EXISTING_SOLAR_BANNER });
  }
  node.hidden = !items.length;
  for (const it of items) {
    const box = el("div.banner" + (it.tone === "bad" ? ".banner-bad" : ""), { style: "margin-bottom:6px" },
      [el("span", { text: it.text })]);
    if (it.actions) {
      box.appendChild(el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:6px" }, it.actions.map((a) =>
        el("button.btn" + (a.primary ? ".btn-primary" : ""), { type: "button", text: a.label, on: { click: a.onClick } }))));
    }
    node.appendChild(box);
  }
}

async function enterApp() {
  // Re-entry (after a bounce back to the landing): take the old tab down properly
  // first, so its charts and the roof builder's map do not leak.
  if (mountedTab && typeof mountedTab.unmount === "function") {
    try { mountedTab.unmount(); } catch (err) { console.warn("Tab unmount failed:", err); }
  }
  destroyAll();
  mountedTab = null;
  inApp = true;
  landingNotice(null);
  $("landing").hidden = true;
  $("shell").hidden = false;
  document.body.classList.add("in-app");
  persist = true;
  State.writeHash(State.get());
  State.saveLocal(State.get());
  renderBanner();

  buildTabStrip();
  buildRailJump();
  rail = new ControlRail($("rail-controls"), onControlSet);
  mountedTab = null;
  mountTab();
  render();

  await ensureSolar();
  ctx.weatherOptions = buildWeatherOptions(State.get());
  await bootWorker();
  render();
}

async function forgetEverything() {
  const sure = window.confirm(
    "Erase your meter readings from this browser, along with every setting and the scenario in the URL?\n\n"
    + "Nothing was ever sent anywhere, so this is the only copy this page has.",
  );
  if (!sure) return;
  // Nothing still running may write after the erase: stop the worker, abort any
  // sunlight fetch (its cache.set would reopen the database), stop persisting.
  persist = false;
  supersedeQuestion();
  if (worker) { worker.terminate(); worker = null; workerReady = false; }
  bootGen++;
  if (weatherAbort) weatherAbort.abort();
  weatherMemo = { key: "", promise: null };
  if (Core.weather && Core.weather.forgetCaches) Core.weather.forgetCaches();
  await State.forgetEverything();
  location.href = location.pathname;
}

/**
 * The whole scenario — every non-default knob, the roof faces, the flexible
 * loads and their schedules — is already in the URL fragment, written on every
 * change.  "Share link" just copies it.  The meter data itself is never in the
 * link (it is private and about a megabyte); a link built on the demo household
 * carries a flag that loads the demo, so it reproduces exactly.
 */
async function shareLink() {
  State.writeHash(State.get());
  if (State.hashIsCurrent && !State.hashIsCurrent()) {
    // The address bar is stale or missing a setting: copying it would share the wrong scenario.
    toast("Could not build a link for these settings just now. Try again in a moment; nothing was copied.");
    return;
  }
  const ok = await copyToClipboard(location.href);
  const s = State.get();
  toast(ok
    ? (s.ui.demo ? "Link copied — it opens with these settings on the demo household."
      : "Link copied — it carries every setting. The recipient adds their own meter data.")
    : "Could not reach the clipboard — copy the address bar instead.");
}

function bindShell() {
  $("btn-forget").addEventListener("click", forgetEverything);
  $("btn-share").addEventListener("click", shareLink);
  $("btn-copy").addEventListener("click", async () => {
    const ok = await copyToClipboard(summaryText(State.get(), ctx));
    toast(ok ? "Summary copied." : "Could not reach the clipboard — press Ctrl/Cmd+C.");
  });
  $("btn-reset").addEventListener("click", () => {
    State.update((s) => {
      const fresh = State.freshState();
      s.system = fresh.system; s.fin = fresh.fin; s.baseLoadScale = fresh.baseLoadScale;
      s.ui.objective = fresh.ui.objective; s.ui.basis = fresh.ui.basis;
    }, "sim");
    toast("Back to the default system and prices.");
  });

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      readTokens();
      if (ctx.priced) render();
    });
  }
  /**
   * A hash change is someone pasting a link (or using the back button). The
   * hash is a LAYER, not a snapshot: applying it over the live state means a
   * partial link — `#cw=2.5`, say — changes the price it names and leaves the
   * roof, the loads and the meter data alone. Rebuilding from defaults here
   * would quietly delete the session the link was pasted into.
   */
  window.addEventListener("hashchange", () => {
    try {
      const before = State.toHash(State.get());
      if (location.hash.replace(/^#/, "") === before) return;   // our own replaceState
      const report = {};
      const prevUtil = State.get().site.utilityId;
      const next = State.fromHash(location.hash, State.get(), report);
      next.ui.tab = normalizeTab(next.ui.tab);
      State.replace(next, "load");
      if (report.damaged) toast(DAMAGED_LINK);
      if (ctx.loadSet && inApp) {
        if (mountedTab && typeof mountedTab.unmount === "function") mountedTab.unmount();
        mountedTab = null;
        mountTab();
        if (next.site.utilityId !== prevUtil) {
          // A different rate book: the worker was initialised with the old one, so
          // this is a fresh load of that utility - new tariff, new worker, nothing
          // carried over from the old rate book (its grid, detail run, plan list,
          // replay).  A programmatic switch, so a standing coverage block is not
          // lifted; a utility the library does not know keeps the old one running
          // and says so instead of pricing the new name on the old tariffs.
          onLinkUtility(prevUtil);
        } else {
          refreshSolarAndGrid();
        }
      }
    } catch (err) {
      // A pasted link must never blank a working page.
      console.error("Could not apply the link:", err);
      toast(DAMAGED_LINK);
    }
  });

  // The URL and localStorage are written 300 ms after the last change; make sure
  // the last change lands when the tab is hidden or closed.
  window.addEventListener("pagehide", () => State.flushPersist());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") State.flushPersist();
  });
}

/** A pasted link named a different utility: reboot exactly as a fresh load of it would. */
async function onLinkUtility(prevUtil) {
  const wanted = State.get().site.utilityId;
  if (!utilityOf(wanted) && !ctx.coverageBlocked) {
    State.update((s) => { s.site.utilityId = prevUtil; s.tariff.utilityId = prevUtil; }, "silent");
    toast(DAMAGED_LINK);
    render();
    return;
  }
  ctx.grid = null; ctx.priced = null; ctx.selected = null; ctx.detail = null; ctx.replay = null;
  ctx.planOptions = []; ctx.providerOptions = [];
  ctx.weatherRows = null; ctx.tornado = null;
  markStale();
  const ok = await chooseTariff(null);
  // A baseline region carried over from the old utility means nothing in the new rate book.
  const regions = ok && Core.tariff.baselineRegionList ? Core.tariff.baselineRegionList(ctx.tariff) : [];
  const breg = State.get().site.baselineRegion;
  if (ok && breg && !regions.some((r) => String(r.id) === String(breg))) {
    State.update((s) => { s.site.baselineRegion = null; }, "silent");
  }
  renderBanner();
  await bootWorker();              // with a block standing this only shows the reason
  if (ok) await refreshSolarAndGrid();
  render();
}

const DAMAGED_LINK = "Part of the link could not be read; those settings were left as they were.";
const DAMAGED_SESSION = "Some saved settings could not be read; those are back at their defaults.";

// ---------------------------------------------------------------------- boot

async function boot() {
  readTokens();
  bindShell();
  adoptGeocodeNote();

  // The landing goes up first, so nothing in a stored session or a pasted link
  // can leave the visitor looking at a blank page.
  renderLanding($("landing"), { onFiles, onDemo, onAddress, onZip, onMap });

  // Hash beats localStorage beats defaults: a shared link always wins.
  let start = State.freshState();
  try {
    const stored = State.loadLocal();
    const report = {};
    if (stored) start = State.fromStorage(stored, start, report);
    if (report.damaged) {
      console.warn("Unreadable saved settings:", report.keys);
      toast(DAMAGED_SESSION);
    }
  } catch (err) {
    console.warn("The saved session could not be read; starting fresh.", err);
    start = State.freshState();
  }
  try {
    if (location.hash) {
      const report = {};
      start = State.fromHash(location.hash, start, report);
      const bad = new Set(report.keys || []);
      for (const pair of location.hash.replace(/^#/, "").split("&")) {
        const k = pair.split("=")[0];
        if (k && !bad.has(k)) ctx.linkKeys.add(k);
      }
      if (report.damaged) { console.warn("Damaged link keys:", report.keys); toast(DAMAGED_LINK); }
    }
  } catch (err) {
    console.warn("The link could not be read; using defaults.", err);
    toast(DAMAGED_LINK);
  }
  start.ui.tab = normalizeTab(start.ui.tab);
  State.replace(start, "silent");

  await loadCore();

  const missing = Object.entries(Core).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn("These core modules did not load:", missing.join(", "));
  }

  await chooseTariff(null);

  // A previous session's meter data comes straight back out of IndexedDB.
  const saved = await State.readLoadSet();
  if (saved && saved.ts && saved.ts.length) {
    ctx.loadSet = saved;
    ctx.recentAnnualKwh = Core.sizing ? Core.sizing.recentAnnualKwh(saved) : null;
    State.update((s) => { s.load = { meta: saved.meta || {} }; }, "silent");
    if (Core.flexload) {
      try {
        const ev = Core.flexload.detectEV(saved);
        State.update((s) => {
          // A first session keeps what the detector found. A returning one has
          // the schedules back out of storage, but not the detected hourly
          // slice — that is a piece of the meter data, so it is re-attached.
          if (!s.flex.length) {
            if (ev) s.flex = [ev];
            return;
          }
          if (!ev) return;
          // Re-attach the hourly slice only; the person's chosen schedule (mode
          // included - detected loads start "asRecorded") is left exactly as saved.
          for (const f of s.flex) {
            if (f.source === "detected" && f.kind === ev.kind) {
              f.kwhByHour = ev.kwhByHour;
              f.detection = ev.detection;
            }
          }
        }, "silent");
      } catch { /* detection is optional */ }
    }
    // Same gates as a fresh file: a modelled utility and no unacknowledged export.
    // The file's own ZIP is stored with it, so its coverage decision is re-run
    // exactly as on the first drop (a LADWP file stays blocked; a split ZIP the
    // person already answered is not asked again).
    // A utility the link or the saved session already names (and the library has)
    // stands: the file's ZIP only re-applies a coverage block, never swaps utilities.
    const fileZip = fileZipOf(saved);
    const named = utilityOf(State.get().site.utilityId) ? State.get().site.utilityId : null;
    const cov = fileZip && named && Core.coverage ? Core.coverage.coverageForZip(fileZip, ctx.tariffLib) : null;
    const zipBlocks = !!cov && (cov.kind === "outside" || (cov.kind === "muni" && !cov.shared));
    if (fileZip && (!named || zipBlocks)) {
      const prior = utilityOf(State.get().site.utilityId) ? State.get().site.utilityId : null;
      await chooseTariff(fileZip, { ask: true, prior });
    } else if (!ctx.coverageOk) {
      await chooseTariff(null, { ask: true });
    }
    await proceedIfClear();
  } else if (State.get().ui.demo && location.hash) {
    // A shared link built on the demo household: load the demo so the
    // recipient sees exactly what the sender saw.
    await onDemo({ fromLink: true });
  }
}

boot().catch((err) => {
  console.error("Rooftop ROI could not start:", err);
  landingError("Something went wrong starting the page. The browser console has the details.");
});

export { ctx, Core };
