/* =============================================================================
 * state.js — the single source of truth, plus its three persistence layers.
 *
 *   location.hash   non-default scalars, roof planes and flexible loads, so a
 *                   link reproduces someone else's scenario exactly.
 *   localStorage    the same thing plus polygons and custom tariffs, under
 *                   `rooftop-roi:v1`, so a reload keeps the session.
 *   IndexedDB       the LoadSet itself (~1 MB of meter readings) in db
 *                   `rooftop-roi`, store `loads`.
 *
 * Nothing here touches the DOM or the network: this module imports cleanly in
 * Node, which is how tests/state.test.mjs round-trips it.
 *
 * Two things are deliberately never persisted anywhere:
 *   site.addressLabel   a typed street address is the most identifying thing
 *                       on the page; it lives in memory for the session only.
 *   solar.byPlane       ~70 kB of Float64Array per plane, recomputed on load.
 * ========================================================================== */

export const STORAGE_KEY = "rooftop-roi:v1";
export const DB_NAME = "rooftop-roi";
export const DB_STORE = "loads";
export const LOAD_KEY = "current";

export const TABS = ["dashboard", "roof", "loads", "bills", "assumptions"];

/** Defaults. Anything equal to these is omitted from the hash and from storage. */
export const DEFAULTS = {
  site: { lat: null, lon: null, elevationM: null, tz: null, utilityId: null, addressLabel: null },
  roof: { planes: [] },
  load: null,
  flex: [],
  baseLoadScale: 1,
  solar: { byPlane: {}, weatherYears: [], status: "idle", cached: false, note: "" },
  tariff: { utilityId: null, planId: null, providerId: null, custom: null },
  system: {
    panelW: 460, battKWh: 10, battKW: 5, rte: 0.9, minReserve: 0.2,
    strategy: "tou_arbitrage", gridCharge: false, exportThreshold: 0.5, ngom: false,
    maxPanels: 40, maxBatteries: 6,
    override: { panelsByPlane: null, batteries: null },
  },
  fin: {
    costPerW: 3.0, costPerKwh: 1000, adder: 0,
    incentiveMode: "none", discountPct: 0, passThroughPct: 0.34, taxCreditPct: 0,
    sgipPerKwh: 0, rebates: 0,
    horizon: 25, escalation: 0.05, exportEscalation: 0, investReturn: 0.07, discountRate: 0.025,
    panelDeg: 0.005, battDeg: 0.02, battReplYear: 20, battReplFraction: 0.5,
    omPerYear: 150, inverterYear: 12, inverterPerW: 0.15, resaleValue: 0,
    financing: {
      mode: "cash",
      loan: { sharePct: 1.0, apr: 0.0699, termYears: 15, dealerFeePct: 0.0 },
      lease: { monthly: 180, escalatorPct: 0.029, termYears: 25, buyout: 0 },
    },
  },
  ui: {
    tab: "dashboard", demo: false, basis: "sameFlex", season: 0, weatherKey: "tmy", objective: "npv",
    replayStart: "", replayEnd: "", replayActual: 0,
    // Rail entries that are verbs or one-shot pickers, not persisted settings.
    addPreset: "", customEnabled: false, assumptionsJump: "method", runReplay: false,
  },
};

