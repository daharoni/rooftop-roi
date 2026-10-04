/* =============================================================================
 * core/engine.js - hourly solar + storage simulation for one household.
 *
 * Plain ES module, no DOM, no dependencies.  The same source is concatenated into
 * app/worker-bundle.js by core/bundle-for-worker.mjs so the Blob worker can run it
 * as a classic script (see that file for the two rewriting rules it applies).
 *
 * -----------------------------------------------------------------------------
 * INPUT CONTRACT (docs/ARCHITECTURE.md is the authority)
 * -----------------------------------------------------------------------------
 * prepare({ load, tariffs })
 *   load     LoadSet from core/greenbutton.js:
 *              ts[]        "YYYY-MM-DDTHH:00" local CLOCK time, hour start.  Real DST
 *                          days: spring-forward has 23 slots, fall-back has 24 (the
 *                          duplicated wall-clock hour is summed into one slot).
 *              kwh[]       delivered (import) kWh for that hour
 *              exportKwh[] received kWh, or null
 *              meta        { tz, start, end, nHours, totalKwh, gapsFilled, notes }
 *   tariffs  data/tariffs/<utility>.json (schema: docs/tariffs-sce.md)
 *
 * params.planes[] = { id, profile: Float64Array(8760), panels, shading }
 *   profile  kWh AC per kW DC, index (dayOfYear-1)*24 + hour, local STANDARD time,
 *            365-day year.  The caller picks the weather year (see profileFor()).
 *   shading  { annual: fractionLost } | { monthly: [12 fractions lost] }
 *   Orientation is baked into the profile by core/pv.js; the engine never applies
 *   orientation factors of its own.  PV per hour = sum over planes.
 *
 * params.billing  "nbt" (default) | "nem2" | "nem1": which export-credit regime settles the
 *   bill.  NEM 1/2 credits each exported kWh at that hour's retail import price (NEM 2
 *   less the non-bypassable charges), rolls the dollars monthly and zeroes them at the
 *   annual true-up after paying Net Surplus Compensation on the surplus kWh.  See
 *   docs/nem2.md.
 * params.existing = { planeId, panels } | null: panels ALREADY on the roof.  The meter
 *   then records import and export of a house with solar, so the household load is
 *   reconstructed as import - export + the modelled output of those panels, and every
 *   scenario (both baselines included) carries them.
 *
 * params.flex[] = FlexLoad (core/flexload.js).  The engine subtracts every detected
 *   `kwhByHour` from the recorded load to get the base load, then adds each flex load
 *   back at its scheduled hours via FlexLoad.reshape(flex, cal, solarShape).
 *
 * -----------------------------------------------------------------------------
 * ASSUMPTIONS BEYOND THE CONTRACT (all surfaced in the UI's method panel)
 * -----------------------------------------------------------------------------
 * 1. rates[season][period][providerId] is the FULL bundled $/kWh for that provider
 *    (delivery + that provider's generation).  An unknown provider id falls back to
 *    the SAME utility's default provider (result.tariffTerms.providerFallback = true),
 *    then to delivery + `<utilityId>_generation`; anything else throws.
 * 2. nbt.nonbypassable_charges_per_kwh is treated as ALREADY INSIDE the retail
 *    import rates (that is how SCE publishes them), so it is not added on top.
 *    Set params.applyNbc = true if your tariff file lists NBC-exclusive rates.
 * 3. Net surplus is kWh, not dollars: at true-up the kWh exported minus the kWh
 *    imported over the relevant period (if positive) are debited from the export
 *    credit balance at the ARECR (never below zero; the ACC Plus adder is exempt) and
 *    paid at the NSC rate (settle()).
 * 4. The minimum-charge floor is max(minimum_charge_per_day, fixed_charge_per_day)
 *    x days.  Export credit (ACC value and ACC Plus adder alike) offsets a month only
 *    down to max(that floor, fixed charge + nbt.nonbypassable_charges_per_kwh x imported
 *    kWh): NBCs and the fixed charge are always paid.  Credit that does not fit is
 *    banked, settled at true-up, and any residual carried into the next period.
 * 5. Holidays use the weekend schedule: New Year's, Presidents', Memorial,
 *    Independence, Labor, Veterans, Thanksgiving, Christmas, on the actual date, and a
 *    Sunday holiday also on the Monday after (a Saturday one is NOT moved to Friday:
 *    the utilities' rule).  The rule, and the plan's schedule_overrides, come from
 *    core/periods.js - the SAME lookup core/tariff.js periodAt() uses.
 * ========================================================================== */

import FlexLoad from "./flexload.js";
import Periods from "./periods.js";

const EPS = 1e-9;
const PERIOD_IDS = ["on", "mid", "off", "super_off"];
const PERIOD_INDEX = { on: 0, mid: 1, off: 2, super_off: 3 };
const CUM_NONLEAP = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
// SCE's published generation rate minus CPA Clean Power's, identical for every
// residential schedule (SCE/CPA Joint Rate Comparison).  Used only to separate the
// CCA surcharge stack from true generation when applying the municipal surcharge.
const SCE_CPA_GEN_GAP = 0.02433;
// Export-price buckets, highest first.  Schedule NBT SC 5.c.vii deems forfeited export
// to have happened in the customer's highest-priced hours, cascading downward, so the
// hourly loop files every exported kWh into a price band and the settlement strips
// credit from the top band down.  Ten bands is close enough to exact and costs one
// comparison chain per hour.
const EXP_BANDS = [1.00, 0.70, 0.50, 0.35, 0.25, 0.15, 0.09, 0.06, 0.03, 0];
function bandOf(rate) {
  for (let b = 0; b < EXP_BANDS.length; b++) if (rate >= EXP_BANDS[b]) return b;
  return EXP_BANDS.length - 1;
}

/**
 * Flexible-load rescheduling lives in core/flexload.js, which owns the contract
 * `reshape(flex, cal, solarShape) -> Float64Array(N)`.  fallbackReshape() below is a
 * straight generalisation of the prototype's spreadEV and stands in only if that
 * module ever returns something unusable (and in tests, which use it to pin the
 * prototype's exact numbers).  core/bundle-for-worker.mjs rewrites this import into
 * a reference to the FlexLoad global of the concatenated worker script.
 */
let _flexReshape = (FlexLoad && typeof FlexLoad.reshape === "function") ? FlexLoad.reshape : null;

/** Override the FlexLoad.reshape implementation (tests, and the worker bootstrap). */
export function setFlexReshape(fn) { _flexReshape = typeof fn === "function" ? fn : null; }
/** Which reshape implementation is live: "flexload" once core/flexload.js is wired in. */
export function flexReshapeSource() { return _flexReshape ? "flexload" : "engine-fallback"; }

// ---------------------------------------------------------------- calendar
// Holidays, the weekend rule and the schedule/override lookup are core/periods.js,
// shared with core/tariff.js periodAt(): there is exactly one TOU-period lookup.
const nthWeekday = Periods.nthWeekday;
// US DST: 2nd Sunday of March 02:00 -> 1st Sunday of November 02:00.
function dstBounds(year) {
  return { start: nthWeekday(year, 3, 0, 2), end: nthWeekday(year, 11, 0, 1) };
}
function isDST(y, mo, d, h) {
  const b = dstBounds(y);
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  if (mo === 3) return d > b.start || (d === b.start && h >= 2);
  return d < b.end || (d === b.end && h < 2);
}

// ---------------------------------------------------------------- prepare()
/**
 * One-time decode of a LoadSet + tariff into typed arrays and calendar indices.
 * Everything here is independent of every user control, so it happens once.
 */
export const MIN_USABLE_DAYS = 300;

export function prepare(data, opts) {
  const load = data.load, tariffs = data.tariffs;
  // null / undefined = the default bar; only a finite number lowers or raises it.
  const minOpt = opts ? opts.minUsableDays : undefined;
  const minUsableDays = minOpt != null && isFinite(+minOpt) ? +minOpt : MIN_USABLE_DAYS;
  const ts = load.ts, N = ts.length;
  const month = new Uint8Array(N);        // 1-12
  const hourA = new Int8Array(N);         // 0-23 wall clock
  const dayType = new Uint8Array(N);      // 0 weekday, 1 weekend/holiday
  const solarIdx = new Int32Array(N);     // index into an 8760 profile
  const dayIdx = new Int32Array(N);
  const monthIdx = new Int32Array(N);

  // Unfilled gaps (non-finite readings) are NOT priced as zero-usage hours: they are
  // masked out of the simulation entirely (`valid[i] = 0`), and every annualised total
  // divides by the USABLE days, so a 60-day outage no longer reads as a 16% smaller
  // household.  `recorded` still holds 0 there so nothing downstream sees a NaN.
  const recorded = new Float64Array(N);
  const valid = new Uint8Array(N);
  let nanHours = 0;
  for (let i = 0; i < N; i++) {
    const v = load.kwh[i] === null ? NaN : +load.kwh[i];
    if (isFinite(v)) { recorded[i] = v; valid[i] = 1; } else nanHours++;
  }
  const exportKwh = load.exportKwh ? Float64Array.from(load.exportKwh, (v) => (isFinite(v) ? v : 0)) : null;

  const dayStart = [], dayLen = [], dayDow = [], monthDays = [], monthKey = [], dayExpect = [];
  const dayValid = [], monthValidHours = [], monthHours = [];
  let prevDay = "", prevMonth = "", d = -1, m = -1, prevTs = "";
  let cachedDayType = 0;

  for (let i = 0; i < N; i++) {
    const s = ts[i];
    const y = +s.slice(0, 4), mo = +s.slice(5, 7), dd = +s.slice(8, 10), h = +s.slice(11, 13);
    const dkey = s.slice(0, 10), mkey = s.slice(0, 7);
    if (dkey !== prevDay) {
      prevDay = dkey; d++; dayStart.push(i); dayLen.push(0); dayValid.push(0);
      // Hours a complete day has: 23 on the spring-forward Sunday, else 24 (a fall-back
      // day may carry 25 rows; dividing by the rows present covers that).
      dayExpect.push(mo === 3 && dd === dstBounds(y).start ? 23 : 24);
      const dow = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay();
      dayDow.push(dow);
      cachedDayType = Periods.billsAsWeekend(y, mo, dd, dow) ? 1 : 0;
      if (mkey !== prevMonth) { prevMonth = mkey; m++; monthDays.push(0); monthKey.push(mkey); }
      monthDays[m]++;
    }
    dayLen[d]++; dayValid[d] += valid[i];
    dayIdx[i] = d; monthIdx[i] = m; month[i] = mo; hourA[i] = h; dayType[i] = cachedDayType;

    // Repeated wall-clock hour on fall-back day: the 2nd copy is standard time.
    const dst = isDST(y, mo, dd, h) && s !== prevTs;
    prevTs = s;
    let doy = CUM_NONLEAP[mo - 1] + ((mo === 2 && dd === 29) ? 28 : dd);
    let hs = h - (dst ? 1 : 0);
    if (hs < 0) { hs = 23; doy = doy === 1 ? 365 : doy - 1; }
    solarIdx[i] = (doy - 1) * 24 + hs;
  }

  const nDays = d + 1;
  // Usable days: each day counts by the share of a FULL day's hours that carry a reading
  // (finite hours / 24, DST-aware), so a record cut mid-day or a day with one reading
  // counts as a fraction of a day, and a fixed charge, a baseline allowance and the
  // annualisation all see the same days.
  const monthUsableDays = new Float64Array(m + 1);
  let usableDays = 0;
  for (let k = 0; k < nDays; k++) {
    const frac = Math.min(1, dayValid[k] / Math.max(dayLen[k], dayExpect[k]));
    usableDays += frac;
    monthUsableDays[monthIdx[dayStart[k]]] += frac;
  }
  if (!(usableDays >= minUsableDays)) {
    const err = new Error("Your meter data has only " + Math.floor(usableDays) + " usable days of readings (out of " +
      nDays + " calendar days). At least " + minUsableDays + " days are needed to estimate a year of bills. " +
      "Download a longer history (12 months or more of hourly or 15-minute data) from your utility and try again.");
    err.code = "INSUFFICIENT_DATA";
    err.usableDays = usableDays; err.days = nDays; err.minUsableDays = minUsableDays;
    throw err;
  }
  const ctx = {
    load, tariffs, N, nDays, nMonths: m + 1,
    month, hour: hourA, dayType, solarIdx, dayIdx, monthIdx,
    dayStart: Int32Array.from(dayStart), dayLen: Int32Array.from(dayLen),
    dayDow: Int8Array.from(dayDow),
    monthDays: Int32Array.from(monthDays), monthKey,
    monthNum: monthKey.map((k) => +k.slice(5, 7)),
    monthUsableDays,
    recorded, exportKwh, valid, gapHours: nanHours,
    usableDays,
    // Annualisation divides by USABLE days / 365 (equal to elapsed days / 365 when the
    // record has no unfilled gaps).
    years: usableDays / 365,
    // The calendar slice core/flexload.js is given.  Same typed arrays, no copies.
    cal: { N, ts, dayIdx, dayDow: Int8Array.from(dayDow), hourA, nDays },
  };
  ctx.quality = dataQuality(ctx, nanHours);
  return ctx;
}

