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
  planOptions: [], providerOptions: [], utilityOptions: [],
  dataWarnings: [],
  escalationNote: "",
  climateCredit: null,
  // Gates that stop the optimiser from running at all (P0 #3, #6, short files):
  coverage: null,            // last core/coverage.js answer for this location
  coverageOk: false,         // a modelled IOU has been chosen, by ZIP or explicitly by the user
  blockReason: "",           // non-empty: the reason no simulation runs, shown in the banner
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

  const forceInline = /[?&]noworker\b/.test(location.search);
  try {
    if (forceInline) throw new Error("inline worker forced with ?noworker");
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  } catch (err) {
    console.warn("Blob worker unavailable, simulating on the main thread:", err && err.message);
    worker = makeInlineWorker(src);
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
      ctx.blockReason = msg;
      status(msg, 1);
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

function finEff() {
  const s = State.get();
  const ngomCost = (ctx.tariff && ctx.tariff.meta && ctx.tariff.meta.ngom_cost) || NGOM_COST_DEFAULT;
  return Object.assign({}, s.fin, { adder: s.fin.adder + (s.system.ngom ? ngomCost : 0) });
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
  const fin = finEff();
  let obj = s.ui.objective;
  let priced = Core.optimizer.priceGrid(ctx.grid, fin, obj, s.ui.basis);
  const cells = priced.cells || [];
  const useless = (obj === "irr" && cells.every((c) => c.projectIrr === null || c.projectIrr === undefined))
    || (obj === "payback" && cells.every((c) => !c.payback));
  if (useless) { obj = "npv"; priced = Core.optimizer.priceGrid(ctx.grid, fin, obj, s.ui.basis); }
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
    const f = Core.finance.withDefaults(finEff());
    ctx.effectiveDiscount = Core.finance.effectiveDiscount(f);
    const sim = {
      savings: ctx.selected.savings, importSavings: ctx.selected.importSavings,
      exportRevenue: ctx.selected.exportRevenue, bill: ctx.selected.bill,
      baselineBill: ctx.baselineBill, pvKwh: ctx.selected.pvKwh,
      kwdc: ctx.selected.kwdc, battKWhTotal: ctx.selected.battKWhTotal,
    };
    ctx.breakEvenPerW = Core.finance.breakEven(sim, finEff(), "costPerW");
    ctx.breakEvenPerKwh = Core.finance.breakEven(sim, finEff(), "costPerKwh");
    // The same system bought outright, so a loan or lease tile can state the
    // financing decision as a dollar gap rather than leave it to the IRR/APR hint.
    ctx.cashNpv = f.financing.mode === "cash" ? null
      : Core.finance.evaluate(sim, Object.assign({}, finEff(), { financing: Object.assign({}, f.financing, { mode: "cash" }) })).npv;
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
      ctx.selected, finEff(), ctx.baselineBill,
      ctx.detail ? ctx.detail.flexVariants : null,
    );
  }

  if (ctx.detail && ctx.detail.weather && Core.finance) {
    ctx.weatherRows = ctx.detail.weather.map((w) => {
      const f = Core.finance.evaluate({
        savings: w.savings, importSavings: w.importSavings, exportRevenue: w.exportRevenue,
        bill: w.bill, baselineBill: w.baselineBill,
        pvKwh: w.pvKwh, kwdc: ctx.selected.kwdc, battKWhTotal: ctx.selected.battKWhTotal,
      }, finEff());
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

function buildTabStrip() {
  const strip = clear($("tabs"));
  for (const id of State.TABS) {
    const mod = TAB_MODULES[id];
    strip.appendChild(el("button", {
      type: "button", role: "tab", id: "tab-" + id,
      "aria-selected": String(State.get().ui.tab === id),
      "aria-controls": "pane", text: mod.label,
      on: { click: () => goTab(id) },
    }));
  }
}

function goTab(id) {
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
    if (btn) btn.setAttribute("aria-selected", String(id === s.ui.tab));
  }
  const pane = $("pane");
  pane.scrollTop = 0;
  mod.mount(pane, s, ctx);
  rail.build(mod.rail(s, ctx), s);
}

function render() {
  const s = State.get();
  if (!mountedTab) return;
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
  if (ctx.weatherOptions.length) rail.setOptions("ui.weatherKey", ctx.weatherOptions, s);
}

function renderTopBar(s) {
  const chip = $("household-chip");
  if (!chip) return;
  const meta = (ctx.loadSet && ctx.loadSet.meta) || {};
  const years = meta.nHours ? meta.nHours / 8760 : 0;
  const bits = [];
  if (meta.totalKwh && years) bits.push(fmtKwh(meta.totalKwh / years, 0) + "/yr");
  if (s.site.utilityId) bits.push(s.site.utilityId.toUpperCase());
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
  if (path === "ui.customEnabled") { toast("Custom rates from a bill are not wired up yet — pick the closest published plan."); return; }
  if (path === "site.utilityId") { switchUtility(value); return; }

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
async function switchUtility(utilityId) {
  if (!utilityOf(utilityId)) return;
  State.update((s) => {
    s.site.utilityId = utilityId;
    s.tariff.planId = null;
    s.tariff.providerId = null;
  }, "silent");
  await chooseTariff(null);
  markStale();
  await bootWorker();
  render();
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
  setSite: (site) => State.update((s) => Object.assign(s.site, site), "site"),
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
const siteKey = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;

function weatherFor(s) {
  const key = siteKey(s.site.lat, s.site.lon);
  if (weatherMemo.key === key && weatherMemo.promise) return weatherMemo.promise;
  let fromCache = true;
  const promise = Core.weather.tryFetchYears({
    lat: s.site.lat, lon: s.site.lon, elevationM: s.site.elevationM ?? undefined,
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
    ctx.dataWarnings = [{ severity: "bad", text: `Sunlight: ${result.message}` }];
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

async function readFiles(files) {
  if (!Core.greenbutton) throw new Error("The Green Button parser is not available in this build.");
  const sets = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      throw new Error(`${file.name} is a zip. Unzip it first and drop the CSV or XML inside.`);
    }
    const text = await file.text();
    sets.push(Core.greenbutton.parse(text, { filename: file.name }));
  }
  return sets.length === 1 ? sets[0] : Core.greenbutton.mergeLoadSets(sets);
}

async function onFiles(files) {
  if (!files || !files.length) return;
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

async function onDemo() {
  landingError("");
  landingNotice(null);
  try {
    const names = ["demo-sce-usage-2024-09.csv", "demo-sce-usage-2025-09.csv"];
    const texts = await Promise.all(names.map(async (n) => {
      const res = await fetch(`data/demo/${n}`);
      if (!res.ok) throw new Error(`data/demo/${n} is missing (HTTP ${res.status})`);
      return res.text();
    }));
    const sets = texts.map((t, i) => Core.greenbutton.parse(t, { filename: names[i] }));
    const loadSet = Core.greenbutton.mergeLoadSets(sets);
    State.update((s) => {
      // Flagged in the hash so a shared link built on the demo loads the demo.
      s.ui.demo = true;
      s.ui.existingSolarAck = false;
      s.site.lat = 34.15; s.site.lon = -118.75; s.site.elevationM = 280;
      s.site.tz = "America/Los_Angeles"; s.site.utilityId = "sce";
      s.site.addressLabel = "Demo household, Agoura Hills CA 91301";
      // The demo is a real house: SCE delivery with Clean Power Alliance 100% Green
      // generation on TOU-D-PRIME, a south-facing roof at 169 degrees with room for far
      // more panels than the optimiser will ever want.
      s.tariff.utilityId = "sce"; s.tariff.planId = "TOU-D-PRIME"; s.tariff.providerId = "cpa_green";
      if (!s.roof.planes.length || (s.roof.planes.length === 1 && !s.roof.planes[0].polygon)) {
        s.roof.planes = [Object.assign(defaultPlane("p1", "South face"), { azimuth: 169, maxPanels: 40 })];
      }
    }, "silent");
    await adoptLoadSet(loadSet, "91301");
  } catch (err) {
    console.error(err);
    landingError(userMessageOf(err, "The demo data could not be loaded."));
  }
}

/** Everything that happens once there is a LoadSet, however it arrived. */
async function adoptLoadSet(loadSet, zipHint) {
  ctx.loadSet = loadSet;
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
        const manual = s.flex.filter((f) => f.source === "manual");
        s.flex = found.concat(manual);
      }, "silent");
    } catch (err) { console.warn("Flexible-load detection failed:", err && err.message); }
  }

  // Which rate book. A ZIP out of the file header beats anything we guessed.
  const zip = zipHint || meta.zip || meta.serviceZip || null;
  State.saveLoadSet(loadSet);
  await chooseTariff(zip, { ask: true });
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
 *   iou      -> that utility (an ambiguous prefix picks one and says so)
 *   muni     -> blocked: a publicly owned utility is not on Net Billing.  A ZIP that
 *               is split with an IOU asks instead, with an explicit IOU choice.
 *   outside  -> blocked: California only.
 *   unknown  -> the person picks the utility explicitly, with a warning.
 * Never silently falls back to the first utility in the library.
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
    const cov = Core.coverage
      ? Core.coverage.coverageForZip(zip, ctx.tariffLib, { city: geo.city, state: geo.state })
      : legacyCoverage(zip);
    ctx.coverage = cov;
    const decided = await decideCoverage(cov, zip);
    if (decided === null) { ctx.coverageOk = false; return false; }
    utilityId = decided;
  } else if (!utilityId) {
    if (!opts.ask) { ctx.coverageOk = false; return false; }
    const picked = await askUtility("Which utility sends your electricity bill? This file does not say, and no location has been set.");
    if (!picked) { ctx.coverageOk = false; return false; }
    utilityId = picked;
  }

  const t = utilityOf(utilityId);
  if (!t) { ctx.coverageOk = false; return false; }
  ctx.coverageOk = true;
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

const utilityName = (id) => ((utilityOf(id) || {}).utility || {}).name
  || String(id).toUpperCase();

/** If core/coverage.js failed to load, still never guess: unknown unless the tariff prefixes match. */
function legacyCoverage(zip) {
  const hit = zip ? Core.tariff.utilityForZip(zip, ctx.tariffLib) : null;
  return hit ? { kind: "iou", utilityId: hit.utilityId, ambiguous: hit.ambiguous, candidates: hit.candidates }
    : { kind: "unknown" };
}

/** Turn a coverage answer into a utility id, or null (blocked or declined). */
async function decideCoverage(cov, zip) {
  const msg = Core.coverage ? Core.coverage.coverageMessage(cov) : "";
  if (cov.kind === "iou") {
    if (cov.ambiguous) {
      ctx.dataWarnings.push({
        text: `ZIP ${zip} is served by more than one utility (${cov.candidates.map((c) => String(c).toUpperCase()).join(", ")}). `
          + `Assuming ${String(cov.utilityId).toUpperCase()} — change it on the Bills tab if that is wrong.`,
      });
    }
    return cov.utilityId;
  }
  if (cov.kind === "outside") { block(msg || "California only for now."); return null; }
  if (cov.kind === "muni" && !cov.shared) { block(msg); return null; }
  if (cov.kind === "muni") {
    // Split ZIP: ask, never assume.  Only an explicit "my bill is from <IOU>" goes on.
    const iou = cov.iouHint && cov.iouHint.utilityId;
    const choice = await ask({
      tone: "warn",
      text: `Part of this area is served by ${cov.name}, a publicly owned utility that is not on Net Billing; `
        + "this tool does not model it yet. Who sends your electricity bill?",
      actions: [
        { label: `${cov.name}`, value: "__muni" },
        ...(iou ? [{ label: `${utilityName(iou)}`, value: iou, primary: true }] : []),
        ...(!iou ? (ctx.tariffLib.ids || []).map((id) => ({ label: utilityName(id), value: id })) : []),
      ],
    });
    if (!choice || choice === "__muni") { block(msg); return null; }
    return choice;
  }
  // unknown: explicit pick with a warning.
  const picked = await askUtility(msg || "This ZIP is not in any utility list this tool has.");
  return picked || null;
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
    if (!v || v === "__other") {
      block("This tool only models SCE, PG&E and SDG&E under Net Billing for now.");
      return null;
    }
    ctx.dataWarnings.push({ text: `Utility chosen by hand (${utilityName(v)}); the ZIP did not identify it.` });
    return v;
  });
}

