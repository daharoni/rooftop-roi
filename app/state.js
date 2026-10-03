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
 * And site.lat / site.lon are written to the hash at two decimals (~1 km), so a
 * share link places a neighbourhood, never a house - see roundCoord().
 * ========================================================================== */

import { openSharedDb, closeSharedDb, SHARED_DB_NAME } from "../core/weather.js";

export const STORAGE_KEY = "rooftop-roi:v1";

/**
 * Version of both codecs.  The hash carries `v=1` and storage carries `{ v: 1 }`;
 * a future change to a default or a key's meaning adds an entry to MIGRATIONS so
 * an old link keeps meaning what it meant when it was shared.
 */
export const CODEC_VERSION = 1;

/**
 * from-version -> function(flat key/value object) returning the next version's
 * object.  Empty today: version 1 is the first versioned format, and unversioned
 * links and sessions are read as version 1.
 */
const MIGRATIONS = {
  // 1: (kv) => { /* e.g. if (!("cw" in kv)) kv.cw = 3.0;  // the old default */ return kv; },
};

function migrate(kv, from) {
  let v = Number.isInteger(from) && from >= 1 ? from : 1;
  while (v < CODEC_VERSION) {
    if (MIGRATIONS[v]) kv = MIGRATIONS[v](kv) || kv;
    v++;
  }
  return kv;
}

/** Longest roof-face or flexible-load name kept; anything longer is cut. */
export const NAME_MAX = 40;

/** Coordinates to ~1 km: all the solar model can use, and nothing a share link should carry more of. */
export function roundCoord(v) { return Math.round(Number(v) * 100) / 100; }
export const DB_NAME = SHARED_DB_NAME;
export const DB_STORE = "loads";
export const LOAD_KEY = "current";

export const TABS = ["dashboard", "roof", "loads", "bills", "assumptions"];

/** Defaults. Anything equal to these is omitted from the hash and from storage. */
export const DEFAULTS = {
  site: {
    lat: null, lon: null, elevationM: null, tz: null, utilityId: null, addressLabel: null,
    baselineRegion: null,     // utility baseline territory (e.g. SCE "9"); null = engine default
  },
  roof: { planes: [] },
  load: null,
  flex: [],
  baseLoadScale: 1,
  solar: { byPlane: {}, weatherYears: [], status: "idle", cached: false, note: "" },
  tariff: {
    utilityId: null, planId: null, providerId: null, custom: null,
  },
  system: {
    panelW: 460, battKWh: 10, battKW: 5, rte: 0.9, minReserve: 0.2,
    acFactor: 0.9,            // CEC-AC per panel as a share of nameplate (PTC x inverter), for the SCE sizing line
    strategy: "tou_arbitrage", gridCharge: false, exportThreshold: 0.5, ngom: false,
    maxPanels: 40, maxBatteries: 6,
    override: { panelsByPlane: null, batteries: null },
  },
  fin: {
    costPerW: 3.0, costPerKwh: 1000, adder: 0,
    trueUpMonth: null,        // 1-12, PTO anniversary month for the NBT true-up; null = tariff file default
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
    // The meter already exports (NEM 1/2 solar) and the person chose to go on anyway,
    // treating import as their whole usage. Kept in storage with the data, never in a link.
    existingSolarAck: false,
  },
};

/**
 * Every scalar that survives a reload, with the short key it wears in the hash
 * and the schema a value must pass to be accepted from a link or from storage.
 * A value that fails (unparseable, out of range, not in the enum) is replaced by
 * the DEFAULTS value, never by null.  Ranges are the rail's own slider bounds,
 * widened where a typed value or another utility's tariff can legitimately sit
 * outside them.
 *
 *   num: { min, max, int }     str: { enum } | { re, max }     bool: {}
 */