/** Everything the method / data-quality panel needs, read from the files' own meta. */
function dataQuality(ctx, nanHours) {
  const lm = ctx.load.meta || {}, tm = (ctx.tariffs && ctx.tariffs.meta) || {};
  const totalKwh = lm.totalKwh !== undefined ? lm.totalKwh : lm.total_kwh;
  let sum = 0;
  for (let i = 0; i < ctx.N; i++) sum += ctx.recorded[i];
  return {
    hours: ctx.N, days: ctx.nDays, years: ctx.years,
    usableDays: ctx.usableDays, usableHours: ctx.N - nanHours,
    start: lm.start || ctx.load.ts[0], end: lm.end || ctx.load.ts[ctx.N - 1],
    tz: lm.tz || null, source: lm.source || lm.source_files || null,
    totalKwh: totalKwh !== undefined ? totalKwh : sum,
    annualKwh: sum / ctx.years,
    intervalMinutes: lm.intervalMinutes || null,
    gapsFilled: lm.gapsFilled || lm.gaps_filled || [],
    unfilledHours: nanHours,
    loadNotes: lm.notes || null,
    ratesEffective: tm.rates_effective, tariffSource: tm.sources || tm.source,
    escalationDefault: (tm.escalation || {}).recommended_default,
    baselineKwhPerDay: tm.baseline_kwh_per_day,
    climateCredit: tm.climate_credit || null,
  };
}

/**
 * Resolve a weather key against a SolarProfiles bundle.  This is the ONLY weather-year
 * knowledge left in the engine: the caller picks a profile per plane and passes it in.
 * Accepts both the core/pv.js shape ({ profiles, percentiles: { p50Year } }) and the
 * prototype's ({ profiles, meta: { percentiles: { p50_year } } }).
 */
export function profileFor(solarProfiles, weatherKey) {
  if (!solarProfiles) return null;
  const profiles = solarProfiles.profiles || solarProfiles;
  if (profiles[weatherKey]) return profiles[weatherKey];
  const pc = solarProfiles.percentiles || (solarProfiles.meta && solarProfiles.meta.percentiles) || {};
  const alias = { p10: pc.p10Year || pc.p10_year, p50: pc.p50Year || pc.p50_year, p90: pc.p90Year || pc.p90_year };
  if (alias[weatherKey] && profiles[alias[weatherKey]]) return profiles[alias[weatherKey]];
  return profiles.tmy || profiles[Object.keys(profiles)[0]] || null;
}

// ---------------------------------------------------------------- flexible loads
const DOW_PRIORITY = [1, 2, 3, 4, 5, 6, 0];    // Mon .. Sun

/**
 * Spread `amount` kWh across `idxs` (hour indices) weighted by `w`, never pushing
 * any single hour above `capKWh`.  Returns the kWh that would not fit.
 */
function spread(out, idxs, w, amount, capKWh) {
  for (let pass = 0; pass < 4 && amount > EPS; pass++) {
    let tw = 0;
    for (let k = 0; k < idxs.length; k++) if (capKWh - out[idxs[k]] > EPS) tw += w[k];
    if (tw <= EPS) break;
    let placed = 0;
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k], room = capKWh - out[i];
      if (room <= EPS || w[k] <= 0) continue;
      const take = Math.min(room, amount * w[k] / tw);
      out[i] += take; placed += take;
    }
    amount -= placed;
    if (placed <= EPS) break;
  }
  return amount;
}

/** Day start/length from cal.dayIdx (flexload.js gets no dayStart array). */
function dayBounds(cal) {
  if (cal._dayStart) return cal;
  const start = new Int32Array(cal.nDays), len = new Int32Array(cal.nDays);
  let prev = -1;
  for (let i = 0; i < cal.N; i++) {
    const d = cal.dayIdx[i];
    if (d !== prev) { start[d] = i; prev = d; }
    len[d]++;
  }
  cal._dayStart = start; cal._dayLen = len;
  return cal;
}

/**
 * TEMPORARY stand-in for core/flexload.js `reshape(flex, cal, solarShape)`.
 * Generalisation of the prototype's spreadEV, with the EV hard-coding removed:
 *
 *   - take each Monday-Sunday week's energy (recorded kWh for a detected load, or
 *     annualKwh x daysInWeek/365 for a manual one), times `scale`,
 *   - split it evenly across `daysPerWeek` days, chosen in the fixed order
 *     Mon, Tue, Wed, Thu, Fri, Sat, Sun (so 5 = weekdays, 7 = every day),
 *   - put `daylightFraction` of each day's kWh into `window`, weighted by the solar
 *     shape when `followSolar`, and the remainder into `overnightWindow`,
 *   - cap every hour at `maxKW`, spilling to the nearest hours of the same day.
 *
 * A week with no energy stays empty, and total kWh is conserved exactly per week.
 * schedule.mode "asRecorded" returns the detected series untouched (x scale).
 */
function fallbackReshape(flex, cal, solarShape) {
  const N = cal.N, out = new Float64Array(N);
  const sch = flex.schedule || {};
  const scale = (flex.scale === undefined || flex.scale === null) ? 1 : +flex.scale;
  const src = flex.kwhByHour || null;

  if ((sch.mode || "asRecorded") === "asRecorded" && src) {
    for (let i = 0; i < N; i++) out[i] = src[i] * scale;
    return out;
  }

  dayBounds(cal);
  const dayStart = cal._dayStart, dayLen = cal._dayLen;
  let lo = sch.window ? sch.window[0] : 8, hi = sch.window ? sch.window[1] : 15;
  if (!(hi > lo)) { lo = 8; hi = 15; }
  let nlo = sch.overnightWindow ? sch.overnightWindow[0] : 1;
  let nhi = sch.overnightWindow ? sch.overnightWindow[1] : 5;
  if (!(nhi > nlo)) { nlo = 1; nhi = 5; }
  const frac = Math.max(0, Math.min(1, sch.daylightFraction === undefined ? 0.9 : sch.daylightFraction));
  const perWeek = Math.max(1, Math.min(7, Math.round(sch.daysPerWeek === undefined ? 5 : sch.daysPerWeek)));
  const cap = sch.maxKW > 0 ? sch.maxKW : Infinity;
  const followSolar = sch.followSolar !== false;
  const annual = (+flex.annualKwh || 0) * scale;

  // Align week boundaries to Monday regardless of where the record starts.
  const shift = (cal.dayDow[0] + 6) % 7;
  const weeks = [];
  for (let d = 0; d < cal.nDays; d++) {
    const w = ((d + shift) / 7) | 0;
    (weeks[w] || (weeks[w] = [])).push(d);
  }

  for (let wi = 0; wi < weeks.length; wi++) {
    const days = weeks[wi];
    if (!days) continue;
    let total = 0;
    if (src) {
      for (let i = 0; i < days.length; i++) {
        const s0 = dayStart[days[i]], s1 = s0 + dayLen[days[i]];
        for (let k = s0; k < s1; k++) total += src[k];
      }
      total *= scale;
    } else {
      total = annual * days.length / 365;
    }
    if (total <= EPS) continue;                      // nothing happened that week

    const ordered = days.slice().sort((a, b) =>
      DOW_PRIORITY.indexOf(cal.dayDow[a]) - DOW_PRIORITY.indexOf(cal.dayDow[b]));
    const useDays = ordered.slice(0, Math.min(perWeek, ordered.length));
    const perDay = total / useDays.length;

    for (let i = 0; i < useDays.length; i++) {
      const day = useDays[i];
      let left = place(out, cal, solarShape, day, lo, hi, perDay * frac, cap, followSolar);
      left += place(out, cal, solarShape, day, nlo, nhi, perDay * (1 - frac), cap, false);
      if (left > EPS) left = placeNearest(out, cal, day, lo, hi, left, cap);
      if (left > EPS) {                              // the whole day is full: put it back
        const s0 = dayStart[day], s1 = s0 + dayLen[day];
        for (let k = s0; k < s1 && left > EPS; k++) { out[k] += left; left = 0; }
      }
    }
  }
  return out;
}

function place(out, cal, solarShape, day, lo, hi, amount, cap, solarMode) {
  const s0 = cal._dayStart[day], s1 = s0 + cal._dayLen[day], idxs = [], w = [];
  for (let k = s0; k < s1; k++) {
    const h = cal.hourA[k];
    if (h >= lo && h < hi) {
      idxs.push(k);
      w.push(solarMode && solarShape ? Math.max(1e-3, solarShape[k]) : 1);
    }
  }
  return idxs.length ? spread(out, idxs, w, amount, cap) : amount;
}

