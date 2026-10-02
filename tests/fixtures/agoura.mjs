/* =============================================================================
 * tests/fixtures/agoura.mjs - the reference household, adapted to the new contracts.
 *
 * The fixtures are the PROTOTYPE's bundle: load-agoura-hills.json still carries the
 * EV series inside the load file (`ev_kwh`), and solar-agoura-hills.json still ships
 * orientation factors separately from the profiles.  The new API takes neither, so
 * this adapter does what core/greenbutton.js + core/flexload.js + core/pv.js will do
 * in the app:
 *
 *   loadSet()   { meta, ts, kwh, exportKwh }      - no EV series
 *   evFlex()    the detected EV as a FlexLoad with the prototype's default schedule
 *   poolFlex()  the prototype's pool pump as a manual FlexLoad
 *   plane()     one roof plane whose 8760 profile already carries its orientation
 *
 * Orientation is folded into the plane as a monthly derate, exactly the way the
 * prototype applied `orientation_factors` by calendar month, so the reference numbers
 * are comparable line for line.
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

export const RAW_LOAD = read("tests/fixtures/load-agoura-hills.json");
export const SOLAR = read("tests/fixtures/solar-agoura-hills.json");
export const TARIFF = read("data/tariffs/sce.json");

/** LoadSet per docs/ARCHITECTURE.md - the whole-house series, EV included in it. */
export function loadSet() {
  return {
    meta: { source: "sce-csv", tz: RAW_LOAD.meta.tz, start: RAW_LOAD.meta.start,
            end: RAW_LOAD.meta.end, nHours: RAW_LOAD.meta.n_hours,
            totalKwh: RAW_LOAD.meta.total_kwh, intervalMinutes: 60,
            gapsFilled: RAW_LOAD.meta.gaps_filled || [], notes: [RAW_LOAD.meta.notes] },
    ts: RAW_LOAD.ts,
    kwh: Float64Array.from(RAW_LOAD.kwh),
    exportKwh: null,
  };
}

/** The detected EV, with the prototype's default charging schedule. */
const EV_SCHEDULE = { mode: "spread", daysPerWeek: 5, window: [8, 15], daylightFraction: 0.9,
                      overnightWindow: [1, 5], maxKW: 8.0, followSolar: true };
export function evFlex(over = {}) {
  return {
    id: "ev1", kind: "ev", name: "EV", source: "detected",
    kwhByHour: Float64Array.from(RAW_LOAD.ev_kwh),
    annualKwh: RAW_LOAD.meta.ev_kwh_per_year,
    detection: { method: RAW_LOAD.meta.ev_method, chargerKW: 8.02, sessions: RAW_LOAD.ev_sessions },
    scale: 1,
    ...over,
    schedule: { ...EV_SCHEDULE, ...(over.schedule || {}) },
  };
}

/** The prototype's pool pump: 0.5 kW for 8 h/day inside the solar window, every day. */
const POOL_SCHEDULE = { mode: "spread", daysPerWeek: 7, window: [9, 17], daylightFraction: 1,
                        overnightWindow: [1, 5], maxKW: 0.5, followSolar: false, hoursPerDay: 8 };
export function poolFlex(over = {}) {
  return {
    id: "pool1", kind: "pool", name: "Pool pump", source: "manual",
    kwhByHour: null, annualKwh: 0.5 * 8 * 365, detection: null,
    scale: 1,
    ...over,
    schedule: { ...POOL_SCHEDULE, ...(over.schedule || {}) },
  };
}

// --- orientation factors: core/pv.js bakes these into the profile it hands the engine.
function bracket(list, v) {
  if (v <= list[0]) return [list[0], list[0], 0];
  const last = list[list.length - 1];
  if (v >= last) return [last, last, 0];
  for (let i = 1; i < list.length; i++) {
    if (v <= list[i]) return [list[i - 1], list[i], (v - list[i - 1]) / (list[i] - list[i - 1])];
  }
  return [last, last, 0];
}
export function orientationFactor(tilt, az) {
  const of = SOLAR.orientation_factors || {};
  const tilts = new Set(), azs = new Set();
  for (const k of Object.keys(of)) {
    const m = /^tilt_(-?\d+)_az_(-?\d+)$/.exec(k);
    if (m && Array.isArray(of[k]) && of[k].length === 12) { tilts.add(+m[1]); azs.add(+m[2]); }
  }
  const T = [...tilts].sort((a, b) => a - b), A = [...azs].sort((a, b) => a - b);
  const bt = bracket(T, tilt), ba = bracket(A, az);
  const at = (t, a) => of[`tilt_${t}_az_${a}`] || new Array(12).fill(1);
  const f00 = at(bt[0], ba[0]), f01 = at(bt[0], ba[1]);
  const f10 = at(bt[1], ba[0]), f11 = at(bt[1], ba[1]);
  const out = [];
  for (let m = 0; m < 12; m++) {
    const lo = f00[m] + (f01[m] - f00[m]) * ba[2];
    const hi = f10[m] + (f11[m] - f10[m]) * ba[2];
    out.push(lo + (hi - lo) * bt[2]);
  }
  return out;
}

/**
 * One roof plane.  `shading.monthly` carries the orientation derate for the reference
 * roof (tilt 20, azimuth 169), which is how the prototype applied it: a monthly
 * multiplier keyed on the calendar month of the metered hour.  Extra shading passed in
 * `over.shading` replaces it.
 */
export function plane(panels, over = {}) {
  const tilt = over.tilt === undefined ? 20 : over.tilt;
  const az = over.azimuth === undefined ? 169 : over.azimuth;
  const key = over.weatherKey || "tmy";
  const of = orientationFactor(tilt, az);
  return {
    id: over.id || "p1", name: over.name || "Main roof",
    profile: Float64Array.from(SOLAR.profiles[key]),
    panels, maxPanels: over.maxPanels === undefined ? 60 : over.maxPanels,
    shading: over.shading === undefined ? { monthly: of.map((f) => 1 - f) } : over.shading,
  };
}

/** The prototype's default scenario: one roof, the detected EV, the pool pump. */
export function refParams(panels = 20, batteries = 1, over = {}) {
  return {
    planes: [plane(panels)], flex: [evFlex(), poolFlex()],
    batteries, planId: "TOU-D-PRIME", providerId: "cpa_green", weatherKey: "tmy",
    ...over,
  };
}

/** The prototype's answer, reproduced exactly by the engine's fallback reshape. */
export const REFERENCE = {
  billReplay: { start: "2026-07-23", end: "2026-08-20", days: 29,
                model: 749.41, actual: 749.37,
                kwh: { on: 436, mid: 176, off: 1362, total: 1974 } },
  optimum: { panels: 27, batteries: 1, npv: 45226, irr: 0.179244, payback: 6.1104,
             escalation: 0.05 },
};