const STRATEGIES = ["self_consumption", "tou_arbitrage", "export_arbitrage", "backup_only"];
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const SCALARS = [
  ["lat", "site.lat", "num", { min: -90, max: 90 }],
  ["lon", "site.lon", "num", { min: -180, max: 180 }],
  ["elev", "site.elevationM", "num", { min: -500, max: 9000 }],
  ["tz", "site.tz", "str", { re: /^[A-Za-z0-9_/+-]+$/, max: 64 }],
  ["util", "site.utilityId", "str", { re: ID_RE, max: 24 }],
  ["breg", "site.baselineRegion", "str", { re: ID_RE, max: 12 }],

  ["bls", "baseLoadScale", "num", { min: 0.1, max: 5 }],

  ["plan", "tariff.planId", "str", { re: ID_RE, max: 48 }],
  ["prov", "tariff.providerId", "str", { re: ID_RE, max: 48 }],
  ["tum", "fin.trueUpMonth", "num", { min: 1, max: 12, int: true }],

  ["pw", "system.panelW", "num", { min: 100, max: 1000 }],
  ["acf", "system.acFactor", "num", { min: 0.5, max: 1 }],
  ["bkwh", "system.battKWh", "num", { min: 1, max: 100 }],
  ["bkw", "system.battKW", "num", { min: 0.5, max: 50 }],
  ["rte", "system.rte", "num", { min: 0.5, max: 1 }],
  ["res", "system.minReserve", "num", { min: 0, max: 0.9 }],
  ["strat", "system.strategy", "str", { enum: STRATEGIES }],
  ["gcharge", "system.gridCharge", "bool", {}],
  ["xthr", "system.exportThreshold", "num", { min: 0, max: 5 }],
  ["ngom", "system.ngom", "bool", {}],
  ["maxp", "system.maxPanels", "num", { min: 1, max: 200, int: true }],
  ["maxb", "system.maxBatteries", "num", { min: 0, max: 20, int: true }],
  ["ovb", "system.override.batteries", "num", { min: -1, max: 20, int: true }],

  ["cw", "fin.costPerW", "num", { min: 0, max: 15 }],
  ["ck", "fin.costPerKwh", "num", { min: 0, max: 5000 }],
  ["add", "fin.adder", "num", { min: 0, max: 200000 }],
  ["imode", "fin.incentiveMode", "str", { enum: ["none", "discount", "vendor"] }],
  ["disc", "fin.discountPct", "num", { min: 0, max: 1 }],
  ["pass", "fin.passThroughPct", "num", { min: 0, max: 1 }],
  ["tcred", "fin.taxCreditPct", "num", { min: 0, max: 1 }],
  ["sgip", "fin.sgipPerKwh", "num", { min: 0, max: 5000 }],
  ["reb", "fin.rebates", "num", { min: 0, max: 200000 }],
  ["hz", "fin.horizon", "num", { min: 1, max: 50, int: true }],
  ["esc", "fin.escalation", "num", { min: -0.1, max: 0.3 }],
  ["xesc", "fin.exportEscalation", "num", { min: -0.1, max: 0.3 }],
  ["ret", "fin.investReturn", "num", { min: -0.2, max: 0.4 }],
  ["infl", "fin.discountRate", "num", { min: -0.1, max: 0.3 }],
  ["pdeg", "fin.panelDeg", "num", { min: 0, max: 0.1 }],
  ["bdeg", "fin.battDeg", "num", { min: 0, max: 0.2 }],
  ["bry", "fin.battReplYear", "num", { min: 1, max: 50, int: true }],
  ["brf", "fin.battReplFraction", "num", { min: 0, max: 2 }],
  ["om", "fin.omPerYear", "num", { min: 0, max: 20000 }],
  ["invy", "fin.inverterYear", "num", { min: 1, max: 50, int: true }],
  ["invw", "fin.inverterPerW", "num", { min: 0, max: 3 }],
  ["resale", "fin.resaleValue", "num", { min: 0, max: 500000 }],

  ["fmode", "fin.financing.mode", "str", { enum: ["cash", "loan", "lease"] }],
  ["lshare", "fin.financing.loan.sharePct", "num", { min: 0, max: 1 }],
  ["lapr", "fin.financing.loan.apr", "num", { min: 0, max: 0.5 }],
  ["lterm", "fin.financing.loan.termYears", "num", { min: 1, max: 40, int: true }],
  ["lfee", "fin.financing.loan.dealerFeePct", "num", { min: 0, max: 0.6 }],
  ["lsmon", "fin.financing.lease.monthly", "num", { min: 0, max: 5000 }],
  ["lsesc", "fin.financing.lease.escalatorPct", "num", { min: 0, max: 0.2 }],
  ["lsterm", "fin.financing.lease.termYears", "num", { min: 1, max: 40, int: true }],
  ["lsbuy", "fin.financing.lease.buyout", "num", { min: 0, max: 500000 }],

  // Tab ids are normalised by main.js (old links say "money" or "home").
  ["tab", "ui.tab", "str", { re: /^[a-z]+$/, max: 20 }],
  ["demo", "ui.demo", "bool", {}],
  ["basis", "ui.basis", "str", { enum: ["sameFlex", "asRecorded"] }],
  ["season", "ui.season", "num", { min: 0, max: 1, int: true }],
  ["wx", "ui.weatherKey", "str", { re: /^[a-z0-9]+$/, max: 8 }],
  ["obj", "ui.objective", "str", { enum: ["npv", "lifetime", "irr", "payback"] }],
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

const INVALID = Symbol("invalid");

/** Parse a raw hash/storage value against its schema; INVALID when it fails. */
function parseScalar(kind, rule, raw) {
  rule = rule || {};
  if (kind === "bool") {
    if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
    if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
    return INVALID;
  }
  if (kind === "num") {
    if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return INVALID;
    const n = Number(raw);
    if (!Number.isFinite(n)) return INVALID;
    if (rule.int && !Number.isInteger(n)) return INVALID;
    if (rule.min !== undefined && n < rule.min) return INVALID;
    if (rule.max !== undefined && n > rule.max) return INVALID;
    return n;
  }
  if (raw === null || raw === undefined || typeof raw === "object") return INVALID;
  const str = String(raw);
  if (rule.enum) return rule.enum.includes(str) ? str : INVALID;
  if (!str || (rule.max && str.length > rule.max) || (rule.re && !rule.re.test(str))) return INVALID;
  return str;
}

/** Percent-decode once; null (never a throw) for a malformed sequence such as `%E0%A4%A`. */
export function safeDecode(raw) {
  try { return decodeURIComponent(String(raw)); } catch { return null; }
}

const cleanName = (v, fallback) => {
  const n = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  return n || fallback;
};
const inRange = (v, d, lo, hi, int) => {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < lo || n > hi) return d;
  return int ? Math.round(n) : n;
};

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