/** Spill into whatever hours of the day still have headroom, closest to the window first. */
function placeNearest(out, cal, day, lo, hi, amount, cap) {
  const s0 = cal._dayStart[day], s1 = s0 + cal._dayLen[day], idxs = [], w = [];
  const mid = (lo + hi) / 2;
  for (let k = s0; k < s1; k++) { idxs.push(k); w.push(1 / (1 + Math.abs(cal.hourA[k] - mid))); }
  return idxs.length ? spread(out, idxs, w, amount, cap) : amount;
}

/**
 * The one place the engine asks for a flexible load's hourly shape.  Prefers
 * core/flexload.js; falls back to the local implementation, and also falls back if
 * the external one returns something that is not an N-long series.
 */
export function reshapeFlex(flex, cal, solarShape) {
  if (_flexReshape) {
    const out = _flexReshape(flex, cal, solarShape);
    if (out && out.length === cal.N) return out;
  }
  return fallbackReshape(flex, cal, solarShape);
}

// ---------------------------------------------------------------- rates
export function planById(tariffs, id) {
  return resolvePlan(tariffs, id).plan;
}
/**
 * Which plan prices this run.  An empty id asks for the utility's default plan
 * (`plans[].default === true`, else the first; mirrors core/tariff.js defaultPlan()).
 * An id the tariff does not list falls back to that same default and says so.
 */
export function resolvePlan(t, id) {
  const plans = (t && t.plans) || [];
  const def = plans.find((p) => p.default === true) || plans[0];
  const want = id == null || id === "" ? null : String(id);
  if (want) for (let i = 0; i < plans.length; i++) if (plans[i].id === want) return { plan: plans[i], requested: want, fallback: false };
  if (!def) throw new Error("tariff has no plans: cannot price plan '" + id + "'");
  return { plan: def, requested: want, fallback: !!want };
}
/**
 * The provider the utility's customers are on unless they opted out: the provider
 * marked `default: true`, else the one keyed by `utility.id`, else the first listed.
 * Mirrors core/tariff.js defaultProvider() (the worker bundle cannot import tariff.js).
 */
function tariffDefaultProvider(t) {
  const provs = (t && t.providers) || {};
  const marked = Object.keys(provs).find((id) => provs[id] && provs[id].default === true);
  if (marked) return marked;
  const uid = t && t.utility && t.utility.id;
  if (uid && provs[uid]) return uid;
  return Object.keys(provs)[0] || null;
}

/**
 * Which provider column actually prices this run.  A provider the tariff does not know
 * (a stale id from another utility, a typo) falls back to THIS utility's default
 * provider - never to another utility's generation column.  `fallback` says so.
 */
export function resolveProvider(t, providerId) {
  const provs = (t && t.providers) || {};
  const want = providerId == null || providerId === "" ? null : String(providerId);
  if (want && provs[want]) return { id: want, requested: want, fallback: false };
  const def = tariffDefaultProvider(t);
  const uid = (t && t.utility && t.utility.id) || null;
  if (!def && !uid) {
    throw new Error("tariff has no providers and no utility.id: cannot price provider '" + providerId + "'");
  }
  // An empty id asks for the default; only an id the tariff does not know is a fallback.
  return { id: def || uid, requested: want, fallback: !!want };
}

/**
 * Full retail $/kWh for one rate cell.  The resolved provider's column if present, else
 * the utility's default provider's column, else delivery + `<utilityId>_generation`.
 * Anything else is a hole in the tariff file and throws: a miss is a bug, not a zero.
 */
function rateFor(rates, provider, t, where) {
  if (rates == null) throw new Error("tariff: no rate cell for " + where);
  if (typeof rates[provider] === "number") return rates[provider];
  const def = tariffDefaultProvider(t);
  if (def && typeof rates[def] === "number") return rates[def];
  const uid = t && t.utility && t.utility.id;
  const genKey = uid ? uid + "_generation" : null;
  if (genKey && typeof rates.delivery === "number" && typeof rates[genKey] === "number") {
    return rates.delivery + rates[genKey];
  }
  throw new Error("tariff: " + where + " prices neither provider '" + provider + "' nor the utility default");
}

/** ACC Plus adder from the tariff file ($/kWh); mirrors core/tariff.js accPlusAdder(). */
export function tariffAccPlus(t) {
  const n = (t && t.nbt) || {};
  if (typeof n.acc_plus_adder_per_kwh === "number" && isFinite(n.acc_plus_adder_per_kwh)) return n.acc_plus_adder_per_kwh;
  throw new Error("tariff " + ((t && t.utility && t.utility.id) || "?") + " has no nbt.acc_plus_adder_per_kwh");
}

/** Average Retail Export Compensation Rate (SCE: "EEC Adjustment"), $/kWh, from the file. */
export function tariffArecr(t) {
  const n = (t && t.nbt) || {};
  if (typeof n.eec_adjustment_per_kwh === "number" && isFinite(n.eec_adjustment_per_kwh)) return n.eec_adjustment_per_kwh;
  throw new Error("tariff " + ((t && t.utility && t.utility.id) || "?") + " has no nbt.eec_adjustment_per_kwh");
}

/**
 * Baseline allocation (kWh/day, { summer, winter }) for a region of utility.baselineRegions,
 * falling back to the file's default region (meta.baseline_region) and then to
 * meta.baseline_kwh_per_day.  Mirrors core/tariff.js baselineAllocation().
 */
export function resolveBaseline(t, region) {
  const br = (t && t.utility && t.utility.baselineRegions) || null;
  const alloc = (br && br.allocations) || {};
  const meta = (t && t.meta) || {};
  const def = meta.baseline_region != null && alloc[String(meta.baseline_region)]
    ? String(meta.baseline_region) : (Object.keys(alloc)[0] || null);
  const want = region == null || region === "" ? null : String(region);
  let id = null, fallback = false;
  if (want && alloc[want]) id = want;
  else { id = def; fallback = !!want; }
  const a = id ? alloc[id] : (meta.baseline_kwh_per_day || null);
  return {
    region: id, requested: want, fallback,
    summer: a ? +a.summer || 0 : 0, winter: a ? +a.winter || 0 : 0,
    summerMonths: (br && Array.isArray(br.summer_months)) ? br.summer_months : null,
  };
}

/**
 * True-up month 1-12: params override, else nbt.true_up_month, else October.  Only a
 * NUMBER that is an integer 1-12 is accepted - a numeric string ("4") is not - exactly
 * as core/tariff.js trueUpMonth() and validate() read the file.
 */
export const DEFAULT_TRUE_UP_MONTH = 10;
const isMonth = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12;
export function resolveTrueUpMonth(t, override) {
  if (isMonth(override)) return override;
  const f = t && t.nbt && t.nbt.true_up_month;
  return isMonth(f) ? f : DEFAULT_TRUE_UP_MONTH;
}

/** The billing regime: "nem2" / "nem1" as given, anything else is Net Billing. */
export const BILLING_REGIMES = ["nbt", "nem2", "nem1"];
function nemBilling(v) { return v === "nem2" || v === "nem1" ? v : "nbt"; }

/**
 * Per-hour import/export prices + period codes for one (plan, provider).
 *
 * accPlus     undefined / null = the tariff file's nbt.acc_plus_adder_per_kwh;
 *             a number is an explicit override.
 * opts        { baselineRegion, trueUpMonth, municipalSurchargeFactor, billing } - all
 *             optional, see DEFAULTS.  billing "nem2"/"nem1" swaps the ACC export matrix
 *             for the hour's retail price (less NBCs on NEM 2) and switches off ACC Plus,
 *             the ARECR and the export cap.
 */
export function buildRates(ctx, planId, providerIdIn, applyNbc, climate, accPlus, capExport, opts) {
  const t = ctx.tariffs, planRes = resolvePlan(t, planId), plan = planRes.plan;
  const o = opts || {};
  const prov = resolveProvider(t, providerIdIn);
  const providerId = prov.id;
  const N = ctx.N;
  const imp = new Float64Array(N), exp = new Float64Array(N);
  const per = new Uint8Array(N), summer = new Uint8Array(N);
  const nbc = applyNbc ? (t.nbt.nonbypassable_charges_per_kwh || 0) : 0;
  // NEM 1 / NEM 2 (an existing array on a legacy agreement): retail-rate export credit,
  // so none of the Net Billing machinery - ACC matrix, ACC Plus, ARECR, export cap -
  // applies, and none of it is read from the file.
  const billing = nemBilling(o.billing);
  const nem = billing !== "nbt";
  const accPlusUsed = nem ? 0 : (accPlus === undefined || accPlus === null) ? tariffAccPlus(t) : +accPlus;
  const arecr = nem ? 0 : tariffArecr(t);
  if (nem) capExport = false;
  const baseline = resolveBaseline(t, o.baselineRegion);
  const baselinePct = (typeof plan.baseline_credit_pct === "number" && plan.baseline_credit_pct > 0)
    ? plan.baseline_credit_pct : 1;
  // CCA export adder: one key in all three utility files, applied to any non-bundled
  // provider (provider id differs from utility.id).
  const uidForAdder = t.utility && t.utility.id;
  const adder = (!nem && uidForAdder && providerId !== uidForAdder) ? (t.nbt.cca_export_adder_per_kwh || 0) : 0;
  // Two bill lines deliberately kept out of the rate tables (sce.json meta.notes): a
  // city's generation municipal surcharge, levied on the GENERATION component only, and
  // CPA's flat per-kWh energy surcharge.  Folding both into the hourly import price is
  // exact and costs nothing in the inner loop.  The municipal factor is city-specific
  // (sce.json meta.bill_validation carries Agoura Hills' for the bill replay), so it
  // applies ONLY when the caller passes one: `opts.municipalSurchargeFactor`.
  const bv = (t.meta || {}).bill_validation || {};
  const mf = +o.municipalSurchargeFactor;
  const munFactor = isFinite(mf) && mf > 0 ? mf : 0;
  const cpaSurcharge = /^cpa/.test(providerId) ? (bv.cpa_energy_surcharge_per_kwh || 0) : 0;
  // The period of every (month, day type, hour) comes from core/periods.js periodGrid():
  // the same lookup, overrides and all, that core/tariff.js periodAt() answers with.
  // Prices are memoised on the same 12 x 2 x 24 key, so the hourly loop is two
  // typed-array reads and no allocation.
  const grid = Periods.periodGrid(plan);
  const cellP = new Uint8Array(576), cellR = new Float64Array(576), cellS = new Uint8Array(576);
  const cellDone = new Uint8Array(576);
  const nbcDollarsPerKwh = (t.nbt && t.nbt.nonbypassable_charges_per_kwh) || 0;
  // NEM 2 credits an exported kWh at the retail price of that hour less the NBCs, which
  // are charged on every imported kWh and never netted (NEM 2 SC "Non-Bypassable
  // Charges").  NEM 1 predates that rule: the full retail price.  `imp` already holds
  // the NBCs whether they sit inside the rate table or were added with applyNbc, so the
  // subtraction is the same either way.
  const nemExportDeduct = billing === "nem2" ? nbcDollarsPerKwh : 0;
  for (let i = 0; i < N; i++) {
    const mo = ctx.month[i], h = ctx.hour[i], dt = ctx.dayType[i];
    const key = (mo - 1) * 48 + dt * 24 + h;
    if (!cellDone[key]) {
      const pid = grid[key];
      const su = Periods.seasonOf(plan, mo) === "summer" ? 1 : 0;
      const season = su ? "summer" : "winter";
      const tbl = plan.rates[season][pid];
      const full = rateFor(tbl, providerId, t, plan.id + " " + season + "." + pid);
      // The municipal surcharge is levied on GENERATION only.  For a CCA customer the
      // gap between the bundled price and delivery also contains the CCA surcharge
      // stack (PCIA + wildfire + CTC + fixed recovery), which is not generation - back
      // it out using the identity the tariff file documents:
      //   cpa_clean = delivery + (sce_generation - $0.02433) + cca_stack
      const del = (tbl && tbl.delivery) || 0;
      let stack = 0;
      if (/^cpa/.test(providerId) && tbl && tbl.cpa_clean !== undefined) {
        stack = Math.max(0, tbl.cpa_clean - del - tbl.sce_generation + SCE_CPA_GEN_GAP);
      }
      const gen = Math.max(0, full - del - stack);
      cellP[key] = PERIOD_INDEX[pid] === undefined ? 2 : PERIOD_INDEX[pid];
      cellR[key] = full + nbc + gen * munFactor + cpaSurcharge;
      cellS[key] = su;
      cellDone[key] = 1;
    }
    per[i] = cellP[key]; imp[i] = cellR[key]; summer[i] = cellS[key];
    if (nem) { const v = imp[i] - nemExportDeduct; exp[i] = v > 0 ? v : 0; }
    else exp[i] = t.nbt.export_rates[dt ? "weekend" : "weekday"][mo - 1][h] + adder;
  }
  return { plan, planRequested: planRes.requested, planFallback: planRes.fallback,
           billing, imp, exp, period: per, summer,
           providerId, providerRequested: prov.requested, providerFallback: prov.fallback,
           accPlus: accPlusUsed, arecr,
           capExport, munFactor, cpaSurcharge,
           baselineCredit: plan.baseline_credit_per_kwh || 0,
           baselineAllow: { summer: baseline.summer, winter: baseline.winter },
           baselineSummerMonths: baseline.summerMonths || plan.summer_months,
           baselineRegion: baseline.region, baselineRegionFallback: baseline.fallback,
           baselineCreditPct: baselinePct,
           fixed: plan.fixed_charge_per_day, min: plan.minimum_charge_per_day,
           // Non-bypassable charges, $/kWh IMPORTED: inside the retail rates (or added on
           // top with applyNbc), and never offsettable by export credit (settle()).
           nbcPerKwh: nbcDollarsPerKwh,
           nsc: t.nbt.net_surplus_compensation_per_kwh, climate: climate || null,
           trueUpMonth: resolveTrueUpMonth(t, o.trueUpMonth) };
}