/** Every scalar that survives a reload, with the short key it wears in the hash. */
const SCALARS = [
  ["lat", "site.lat", "num"], ["lon", "site.lon", "num"], ["elev", "site.elevationM", "num"],
  ["tz", "site.tz", "str"], ["util", "site.utilityId", "str"],

  ["bls", "baseLoadScale", "num"],

  ["plan", "tariff.planId", "str"], ["prov", "tariff.providerId", "str"],

  ["pw", "system.panelW", "num"], ["bkwh", "system.battKWh", "num"], ["bkw", "system.battKW", "num"],
  ["rte", "system.rte", "num"], ["res", "system.minReserve", "num"],
  ["strat", "system.strategy", "str"], ["gcharge", "system.gridCharge", "bool"],
  ["xthr", "system.exportThreshold", "num"], ["ngom", "system.ngom", "bool"],
  ["maxp", "system.maxPanels", "num"], ["maxb", "system.maxBatteries", "num"],
  ["ovb", "system.override.batteries", "num"],

  ["cw", "fin.costPerW", "num"], ["ck", "fin.costPerKwh", "num"], ["add", "fin.adder", "num"],
  ["imode", "fin.incentiveMode", "str"], ["disc", "fin.discountPct", "num"],
  ["pass", "fin.passThroughPct", "num"], ["tcred", "fin.taxCreditPct", "num"],
  ["sgip", "fin.sgipPerKwh", "num"], ["reb", "fin.rebates", "num"],
  ["hz", "fin.horizon", "num"], ["esc", "fin.escalation", "num"], ["xesc", "fin.exportEscalation", "num"],
  ["ret", "fin.investReturn", "num"], ["infl", "fin.discountRate", "num"],
  ["pdeg", "fin.panelDeg", "num"], ["bdeg", "fin.battDeg", "num"],
  ["bry", "fin.battReplYear", "num"], ["brf", "fin.battReplFraction", "num"],
  ["om", "fin.omPerYear", "num"], ["invy", "fin.inverterYear", "num"],
  ["invw", "fin.inverterPerW", "num"], ["resale", "fin.resaleValue", "num"],

  ["fmode", "fin.financing.mode", "str"],
  ["lshare", "fin.financing.loan.sharePct", "num"], ["lapr", "fin.financing.loan.apr", "num"],
  ["lterm", "fin.financing.loan.termYears", "num"], ["lfee", "fin.financing.loan.dealerFeePct", "num"],
  ["lsmon", "fin.financing.lease.monthly", "num"], ["lsesc", "fin.financing.lease.escalatorPct", "num"],
  ["lsterm", "fin.financing.lease.termYears", "num"], ["lsbuy", "fin.financing.lease.buyout", "num"],

  ["tab", "ui.tab", "str"], ["demo", "ui.demo", "bool"], ["basis", "ui.basis", "str"], ["season", "ui.season", "num"],
  ["wx", "ui.weatherKey", "str"], ["obj", "ui.objective", "str"],
];

// ---------------------------------------------------------------- path access

export function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = String(path).split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] === null || typeof node[keys[i]] !== "object") node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return obj;
}

function coerce(kind, raw) {
  if (kind === "bool") return raw === true || raw === "true" || raw === 1 || raw === "1";
  if (kind === "num") { const n = Number(raw); return Number.isFinite(n) ? n : null; }
  return raw === null || raw === undefined ? null : String(raw);
}

/** Deep clone that keeps typed arrays intact (structuredClone is not in old Node). */
export function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = clone(v[k]);
  return out;
}

export function freshState() { return clone(DEFAULTS); }

// ---------------------------------------------------------------- plane codec

/** A plane compresses to `id:tilt:az:maxPanels:shading:costAdder:name`. */
function planeToToken(p) {
  const shade = p.shading && typeof p.shading.annual === "number" ? p.shading.annual : 0;
  return [p.id, p.tilt, p.azimuth, p.maxPanels, round(shade, 3), p.costAdder || 0,
    encodeURIComponent(p.name || "")].join(":");
}

function planeFromToken(tok) {
  const [id, tilt, az, maxPanels, shade, adder, name] = String(tok).split(":");
  return {
    id: id || "p1",
    name: decodeURIComponent(name || "") || "Roof face",
    tilt: num(tilt, 20), azimuth: num(az, 180), maxPanels: Math.round(num(maxPanels, 20)),
    shading: { annual: num(shade, 0) },
    costAdder: num(adder, 0),
    polygon: null, gutterEdge: null,
  };
}