/**
 * A plane compresses to `id:tilt:az:maxPanels:shading:costAdder:name`, each field
 * percent-encoded exactly once.  encodeURIComponent escapes `; : % & , =`, so the
 * separators can never appear inside a field and the decoder can split first and
 * decode each field once afterwards.
 */
function planeToToken(p) {
  const shade = p.shading && typeof p.shading.annual === "number" ? p.shading.annual : 0;
  return [p.id, p.tilt, p.azimuth, p.maxPanels, round(shade, 3), p.costAdder || 0,
    cleanName(p.name, "")].map((f) => encodeURIComponent(String(f))).join(":");
}

/** `fields` are already decoded; anything unreadable falls back to the plane default. */
function planeFromFields(f, i) {
  const id = f[0] && ID_RE.test(f[0]) && f[0].length <= 24 ? f[0] : "p" + (i + 1);
  return {
    id,
    name: cleanName(f[6], "Roof face"),
    tilt: inRange(f[1], 20, 0, 90), azimuth: inRange(f[2], 180, 0, 360),
    maxPanels: inRange(f[3], 20, 0, 200, true),
    shading: { annual: inRange(f[4], 0, 0, 1) },
    costAdder: inRange(f[5], 0, 0, 200000),
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
    cleanName(f.name, ""),
  ].map((x) => encodeURIComponent(String(x))).join(":");
}

function flexFromFields(p, i) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    id: p[0] && ID_RE.test(p[0]) && p[0].length <= 40 ? p[0] : "f" + (i + 1),
    kind: pick(p[1], ["ev", "pool", "custom"], "custom"),
    annualKwh: inRange(p[2], 0, 0, 200000),
    source: pick(p[3], ["detected", "manual"], "manual"),
    name: cleanName(p[14], "Flexible load"),
    kwhByHour: null, detection: null,
    schedule: {
      mode: pick(p[4], ["asRecorded", "spread"], "asRecorded"),
      daysPerWeek: inRange(p[5], 5, 0, 7, true),
      window: [inRange(p[6], 8, 0, 24, true), inRange(p[7], 15, 0, 24, true)],
      daylightFraction: inRange(p[8], 0.9, 0, 1),
      overnightWindow: [inRange(p[9], 1, 0, 24, true), inRange(p[10], 5, 0, 24, true)],
      maxKW: inRange(p[11], 8, 0, 100), followSolar: p[12] !== "0",
    },
    scale: inRange(p[13], 1, 0, 10),
  };
}