/** The tariff terms a run actually used, for the method panel and for tests. */
function tariffTerms(r) {
  return { planId: r.plan.id, planRequested: r.planRequested, planFallback: r.planFallback,
           providerId: r.providerId, providerRequested: r.providerRequested,
           providerFallback: r.providerFallback, municipalSurchargeFactor: r.munFactor,
           accPlusAdder: r.accPlus, arecr: r.arecr, nsc: r.nsc,
           baselineRegion: r.baselineRegion, baselineRegionFallback: r.baselineRegionFallback,
           baselineKwhPerDay: { summer: r.baselineAllow.summer, winter: r.baselineAllow.winter },
           baselineCreditPct: r.baselineCreditPct, baselineCreditPerKwh: r.baselineCredit,
           trueUpMonth: r.trueUpMonth, billing: r.billing };
}

// ---------------------------------------------------------------- scenario
/** Monthly RETAINED fraction (1 - loss) from a plane's shading block. */
function shadingFactors(shading) {
  const f = new Float64Array(12).fill(1);
  if (!shading) return f;
  if (Array.isArray(shading.monthly) && shading.monthly.length === 12) {
    for (let m = 0; m < 12; m++) f[m] = Math.max(0, 1 - (+shading.monthly[m] || 0));
  } else if (shading.annual !== undefined && shading.annual !== null) {
    const keep = Math.max(0, 1 - (+shading.annual || 0));
    for (let m = 0; m < 12; m++) f[m] = keep;
  }
  return f;
}

/**
 * Everything that depends on the controls but NOT on panel/battery count: the load
 * series (flexible loads rescheduled), per-PANEL PV for every roof plane, and prices.
 * The optimizer builds this once and then sweeps allocations x batteries against it.
 *
 * opts.flexMode "asRecorded" puts every DETECTED flexible load back at its metered
 * hours (manual loads keep their schedule - the household is adding them either way).
 * That is the `baselineAsRecorded` arm.
 */
export function buildScenario(ctx, params, opts) {
  const p = withDefaults(params);
  const asRecorded = !!(opts && opts.flexMode === "asRecorded");
  const N = ctx.N;
  const kwPerPanel = p.panelW / 1000;

  const planes = (p.planes || []).map((pl, k) => {
    const prof = pl.profile;
    const keep = shadingFactors(pl.shading);
    const per = new Float64Array(N);
    // Gap hours (no meter reading) are outside the simulation: no PV there either, so
    // production, export and load are all counted over the same usable hours.
    const valid = ctx.valid;
    if (prof) for (let i = 0; i < N; i++) {
      if (valid && !valid[i]) continue;
      per[i] = prof[ctx.solarIdx[i]] * kwPerPanel * keep[ctx.month[i] - 1];
    }
    return { id: pl.id === undefined ? "p" + (k + 1) : pl.id, name: pl.name || null,
             panels: Math.max(0, Math.round(pl.panels || 0)),
             maxPanels: pl.maxPanels === undefined ? null : pl.maxPanels,
             shading: pl.shading || null, pvPerPanel: per };
  });

  // Solar shape handed to FlexLoad.reshape for `followSolar` weighting: kWh AC per kW
  // DC per hour, aligned to the LOAD series (clock time), averaged over the planes and
  // weighted by their panel counts.  Monthly shading is constant within a day, so it
  // cancels out of the within-window weights; only genuinely different plane shapes move it.
  const solarShape = new Float64Array(N);
  if (planes.length) {
    let wsum = 0;
    for (const pl of planes) wsum += Math.max(0, pl.panels);
    const even = wsum <= 0;
    let kwTot = 0;
    for (const pl of planes) {
      const w = even ? 1 : pl.panels;
      if (w <= 0) continue;
      kwTot += w * kwPerPanel;
      for (let i = 0; i < N; i++) solarShape[i] += pl.pvPerPanel[i] * w;
    }
    if (kwTot > 0) for (let i = 0; i < N; i++) solarShape[i] /= kwTot;
  }

  // Base load = recorded minus every DETECTED flexible load, then rescaled.
  // A non-finite hour in a detected series is treated as 0 kWh and counted, so one bad
  // sample cannot turn the whole bill into NaN.
  let flexNanHours = 0;
  const flexList = (p.flex || []).filter(Boolean).map(function (f) {
    if (!f.kwhByHour) return f;
    const src = f.kwhByHour;
    let bad = 0;
    for (let i = 0; i < N; i++) if (!isFinite(src[i])) bad++;
    if (!bad) return f;
    flexNanHours += bad;
    const clean = new Float64Array(N);
    for (let i = 0; i < N; i++) { const v = src[i]; clean[i] = isFinite(v) ? v : 0; }
    return Object.assign({}, f, { kwhByHour: clean });
  });
  // An existing array: the meter saw import and export of a house that already has
  // solar, so the household's own draw is import - export + what those panels made.
  // Our modelled output stands in for the real one; where the model undershoots a
  // sunny hour the sum can dip below zero, and it is clipped there (and counted).
  const existing = resolveExisting(p.existing, planes);
  const base = new Float64Array(N);
  if (existing) {
    const exp = ctx.exportKwh, valid = ctx.valid;
    const per = planes[existing.planeIndex].pvPerPanel, n = existing.panels;
    const xpv = new Float64Array(N);
    let xKwh = 0, clipKwh = 0, clipHours = 0;
    for (let i = 0; i < N; i++) {
      if (valid && !valid[i]) continue;
      const v = per[i] * n;
      xpv[i] = v; xKwh += v;
      const g = ctx.recorded[i] - (exp ? exp[i] : 0) + v;
      if (g < 0) { clipKwh -= g; clipHours++; } else base[i] = g;
    }
    existing.pv = xpv; existing.pvKwhTotal = xKwh;
    existing.grossClippedKwh = clipKwh; existing.grossClippedHours = clipHours;
  } else {
    base.set(ctx.recorded);
  }
  for (const f of flexList) {
    // Only a DETECTED load was ever in the meter record.  A manual load may carry a
    // built hourly series (a heat pump's, from weather) that is added back below but
    // was never metered, so it must not be subtracted out of the base.
    if (!f.kwhByHour || f.source === "manual") continue;
    const s = f.kwhByHour;
    for (let i = 0; i < N; i++) base[i] -= s[i];
  }
  let clampedKwh = 0;
  for (let i = 0; i < N; i++) {
    if (base[i] < 0) { clampedKwh -= base[i]; base[i] = 0; }
    base[i] *= p.baseLoadScale;
  }

  // ...then each flexible load added back at its scheduled hours.
  const flexSeries = [], load = new Float64Array(N);
  const flexTotal = new Float64Array(N);
  for (const f of flexList) {
    let s;
    if (asRecorded && f.kwhByHour) {
      const scale = (f.scale === undefined || f.scale === null) ? 1 : +f.scale;
      s = new Float64Array(N);
      for (let i = 0; i < N; i++) s[i] = f.kwhByHour[i] * scale;
    } else {
      s = reshapeFlex(f, ctx.cal, solarShape);
    }
    for (let i = 0; i < N; i++) if (!isFinite(s[i])) { s[i] = 0; flexNanHours++; }
    flexSeries.push({ id: f.id, kind: f.kind || "custom", name: f.name || f.id, series: s });
    for (let i = 0; i < N; i++) flexTotal[i] += s[i];
  }
  for (let i = 0; i < N; i++) load[i] = base[i] + flexTotal[i];
  if (ctx.valid && ctx.gapHours) {
    // Gap hours are skipped by runHours; zero them here so every load total agrees.
    for (let i = 0; i < N; i++) if (!ctx.valid[i]) { load[i] = 0; base[i] = 0; flexTotal[i] = 0; }
  }

  return {
    ctx, planes, panelW: p.panelW, load, baseLoad: base, flex: flexTotal, flexSeries,
    solarShape, flexMode: asRecorded ? "asRecorded" : "scheduled",
    baseClampedKwh: clampedKwh, flexNanHours,
    rates: buildRates(ctx, p.planId, p.providerId, p.applyNbc, climateCredit(ctx, p),
                      p.accPlusAdder, !p.ngom,
                      { baselineRegion: p.baselineRegion, trueUpMonth: p.trueUpMonth,
                        municipalSurchargeFactor: p.municipalSurchargeFactor,
                        billing: p.billing }),
    existing,
    weatherKey: p.weatherKey,
    _pv: null,
  };
}