/** A flexible load compresses to its identity plus its whole schedule. */
function flexToToken(f) {
  const s = f.schedule || {};
  const w = s.window || [8, 15], ow = s.overnightWindow || [1, 5];
  return [
    f.id, f.kind, Math.round(f.annualKwh || 0), f.source || "manual",
    s.mode || "asRecorded", s.daysPerWeek ?? 5, w[0], w[1],
    round(s.daylightFraction ?? 0.9, 2), ow[0], ow[1], round(s.maxKW ?? 8, 1),
    s.followSolar === false ? 0 : 1, round(f.scale ?? 1, 2),
    encodeURIComponent(f.name || ""),
  ].join(":");
}

function flexFromToken(tok) {
  const p = String(tok).split(":");
  return {
    id: p[0] || "f1", kind: p[1] || "custom", annualKwh: num(p[2], 0),
    source: p[3] || "manual",
    name: decodeURIComponent(p[14] || "") || "Flexible load",
    kwhByHour: null, detection: null,
    schedule: {
      mode: p[4] || "asRecorded", daysPerWeek: Math.round(num(p[5], 5)),
      window: [Math.round(num(p[6], 8)), Math.round(num(p[7], 15))],
      daylightFraction: num(p[8], 0.9),
      overnightWindow: [Math.round(num(p[9], 1)), Math.round(num(p[10], 5))],
      maxKW: num(p[11], 8), followSolar: p[12] !== "0",
    },
    scale: num(p[13], 1),
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// ---------------------------------------------------------------- hash codec

/**
 * Serialize only what differs from DEFAULTS.  An empty result means "this is
 * the default scenario", and the caller drops the `#` entirely.
 */
export function toHash(state) {
  const parts = [];
  for (const [key, path, kind] of SCALARS) {
    const v = getPath(state, path), d = getPath(DEFAULTS, path);
    if (v === d || v === null || v === undefined) continue;
    if (kind === "num" && Number(v) === Number(d)) continue;
    parts.push(key + "=" + encodeURIComponent(kind === "bool" ? (v ? "1" : "0") : String(v)));
  }
  const planes = state.roof && state.roof.planes;
  if (planes && planes.length) parts.push("roof=" + planes.map(planeToToken).join(";"));

  const flex = state.flex || [];
  if (flex.length) parts.push("flex=" + flex.map(flexToToken).join(";"));

  const ov = state.system && state.system.override && state.system.override.panelsByPlane;
  if (ov && Object.keys(ov).length) {
    parts.push("ovp=" + Object.entries(ov).map(([k, n]) => k + ":" + n).join(";"));
  }
  return parts.join("&");
}

export function fromHash(hash, base) {
  const state = base ? clone(base) : freshState();
  const body = String(hash || "").replace(/^#/, "");
  if (!body) return state;
  for (const pair of body.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const key = pair.slice(0, i), raw = decodeURIComponent(pair.slice(i + 1));
    if (key === "roof") { state.roof.planes = raw ? raw.split(";").map(planeFromToken) : []; continue; }
    if (key === "flex") { state.flex = raw ? raw.split(";").map(flexFromToken) : []; continue; }
    if (key === "ovp") {
      const map = {};
      for (const t of raw.split(";")) { const [id, n] = t.split(":"); if (id) map[id] = Math.round(num(n, 0)); }
      state.system.override.panelsByPlane = Object.keys(map).length ? map : null;
      continue;
    }
    const spec = SCALARS.find((s) => s[0] === key);
    if (!spec) continue;                       // unknown key: an older or newer link
    setPath(state, spec[1], coerce(spec[2], raw));
  }
  return state;
}

// ------------------------------------------------------------- storage codec

/**
 * localStorage carries everything the hash carries plus the parts too bulky
 * for a URL: roof polygons, a custom tariff, and the detected-load provenance.
 */
export function toStorage(state) {
  const out = { v: 1 };
  for (const [key, path, kind] of SCALARS) {
    const v = getPath(state, path), d = getPath(DEFAULTS, path);
    if (v === d || v === null || v === undefined) continue;
    if (kind === "num" && Number(v) === Number(d)) continue;
    out[key] = v;
  }
  if (state.roof && state.roof.planes && state.roof.planes.length) out.planes = clone(state.roof.planes);
  if (state.flex && state.flex.length) {
    // kwhByHour is a slice of the meter data and lives in IndexedDB with it.
    out.flex = state.flex.map((f) => { const c = clone(f); c.kwhByHour = null; return c; });
  }
  if (state.tariff && state.tariff.custom) out.customTariff = clone(state.tariff.custom);
  const ov = state.system && state.system.override && state.system.override.panelsByPlane;
  if (ov && Object.keys(ov).length) out.ovp = clone(ov);
  return out;
}

export function fromStorage(obj, base) {
  const state = base ? clone(base) : freshState();
  if (!obj || typeof obj !== "object") return state;
  for (const [key, path, kind] of SCALARS) {
    if (!(key in obj)) continue;
    setPath(state, path, coerce(kind, obj[key]));
  }
  if (Array.isArray(obj.planes)) state.roof.planes = clone(obj.planes);
  if (Array.isArray(obj.flex)) state.flex = clone(obj.flex);
  if (obj.customTariff) state.tariff.custom = clone(obj.customTariff);
  if (obj.ovp && Object.keys(obj.ovp).length) state.system.override.panelsByPlane = clone(obj.ovp);
  return state;
}

// ------------------------------------------------------------------- the store

const listeners = new Set();
let current = freshState();

export function get() { return current; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * `reason` tells listeners how much work a change costs: "finance" re-prices
 * cached simulations in ~15 ms, "sim" queues a worker round-trip, "ui" only
 * redraws.  main.js routes on it rather than diffing the whole state.
 */
export function update(mutator, reason = "ui") {
  const before = current.ui.tab;
  if (typeof mutator === "function") mutator(current);
  else Object.assign(current, mutator);
  for (const fn of listeners) fn(current, reason, { tabChanged: before !== current.ui.tab });
  return current;
}

export function replace(next, reason = "load") {
  current = next;
  for (const fn of listeners) fn(current, reason, { tabChanged: true });
  return current;
}

export function setAt(path, value, reason = "ui") {
  return update((s) => setPath(s, path, value), reason);
}

// ---------------------------------------------------------------- browser I/O

const hasWindow = typeof window !== "undefined";

export function writeHash(state = current) {
  if (!hasWindow) return "";
  const h = toHash(state);
  const url = h ? "#" + h : location.pathname + location.search;
  history.replaceState(null, "", url);
  return h;
}

export function readHash() { return hasWindow ? location.hash : ""; }

export function saveLocal(state = current) {
  if (!hasWindow) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toStorage(state))); }
  catch (err) { console.warn("Could not save the session locally:", err && err.message); }
}

export function loadLocal() {
  if (!hasWindow) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { console.warn("Could not read the saved session:", err && err.message); return null; }
}

export function clearLocal() {
  if (!hasWindow) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- IndexedDB

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(DB_STORE, mode);
    const req = fn(t.objectStore(DB_STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

/** LoadSets hold Float64Arrays; the structured-clone algorithm keeps them. */
export function saveLoadSet(loadSet) {
  return tx("readwrite", (store) => store.put(loadSet, LOAD_KEY)).catch((err) => {
    console.warn("Could not keep your meter data on this device:", err && err.message);
  });
}

export function readLoadSet() {
  return tx("readonly", (store) => store.get(LOAD_KEY)).catch(() => null);
}

/** "Forget my data" — hash, localStorage and IndexedDB, in that order. */
export async function forgetEverything() {
  clearLocal();
  if (hasWindow) history.replaceState(null, "", location.pathname + location.search);
  try { await tx("readwrite", (store) => store.clear()); } catch { /* nothing stored */ }
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.deleteDatabase) indexedDB.deleteDatabase(DB_NAME);
  } catch { /* some browsers refuse while a tab holds it open */ }
}

export default {
  DEFAULTS, TABS, STORAGE_KEY, DB_NAME, DB_STORE,
  freshState, clone, getPath, setPath,
  toHash, fromHash, toStorage, fromStorage,
  get, subscribe, update, replace, setAt,
  writeHash, readHash, saveLocal, loadLocal, clearLocal,
  saveLoadSet, readLoadSet, forgetEverything,
};