/**
 * Split a raw (still percent-encoded) list value on `;` then `:`, and decode each
 * field exactly once.  A field that will not decode becomes "" and is reported.
 */
function splitTokens(raw, report, key) {
  if (!raw) return [];
  return String(raw).split(";").filter((t) => t !== "").map((tok) => tok.split(":").map((f) => {
    const d = safeDecode(f);
    if (d === null) { flag(report, key); return ""; }
    return d;
  }));
}

function flag(report, key) {
  if (!report) return;
  report.damaged = true;
  (report.keys || (report.keys = [])).push(key);
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// ---------------------------------------------------------------- hash codec

/**
 * Serialize only what differs from DEFAULTS.  An empty result means "this is
 * the default scenario", and the caller drops the `#` entirely; anything else
 * starts with `v=1`.
 */
export function toHash(state) {
  const parts = [];
  for (const [key, path, kind] of SCALARS) {
    const v = getPath(state, path), d = getPath(DEFAULTS, path);
    if (v === d || v === null || v === undefined) continue;
    if (kind === "num" && Number(v) === Number(d)) continue;
    const out = (key === "lat" || key === "lon") ? roundCoord(v) : v;
    parts.push(key + "=" + encodeURIComponent(kind === "bool" ? (out ? "1" : "0") : String(out)));
  }
  const planes = state.roof && state.roof.planes;
  if (planes && planes.length) parts.push("roof=" + planes.map(planeToToken).join(";"));

  const flex = state.flex || [];
  if (flex.length) parts.push("flex=" + flex.map(flexToToken).join(";"));

  const ov = state.system && state.system.override && state.system.override.panelsByPlane;
  if (ov && Object.keys(ov).length) {
    parts.push("ovp=" + Object.entries(ov)
      .map(([k, n]) => encodeURIComponent(k) + ":" + encodeURIComponent(String(n))).join(";"));
  }
  return parts.length ? ["v=" + CODEC_VERSION].concat(parts).join("&") : "";
}

/**
 * Apply a hash over `base`.  Never throws: a malformed percent sequence, an
 * out-of-range number or an unknown enum value leaves that setting at its
 * DEFAULTS value and is listed in `report` ({ damaged, keys }) so the page can
 * say the link was damaged.
 */
export function fromHash(hash, base, report) {
  const state = base ? clone(base) : freshState();
  let body = "";
  try { body = String(hash || "").replace(/^#/, ""); } catch { body = ""; }
  if (!body) return state;

  const kv = {};
  for (const pair of body.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const key = safeDecode(pair.slice(0, i));
    if (key === null) { flag(report, "?"); continue; }
    kv[key] = pair.slice(i + 1);               // still encoded
  }
  const version = kv.v !== undefined ? Number(safeDecode(kv.v)) : 1;
  delete kv.v;
  const flat = migrate(kv, version);

  for (const [key, raw] of Object.entries(flat)) {
    if (key === "roof") {
      state.roof.planes = splitTokens(raw, report, key).map(planeFromFields);
      continue;
    }
    if (key === "flex") {
      state.flex = splitTokens(raw, report, key).map(flexFromFields);
      continue;
    }
    if (key === "ovp") {
      const map = {};
      for (const [id, n] of splitTokens(raw, report, key)) {
        if (id && /^[A-Za-z0-9_.-]{1,24}$/.test(id)) map[id] = inRange(n, 0, 0, 200, true);
      }
      state.system.override.panelsByPlane = Object.keys(map).length ? map : null;
      continue;
    }
    const spec = SCALARS.find((s) => s[0] === key);
    if (!spec) continue;                       // unknown key: an older or newer link
    const decoded = safeDecode(raw);
    const v = decoded === null ? INVALID : parseScalar(spec[2], spec[3], decoded);
    if (v === INVALID) { flag(report, key); setPath(state, spec[1], clone(getPath(DEFAULTS, spec[1]))); continue; }
    setPath(state, spec[1], v);
  }
  return state;
}

// ------------------------------------------------------------- storage codec

/**
 * localStorage carries everything the hash carries plus the parts too bulky
 * for a URL: roof polygons, a custom tariff, and the detected-load provenance.
 */
export function toStorage(state) {
  const out = { v: CODEC_VERSION };
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
  if (state.ui && state.ui.existingSolarAck) out.xsolAck = true;
  return out;
}

export function fromStorage(obj, base) {
  const state = base ? clone(base) : freshState();
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return state;
  // A session written by a newer build than this one: its keys may mean
  // something else, so start clean rather than half-apply it.
  if (typeof obj.v === "number" && obj.v > CODEC_VERSION) return state;
  const flat = migrate(Object.assign({}, obj), typeof obj.v === "number" ? obj.v : 1);
  for (const [key, path, kind, rule] of SCALARS) {
    if (!(key in flat)) continue;
    const v = parseScalar(kind, rule, flat[key]);
    setPath(state, path, v === INVALID ? clone(getPath(DEFAULTS, path)) : v);
  }
  if (Array.isArray(flat.planes)) state.roof.planes = clone(flat.planes);
  if (Array.isArray(flat.flex)) state.flex = clone(flat.flex);
  if (flat.customTariff) state.tariff.custom = clone(flat.customTariff);
  if (flat.ovp && typeof flat.ovp === "object" && Object.keys(flat.ovp).length) {
    state.system.override.panelsByPlane = clone(flat.ovp);
  }
  if (flat.xsolAck === true) state.ui.existingSolarAck = true;
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

/**
 * Both writes are wrapped: Safari throws SecurityError after ~100 replaceState
 * calls in 30 s, and an unguarded throw here would abort every later listener
 * in update()'s loop.
 */
export function writeHash(state = current) {
  if (!hasWindow) return "";
  let h = "";
  try {
    h = toHash(state);
    const url = h ? "#" + h : location.pathname + location.search;
    history.replaceState(null, "", url);
  } catch (err) {
    console.warn("Could not update the address bar:", err && err.message);
  }
  return h;
}

export function readHash() { return hasWindow ? location.hash : ""; }

export function saveLocal(state = current) {
  if (!hasWindow) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toStorage(state))); }
  catch (err) { console.warn("Could not save the session locally:", err && err.message); }
}

/**
 * Slider drags fire update() at 60 Hz; the URL and localStorage only need the
 * value the hand stopped on.  persistSoon coalesces to one write per 300 ms
 * and flushPersist (on pagehide / tab hidden) writes the last one immediately.
 */
export const PERSIST_DELAY_MS = 300;
let persistTimer = null;
let persistPending = false;

export function persistSoon() {
  persistPending = true;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS);
}