/**
 * Which plane the existing panels sit on, and how many.  An id the planes do not carry
 * (the face was deleted or renamed) falls back to the first plane and says so; with no
 * plane at all there is nowhere to model them, which is a caller bug, not a zero.
 */
export function resolveExisting(ex, planes) {
  if (!ex) return null;
  const panels = Math.max(0, Math.round(+ex.panels || 0));
  if (!panels) return null;
  if (!planes.length) throw new Error("params.existing needs a roof plane to model the existing panels on");
  let k = planes.findIndex((pl) => pl.id === ex.planeId);
  const fallback = k < 0;
  if (k < 0) k = 0;
  return { planeIndex: k, planeId: planes[k].id, requestedPlaneId: ex.planeId == null ? null : ex.planeId,
           planeFallback: fallback, panels };
}

/**
 * The CA Climate Credit is a flat per-billing-period credit.  Taken from the tariff
 * file (meta.climate_credit); a tariff that does not publish one gets none.
 */
export function climateCredit(ctx, p) {
  if (p.climateCredit === 0 || p.climateCreditOff) return null;
  const fromFile = ((ctx.tariffs || {}).meta || {}).climate_credit;
  const amount = p.climateCredit != null ? p.climateCredit : (fromFile ? fromFile.amount : 0);
  const months = p.climateCreditMonths || (fromFile ? fromFile.months : []);
  return amount > 0 && months && months.length ? { amount, months, fromFile: !!fromFile } : null;
}

/**
 * PV per hour for one panel allocation.  PV is exactly linear in panel count, so the
 * per-panel series is built once in buildScenario and scaled here; the optimizer relies
 * on that to sweep 60 panel counts without ever re-evaluating a solar profile.
 * Memoised on the scenario (one entry: the sweep varies batteries in the inner loop).
 */
export function pvFor(scn, alloc) {
  const key = alloc.join(",");
  if (scn._pv && scn._pv.key === key) return scn._pv;
  const N = scn.ctx.N, pv = new Float64Array(N), byPlane = new Float64Array(scn.planes.length);
  for (let k = 0; k < scn.planes.length; k++) {
    const n = alloc[k] || 0;
    if (n <= 0) continue;
    const per = scn.planes[k].pvPerPanel;
    let tot = 0;
    for (let i = 0; i < N; i++) { const v = per[i] * n; pv[i] += v; tot += v; }
    byPlane[k] = tot;
  }
  let panels = 0;
  for (let k = 0; k < alloc.length; k++) panels += alloc[k] || 0;
  scn._pv = { key, pv, byPlane, panels, kwdc: panels * scn.panelW / 1000 };
  return scn._pv;
}

// ---------------------------------------------------------------- billing
/**
 * Which months of the record settle the credit bank.  The billing year is the twelve
 * months ending in the true-up month, and the record is treated as a CYCLE: the months
 * after the last true-up month in the record wrap round to join the months before the
 * first one, so every month belongs to exactly one relevant period and no period is a
 * stub.
 *
 *   - every occurrence of `tum` in the record is a settlement point;
 *   - the wrapped period (after the last point, round to the first) runs
 *     M - 12 x (points - 1) months; if that is under 12 the first point is dropped and
 *     the wrapped months roll into the next year's window instead (13-23 months);
 *   - a record shorter than a year that never reaches `tum` settles once, at its end.
 *
 * So a 24-month record always settles two 12-month years whatever its start month, a
 * 12-month record settles one year ending in `tum`, and a 13-month record settles one
 * 12- or 13-month year with no 1-month stub.  Returns the settlement month indices.
 */
export function settlementPoints(ctx, tum) {
  const M = ctx.nMonths, pts = [];
  for (let m = 0; m < M; m++) if (ctx.monthNum[m] === tum) pts.push(m);
  if (!pts.length) return [M - 1];
  if (pts.length > 1 && M - 12 * (pts.length - 1) < 12) pts.shift();
  return pts;
}

/**
 * Turn monthly energy totals into a bill, NBT-style:
 *   subtotal = fixed + energy - baseline credit, floored at the minimum charge;
 *   export credits - the ACC export value AND the ACC Plus adder - then offset the
 *   subtotal down to (not below) the CREDIT FLOOR: the fixed charge plus the month's
 *   non-bypassable charges (nbt.nonbypassable_charges_per_kwh x imported kWh), or the
 *   minimum charge if that is higher.  Under Schedule NBT export credit may offset
 *   generation and delivery energy charges only; NBCs and the fixed charge are always
 *   paid.  The ACC Plus adder is a bill credit, not cash: it never takes a month below
 *   that floor, and what does not fit is banked with the export credit;
 *   the unused balance rolls forward.  At true-up the net surplus kWh (exported minus
 *   imported over the relevant period) are debited from the export credit at the ARECR
 *   and paid at NSC.
 * The credit bank runs round the record as a cycle (settlementPoints above): the bank
 * left at the end of the record is CARRIED into the record's first month, never
 * forfeited, and reported as `trailing`.
 */