/** Show a choice on whichever surface is visible and resolve with the picked value. */
function ask(spec) {
  return new Promise((resolve) => {
    const actions = spec.actions.map((a) => ({
      label: a.label, primary: a.primary,
      onClick: () => { landingNotice(null); renderBanner(); resolve(a.value); },
    }));
    if (inApp) renderBanner({ tone: spec.tone, text: spec.text, actions });
    else landingNotice({ tone: spec.tone, text: spec.text, actions });
  });
}

/** Stop the optimiser and say why, on the landing page and in the app banner. */
function block(message) {
  ctx.blockReason = message;
  ctx.coverageOk = false;
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
      const next = State.fromHash(location.hash, State.get(), report);
      next.ui.tab = normalizeTab(next.ui.tab);
      State.replace(next, "load");
      if (report.damaged) toast(DAMAGED_LINK);
      if (ctx.loadSet && inApp) {
        mountedTab = null;
        mountTab();
        refreshSolarAndGrid();
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

const DAMAGED_LINK = "The link was damaged; the unreadable settings are using defaults.";

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
    if (stored) start = State.fromStorage(stored, start);
  } catch (err) {
    console.warn("The saved session could not be read; starting fresh.", err);
    start = State.freshState();
  }
  try {
    if (location.hash) {
      const report = {};
      start = State.fromHash(location.hash, start, report);
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
    if (!ctx.coverageOk) await chooseTariff(null, { ask: true });
    await proceedIfClear();
  } else if (State.get().ui.demo && location.hash) {
    // A shared link built on the demo household: load the demo so the
    // recipient sees exactly what the sender saw.
    await onDemo();
  }
}

boot().catch((err) => {
  console.error("Rooftop ROI could not start:", err);
  landingError("Something went wrong starting the page. The browser console has the details.");
});

export { ctx, Core };