export function flushPersist() {
  if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
  if (!persistPending) return;
  persistPending = false;
  writeHash(current);
  saveLocal(current);
}

export function cancelPersist() {
  if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
  persistPending = false;
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
//
// The database is shared with core/weather.js (store `weather`), so it is opened
// only through that module's openSharedDb(): one version, one upgrade handler
// that creates both stores.  The connection is cached and shared, so a
// transaction here never closes it.

function tx(mode, fn, store = DB_STORE, retry = true) {
  return openSharedDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = t.onabort = () => reject(t.error);
  })).catch((err) => {
    if (retry && err && err.name === "InvalidStateError") return tx(mode, fn, store, false);
    throw err;
  });
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

/**
 * "Forget my data" — hash, localStorage, then IndexedDB: both stores are cleared
 * explicitly first (so the data is gone even if the delete below is blocked by
 * another open tab), the shared connection is closed, and the database deleted.
 */
export async function forgetEverything() {
  cancelPersist();
  clearLocal();
  if (hasWindow) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* Safari rate limit */ }
  }
  try { await tx("readwrite", (store) => store.clear(), "loads"); } catch { /* nothing stored */ }
  try { await tx("readwrite", (store) => store.clear(), "weather"); } catch { /* nothing stored */ }
  await closeSharedDb();
  if (typeof indexedDB === "undefined" || !indexedDB.deleteDatabase) return;
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = () => resolve();
      // Another tab still has it open; the stores are already empty, so carry on.
      req.onblocked = () => resolve();
    } catch { resolve(); }
    setTimeout(resolve, 1500);
  });
}

export default {
  DEFAULTS, TABS, STORAGE_KEY, DB_NAME, DB_STORE, CODEC_VERSION, NAME_MAX,
  freshState, clone, getPath, setPath, safeDecode,
  toHash, fromHash, toStorage, fromStorage,
  get, subscribe, update, replace, setAt,
  writeHash, readHash, saveLocal, loadLocal, clearLocal,
  persistSoon, flushPersist, cancelPersist,
  saveLoadSet, readLoadSet, forgetEverything,
};