export function settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred) {
  const M = ctx.nMonths;
  const blSummer = r.baselineSummerMonths || r.plan.summer_months;
  const blPct = r.baselineCreditPct || 1;

  // ---- 1. everything that does not depend on the credit bank, month by month
  const subtotalA = new Float64Array(M), creditFloorA = new Float64Array(M);
  const expKwhA = new Float64Array(M), expCredA = new Float64Array(M);
  const accPlusA = new Float64Array(M), climateA = new Float64Array(M);
  const pre = detail ? new Array(M) : null;
  let forfeitedCap = 0;
  for (let m = 0; m < M; m++) {
    // Usable days: a month with unfilled gaps is billed (fixed charge, minimum charge,
    // baseline allowance, climate credit) only for the share of it the simulation saw.
    const calDays = ctx.monthDays[m];
    const days = ctx.monthUsableDays ? ctx.monthUsableDays[m] : calDays;
    const share = calDays > 0 ? days / calDays : 0;
    // Paired storage under 10 kW without a Net Generation Output Meter: creditable
    // export in a month is capped at SCE's estimate of what the PV produced, and the
    // forfeited kWh are DEEMED to have happened in the highest-priced hours.  We use
    // our own modelled PV for the cap and strip credit at the month's top export
    // price, which is the conservative reading of Schedule NBT SC 5.c.vii.
    let expKwh = mExpKwh[m], expCred = mExpCred[m], forfeitKwh = 0, forfeit$ = 0;
    if (r.capExport && mPvKwh && expKwh > mPvKwh[m]) {
      let over = expKwh - mPvKwh[m];
      forfeitKwh = over;
      for (let b = 0; b < EXP_BANDS.length && over > EPS; b++) {   // top band first
        const bk = mBandKwh[b][m];
        if (bk <= EPS) continue;
        const take = Math.min(bk, over);
        forfeit$ += mBandCred[b][m] * (take / bk);
        over -= take;
      }
      forfeit$ = Math.min(forfeit$, expCred);
      expKwh -= forfeitKwh; expCred -= forfeit$; forfeitedCap += forfeit$;
    }
    const fixed = r.fixed * days;
    // Baseline credit applies up to baseline_credit_pct of the allocation (SDG&E
    // TOU-DR1/DR2: 130%; everyone else 100%), on the baseline season's calendar.
    const allow = (blSummer.indexOf(ctx.monthNum[m]) >= 0
                   ? r.baselineAllow.summer : r.baselineAllow.winter) * days * blPct;
    // Under NEM the energy charge is computed on net usage, so the baseline allowance
    // is set against net kWh too; under Net Billing every imported kWh is billed.
    const nem = r.billing === "nem2" || r.billing === "nem1";
    const blKwh = nem ? Math.max(0, mImpKwh[m] - mExpKwh[m]) : mImpKwh[m];
    const credit = r.baselineCredit * Math.min(blKwh, allow);
    const energy = mImpCost[m];
    const floor = Math.max(r.min * days, fixed);
    let subtotal = fixed + energy - credit;
    let minApplied = 0;
    if (subtotal < floor) { minApplied = floor - subtotal; subtotal = floor; }
    // The CA Climate Credit is a flat bill credit, not an energy charge: it lands after
    // the export offset and CAN push the bill below the fixed charge.
    // A month at either edge of the record may be only partly present (a record that
    // ends on the 9th): there the credit is prorated by the days present over the
    // calendar month's length.  Billing months inside the record are whole, so they keep
    // the usable-day share above.  Baseline and system get the same credit either way.
    let climate = 0;
    if (r.climate && r.climate.amount && r.climate.months.indexOf(ctx.monthNum[m]) >= 0) {
      let ccShare = share;
      if (m === 0 || m === M - 1) {
        const key = ctx.monthKey[m];
        const monthLen = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7), 0)).getUTCDate();
        ccShare = Math.min(1, days / monthLen);
      }
      climate = r.climate.amount * ccShare;
    }
    // What export credit can never touch: the fixed charge and the month's NBCs, which
    // sit inside the retail import rates (or are added on top with applyNbc - either way
    // they are inside `energy`).  Never above the subtotal itself.
    // NEM 1 credits export at the full retail rate, non-bypassable charges included,
    // so there is no NBC floor; NEM 2 and Net Billing keep the NBCs out of reach.
    const nbc$ = r.billing === "nem1" ? 0 : (r.nbcPerKwh || 0) * mImpKwh[m];
    const creditFloor = Math.min(subtotal, Math.max(floor, fixed + nbc$));
    subtotalA[m] = subtotal; creditFloorA[m] = creditFloor; expKwhA[m] = expKwh; expCredA[m] = expCred;
    // ACC Plus earned on this month's creditable export.  It joins the credit bank below
    // with the ACC value, so it obeys the same floor and the same carry-forward.
    accPlusA[m] = (r.accPlus || 0) * expKwh;
    climateA[m] = climate;
    if (pre) pre[m] = { days, calDays, fixed, energy, credit, minApplied, forfeitKwh, forfeit$, nbc$ };
  }

  // ---- 2. the credit bank, round the cycle, starting empty in the month after the
  // record's last settlement point.
  const points = settlementPoints(ctx, r.trueUpMonth);
  const isPoint = new Uint8Array(M);
  for (const k of points) isPoint[k] = 1;
  const start = (points[points.length - 1] + 1) % M;
  // The bank holds four dollar pools.  Every month the room (subtotal - credit floor)
  // is filled from them in this order:
  //   1. this relevant period's ACC export credit;
  //   2. export credit carried over a true-up;
  //   3. this period's ACC Plus adder;
  //   4. adder carried over a true-up.
  // Export credit first is the tariff's own order: export credit is applied to the
  // month's energy charges, and the adder - a separate bill line that "will apply to
  // future bills until the credit is used" - to what remains (PG&E NBT SC 2.c-2.e).
  //
  // The NET SURPLUS kWh are tracked apart from the dollars.  Net Surplus Electricity is
  // the kWh exported over the relevant period in excess of the kWh imported, max(0,
  // export - import), export-cap forfeited kWh excluded - whatever has happened to the
  // dollars (PG&E NBT SC 5.d: "if the customer exported more electricity than they
  // imported over the Relevant Period").  At true-up those kWh are debited at the ARECR
  // and then credited at the NSC rate.  The debit falls on EXPORT credit only (pools 1
  // and 2): "The ACC Plus paid to the customer on Net Surplus Electricity will not be
  // debited" (SC 5.d), and the true-up carries forward "export credits (not including
  // the ACC Plus credit) ... after debit for excess energy" (SC 2.h).  We stop the debit
  // at an empty export balance - it is never turned into a charge - and pay NSC on the
  // surplus kWh even when the bank is already spent.
  //
  // So the NSC payout depends on kWh alone, and the room filled each month is
  // min(bank, room) in any order.  The pool order still reaches the TOTAL in one place:
  // the debit sees only the export pools, so drawing the adder first would leave more
  // export credit exposed to it (tests/engine.test.mjs swaps the order with the
  // test-only r.bankDrawOrder and checks NSC is unchanged and the tariff order is never
  // worse).  Export first also makes the export side follow EXACTLY its no-adder path,
  // so the adder dollars that reach a bill (accUsedA) are the adder's marginal value and
  // exportValue - accPlusValue is the export value once the adder expires.
  //
  // Whatever survives a true-up rolls into the next relevant period (SC 4.e.i) as a
  // carried pool.  The record is a cycle, so in steady state each pass round it starts
  // with the carry the previous pass ended on (the cycle ends ON a settlement point).
  // One pass from empty, then warm passes until the dollars realised stop changing; a
  // bank that only ever grows stops changing after one warm pass, because every month's
  // room is already full.
  const adderFirst = r.bankDrawOrder === "adderFirst";   // test-only: proves order-freedom
  const nem = r.billing === "nem2" || r.billing === "nem1";
  function runCycle(ce0, ca0) {
    const usedA = new Float64Array(M), accUsedA = new Float64Array(M), trueUpA = new Float64Array(M);
    const forfeitSettleA = new Float64Array(M), balA = new Float64Array(M);
    let e$ = 0, ce$ = ce0, a$ = 0, ca$ = ca0, pExpKwh = 0, pImpKwh = 0;
    let endBank$ = 0, endBankKwh = 0, value = 0;
    // Take up to `want` dollars from the pools in order; returns [fromE, fromCe, fromA, fromCa].
    function take(want, exportOnly) {
      const order = exportOnly ? [0, 1] : adderFirst ? [2, 3, 0, 1] : [0, 1, 2, 3];
      const got = [0, 0, 0, 0];
      for (const k of order) {
        const have = k === 0 ? e$ : k === 1 ? ce$ : k === 2 ? a$ : ca$;
        const x = Math.min(have, want);
        if (x <= 0) continue;
        want -= x; got[k] = x;
        if (k === 0) e$ -= x; else if (k === 1) ce$ -= x; else if (k === 2) a$ -= x; else ca$ -= x;
      }
      return got;
    }
    for (let j = 0; j < M; j++) {
      const m = (start + j) % M;
      e$ += expCredA[m]; a$ += accPlusA[m];
      pExpKwh += expKwhA[m]; pImpKwh += mImpKwh[m];
      const [fromE, fromCe, fromA, fromCa] = take(Math.max(0, subtotalA[m] - creditFloorA[m]));
      let trueUp = 0, forfeitCredit = 0;
      if (isPoint[m] && nem) {
        // NEM 1/2 true-up: net surplus kWh are paid at NSC (AB 920) and whatever dollar
        // credit is left is zeroed - it does not roll into the next year.  No ARECR.
        const surplusKwh = Math.max(0, pExpKwh - pImpKwh);
        trueUp = surplusKwh * r.nsc;
        forfeitCredit = e$ + ce$ + a$ + ca$;
        e$ = 0; ce$ = 0; a$ = 0; ca$ = 0; pExpKwh = 0; pImpKwh = 0;
      } else if (isPoint[m]) {
        // Schedule NBT SC 4.e.i, in order: the credit bank is first reduced by the
        // "Average Retail Export Compensation Rate" applied to the net surplus kWh, THEN
        // the net surplus kWh are paid at Net Surplus Compensation.  The ARECR is about
        // three times the NSC rate, so a bank built out of cheap midday exports is wiped
        // out and the customer keeps only the NSC payment - the penalty for an array
        // sized to annual kWh offset rather than to self-consumption.
        const surplusKwh = Math.max(0, pExpKwh - pImpKwh);
        const cut = take(r.arecr * surplusKwh, true).reduce((s, v) => s + v, 0);
        trueUp = surplusKwh * r.nsc;
        forfeitCredit = Math.max(0, cut - trueUp);
        // Any residual rolls into the new relevant period as carried credit.
        ce$ += e$; e$ = 0; ca$ += a$; a$ = 0; pExpKwh = 0; pImpKwh = 0;
      }
      const bank = e$ + ce$ + a$ + ca$;
      if (m === M - 1) { endBank$ = bank; endBankKwh = Math.max(0, pExpKwh - pImpKwh); }
      usedA[m] = fromE + fromCe; accUsedA[m] = fromA + fromCa; trueUpA[m] = trueUp;
      forfeitSettleA[m] = forfeitCredit; balA[m] = bank;
      value += fromE + fromCe + fromA + fromCa + trueUp;
    }
    // The cycle ends on a settlement point, so only carried pools are left.
    return { usedA, accUsedA, trueUpA, forfeitSettleA, balA, endBank$, endBankKwh, value,
             carryE$: ce$ + e$, carryA$: ca$ + a$ };
  }
  let cyc = runCycle(0, 0);
  for (let pass = 0; pass < 4 && cyc.carryE$ + cyc.carryA$ > EPS; pass++) {
    const next = runCycle(cyc.carryE$, cyc.carryA$);
    const done = Math.abs(next.value - cyc.value) < 1e-9;
    cyc = next;
    if (done) break;
  }
  const { usedA, accUsedA, trueUpA, forfeitSettleA, balA, endBank$, endBankKwh } = cyc;

  // ---- 3. totals and rows, in record order
  let total = 0, forfeitedTotal = forfeitedCap, exportValue = 0, accPlusValue = 0, nscValue = 0;
  const rows = detail ? [] : null;
  for (let m = 0; m < M; m++) {
    const bill = subtotalA[m] - usedA[m] - accUsedA[m] - climateA[m] - trueUpA[m];
    total += bill;
    exportValue += usedA[m] + accUsedA[m] + trueUpA[m];   // dollars sourced from exported kWh
    accPlusValue += accUsedA[m];                          // ...of which the ACC Plus adder
    nscValue += trueUpA[m];                               // ...of which the true-up payout
    forfeitedTotal += forfeitSettleA[m];
    if (rows) {
      const q = pre[m];
      rows.push({ key: ctx.monthKey[m], days: q.days, calendarDays: q.calDays, fixed: q.fixed,
                  energy: q.energy, baselineCredit: -q.credit, minimumAdj: q.minApplied,
                  // accPlus is the adder that reached this bill (this month's or banked);
                  // accPlusEarned is this month's adder before the credit floor.
                  // nonBypassable is INSIDE energy, shown because no credit offsets it.
                  exportCreditUsed: -usedA[m], accPlus: -accUsedA[m],
                  accPlusEarned: -accPlusA[m], nonBypassable: q.nbc$,
                  climateCredit: -climateA[m], trueUp: -trueUpA[m], settled: !!isPoint[m], bill,
                  importKwh: mImpKwh[m], exportKwh: expKwhA[m],
                  forfeitedKwh: q.forfeitKwh, forfeitedCredit: q.forfeit$ + forfeitSettleA[m],
                  creditBalance: balA[m] });
    }
  }
  // The months after the record's last settlement: their bank is carried round into the
  // record's first month (and settled at the first settlement point), not forfeited.
  const last = points[points.length - 1];
  const unsettledMonths = [];
  for (let m = last + 1; m < M; m++) unsettledMonths.push(ctx.monthKey[m]);
  const trailing = { unsettledMonths, bankKwh: unsettledMonths.length ? endBankKwh : 0,
                     bankDollars: unsettledMonths.length ? endBank$ : 0,
                     carriedTo: unsettledMonths.length ? ctx.monthKey[0] : null,
                     settledAt: unsettledMonths.length ? ctx.monthKey[points[0]] : null };
  const periods = points.map(function (p, i) {
    const from = i === 0 ? start : points[i - 1] + 1;
    const months = i === 0 ? ((p - start + M) % M) + 1 : p - points[i - 1];
    return { start: ctx.monthKey[from], end: ctx.monthKey[p], months };
  });
  return { total, months: rows, leftoverCredit: endBank$, forfeited: forfeitedTotal,
           exportValue, accPlusValue, nscValue, settledMonths: points.map((k) => ctx.monthKey[k]), periods, trailing };
}

// ---------------------------------------------------------------- dispatch
/**
 * One hourly run for a given panel allocation and battery bank.  Strategies differ
 * only in the three hooks evaluated per hour: may we discharge, down to what level,
 * and may we push stored energy to the grid.  There is no LP / perfect foresight - the
 * rules use a one-day lookahead on the *actual* next-day profile as the "forecast",
 * which is optimistic by exactly the amount a real forecast is wrong.
 *
 * `p.panelsByPlane` overrides the per-plane panel counts from buildScenario;
 * `p.batteries` sets the bank size.
 */
