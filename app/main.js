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
import { renderLanding, landingError } from "./ui/landing.js";
import { summaryText, copyToClipboard } from "./ui/summary.js";
import { destroyAll } from "./charts/base.js";
import { fmtKwh } from "./ui/format.js";
import { adoptGeocodeNote } from "./privacy.js";

import * as dashboardTab from "./tabs/dashboard.js";
import * as roofTab from "./tabs/roof.js";
import * as loadsTab from "./tabs/loads.js";
import * as billsTab from "./tabs/bills.js";
import * as assumptionsTab from "./tabs/assumptions.js";

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
  geocode: null, engine: null, finance: null, optimizer: null,
};

async function loadCore() {
  const wanted = {
    greenbutton: "../core/greenbutton.js", flexload: "../core/flexload.js",
    tariff: "../core/tariff.js", pv: "../core/pv.js", weather: "../core/weather.js",
    geocode: "../core/geocode.js", engine: "../core/engine.js",
    finance: "../core/finance.js", optimizer: "../core/optimizer.js",
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
  getState: State.get,
  actions: {},
};

// ------------------------------------------------------------------- worker

let worker = null;
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

async function bootWorker() {
  if (worker) { worker.terminate(); worker = null; workerReady = false; }
  let src = "";
  try {
    const res = await fetch(new URL("./worker-bundle.js", import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    src = await res.text();
  } catch (err) {
    // INTEGRATION: app/worker-bundle.js is generated by `node core/bundle-for-worker.mjs`.
    // Without it there is no simulation at all, so say so rather than showing zeros.
    status("Simulation engine missing — run: node core/bundle-for-worker.mjs", 1);
    console.error("worker-bundle.js could not be fetched:", err && err.message);
    return;
  }

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
    status("Simulation error — see the console", 1);
    console.error(m.message, m.stack);
    toast("The simulation hit an error. The console has the details.");
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
  };
}

function runGrid() {
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

let lastDetailKey = "";
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
  const prov = (ctx.tariff.providers || {})[s.tariff.providerId];
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
  if (!ctx.tariffLib || !ctx.tariffLib.utilities[utilityId]) return;
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
    s.roof.planes.push(defaultPlane("p" + n, n === 1 ? "South face" : `Roof face ${n}`));
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

let solarToken = 0;

/**
 * Nothing is written to the URL or to localStorage until there is actually a
 * session to keep: a visitor who lands, reads the privacy panel and leaves
 * should find the address bar exactly as they left it and this origin's
 * storage empty.
 */
let persist = false;

State.subscribe((s, reason, info) => {
  if (persist) { State.writeHash(s); State.saveLocal(s); }
  // Everything below needs the shell; during boot and intake there is none yet.
  if (!rail || reason === "silent") return;

  if (reason === "tab" || info.tabChanged) { mountTab(); render(); return; }

  if (reason === "roof" || reason === "site") {
    rail.refresh(s);
    ensureSolar().then(() => { markStale(); runGrid(); });
    render();
    return;
  }
  if (reason === "sim") { markStale(); rail.refresh(s); queueSim(); return; }
  if (reason === "finance") { repriceAndRender(); return; }
  render();
});

// ------------------------------------------------------------------- solar

/**
 * Sunlight for every roof face. This is the one place the app goes to the
 * network on the user's behalf, so it is loud about it: a status line, a
 * cache indicator on the Roof tab, and a failure that never blocks anything
 * else on the page.
 */
async function ensureSolar() {
  const s = State.get();
  const token = ++solarToken;
  if (!s.roof.planes.length) { ctx.solarStatusText = "Add a roof face."; return; }
  if (s.site.lat === null || s.site.lon === null) {
    ctx.solarStatusText = "Set a location on the Roof tab before the sunlight can be fetched.";
    s.solar.status = "idle";
    return;
  }
  if (!Core.weather || !Core.pv) {
    ctx.solarStatusText = "The sunlight model is not available in this build.";
    return;
  }

  const stale = s.roof.planes.filter((p) => !s.solar.byPlane[p.id]
    || s.solar.byPlane[p.id].tilt !== p.tilt || s.solar.byPlane[p.id].azimuth !== p.azimuth);
  if (!stale.length && (s.solar.weatherYears || []).length) { ctx.solarProgress = 1; return; }

  s.solar.status = "loading";
  ctx.solarProgress = 0.05;
  ctx.solarStatusText = "Fetching hourly sunlight for your coordinates…";
  renderRoofOnly();

  let fromCache = true;
  const result = await Core.weather.tryFetchYears({
    lat: s.site.lat, lon: s.site.lon, elevationM: s.site.elevationM ?? undefined,
    onProgress: ({ index, total, fromCache: cached }) => {
      if (token !== solarToken) return;
      if (!cached) fromCache = false;
      ctx.solarProgress = Math.max(0.05, (index + 1) / (total || 11));
      ctx.solarStatusText = `Sunlight: year ${index + 1} of ${total}${cached ? " (cached)" : ""}`;
      renderRoofOnly();
    },
  });

  if (token !== solarToken) return;

  if (!result.ok) {
    s.solar.status = "error";
    s.solar.note = result.message || "";
    ctx.solarProgress = 0;
    ctx.solarStatusText = result.message || "Sunlight could not be fetched.";
    ctx.dataWarnings = [{ severity: "bad", text: `Sunlight: ${result.message}` }];
    renderRoofOnly();
    return;
  }

  ctx.solarStatusText = "Modelling each roof face…";
  renderRoofOnly();
  const years = result.years;
  for (const plane of s.roof.planes) {
    s.solar.byPlane[plane.id] = Core.pv.profilesForPlane(years, plane, {
      lat: s.site.lat, lon: s.site.lon, elevationM: s.site.elevationM ?? undefined,
    });
  }
  s.solar.weatherYears = years.map((y) => y.year).filter(Boolean);
  s.solar.status = "ready";
  s.solar.cached = fromCache;
  ctx.solarProgress = 1;
  ctx.solarStatusText = `Ready — ${s.solar.weatherYears.length} weather years, ${s.roof.planes.length} `
    + `${s.roof.planes.length === 1 ? "face" : "faces"} modelled.`;
  ctx.weatherOptions = buildWeatherOptions(s);

  if (workerReady) await bootWorker();     // the worker caches the profiles at init
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
  try {
    const loadSet = await readFiles(files);
    State.update((s) => { s.ui.demo = false; }, "silent");
    await adoptLoadSet(loadSet);
  } catch (err) {
    console.error(err);
    landingError(err && err.message ? err.message : "That file could not be read as Green Button data.");
  }
}

async function onDemo() {
  landingError("");
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
      s.site.lat = 34.145; s.site.lon = -118.76; s.site.elevationM = 280;
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
    landingError(err && err.message ? err.message : "The demo data could not be loaded.");
  }
}

/** Everything that happens once there is a LoadSet, however it arrived. */
async function adoptLoadSet(loadSet, zipHint) {
  ctx.loadSet = loadSet;
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
  await chooseTariff(zip);

  State.saveLoadSet(loadSet);
  enterApp();
}

async function chooseTariff(zip) {
  if (!Core.tariff) return;
  if (!ctx.tariffLib) {
    try { ctx.tariffLib = await Core.tariff.loadLibrary("data/tariffs"); }
    catch (err) { console.error("The tariff library did not load:", err && err.message); return; }
  }
  ctx.utilityOptions = (ctx.tariffLib.ids || []).map((id) => ({
    v: id, t: (ctx.tariffLib.utilities[id].utility || {}).name || id.toUpperCase(),
  }));

  const s = State.get();
  let utilityId = s.site.utilityId;
  if (zip) {
    const hit = Core.tariff.utilityForZip(zip, ctx.tariffLib);
    if (hit && !hit.ambiguous) utilityId = hit.utilityId;
    else if (hit && hit.ambiguous) {
      utilityId = hit.candidates[0].utilityId;
      ctx.dataWarnings.push({
        text: `ZIP ${zip} is served by more than one utility (${hit.candidates.map((c) => c.utilityId.toUpperCase()).join(", ")}). `
          + `Assuming ${utilityId.toUpperCase()} — change it on the Bills tab if that is wrong.`,
      });
    }
  }
  if (!utilityId) utilityId = ctx.tariffLib.ids[0];

  const t = ctx.tariffLib.utilities[utilityId];
  if (!t) return;
  ctx.tariff = t;
  ctx.climateCredit = Core.tariff.climateCredit(t);
  ctx.escalationNote = (t.meta && t.meta.escalation && t.meta.escalation.note)
    ? shorten(t.meta.escalation.note, 2) : "";

  State.update((s2) => {
    s2.site.utilityId = utilityId;
    s2.tariff.utilityId = utilityId;
    const plan = Core.tariff.defaultPlan(t);
    if (!s2.tariff.planId || !Core.tariff.plan(t, s2.tariff.planId)) s2.tariff.planId = plan.id;
    const prov = Core.tariff.defaultProvider(t);
    if (!s2.tariff.providerId) s2.tariff.providerId = prov;
    if (t.meta && t.meta.escalation && t.meta.escalation.recommended_default !== undefined
        && s2.fin.escalation === State.DEFAULTS.fin.escalation) {
      s2.fin.escalation = t.meta.escalation.recommended_default;
    }
  }, "silent");
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
    landingError(err && err.message ? err.message : "That address could not be found. Try a ZIP code instead.");
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
    landingError(err && err.message ? err.message : "That ZIP could not be located.");
  }
}

async function applyLocation(hit) {
  let elevation = null;
  if (Core.geocode && Core.geocode.elevationFor) {
    elevation = await Core.geocode.elevationFor(hit.lat, hit.lon).catch(() => null);
  }
  State.update((s) => {
    s.site.lat = hit.lat;
    s.site.lon = hit.lon;
    if (elevation !== null) s.site.elevationM = elevation;
    s.site.addressLabel = hit.label || null;      // memory only; never persisted
  }, "silent");
  if (hit.zip) await chooseTariff(hit.zip);
  toast(`Location set to ${hit.label || `${hit.lat.toFixed(3)}, ${hit.lon.toFixed(3)}`}.`);
  if (ctx.loadSet) { await ensureSolar(); markStale(); runGrid(); }
}

function onMap() {
  if (ctx.loadSet) { goTab("roof"); return; }
  landingError("Drop your meter file first — the map lives on the Roof tab, next to the rest of the roof.");
}

// --------------------------------------------------------------------- shell

async function enterApp() {
  $("landing").hidden = true;
  $("shell").hidden = false;
  document.body.classList.add("in-app");
  persist = true;
  State.writeHash(State.get());
  State.saveLocal(State.get());

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
    const before = State.toHash(State.get());
    if (location.hash.replace(/^#/, "") === before) return;   // our own replaceState
    const next = State.fromHash(location.hash, State.get());
    next.ui.tab = normalizeTab(next.ui.tab);
    State.replace(next, "load");
    if (ctx.loadSet) {
      mountedTab = null;
      mountTab();
      ensureSolar().then(() => { markStale(); runGrid(); });
    }
  });
}

// ---------------------------------------------------------------------- boot

async function boot() {
  readTokens();
  bindShell();
  adoptGeocodeNote();

  // Hash beats localStorage beats defaults: a shared link always wins.
  const stored = State.loadLocal();
  let start = stored ? State.fromStorage(stored, State.freshState()) : State.freshState();
  if (location.hash) start = State.fromHash(location.hash, start);
  start.ui.tab = normalizeTab(start.ui.tab);
  State.replace(start, "silent");

  renderLanding($("landing"), { onFiles, onDemo, onAddress, onZip, onMap });

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
          for (const f of s.flex) {
            if (f.source === "detected" && f.kind === ev.kind) {
              f.kwhByHour = ev.kwhByHour;
              f.detection = ev.detection;
            }
          }
        }, "silent");
      } catch { /* detection is optional */ }
    }
    await enterApp();
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
