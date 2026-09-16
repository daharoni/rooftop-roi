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
 * params.flex[] = FlexLoad (core/flexload.js).  The engine subtracts every detected
 *   `kwhByHour` from the recorded load to get the base load, then adds each flex load
 *   back at its scheduled hours via FlexLoad.reshape(flex, cal, solarShape).
 *
 * -----------------------------------------------------------------------------
 * ASSUMPTIONS BEYOND THE CONTRACT (all surfaced in the UI's method panel)
 * -----------------------------------------------------------------------------
 * 1. rates[season][period][providerId] is the FULL bundled $/kWh for that provider
 *    (delivery + that provider's generation).  If a provider key is missing we fall
 *    back to rates[...].delivery + rates[...].sce_generation.
 * 2. nbt.nonbypassable_charges_per_kwh is treated as ALREADY INSIDE the retail
 *    import rates (that is how SCE publishes them), so it is not added on top.
 *    Set params.applyNbc = true if your tariff file lists NBC-exclusive rates.
 * 3. Net surplus compensation is applied to the kWh basis of unused credits: we
 *    track both the dollar balance and the kWh that produced it, and pay the
 *    remaining kWh at the NSC rate at true-up.
 * 4. The minimum-charge floor is max(minimum_charge_per_day, fixed_charge_per_day)
 *    x days, so the fixed charge always survives an export-credit offset.
 * 5. Holidays use the weekend schedule: New Year's, Presidents', Memorial,
 *    Independence, Labor, Veterans, Thanksgiving, Christmas (observed dates are
 *    NOT shifted for weekend-falling holidays - SCE bills the actual date).
 * ========================================================================== */

import FlexLoad from "./flexload.js";

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
function nthWeekday(year, month /*1-12*/, weekday /*0=Sun*/, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const off = (weekday - first.getUTCDay() + 7) % 7;
  return 1 + off + 7 * (n - 1);
}
function lastWeekday(year, month, weekday) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, days));
  return days - ((last.getUTCDay() - weekday + 7) % 7);
}
function holidaySet(years) {
  const s = new Set();
  years.forEach(function (y) {
    const add = (m, d) => s.add(y + "-" + m + "-" + d);
    add(1, 1);                                   // New Year's Day
    add(2, nthWeekday(y, 2, 1, 3));              // Presidents' Day
    add(5, lastWeekday(y, 5, 1));                // Memorial Day
    add(7, 4);                                   // Independence Day
    add(9, nthWeekday(y, 9, 1, 1));              // Labor Day
    add(11, 11);                                 // Veterans Day
    add(11, nthWeekday(y, 11, 4, 4));            // Thanksgiving
    add(12, 25);                                 // Christmas
  });
  return s;
}
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
export function prepare(data) {
  const load = data.load, tariffs = data.tariffs;
  const ts = load.ts, N = ts.length;
  const month = new Uint8Array(N);        // 1-12
  const hourA = new Int8Array(N);         // 0-23 wall clock
  const dayType = new Uint8Array(N);      // 0 weekday, 1 weekend/holiday
  const solarIdx = new Int32Array(N);     // index into an 8760 profile
  const dayIdx = new Int32Array(N);
  const monthIdx = new Int32Array(N);

  const recorded = new Float64Array(N);
  let nanHours = 0;
  for (let i = 0; i < N; i++) {
    const v = +load.kwh[i];
    if (isFinite(v)) recorded[i] = v; else nanHours++;      // unfilled gaps price as 0
  }
  const exportKwh = load.exportKwh ? Float64Array.from(load.exportKwh, (v) => (isFinite(v) ? v : 0)) : null;

  const years = new Set();
  for (let i = 0; i < N; i++) years.add(+ts[i].slice(0, 4));
  const hol = holidaySet(Array.from(years));

  const dayStart = [], dayLen = [], dayDow = [], monthDays = [], monthKey = [];
  let prevDay = "", prevMonth = "", d = -1, m = -1, prevTs = "";
  let cachedDayType = 0;

  for (let i = 0; i < N; i++) {
    const s = ts[i];
    const y = +s.slice(0, 4), mo = +s.slice(5, 7), dd = +s.slice(8, 10), h = +s.slice(11, 13);
    const dkey = s.slice(0, 10), mkey = s.slice(0, 7);
    if (dkey !== prevDay) {
      prevDay = dkey; d++; dayStart.push(i); dayLen.push(0);
      const dow = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay();
      dayDow.push(dow);
      cachedDayType = (dow === 0 || dow === 6 || hol.has(y + "-" + mo + "-" + dd)) ? 1 : 0;
      if (mkey !== prevMonth) { prevMonth = mkey; m++; monthDays.push(0); monthKey.push(mkey); }
      monthDays[m]++;
    }
    dayLen[d]++;
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
  const ctx = {
    load, tariffs, N, nDays, nMonths: m + 1,
    month, hour: hourA, dayType, solarIdx, dayIdx, monthIdx,
    dayStart: Int32Array.from(dayStart), dayLen: Int32Array.from(dayLen),
    dayDow: Int8Array.from(dayDow),
    monthDays: Int32Array.from(monthDays), monthKey,
    monthNum: monthKey.map((k) => +k.slice(5, 7)),
    recorded, exportKwh,
    years: nDays / 365,
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
    hours: ctx.N, days: ctx.nDays, years: ctx.nDays / 365,
    start: lm.start || ctx.load.ts[0], end: lm.end || ctx.load.ts[ctx.N - 1],
    tz: lm.tz || null, source: lm.source || lm.source_files || null,
    totalKwh: totalKwh !== undefined ? totalKwh : sum,
    annualKwh: sum / (ctx.nDays / 365),
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

  if ((sch.mode || "spread") === "asRecorded" && src) {
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
  for (let i = 0; i < tariffs.plans.length; i++) if (tariffs.plans[i].id === id) return tariffs.plans[i];
  return tariffs.plans[0];
}
function rateFor(rates, provider) {
  if (rates == null) return 0;
  if (typeof rates[provider] === "number") return rates[provider];
  return (rates.delivery || 0) + (rates.sce_generation || 0);
}

/** Per-hour import/export prices + period codes for one (plan, provider). */
export function buildRates(ctx, planId, providerId, applyNbc, climate, accPlus, capExport) {
  const t = ctx.tariffs, plan = planById(t, planId);
  const N = ctx.N;
  const imp = new Float64Array(N), exp = new Float64Array(N);
  const per = new Uint8Array(N), summer = new Uint8Array(N);
  const nbc = applyNbc ? (t.nbt.nonbypassable_charges_per_kwh || 0) : 0;
  const adder = /^cpa/.test(providerId) ? (t.nbt.cpa_export_adder_per_kwh || 0) : 0;
  // Two bill lines deliberately kept out of the rate tables (sce.json meta.notes):
  // Agoura Hills' generation municipal surcharge, levied on the GENERATION component
  // only, and CPA's flat per-kWh energy surcharge.  Folding both into the hourly
  // import price is exact and costs nothing in the inner loop.
  const bv = (t.meta || {}).bill_validation || {};
  const munFactor = bv.generation_municipal_surcharge_factor || 0;
  const cpaSurcharge = /^cpa/.test(providerId) ? (bv.cpa_energy_surcharge_per_kwh || 0) : 0;
  const isSummer = {};
  for (let m = 1; m <= 12; m++) isSummer[m] = plan.summer_months.indexOf(m) >= 0;

  // memoise the 2x2x24 rate lookup
  const cache = {};
  for (let i = 0; i < N; i++) {
    const mo = ctx.month[i], h = ctx.hour[i], dt = ctx.dayType[i];
    const su = isSummer[mo] ? 1 : 0;
    const key = su + "|" + dt + "|" + h;
    let c = cache[key];
    if (!c) {
      const season = su ? "summer" : "winter";
      const pid = plan.schedule[season][dt ? "weekend" : "weekday"][h];
      const tbl = plan.rates[season][pid];
      const full = rateFor(tbl, providerId);
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
      c = cache[key] = { p: PERIOD_INDEX[pid] === undefined ? 2 : PERIOD_INDEX[pid],
                         r: full + nbc + gen * munFactor + cpaSurcharge };
    }
    per[i] = c.p; imp[i] = c.r; summer[i] = su;
    exp[i] = t.nbt.export_rates[dt ? "weekend" : "weekday"][mo - 1][h] + adder;
  }
  return { plan, imp, exp, period: per, summer,
           accPlus, arecr: (t.nbt.eec_adjustment_per_kwh || 0.05981),
           capExport, munFactor, cpaSurcharge,
           baselineCredit: plan.baseline_credit_per_kwh || 0,
           baselineAllow: t.meta.baseline_kwh_per_day,
           fixed: plan.fixed_charge_per_day, min: plan.minimum_charge_per_day,
           nsc: t.nbt.net_surplus_compensation_per_kwh, climate: climate || null,
           trueUpMonth: t.nbt.true_up_month || ctx.monthNum[0] };
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
    if (prof) for (let i = 0; i < N; i++) per[i] = prof[ctx.solarIdx[i]] * kwPerPanel * keep[ctx.month[i] - 1];
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
  const flexList = (p.flex || []).filter(Boolean);
  const base = new Float64Array(N);
  base.set(ctx.recorded);
  for (const f of flexList) {
    if (!f.kwhByHour) continue;
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
    flexSeries.push({ id: f.id, kind: f.kind || "custom", name: f.name || f.id, series: s });
    for (let i = 0; i < N; i++) flexTotal[i] += s[i];
  }
  for (let i = 0; i < N; i++) load[i] = base[i] + flexTotal[i];

  return {
    ctx, planes, panelW: p.panelW, load, baseLoad: base, flex: flexTotal, flexSeries,
    solarShape, flexMode: asRecorded ? "asRecorded" : "scheduled",
    baseClampedKwh: clampedKwh,
    rates: buildRates(ctx, p.planId, p.providerId, p.applyNbc, climateCredit(ctx, p),
                      p.accPlusAdder, !p.ngom),
    weatherKey: p.weatherKey,
    _pv: null,
  };
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
 * Turn monthly energy totals into a bill, NBT-style:
 *   subtotal = fixed + energy - baseline credit, floored at the minimum charge;
 *   export credits then offset the subtotal down to (not below) that floor;
 *   the unused balance rolls forward and is cashed out at NSC at true-up.
 */
export function settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred) {
  const M = ctx.nMonths;
  let bal$ = 0, balKwh = 0, total = 0, forfeitedTotal = 0, exportValue = 0;
  const rows = detail ? [] : null;
  for (let m = 0; m < M; m++) {
    const days = ctx.monthDays[m];
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
      expKwh -= forfeitKwh; expCred -= forfeit$; forfeitedTotal += forfeit$;
    }
    const fixed = r.fixed * days;
    const allow = (r.plan.summer_months.indexOf(ctx.monthNum[m]) >= 0
                   ? r.baselineAllow.summer : r.baselineAllow.winter) * days;
    const credit = r.baselineCredit * Math.min(mImpKwh[m], allow);
    const energy = mImpCost[m];
    const floor = Math.max(r.min * days, fixed);
    let subtotal = fixed + energy - credit;
    let minApplied = 0;
    if (subtotal < floor) { minApplied = floor - subtotal; subtotal = floor; }

    // The ACC Plus adder is the one export credit that MAY offset fixed and
    // non-bypassable charges, so it is settled outside the credit bank.
    const accPlus = (r.accPlus || 0) * expKwh;
    bal$ += expCred; balKwh += expKwh;
    const used = Math.min(bal$, Math.max(0, subtotal - floor));
    if (bal$ > EPS) { balKwh *= (1 - used / bal$); }
    bal$ -= used;
    let bill = subtotal - used;

    let climate = 0;
    if (r.climate && r.climate.amount && r.climate.months.indexOf(ctx.monthNum[m]) >= 0) {
      // The CA Climate Credit is a flat bill credit, not an energy charge: it lands
      // after the export offset and CAN push the bill below the fixed charge.
      climate = r.climate.amount;
      bill -= climate;
    }

    bill -= accPlus;                              // may take the bill below the floor
    exportValue += used + accPlus;                // dollars sourced from exported kWh

    let trueUp = 0, forfeitCredit = 0;
    if (ctx.monthNum[m] === r.trueUpMonth || m === M - 1) {
      // Schedule NBT SC 4.e.i, in order: the credit bank is first reduced by the
      // "Average Retail Export Compensation Rate" applied to net surplus kWh, THEN the
      // net surplus kWh are paid at Net Surplus Compensation.  The ARECR is about three
      // times the NSC rate, so a bank built out of cheap midday exports is wiped out
      // entirely and the customer keeps only the NSC payment - which is exactly the
      // penalty for an array sized to annual kWh offset rather than to self-consumption.
      const reduction = Math.min(bal$, r.arecr * balKwh);
      trueUp = balKwh * r.nsc;
      forfeitCredit = Math.max(0, reduction - trueUp);
      forfeitedTotal += forfeitCredit;
      bill -= trueUp;
      exportValue += trueUp;
      bal$ -= reduction;                 // any residual rolls into the new relevant period
      balKwh = 0;
    }
    total += bill;
    if (rows) rows.push({ key: ctx.monthKey[m], days, fixed, energy,
                          baselineCredit: -credit, minimumAdj: minApplied,
                          exportCreditUsed: -used, accPlus: -accPlus,
                          climateCredit: -climate, trueUp: -trueUp, bill,
                          importKwh: mImpKwh[m], exportKwh: expKwh,
                          forfeitedKwh: forfeitKwh, forfeitedCredit: forfeit$ + forfeitCredit,
                          creditBalance: bal$ });
  }
  return { total, months: rows, leftoverCredit: bal$, forfeited: forfeitedTotal,
           exportValue };
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
  const expArb = p.strategy === "export_arbitrage";
  const gridCharge = !!p.gridCharge && tou;
  const thr = p.exportThreshold;
  let soc = backup ? cap : cap * 0.5;

  // --- per-day lookahead (depends on the allocation, so recomputed per panel count)
  const nD = ctx.nDays;
  const surplusDay = new Float64Array(nD);   // PV that exceeds load, i.e. chargeable
  const peakNeed = new Float64Array(nD);     // net load inside on/mid hours
  const peakStart = new Uint8Array(nD);
  for (let d = 0; d < nD; d++) peakStart[d] = 24;
  for (let i = 0; i < N; i++) {
    const dd = ctx.dayIdx[i], net = load[i] - pv[i];
    if (net < 0) surplusDay[dd] -= net;
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
    const L = load[i], P = pv[i];
    const m = ctx.monthIdx[i], day = ctx.dayIdx[i], hr = ctx.hour[i], pc = r.period[i];
    tPv += P; tLoad += L;

    const pvToLoad = P < L ? P : L;
    let surplus = P - pvToLoad, deficit = L - pvToLoad;
    let chg = 0, dis = 0, gcharge = 0, battExp = 0;

    if (!backup && cap > 0) {
      // 1) soak up surplus PV
      if (surplus > EPS) {
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

  const years = ctx.nDays / 365;
  const billing = settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred);
  const out = {
    panels: pvInfo.panels, panelsByPlane: alloc.slice(), batteries,
    kwdc: pvInfo.kwdc, battKWhTotal: cap,
    importKwh: tImp / years, exportKwh: tExp / years, pvKwh: tPv / years,
    pvKwhByPlane: Array.prototype.map.call(pvInfo.byPlane, (v) => v / years),
    planeIds: scn.planes.map((pl) => pl.id),
    selfConsumedKwh: tSelf / years, clippedKwh: tClip / years, loadKwh: tLoad / years,
    chargeKwh: tChg / years, dischargeKwh: tDis / years,
    cycles: cap > 0 ? (tDis / years) / cap : 0,
    bill: billing.total / years, forfeitedCredit: billing.forfeited / years,
    // Every dollar the system earns from EXPORTED energy: credits actually applied to
    // a bill, the ACC Plus adder, and the net-surplus payout at true-up.  Kept separate
    // from avoided import cost because export prices are locked at the ACC vintage
    // for nine years and do not follow retail escalation.
    exportRevenue: billing.exportValue / years,
    selfSufficiency: tLoad > 0 ? 1 - tImp / tLoad : 0,
    solarFraction: tPv > 0 ? tSelf / tPv : 0,
    weatherKey: scn.weatherKey,
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

/** Panel counts per plane: explicit override, else whatever the planes carry. */
function normaliseAlloc(scn, p) {
  const n = scn.planes.length;
  const src = p.panelsByPlane;
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const v = src && src[k] !== undefined ? src[k] : scn.planes[k].panels;
    out[k] = Math.max(0, Math.round(v || 0));
  }
  return out;
}

// ---------------------------------------------------------------- public API
export const DEFAULTS = {
  planes: [],                 // [{ id, profile: Float64Array(8760), panels, shading }]
  panelsByPlane: null,        // optional override of planes[].panels
  panelW: 460, batteries: 1, battKWh: 10, battKW: 5,
  rte: 0.90, minReserve: 0.20,
  flex: [], baseLoadScale: 1,
  planId: "TOU-D-PRIME", providerId: "cpa_green", applyNbc: false,
  weatherKey: "tmy",
  climateCredit: null, climateCreditMonths: null, climateCreditOff: false,
  accPlusAdder: 0.016, ngom: false,
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
  const scn = buildScenario(ctx, Object.assign({}, p, { flex: [], planes: [], baseLoadScale: 1 }));
  const r = scn.rates;
  const plan = r.plan;
  const byPeriod = { on: { kwh: 0, cost: 0 }, mid: { kwh: 0, cost: 0 },
                     off: { kwh: 0, cost: 0 }, super_off: { kwh: 0, cost: 0 } };
  const days = {};
  let total = 0, allowance = 0;
  for (let i = 0; i < ctx.N; i++) {
    const d = ctx.load.ts[i].slice(0, 10);
    if (d < startDate || d > endDate) continue;
    if (!days[d]) {
      days[d] = 1;
      allowance += (plan.summer_months.indexOf(ctx.month[i]) >= 0
                    ? r.baselineAllow.summer : r.baselineAllow.winter);
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

/** The two no-system arms every result is measured against. */
export function baselines(ctx, p, detail) {
  const scnSame = buildScenario(ctx, p);
  const scnRec = buildScenario(ctx, p, { flexMode: "asRecorded" });
  const zero = Object.assign({}, p, { batteries: 0, panelsByPlane: scnSame.planes.map(() => 0) });
  return {
    scnSame, scnRec,
    sameFlex: runHours(scnSame, zero, detail),
    asRecorded: runHours(scnRec, Object.assign({}, zero, { panelsByPlane: scnRec.planes.map(() => 0) }), detail),
  };
}

/** Full run for one configuration, including the two no-system baselines. */
export function simulate(ctx, params, opts) {
  const p = withDefaults(params), detail = !!(opts && opts.detail);
  const b = baselines(ctx, p, detail);
  const res = runHours(b.scnSame, p, detail);

  res.baselineSameFlex = b.sameFlex;
  res.baselineAsRecorded = b.asRecorded;
  res.savingsVsSameFlex = b.sameFlex.bill - res.bill;
  res.savingsVsAsRecorded = b.asRecorded.bill - res.bill;
  // A no-system baseline exports nothing, so the whole of exportRevenue is the
  // system's; the remainder of the saving is avoided retail import cost.
  res.importSavingsVsSameFlex = res.savingsVsSameFlex - res.exportRevenue;
  res.importSavingsVsAsRecorded = res.savingsVsAsRecorded - res.exportRevenue;
  res.flexShiftOnlySavings = b.asRecorded.bill - b.sameFlex.bill;
  res.years = ctx.nDays / 365;
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
             exportRevenue: withSys.exportRevenue,
             savings: b.asRecorded.bill - withSys.bill };
  });
}

/** Same configuration priced on every provider of the current plan. */
export function billOnAllProviders(ctx, params) {
  const p = withDefaults(params);
  const providers = Object.keys(ctx.tariffs.providers || {});
  return providers.map(function (id) {
    const q = Object.assign({}, p, { providerId: id });
    const b = baselines(ctx, q, false);
    const withSys = runHours(b.scnSame, q, false);
    return { id, name: (ctx.tariffs.providers[id] || {}).name || id,
             bill: withSys.bill, baselineSameFlex: b.sameFlex.bill,
             savings: b.sameFlex.bill - withSys.bill };
  });
}

export const _internal = { holidaySet, isDST, spread, fallbackReshape, dayBounds,
                           shadingFactors, PERIOD_IDS, EXP_BANDS, bandOf, DOW_PRIORITY };

const SolarEngine = {
  prepare, buildScenario, runHours, simulate, billPeriod, billOnAllPlans, billOnAllProviders,
  baselines, buildRates, settle, planById, profileFor, pvFor, climateCredit,
  reshapeFlex, setFlexReshape, flexReshapeSource,
  withDefaults, DEFAULTS, _internal,
};
export default SolarEngine;