export function runHours(scn, params, detail) {
  const p = params.__defaulted ? params : withDefaults(params);
  const ctx = scn.ctx, N = ctx.N, r = scn.rates;
  const load = scn.load;
  const alloc = normaliseAlloc(scn, p);
  const pvInfo = pvFor(scn, alloc);
  const pv = pvInfo.pv;
  const batteries = Math.max(0, Math.round(p.batteries || 0));
  const cap = batteries * p.battKWh;
  const maxP = batteries * p.battKW;
  const eff = Math.sqrt(Math.max(0.5, Math.min(1, p.rte)));
  const floorKwh = cap * Math.max(0, Math.min(0.9, p.minReserve));
  const backup = p.strategy === "backup_only";
  const tou = p.strategy === "tou_arbitrage" || p.strategy === "export_arbitrage";
  // A battery added to a NEM 1/2 array is installed non-exporting and solar-charged
  // only (the usual way to keep the array's legacy agreement), so under NEM billing it
  // never sells to the grid and never buys from it.
  const nemRun = r.billing === "nem2" || r.billing === "nem1";
  const expArb = p.strategy === "export_arbitrage" && !nemRun;
  const gridCharge = !!p.gridCharge && tou && !nemRun;
  const thr = p.exportThreshold;
  let soc = backup ? cap : cap * 0.5;

  // --- per-day lookahead (depends on the allocation, so recomputed per panel count)
  const nD = ctx.nDays;
  const surplusDay = new Float64Array(nD);   // PV that exceeds load, i.e. chargeable
  const peakNeed = new Float64Array(nD);     // net load inside on/mid hours
  const peakStart = new Uint8Array(nD);
  const chgVal = new Float64Array(nD);       // NEM: what the surplus would have earned as export credit
  const dayMaxImp = new Float64Array(nD);    // NEM: the dearest import hour of the day, what a stored kWh can avoid
  for (let d = 0; d < nD; d++) peakStart[d] = 24;
  const valid = ctx.gapHours ? ctx.valid : null;
  for (let i = 0; i < N; i++) {
    if (valid && !valid[i]) continue;
    const dd = ctx.dayIdx[i], net = load[i] - pv[i];
    if (r.imp[i] > dayMaxImp[dd]) dayMaxImp[dd] = r.imp[i];
    if (net < 0) { surplusDay[dd] -= net; chgVal[dd] += -net * r.exp[i]; }
    else if (r.period[i] <= 1) { peakNeed[dd] += net; if (ctx.hour[i] < peakStart[dd]) peakStart[dd] = ctx.hour[i]; }
  }

  const M = ctx.nMonths;
  const mImpCost = new Float64Array(M), mImpKwh = new Float64Array(M);
  const mExpCred = new Float64Array(M), mExpKwh = new Float64Array(M);
  const mPvKwh = new Float64Array(M);
  const mBandKwh = [], mBandCred = [];
  for (let bb = 0; bb < EXP_BANDS.length; bb++) { mBandKwh.push(new Float64Array(M)); mBandCred.push(new Float64Array(M)); }
  const mPeriod = detail ? [new Float64Array(M), new Float64Array(M), new Float64Array(M), new Float64Array(M)] : null;
  let tImp = 0, tExp = 0, tPv = 0, tSelf = 0, tChg = 0, tDis = 0, tClip = 0, tLoad = 0;
  // Everything except the flexible loads: what the house draws when the cars and
  // the pool pump are not running, which is the draw a battery backs up in an outage.
  let tBase = 0;
  const baseLoad = scn.baseLoad || load;

  // typical-day accumulators: [season][hour][channel]
  const CH = 8; // load, flex, pv, chg, dis, imp, exp, soc
  const tdSum = detail ? [new Float64Array(24 * CH), new Float64Array(24 * CH)] : null;
  const tdCnt = detail ? [new Float64Array(24), new Float64Array(24)] : null;
  const hourly = detail ? { pvToLoad: new Float64Array(N), battToLoad: new Float64Array(N),
                            gridToLoad: new Float64Array(N), gridToBatt: new Float64Array(N),
                            pvToBatt: new Float64Array(N), pvExport: new Float64Array(N),
                            battExport: new Float64Array(N), clipped: new Float64Array(N),
                            soc: new Float64Array(N), pv: new Float64Array(N) } : null;

  const expLimit = (p.exportLimitKW && p.exportLimitKW > 0) ? p.exportLimitKW : Infinity;

  for (let i = 0; i < N; i++) {
    if (valid && !valid[i]) {
      // No meter reading: the hour is outside the simulation.  The pack sits idle.
      if (detail) hourly.soc[i] = soc;
      continue;
    }
    const L = load[i], P = pv[i];
    const m = ctx.monthIdx[i], day = ctx.dayIdx[i], hr = ctx.hour[i], pc = r.period[i];
    tPv += P; tLoad += L; tBase += baseLoad[i];

    const pvToLoad = P < L ? P : L;
    let surplus = P - pvToLoad, deficit = L - pvToLoad;
    let chg = 0, dis = 0, gcharge = 0, battExp = 0;

    // Under NEM a stored kWh gives up roughly a retail export credit, so the pack is only
    // worth filling on a day with an import hour dear enough to beat that credit after
    // two passes through the inverter; otherwise the surplus is better exported.
    let nemCredit = 0, nemWorth = true;
    if (nemRun && cap > 0) {
      const d0 = surplusDay[day] > EPS ? day : (day > 0 ? day - 1 : day);
      nemCredit = surplusDay[d0] > EPS ? chgVal[d0] / surplusDay[d0] : 0;
      const dNext = day + 1 < nD ? day + 1 : day;
      nemWorth = Math.max(dayMaxImp[day], dayMaxImp[dNext]) * eff * eff > nemCredit;
    }

    if (!backup && cap > 0) {
      // 1) soak up surplus PV
      if (surplus > EPS && nemWorth) {
        const room = (cap - soc) / eff;
        chg = Math.min(surplus, maxP, room);
        if (chg > 0) { soc += chg * eff; surplus -= chg; }
      }
      // 2) serve the house from the battery, subject to the strategy's floor
      if (deficit > EPS) {
        let level = floorKwh;
        if (tou && pc >= 2) {
          // Off-peak hold-back.  The peak we are saving for is TODAY's if we are
          // still ahead of it, otherwise tomorrow's - and the sun that refills the
          // pack for it is that same day's.  Hold back only the part of that peak
          // the sun cannot cover, so a sunny forecast frees the pack to serve the
          // house tonight at off-peak prices (which beats exporting at ACC rates).
          const refDay = hr < peakStart[day] ? day : (day + 1 < nD ? day + 1 : day);
          const refill = Math.min(surplusDay[refDay] * eff, cap - floorKwh);
          level = floorKwh + Math.max(0, peakNeed[refDay] / eff - refill);
          if (level > cap) level = cap;
        }
        // Under NEM, spending a stored kWh where the import it avoids is worth no more
        // than the credit it gave up, after losses, only loses the round-trip: hold.
        if (nemRun && r.imp[i] * eff * eff <= nemCredit) level = cap;
        const avail = Math.max(0, soc - level) * eff;
        dis = Math.min(deficit, maxP, avail);
        if (dis > 0) { soc -= dis / eff; deficit -= dis; }
      }
      // 3) pre-charge from the grid in the cheapest window when tomorrow's sun
      //    will not fill the pack before the peak
      if (gridCharge && chg === 0 && (pc === 3 || (pc === 2 && hr < 6))) {
        const short = (cap - soc) - Math.min(surplusDay[day] * eff, cap - soc);
        if (short > EPS) {
          // The inverter is shared: whatever already flowed this hour limits the buy.
          gcharge = Math.min(short / eff, maxP - dis - chg, (cap - soc) / eff);
          if (gcharge > 0) soc += gcharge * eff; else gcharge = 0;
        }
      }
      // 4) sell stored energy into an export-price spike, after the house is served.
      //    Never while grid-charging is enabled: grid energy in the pack must not earn
      //    an export credit, and the tariff forbids the combination outright.
      if (expArb && !gridCharge && r.exp[i] > thr) {
        const avail2 = Math.max(0, soc - floorKwh) * eff;
        battExp = Math.min(maxP - dis - chg, avail2);
        if (battExp > 0) { soc -= battExp / eff; surplus += battExp; } else battExp = 0;
      }
    }

    const clip = surplus > expLimit ? surplus - expLimit : 0;
    surplus -= clip;
    const imp = deficit + gcharge;

    mImpKwh[m] += imp; mImpCost[m] += imp * r.imp[i];
    mExpKwh[m] += surplus; mExpCred[m] += surplus * r.exp[i]; mPvKwh[m] += P;
    if (surplus > EPS) { const bd = bandOf(r.exp[i]); mBandKwh[bd][m] += surplus; mBandCred[bd][m] += surplus * r.exp[i]; }
    if (mPeriod) mPeriod[pc][m] += imp * r.imp[i];
    tImp += imp; tExp += surplus; tSelf += pvToLoad + chg; tChg += chg + gcharge; tDis += dis + battExp; tClip += clip;

    if (detail) {
      hourly.pvToLoad[i] = pvToLoad; hourly.battToLoad[i] = dis; hourly.gridToLoad[i] = deficit;
      hourly.gridToBatt[i] = gcharge; hourly.pvToBatt[i] = chg; hourly.pvExport[i] = surplus - battExp;
      hourly.battExport[i] = battExp; hourly.clipped[i] = clip; hourly.soc[i] = soc; hourly.pv[i] = P;
      if (ctx.dayType[i] === 0) {
        const si = r.summer[i] ? 0 : 1, o = hr * CH, a = tdSum[si];
        a[o] += L; a[o + 1] += scn.flex[i]; a[o + 2] += P; a[o + 3] += chg + gcharge;
        a[o + 4] += dis + battExp; a[o + 5] += imp; a[o + 6] += surplus;
        a[o + 7] += cap > 0 ? soc / cap : 0;
        tdCnt[si][hr]++;
      }
    }
  }

  const years = ctx.years;
  const xs = scn.existing;
  const billing = settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred);
  const out = {
    panels: pvInfo.panels, panelsByPlane: alloc.slice(), batteries,
    kwdc: pvInfo.kwdc, battKWhTotal: cap,
    importKwh: tImp / years, exportKwh: tExp / years, pvKwh: tPv / years,
    pvKwhByPlane: Array.prototype.map.call(pvInfo.byPlane, (v) => v / years),
    planeIds: scn.planes.map((pl) => pl.id),
    selfConsumedKwh: tSelf / years, clippedKwh: tClip / years, loadKwh: tLoad / years,
    baseLoadKwh: tBase / years,
    chargeKwh: tChg / years, dischargeKwh: tDis / years,
    cycles: cap > 0 ? (tDis / years) / cap : 0,
    bill: billing.total / years, forfeitedCredit: billing.forfeited / years,
    // Every dollar the system earns from EXPORTED energy: credits actually applied to
    // a bill, the ACC Plus adder, and the net-surplus payout at true-up.  Kept separate
    // from avoided import cost because export prices are locked at the ACC vintage
    // for nine years and do not follow retail escalation.
    // Under NEM 1/2 the export credit IS the retail price and moves with it, so it
    // belongs with the escalating bill saving: exportRevenue is 0 there and the export
    // dollars are reported, for display only, as nemExportValue (of which nscRevenue is
    // the true-up payout).
    exportRevenue: nemRun ? 0 : billing.exportValue / years,
    // The part of exportRevenue that is the ACC Plus adder - a SUBSET of it, never extra.
    // Realised value (with the adder minus without it, so banked adder lost to the
    // true-up counts for nothing), annualised like exportRevenue.  core/finance.js
    // expires it after the vintage's nine-year lock.
    accPlusRevenue: nemRun ? 0 : billing.accPlusValue / years,
    billing: r.billing,
    nemExportValue: nemRun ? billing.exportValue / years : 0,
    nscRevenue: billing.nscValue / years,
    // Panels already on the roof (params.existing), their modelled output, and the
    // panels this configuration ADDS.  kwdc and panels are the whole array.
    existingPanels: xs ? xs.panels : 0,
    existingPvKwh: xs ? xs.pvKwhTotal / years : 0,
    newPanels: pvInfo.panels - (xs ? xs.panels : 0),
    // Flexible-load hours whose kWh were non-finite and were priced as 0 (buildScenario).
    flexNanHours: scn.flexNanHours || 0,
    selfSufficiency: tLoad > 0 ? 1 - tImp / tLoad : 0,
    solarFraction: tPv > 0 ? tSelf / tPv : 0,
    weatherKey: scn.weatherKey,
    tariffTerms: tariffTerms(r),
    // Which months settled the credit bank, the relevant periods they close, and the bank
    // the record's last months carry round into its first (settle() / docs/engine.md §6).
    trueUp: { month: r.trueUpMonth, settledMonths: billing.settledMonths,
              periods: billing.periods, trailing: billing.trailing },
  };
  if (detail) {
    out.monthly = billing.months;
    out.periodCost = mPeriod.map((a) => Array.prototype.reduce.call(a, (s, v) => s + v, 0) / years);
    out.typicalDay = ["summer", "winter"].map(function (name, si) {
      const rows = [];
      for (let h = 0; h < 24; h++) {
        const n = tdCnt[si][h] || 1, o = h * CH, a = tdSum[si];
        rows.push({ hour: h, load: a[o] / n, flex: a[o + 1] / n, pv: a[o + 2] / n,
                    charge: a[o + 3] / n, discharge: a[o + 4] / n,
                    gridImport: a[o + 5] / n, gridExport: a[o + 6] / n, soc: a[o + 7] / n });
      }
      return { season: name, hours: rows };
    });
    out.hourly = hourly;
  }
  return out;
}

