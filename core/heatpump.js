/* =============================================================================
 * core/heatpump.js - a planned heat pump (replacing a gas furnace) as an hourly load.
 *
 * Pure ES module, browser + Node 24.  No DOM, no network.
 *
 *   profileFor(flex, loadSet, weatherYears) -> Float64Array(loadSet.kwh.length)
 *   defaultAnnualKwh({ sqft }) -> number
 *   describe(flex) -> string
 *
 * Why weather: a heat pump's electricity follows the outdoor temperature, not the
 * household's habits, so nothing in the meter record can say what it would draw.  The
 * only honest shape is heating demand from the weather at the site: each hour needs
 * `max(0, balanceC - outdoorC)` degree-hours of heat, which takes `1 / cop` as much
 * electricity.  One constant k then scales the whole series so that a year sums to the
 * visitor's `annualKwh`; the shape is the weather's, the size is the visitor's.
 *
 * Which temperature for which hour: the weather year with the same calendar year as the
 * load timestamp when we have it, otherwise the day-of-year x hour average over every
 * weather year we hold (a climatology), so a record from a year the archive does not
 * cover still gets a plausible winter.  The load timestamp is local wall-clock time; the
 * weather year is local STANDARD time with Feb 29 dropped.  `buildCalendar` already maps
 * the one onto the other (repeated fall-back hour, spring-forward gap, leap day), the
 * same way core/engine.js does for solar, and is reused here so the two cannot drift.
 * ========================================================================== */

import { buildCalendar } from "./flexload.js";

const HOURS_PER_YEAR = 8760;

/**
 * A rough first guess for the annual electricity of a heat pump that replaces a gas
 * furnace in southern California (coastal and inland): about 3 kWh per square foot per
 * year.  That is an assumption, not a measurement: southern California winters are mild,
 * so the heating load is small, and a heat pump at a COP near 3 needs a third as much
 * electricity as the furnace's heat output.  Clamped to the slider's range.  With no floor area, 2,500 kWh.
 */
export function defaultAnnualKwh({ sqft } = {}) {
  const s = +sqft;
  if (!(s > 0)) return 2500;
  return Math.max(500, Math.min(8000, Math.round(3 * s / 100) * 100));
}

/** Day-of-year x hour mean over every weather year that has a temperature series. */
function climatology(weatherYears) {
  const sum = new Float64Array(HOURS_PER_YEAR);
  let n = 0;
  for (const wy of weatherYears || []) {
    if (!wy || !wy.temp || wy.temp.length < HOURS_PER_YEAR) continue;
    for (let i = 0; i < HOURS_PER_YEAR; i++) sum[i] += wy.temp[i];
    n++;
  }
  if (!n) return null;
  for (let i = 0; i < HOURS_PER_YEAR; i++) sum[i] /= n;
  return sum;
}

/**
 * Hourly electricity, one value per load timestamp.  All zeros (never a throw) when
 * there is no weather to follow or no demand to scale.
 *
 * Heating only.  `flex.heatpump.mode` is read so cooling can slot in later: it would add
 * `max(0, tempC - coolBalanceC) / copCool` here, scaled by its own annual figure.
 */
export function profileFor(flex, loadSet, weatherYears) {
  const N = loadSet.kwh.length;
  const out = new Float64Array(N);
  const hp = (flex && flex.heatpump) || {};
  const annual = +(hp.annualKwh != null ? hp.annualKwh : flex && flex.annualKwh) || 0;
  const cop = hp.cop > 0 ? +hp.cop : 3.0;
  const balanceC = hp.balanceC != null && isFinite(hp.balanceC) ? +hp.balanceC : 16;
  // const mode = hp.mode || "heating";   // cooling hook: only "heating" is modelled
  const clim = climatology(weatherYears);
  if (!N || !(annual > 0) || !clim) return out;

  const byYear = new Map();
  for (const wy of weatherYears) {
    if (wy && wy.temp && wy.temp.length >= HOURS_PER_YEAR && wy.year != null) byYear.set(+wy.year, wy.temp);
  }
  const cal = buildCalendar(loadSet);
  const ts = loadSet.ts;
  for (let i = 0; i < N; i++) {
    const temp = byYear.get(+ts[i].slice(0, 4)) || clim;
    const t = temp[cal.solarIdx[i]];
    const demand = isFinite(t) ? Math.max(0, balanceC - t) : 0;
    out[i] = demand / cop;                 // kWh-electric per unit k, before scaling
  }

  // Scale over the most recent 365 days of the record (8,760 slots; a DST year is a
  // couple of slots off, which is far below the weather's own uncertainty).  A shorter
  // record is scaled pro rata: its hours' share of a year of the annual figure.
  const win = Math.min(N, HOURS_PER_YEAR);
  let s = 0;
  for (let i = N - win; i < N; i++) s += out[i];
  if (!(s > 0)) { out.fill(0); return out; }
  const k = (annual * win / HOURS_PER_YEAR) / s;
  for (let i = 0; i < N; i++) out[i] *= k;
  return out;
}

/** One or two sentences for the Loads tab. */
export function describe(flex) {
  const hp = (flex && flex.heatpump) || {};
  const annual = Math.round(+(hp.annualKwh != null ? hp.annualKwh : flex && flex.annualKwh) || 0);
  const cop = hp.cop > 0 ? +hp.cop : 3.0;
  const bal = hp.balanceC != null ? +hp.balanceC : 16;
  const f = Math.round(bal * 9 / 5 + 32);
  return `A heat pump using ${annual.toLocaleString("en-US")} kWh a year to heat the house. ` +
    `It runs whenever the outdoor temperature is below ${bal} °C (${f} °F), harder the colder it gets, ` +
    `and turns each unit of electricity into about ${cop.toFixed(1)} units of heat.`;
}

export default { profileFor, defaultAnnualKwh, describe };