/**
 * Panel counts per plane: explicit override, else whatever the planes carry.  Panels
 * already on the roof are never taken away: the existing plane holds at least that many
 * in every run, which is how both no-system baselines carry the existing array.
 */
function normaliseAlloc(scn, p) {
  const n = scn.planes.length;
  const src = p.panelsByPlane;
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const v = src && src[k] !== undefined ? src[k] : scn.planes[k].panels;
    out[k] = Math.max(0, Math.round(v || 0));
  }
  const xs = scn.existing;
  if (xs && out[xs.planeIndex] < xs.panels) out[xs.planeIndex] = xs.panels;
  return out;
}

// ---------------------------------------------------------------- public API
export const DEFAULTS = {
  planes: [],                 // [{ id, profile: Float64Array(8760), panels, shading }]
  panelsByPlane: null,        // optional override of planes[].panels
  panelW: 460, batteries: 1, battKWh: 10, battKW: 5,
  rte: 0.90, minReserve: 0.20,   // engine fallback only; the app always passes system.rte (0.88 default)
  flex: [], baseLoadScale: 1,
  planId: "TOU-D-PRIME", providerId: "cpa_green", applyNbc: false,
  weatherKey: "tmy",
  climateCredit: null, climateCreditMonths: null, climateCreditOff: false,
  // undefined = use the tariff file (nbt.acc_plus_adder_per_kwh); a number overrides it.
  accPlusAdder: undefined, ngom: false,
  // utility.baselineRegions.allocations key; null = the file's meta.baseline_region.
  baselineRegion: null,
  // Settlement month 1-12 (the PTO anniversary); null = the file's nbt.true_up_month.
  trueUpMonth: null,
  // A city's generation municipal surcharge / utility-user tax as a fraction of the
  // generation charge (Agoura Hills: sce.json meta.bill_validation).  null = none.
  municipalSurchargeFactor: null,
  // "nbt" | "nem2" | "nem1" (docs/nem2.md), and the panels already on the roof as
  // { planeId, panels } (panels of panelW watts), or null.
  billing: "nbt", existing: null,
  strategy: "tou_arbitrage", gridCharge: false, exportThreshold: 0.5,
  exportLimitKW: 0,
};
export function withDefaults(p) {
  const o = { __defaulted: true };
  for (const k in DEFAULTS) o[k] = (p && p[k] !== undefined) ? p[k] : DEFAULTS[k];
  return o;
}

/**
 * Replay one real billing period out of the load history and price it, so the model
 * can be checked line-by-line against a paper bill.  Dates are inclusive, "YYYY-MM-DD".
 * Always uses the RECORDED load: no flexible-load rescheduling, no additions.
 */
export function billPeriod(ctx, params, startDate, endDate) {
  const p = withDefaults(params);
  const scn = buildScenario(ctx, Object.assign({}, p, { flex: [], planes: [], baseLoadScale: 1, existing: null }));
  const r = scn.rates;
  const plan = r.plan;
  const byPeriod = { on: { kwh: 0, cost: 0 }, mid: { kwh: 0, cost: 0 },
                     off: { kwh: 0, cost: 0 }, super_off: { kwh: 0, cost: 0 } };
  const days = {};
  let total = 0, allowance = 0;
  const blSummer = r.baselineSummerMonths || plan.summer_months;
  for (let i = 0; i < ctx.N; i++) {
    const d = ctx.load.ts[i].slice(0, 10);
    if (d < startDate || d > endDate) continue;
    if (!days[d]) {
      days[d] = 1;
      allowance += (blSummer.indexOf(ctx.month[i]) >= 0
                    ? r.baselineAllow.summer : r.baselineAllow.winter) * r.baselineCreditPct;
    }
    const k = scn.load[i], pid = PERIOD_IDS[r.period[i]];
    byPeriod[pid].kwh += k; byPeriod[pid].cost += k * r.imp[i]; total += k;
  }
  const nDays = Object.keys(days).length;
  const energy = byPeriod.on.cost + byPeriod.mid.cost + byPeriod.off.cost + byPeriod.super_off.cost;
  const fixed = r.fixed * nDays;
  const baseCredit = r.baselineCredit * Math.min(total, allowance);
  const cc = climateCredit(ctx, p);
  const endMonth = +endDate.slice(5, 7);
  const climate = (cc && cc.months.indexOf(endMonth) >= 0) ? cc.amount : 0;
  return { start: startDate, end: endDate, days: nDays, planId: plan.id,
           providerId: p.providerId, byPeriod, totalKwh: total,
           energy, fixed, baselineCredit: -baseCredit,
           baselineAllowanceKwh: allowance, climateCredit: -climate,
           total: fixed + energy - baseCredit - climate };
}

/**
 * One scenario run with no NEW panels and no battery: the no-system arm of a baseline.
 * With params.existing that is "the existing array, no battery" (normaliseAlloc keeps
 * the existing panels on their plane).
 */
function noSystem(scn, p, detail) {
  const zero = Object.assign({}, p, { batteries: 0, panelsByPlane: scn.planes.map(() => 0) });
  return runHours(scn, zero, detail);
}

/**
 * The four savings numbers every result carries, given the two no-system bills.
 * A no-system baseline exports nothing, so the whole of exportRevenue is the system's;
 * the remainder of the saving is avoided retail import cost (res.accPlusRevenue, the
 * adder's share of exportRevenue, needs no baseline term for the same reason).  Shared with the
 * optimizer's sweep so the split is defined in exactly one place.
 */
export function attachSavings(res, sameFlexBill, asRecordedBill) {
  res.savingsVsSameFlex = sameFlexBill - res.bill;
  res.savingsVsAsRecorded = asRecordedBill - res.bill;
  res.importSavingsVsSameFlex = res.savingsVsSameFlex - res.exportRevenue;
  res.importSavingsVsAsRecorded = res.savingsVsAsRecorded - res.exportRevenue;
  return res;
}

/** The two no-system arms every result is measured against. */
export function baselines(ctx, p, detail) {
  const scnSame = buildScenario(ctx, p);
  const scnRec = buildScenario(ctx, p, { flexMode: "asRecorded" });
  return {
    scnSame, scnRec,
    sameFlex: noSystem(scnSame, p, detail),
    asRecorded: noSystem(scnRec, p, detail),
  };
}

/** Full run for one configuration, including the two no-system baselines. */
export function simulate(ctx, params, opts) {
  const p = withDefaults(params), detail = !!(opts && opts.detail);
  const b = baselines(ctx, p, detail);
  const res = runHours(b.scnSame, p, detail);

  res.baselineSameFlex = b.sameFlex;
  res.baselineAsRecorded = b.asRecorded;
  attachSavings(res, b.sameFlex.bill, b.asRecorded.bill);
  res.flexShiftOnlySavings = b.asRecorded.bill - b.sameFlex.bill;
  res.years = ctx.years;
  res.usableDays = ctx.usableDays;
  // runHours already carries flexNanHours; the as-recorded arm can add its own.
  res.flexNanHours = Math.max(res.flexNanHours || 0, b.scnRec.flexNanHours || 0);
  return res;
}

/** Same configuration priced on every plan, so the UI can show the best one. */
export function billOnAllPlans(ctx, params) {
  const p = withDefaults(params);
  return ctx.tariffs.plans.map(function (plan) {
    const q = Object.assign({}, p, { planId: plan.id });
    const b = baselines(ctx, q, false);
    const withSys = runHours(b.scnSame, q, false);
    return { planId: plan.id, name: plan.name, bill: withSys.bill,
             baselineSameFlex: b.sameFlex.bill, baselineAsRecorded: b.asRecorded.bill,
             exportRevenue: withSys.exportRevenue, accPlusRevenue: withSys.accPlusRevenue,
             savings: b.asRecorded.bill - withSys.bill };
  });
}

/** Same configuration priced on every provider of the current plan. */
export function billOnAllProviders(ctx, params) {
  const p = withDefaults(params);
  const providers = Object.keys(ctx.tariffs.providers || {});
  return providers.map(function (id) {
    const q = Object.assign({}, p, { providerId: id });
    // Only the same-flex arm is reported, so the as-recorded scenario is never built.
    const scn = buildScenario(ctx, q);
    const base = noSystem(scn, q, false);
    const withSys = runHours(scn, q, false);
    return { id, name: (ctx.tariffs.providers[id] || {}).name || id,
             bill: withSys.bill, baselineSameFlex: base.bill,
             savings: base.bill - withSys.bill };
  });
}

export const _internal = { isDST, spread, fallbackReshape, dayBounds,
                           shadingFactors, PERIOD_IDS, EXP_BANDS, bandOf, DOW_PRIORITY };

const SolarEngine = {
  prepare, buildScenario, runHours, simulate, billPeriod, billOnAllPlans, billOnAllProviders,
  baselines, attachSavings, buildRates, settle, settlementPoints, planById, resolvePlan,
  resolveTrueUpMonth, profileFor, pvFor, climateCredit, resolveExisting, BILLING_REGIMES,
  resolveProvider, resolveBaseline, tariffAccPlus, tariffArecr,
  MIN_USABLE_DAYS, DEFAULT_TRUE_UP_MONTH,
  reshapeFlex, setFlexReshape, flexReshapeSource,
  withDefaults, DEFAULTS, _internal,
};
export default SolarEngine;
