/* GENERATED FILE - DO NOT EDIT.
 * Built by `node core/bundle-for-worker.mjs` from core/{flexload.js,engine.js,finance.js,optimizer.js}
 * and core/worker.js.  Edit those, re-run the script, commit the result.
 */
/* ===== core/flexload.js =================================================== */
var __ns_FlexLoad = (function () {
/* =============================================================================
 * core/flexload.js - flexible loads: find them in the meter data, then re-place
 * them on the clock.
 *
 * Pure ES module, no dependencies, browser + Node 24.  No DOM, no network.
 *
 * Two halves:
 *
 *   detectEV(loadSet, opts) -> FlexLoad|null   split EV charging out of the whole-house
 *   detectPool(loadSet, opts) -> FlexLoad|null   ... and a pool pump, if there is one
 *
 *   reshape(flex, cal, solarShape) -> Float64Array(N)
 *       the hourly kWh this flexible load adds back once the engine has subtracted
 *       its `kwhByHour` from the recorded load.
 *
 * The detector is a straight port of `docs/reference-ev-detector.py`, which is the
 * tested prototype: two-pass robust hour-of-day baseline, excess threshold, run
 * grouping, charger-kW inference.  Reproducing its numbers on
 * `tests/fixtures/load-agoura-hills.json` is a test, not an aspiration:
 *   3,582 kWh/yr, 8.02 kW charger, 254 sessions, 2.41 sessions/week.
 *
 * FlexLoad shape - docs/ARCHITECTURE.md:
 *   { id, kind: "ev"|"pool"|"custom", name, source: "detected"|"manual",
 *     kwhByHour: Float64Array|null, annualKwh, detection: {...}|null,
 *     schedule: { mode, daysPerWeek, window, daylightFraction, overnightWindow,
 *                 maxKW, followSolar, hoursPerDay }, scale }
 * ========================================================================== */

const EPS = 1e-9;
const HOURS_PER_YEAR = 8766;          // 365.25 * 24, as in the reference detector
const DAYS_PER_YEAR = 365.25;
const WEEKS_PER_YEAR = 52.18;         // as specified for manual loads
// The detectors report sessions/week against the reference detector's own divisor, which
// is a hair different from the one above.  It is kept exactly because the fixture numbers
// (2.41 sessions/week) were produced with it; do not "tidy" the two into one.
const DETECTOR_WEEKS_PER_YEAR = 52.1775;
const DOW_PRIORITY = [1, 2, 3, 4, 5, 6, 0];   // Mon, Tue, Wed, Thu, Fri, Sat, Sun
const CUM_NONLEAP = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// ------------------------------------------------- EV detector tuning (ported)
const EV_TUNING = {
  baselineHalfWindowDays: 15,   // +/- days used to build the hour-of-day baseline
  baselinePctile: 0.30,         // robust "house only" percentile (pass 1)
  nightHours: [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],   // 8PM - 9:59AM
  excessThreshold: 2.0,         // kWh above baseline to call a night hour "EV"
  coreExcess: 4.0,              // a run must peak above this to be a session
  dayFlatness: 1.0,             // max (max-min) excess inside a daytime plateau
  dayLevelLo: 0.70,             // daytime plateau must sit in [lo,hi] x charger kW
  dayLevelHi: 1.20,
  // ---- generalisation beyond the reference household (review 2026-10-02, P0 #4/#5) ----
  // The two thresholds above are CEILINGS.  For a smaller charger they scale down to
  // `thresholdFrac` / `coreFrac` x the inferred charger kW, but never below a floor tied
  // to the house itself (`houseFloorMult` x the median hourly load, at least
  // `minExcessFloor`), so ordinary appliance noise cannot pass for charging.  With an
  // 8 kW charger the ceilings win and the reference numbers are reproduced exactly.
  thresholdFrac: 0.5,
  coreFrac: 0.8,
  houseFloorMult: 1.5,
  minExcessFloor: 1.0,
  minChargerKW: 2.8,            // a plateau lower than this is not a Level-2 charger
  // Below this a detection is not adopted (see `detectEV`).
  minConfidence: 0.5,
  // Plausibility: share of EV energy in Jun-Sep, and in the evening block
  // [eveningHours[0], eveningHours[1]), above which the "EV" is far more likely to be
  // air-conditioning.
  maxSummerShare: 0.75,
  maxEveningShare: 0.75,
  eveningHours: [17, 23],
  // A car uses at least this much a year and charges at least this often.  Below either,
  // the "sessions" are a heat pump's or an AC's thermostat cycles (review 2026-10-03).
  minAnnualKwh: 500,
  minSessionsPerMonth: 2,
  // A record with < 60 days outside Jun-Sep cannot run the summer test; it must show at
  // least this share of the energy overnight (22:00-06:00) instead.
  minShortRecordOvernightShare: 0.3,
};

// ------------------------------------------------------------------- helpers
const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.min(lo + 1, sorted.length - 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function medianOf(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Hours since epoch from a naive local stamp - lets us measure "1 hour apart". */
function naiveHours(y, mo, d, h) { return Date.UTC(y, mo - 1, d, h) / 3600000; }

function tsParts(s) {
  return { y: +s.slice(0, 4), mo: +s.slice(5, 7), d: +s.slice(8, 10), h: +s.slice(11, 13) };
}

// ----------------------------------------------------------------- calendar
/** US DST: 2nd Sunday of March 02:00 -> 1st Sunday of November 02:00. */
function nthWeekday(year, month, dow, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
}
function isDST(y, mo, d, h) {
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  if (mo === 3) { const s = nthWeekday(y, 3, 0, 2); return d > s || (d === s && h >= 2); }
  const e = nthWeekday(y, 11, 0, 1);
  return d < e || (d === e && h < 2);
}

/**
 * The calendar `reshape` needs, built straight from a LoadSet.  `core/engine.js`
 * builds an equivalent (richer) object in `prepare()`; this is here so the Loads
 * tab and the tests can reshape without spinning up the whole engine.
 *
 *   { N, ts, dayIdx:Int32Array, dayDow:Int8Array (0=Sun, one per DAY),
 *     hourA:Int8Array (clock hour per slot), nDays, solarIdx:Int32Array }
 */
function buildCalendar(loadSet) {
  const ts = loadSet.ts, N = ts.length;
  const dayIdx = new Int32Array(N);
  const hourA = new Int8Array(N);
  const solarIdx = new Int32Array(N);
  const dayDow = [];
  let prevDay = "", prevTs = "", d = -1;
  for (let i = 0; i < N; i++) {
    const s = ts[i], p = tsParts(s), dkey = s.slice(0, 10);
    if (dkey !== prevDay) {
      prevDay = dkey; d++;
      dayDow.push(new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay());
    }
    dayIdx[i] = d; hourA[i] = p.h;
    const dst = isDST(p.y, p.mo, p.d, p.h) && s !== prevTs;
    prevTs = s;
    let doy = CUM_NONLEAP[p.mo - 1] + ((p.mo === 2 && p.d === 29) ? 28 : p.d);
    let hs = p.h - (dst ? 1 : 0);
    if (hs < 0) { hs = 23; doy = doy === 1 ? 365 : doy - 1; }
    solarIdx[i] = (doy - 1) * 24 + hs;
  }
  return { N, ts, dayIdx, hourA, dayDow: Int8Array.from(dayDow), nDays: d + 1, solarIdx };
}

/** Start index + length of every day, derived from cal.dayIdx. */
function dayBounds(cal) {
  const nDays = cal.nDays;
  const starts = new Int32Array(nDays).fill(-1);
  const lens = new Int32Array(nDays);
  for (let i = 0; i < cal.N; i++) {
    const d = cal.dayIdx[i];
    if (starts[d] < 0) starts[d] = i;
    lens[d]++;
  }
  return { starts, lens };
}

// ------------------------------------------------------------------ detectEV
/**
 * Split EV charging out of a whole-house LoadSet.
 *
 * Method (identical to docs/reference-ev-detector.py, quoted in `detection.method`):
 *   pass 1  house baseline for each (date, hour) = 30th percentile of the same
 *           hour-of-day over a +/-15 day window;
 *   pass 2  the baseline is recomputed as the MEDIAN of the same-hour samples with
 *           the pass-1 EV hours removed;
 *   excess  = metered kWh - baseline;
 *   night   (8PM-9:59AM): contiguous runs with excess > 2.0 kWh are EV provided the
 *           run peaks above 4.0 kWh;
 *   day     (10AM-7:59PM): only runs of >= 2 consecutive hours whose excess is flat
 *           (range < 1.0 kWh) and sits between 0.70x and 1.20x the inferred charger
 *           power - this rejects air-conditioning, which ramps;
 *   charger kW = median of the top decile of overnight excess (held to within 15%
 *           of the largest flat plateau, see below); every hour is capped at it, and
 *           at the metered kWh for that hour.
 *
 * NaN hours (a gap the parser could not fill) are treated as absent: they never
 * enter a baseline and never carry EV energy.
 *
 * Generalised beyond the reference household (review 2026-10-02, P0 #4 and #5):
 *   - the charger kW is first estimated from the record's flat plateaus, overnight
 *     AND daytime (`estimateChargerKW`), replacing the old fixed 8 kW fallback; the
 *     2.0 / 4.0 kWh thresholds become ceilings that scale down to 0.5x / 0.8x that kW
 *     for a small charger, floored at 1.5x the house's median hourly load;
 *   - every plateau cluster of at least `minChargerKW` counts when the heaviest one
 *     does, so a two-car house is seen as two levels: the thresholds scale to the
 *     smallest, the per-hour cap is the largest (ONE estimate, also used for the
 *     daytime band), and a daytime plateau at either level counts;
 *   - the result is returned as **null** (nothing adopted) when there are no
 *     sessions, when confidence < `minConfidence` (0.5), or when the pattern fails
 *     the plausibility test: summer-only or evening-only (air-conditioning); under
 *     `minAnnualKwh` (500) a year or under `minSessionsPerMonth` (2) sessions a
 *     covered month (a heat pump's thermostat cycles); or, on a record with < 60
 *     days outside Jun-Sep, under 30% of the energy overnight
 *     ("short-record-unconfirmed").  `detection.rejectCode` names the test;
 *   - a detected EV is scheduled "asRecorded": nothing is moved into solar hours
 *     until the visitor opts in.
 *
 * Why 0.5: `evConfidence` scores four sanity checks out of 0.9.  Passing all four
 * scores 0.9; one failure 0.73-0.75; two failures 0.56-0.60; three 0.41-0.43.  0.5
 * therefore adopts a split that passes at least two of the four checks on a complete
 * record, and rejects one that fails three, or fails one on a record with less than
 * ~70% coverage.  The plausibility test, not the score, is what catches AC.
 *
 * opts:
 *   chargerKW     the visitor's stated charger size (kW).  Always the per-hour cap.
 *                 When the record's own plateau agrees (within 40%), it also sets
 *                 the thresholds and waives the evening-only test (the visitor has
 *                 told us there is a car).  When it disagrees, `detection.
 *                 chargerMismatch` is true, the record's levels join it for the
 *                 thresholds and the daytime band, and every test runs.
 *   keepRejected  return the FlexLoad even when a plausibility test rejects it, with
 *                 `detection.accepted: false`, `detection.rejectReason` (a sentence)
 *                 and `detection.rejectCode` (for the Loads tab's "we looked, here is
 *                 why not" line, and for tests).  Without it a rejection is null.
 *   any EV_TUNING key overrides that constant; an explicit excessThreshold or
 *   coreExcess is used as given (not scaled).
 */
function detectEV(loadSet, opts = {}) {
  const T = { ...EV_TUNING, ...opts };
  const NIGHT = new Uint8Array(24);
  for (const h of T.nightHours) NIGHT[h] = 1;

  const ts = loadSet.ts, kwhIn = loadSet.kwh, N = ts.length;
  if (!N) throw new Error("detectEV: empty LoadSet");

  // ---- index the record on a contiguous calendar of dates -------------------
  const p0 = tsParts(ts[0]), pN = tsParts(ts[N - 1]);
  const dayMs = 86400000;
  const d0 = Date.UTC(p0.y, p0.mo - 1, p0.d);
  const d1 = Date.UTC(pN.y, pN.mo - 1, pN.d);
  const nDates = Math.round((d1 - d0) / dayMs) + 1;

  const val = new Float64Array(nDates * 24);
  const present = new Uint8Array(nDates * 24);
  const sDate = new Int32Array(N);       // date index per slot
  const sHour = new Int8Array(N);
  const sNaive = new Float64Array(N);
  const sCell = new Int32Array(N);
  let nUsable = 0;
  for (let i = 0; i < N; i++) {
    const p = tsParts(ts[i]);
    const di = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - d0) / dayMs);
    const cell = di * 24 + p.h;
    sDate[i] = di; sHour[i] = p.h; sCell[i] = cell;
    sNaive[i] = naiveHours(p.y, p.mo, p.d, p.h);
    if (Number.isFinite(kwhIn[i])) { val[cell] = kwhIn[i]; present[cell] = 1; nUsable++; }
  }

  // ---- house scale, charger estimate, relative thresholds ----------------
  const userKW = opts.chargerKW > 0 ? +opts.chargerKW : null;
  const houseVals = [];
  for (let c = 0; c < val.length; c++) if (present[c]) houseVals.push(val[c]);
  houseVals.sort((a, b) => a - b);
  const medianLoad = medianOf(houseVals);
  const floor = Math.max(T.minExcessFloor, T.houseFloorMult * medianLoad);

  const base0 = buildBaseline(val, present, nDates, null, false, T);
  const est = estimateChargerKW(N, sCell, sNaive, val, present, base0, floor);
  // The record's charger level(s): every plateau cluster of at least `minChargerKW`,
  // provided the HEAVIEST cluster is one (a house whose dominant plateau is 1.6 kW of
  // heat pump does not get a 3 kW "charger" out of a minor cluster).  A second
  // cluster is a second car: a two-EV house charging 3.3 kW at night and 11.5 kW on a
  // Saturday has both.
  const levels = est.kw >= T.minChargerKW ? est.levels.filter((l) => l >= T.minChargerKW) : [];
  const plateauKW = levels.length ? Math.max(...levels) : null;
  // A stated size that the record's own plateau contradicts (by more than 40%) is
  // kept for the cap - the visitor knows their charger - but it no longer vouches for
  // the pattern: the evening test runs, and the record's levels set the thresholds.
  const chargerMismatch = !!(userKW && plateauKW &&
    Math.max(userKW, plateauKW) / Math.min(userKW, plateauKW) > 1.4);
  const bandKW = userKW ? (chargerMismatch ? [userKW, ...levels] : [userKW]) : levels;
  const thrKW = bandKW.length ? Math.min(...bandKW) : null;
  if (thrKW) {
    // An explicit threshold in opts is the caller's to keep; otherwise scale to the
    // SMALLEST charger, so a 3.3 kW car is not hidden by an 11.5 kW one.
    if (!("excessThreshold" in opts)) {
      T.excessThreshold = Math.min(EV_TUNING.excessThreshold, Math.max(floor, T.thresholdFrac * thrKW));
    }
    if (!("coreExcess" in opts)) {
      T.coreExcess = Math.min(EV_TUNING.coreExcess,
        Math.max(T.excessThreshold + 0.5, T.coreFrac * thrKW));
    }
  }

  // ---- two-pass baseline ---------------------------------------------------
  // ONE charger estimate drives the per-hour cap: the largest plausible plateau.  The
  // reference estimate (top decile of overnight excess) is kept when it agrees with
  // that plateau to within 15%, because it reproduces the prototype; when it does not
  // (a small overnight car under a big daytime one, or house noise stacked on a small
  // charger) the plateau wins.
  const fallbackKW = plateauKW || 8.0;
  const pickKW = (base) => {
    if (userKW) return userKW;
    const top = inferChargerKW(val, present, N, sCell, sHour, base, NIGHT, T, fallbackKW);
    return plateauKW && (top > 1.15 * plateauKW || top < 0.85 * plateauKW) ? plateauKW : top;
  };
  const dayLevels = (kw) => (bandKW.length ? Array.from(new Set([...bandKW, kw])) : [kw]);
  let chargerKW = pickKW(base0);
  const ev0 = detectRuns(N, sCell, sHour, sNaive, val, present, base0, chargerKW, dayLevels(chargerKW), NIGHT, T);

  const exclude = new Uint8Array(nDates * 24);
  for (const i of ev0.keys()) exclude[sCell[i]] = 1;
  const base1 = buildBaseline(val, present, nDates, exclude, true, T);
  chargerKW = pickKW(base1);
  const ev1 = detectRuns(N, sCell, sHour, sNaive, val, present, base1, chargerKW, dayLevels(chargerKW), NIGHT, T);

  // ---- emit ----------------------------------------------------------------
  const kwhByHour = new Float64Array(N);
  let evTotal = 0, total = 0, dayEv = 0, summerEv = 0, eveningEv = 0, overnightEv = 0;
  let nonSummerHours = 0;
  for (let i = 0; i < N; i++) {
    const metered = present[sCell[i]] ? val[sCell[i]] : 0;
    const e = round3(Math.min(ev1.get(i) || 0, metered));
    kwhByHour[i] = e;
    evTotal += e; total += metered;
    if (!NIGHT[sHour[i]]) dayEv += e;
    const mo = +ts[i].slice(5, 7);
    if (mo >= 6 && mo <= 9) summerEv += e;
    else if (present[sCell[i]]) nonSummerHours++;
    if (sHour[i] >= T.eveningHours[0] && sHour[i] < T.eveningHours[1]) eveningEv += e;
    if (sHour[i] >= 22 || sHour[i] < 6) overnightEv += e;
  }

  const sessions = sessionsFrom(N, sHour, sNaive, ts, ev1);
  const spanYears = N / HOURS_PER_YEAR;
  const sessKwh = sessions.map((s) => s.kwh).sort((a, b) => a - b);
  const sessionsPerWeek = sessions.length / (spanYears * DETECTOR_WEEKS_PER_YEAR);
  const medianSessionKwh = round3(medianOf(sessKwh));
  const annualKwh = evTotal / spanYears;

  const method =
    `Two-pass hour-of-day baseline. Pass 1: house baseline for each (date, hour) = ` +
    `${Math.round(T.baselinePctile * 100)}th percentile of the same hour-of-day over a ` +
    `+/-${T.baselineHalfWindowDays} day window. Pass 2: the baseline is recomputed as the ` +
    `median of the same-hour samples with pass-1 EV hours removed. Excess = metered kWh - ` +
    `baseline. Overnight window (8PM-9:59AM): contiguous runs with excess > ` +
    `${round2(T.excessThreshold)} kWh are attributed to the EV provided the run peaks above ` +
    `${round2(T.coreExcess)} kWh. Daytime window (10AM-7:59PM): only runs of >=2 consecutive hours ` +
    `whose excess is flat (range < ${T.dayFlatness} kWh) and sits between ` +
    `${T.dayLevelLo.toFixed(2)}x and ${T.dayLevelHi.toFixed(2)}x the inferred charger power ` +
    `are attributed to the EV; this separates charging plateaus from air-conditioning, which ` +
    `ramps. Per-hour EV is capped at the ${userKW ? "stated" : "inferred"} charger power of ` +
    `${chargerKW} kW${userKW ? "" : chargerKW === plateauKW
      ? " (the largest flat charging plateau in the record)"
      : " (median of the top decile of overnight excess)"}. ` +
    (levels.length > 1 ? `The record shows ${levels.length} charging levels (` +
      `${levels.slice().sort((x, y) => x - y).join(" and ")} kW); daytime plateaus at either count. ` : "") +
    `Thresholds scale with the charger (${T.thresholdFrac}x / ${T.coreFrac}x its kW, capped at ` +
    `${EV_TUNING.excessThreshold} / ${EV_TUNING.coreExcess} kWh) but never drop below ` +
    `${round2(floor)} kWh (${T.houseFloorMult}x the house's median hourly load). Detected daytime ` +
    `charging = ${dayEv.toFixed(0)} kWh ` +
    `(${evTotal > 0 ? (100 * dayEv / evTotal).toFixed(1) : "0.0"}% of EV energy).`;

  const confidence = evConfidence({
    nSessions: sessions.length, sessionsPerWeek, chargerKW,
    share: total > 0 ? evTotal / total : 0, medianSessionKwh,
    coverage: nUsable / N,
  });

  // ---- plausibility: is this a car, or the air conditioner / heat pump? ------
  // A car is driven all year.  Air-conditioning shows up as an "EV" that only charges
  // in Jun-Sep, or almost only in the 17:00-23:00 evening block (the hours after a hot
  // day when the house is occupied and the compressor runs flat out).  A heat pump or
  // other thermostat load leaves a thin scatter of "sessions": a few hundred kWh a
  // year, far fewer than a car's weekly charges.  All of these are rejected.
  //   - the summer test needs at least ~60 days outside Jun-Sep to judge; a record
  //     shorter than that must instead show real overnight charging (>= 30% of the
  //     energy between 22:00 and 06:00), or the split stays unconfirmed;
  //   - the evening test is skipped when the caller states a charger size that the
  //     record does not contradict (then the visitor has told us there IS a car).
  const summerShare = evTotal > 0 ? summerEv / evTotal : 0;
  const eveningShare = evTotal > 0 ? eveningEv / evTotal : 0;
  const overnightShare = evTotal > 0 ? overnightEv / evTotal : 0;
  const coveredMonths = nUsable / (HOURS_PER_YEAR / 12);
  const shortRecord = nonSummerHours < 60 * 24;
  const [eveA, eveB] = T.eveningHours;
  let rejectReason = null, rejectCode = null;
  const reject = (code, why) => { rejectCode = code; rejectReason = why; };
  if (!sessions.length) reject("no-sessions", "no charging sessions found");
  else if (!shortRecord && summerShare > T.maxSummerShare) {
    reject("summer-only", `${Math.round(summerShare * 100)}% of the candidate energy is in Jun-Sep; ` +
      `that is air-conditioning, not a car`);
  } else if (shortRecord && overnightShare < T.minShortRecordOvernightShare) {
    reject("short-record-unconfirmed", `the record has fewer than 60 days outside Jun-Sep and only ` +
      `${Math.round(overnightShare * 100)}% of the candidate energy is overnight (22:00-06:00); ` +
      `with no winter to compare against, that cannot be told apart from air-conditioning`);
  } else if ((!userKW || chargerMismatch) && eveningShare > T.maxEveningShare) {
    reject("evening-only", `${Math.round(eveningShare * 100)}% of the candidate energy is between ` +
      `${pad2(eveA)}:00 and ${pad2(eveB)}:00; a car is rarely charged only then, air-conditioning ` +
      `often runs only then`);
  } else if (annualKwh < T.minAnnualKwh) {
    reject("too-small", `${Math.round(annualKwh)} kWh/yr is below ${T.minAnnualKwh}; that is a ` +
      `thermostat load (heat pump, AC) or noise, not a car`);
  } else if (sessions.length < T.minSessionsPerMonth * coveredMonths) {
    reject("too-few-sessions", `${sessions.length} sessions over ${round2(coveredMonths)} months ` +
      `is fewer than ${T.minSessionsPerMonth} a month; a car charges more often than that`);
  } else if (confidence < T.minConfidence) {
    reject("low-confidence", `confidence ${round2(confidence)} is below ${T.minConfidence}`);
  }
  if (rejectReason && !opts.keepRejected) return null;

  return {
    id: "ev1",
    kind: "ev",
    name: "Electric vehicle",
    source: "detected",
    kwhByHour,
    annualKwh: round3(annualKwh),
    detection: {
      method, chargerKW, sessions,
      sessionsPerWeek: round2(sessionsPerWeek),
      medianSessionKwh,
      totalKwh: round3(evTotal),
      daytimeKwh: round3(dayEv),
      confidence: round2(confidence),
      chargerSource: userKW ? "stated" : "inferred",
      chargerMismatch,
      // plateauKW is null when the record's plateau was too small to be a charger and
      // so did not shape anything; chargerLevels lists every level that did.
      thresholds: { excessKwh: round2(T.excessThreshold), coreKwh: round2(T.coreExcess),
                    floorKwh: round2(floor), medianHourlyKwh: round3(medianLoad),
                    plateauKW, chargerLevels: levels },
      plausibility: { summerShare: round2(summerShare), eveningShare: round2(eveningShare),
                      overnightShare: round2(overnightShare), coveredMonths: round2(coveredMonths) },
      accepted: !rejectReason,
      rejectReason,
      rejectCode,
    },
    // Never move load the visitor has not agreed to move: a detected EV stays exactly
    // where the meter recorded it until the Loads tab switches it to "spread".
    schedule: {
      mode: "asRecorded",
      daysPerWeek: 5,
      window: [8, 15],
      daylightFraction: 0.9,
      overnightWindow: [1, 5],
      maxKW: chargerKW,
      followSolar: true,
      hoursPerDay: 4,
    },
    scale: 1.0,
  };
}

/**
 * Charger power from the record's flat plateaus, overnight AND daytime: every run of
 * >= 2 consecutive hours whose excess over the pass-1 baseline stays above `floor` and
 * is flat (range <= max(1 kWh, 25% of its level)) contributes its median level,
 * weighted by its energy.  The answer is the median of the levels in the heaviest
 * 0.5 kW-wide cluster.  Returns null when the record has no such plateau.
 *
 * This replaces the reference detector's fixed 8 kW fallback and lets the thresholds
 * scale to a 3.3 kW Level-2 or an 11.5 kW daytime charger.  Charging at a constant
 * current is the flattest thing a house does; AC cycles and ramps, so it rarely
 * forms a heavy cluster.
 */
function estimateChargerKW(N, sCell, sNaive, val, present, base, floor, minShare = 0.25) {
  const ex = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = sCell[i];
    ex[i] = present[c] ? val[c] - base[c] : -Infinity;
  }
  const levels = [];   // [level, weight]
  let i = 0;
  while (i < N) {
    if (!(ex[i] > floor)) { i++; continue; }
    let j = i;
    while (j + 1 < N && ex[j + 1] > floor && sNaive[j + 1] - sNaive[j] <= 1) j++;
    if (j > i) {
      const run = Array.from(ex.subarray(i, j + 1));
      // drop a partial first/last hour (a session rarely starts on the hour)
      const core = run.length > 3 ? run.slice(1, -1) : run;
      core.sort((a, b) => a - b);
      const lvl = medianOf(core);
      if (core[core.length - 1] - core[0] <= Math.max(1.0, 0.25 * lvl)) {
        levels.push([lvl, lvl * core.length]);
      }
    }
    i = j + 1;
  }
  if (!levels.length) return { kw: null, levels: [] };
  const BIN = 0.5;
  const bins = new Map();
  for (const [l, w] of levels) {
    const b = Math.floor(l / BIN);
    bins.set(b, (bins.get(b) || 0) + w);
  }
  // weight of a bin = itself plus its neighbours, so a level on a bin edge is not split
  let best = null, bestW = -1;
  for (const b of bins.keys()) {
    const w = (bins.get(b - 1) || 0) + bins.get(b) + (bins.get(b + 1) || 0);
    if (w > bestW) { bestW = w; best = b; }
  }
  // Every cluster, heaviest first: a window of three bins, not overlapping one
  // already taken, carrying at least `minShare` of the heaviest cluster's energy.
  const windowW = (b) => (bins.get(b - 1) || 0) + (bins.get(b) || 0) + (bins.get(b + 1) || 0);
  const cand = Array.from(bins.keys()).map((b) => [b, windowW(b)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const taken = [];
  for (const [b, w] of cand) {
    if (w < minShare * bestW) break;
    if (taken.some((t) => Math.abs(t - b) < 3)) continue;
    taken.push(b);
  }
  if (!taken.includes(best)) taken.unshift(best);
  const medianIn = (b) => {
    const lo = (b - 1) * BIN, hi = (b + 2) * BIN;
    return round2(medianOf(levels.filter(([l]) => l >= lo && l < hi).map(([l]) => l).sort((x, y) => x - y)));
  };
  const all = taken.map(medianIn);
  return { kw: all[0], levels: all };
}

/**
 * Baseline house load per (date, hour): the `baselinePctile` percentile of the
 * same hour-of-day inside a +/-`baselineHalfWindowDays` window.  When `exclude`
 * marks the pass-1 EV hours, the clean sample already has the EV removed and we
 * take its median instead.  Falls back to the percentile over ALL samples when
 * fewer than 5 clean ones remain.
 */
function buildBaseline(val, present, nDates, exclude, useMedian, T) {
  const W = T.baselineHalfWindowDays;
  const base = new Float64Array(nDates * 24);
  const clean = new Float64Array(2 * W + 1);
  const all = new Float64Array(2 * W + 1);
  for (let di = 0; di < nDates; di++) {
    const lo = Math.max(0, di - W), hi = Math.min(nDates - 1, di + W);
    for (let h = 0; h < 24; h++) {
      const cell = di * 24 + h;
      if (!present[cell]) continue;
      let nc = 0, na = 0;
      for (let j = lo; j <= hi; j++) {
        const c = j * 24 + h;
        if (!present[c]) continue;
        all[na++] = val[c];
        if (!exclude || !exclude[c]) clean[nc++] = val[c];
      }
      if (nc >= 5) {
        const s = Array.prototype.slice.call(clean.subarray(0, nc)).sort((a, b) => a - b);
        base[cell] = useMedian ? medianOf(s) : percentile(s, T.baselinePctile);
      } else {
        const s = Array.prototype.slice.call(all.subarray(0, na)).sort((a, b) => a - b);
        base[cell] = percentile(s, T.baselinePctile);
      }
    }
  }
  return base;
}

/** Charger power = median of the top decile of overnight excess. */
function inferChargerKW(val, present, N, sCell, sHour, base, NIGHT, T, fallbackKW = 8.0) {
  const vals = [];
  for (let i = 0; i < N; i++) {
    if (!NIGHT[sHour[i]]) continue;
    const c = sCell[i];
    if (!present[c]) continue;
    const e = val[c] - base[c];
    if (e > T.coreExcess) vals.push(e);
  }
  if (!vals.length) return fallbackKW;
  vals.sort((a, b) => a - b);
  const top = vals.slice(Math.floor(0.90 * vals.length));
  return round2(medianOf(top));
}

/** The night-run + daytime-plateau scan.  Returns Map(slotIndex -> ev kWh). */
function detectRuns(N, sCell, sHour, sNaive, val, present, base, chargerKW, dayKW, NIGHT, T) {
  const ev = new Map();
  const excess = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = sCell[i];
    excess[i] = present[c] ? Math.max(0, val[c] - base[c]) : 0;
  }
  const adjacent = (a, b) => sNaive[b] - sNaive[a] <= 1;

  // --- night: contiguous runs over the threshold whose peak is a real charge
  let i = 0;
  while (i < N) {
    if (NIGHT[sHour[i]] && excess[i] > T.excessThreshold) {
      let j = i;
      while (j + 1 < N && NIGHT[sHour[j + 1]] && excess[j + 1] > T.excessThreshold &&
             adjacent(j, j + 1)) j++;
      let peak = 0;
      for (let k = i; k <= j; k++) if (excess[k] > peak) peak = excess[k];
      if (peak > T.coreExcess) {
        for (let k = i; k <= j; k++) ev.set(k, Math.min(excess[k], chargerKW));
      }
      i = j + 1;
    } else i++;
  }

  // --- day: only flat plateaus that look like one of the chargers
  const bands = dayKW.map((kw) => [T.dayLevelLo * kw, T.dayLevelHi * kw]);
  i = 0;
  while (i < N) {
    const band = NIGHT[sHour[i]] ? null : bands.find(([lo, hi]) => excess[i] >= lo && excess[i] <= hi);
    if (band) {
      const [loLvl, hiLvl] = band;
      let j = i;
      for (;;) {
        const k = j + 1;
        if (!(k < N && !NIGHT[sHour[k]] && excess[k] >= loLvl && excess[k] <= hiLvl &&
              adjacent(j, k))) break;
        let mx = -Infinity, mn = Infinity;
        for (let q = i; q <= k; q++) { if (excess[q] > mx) mx = excess[q]; if (excess[q] < mn) mn = excess[q]; }
        if (!(mx - mn < T.dayFlatness)) break;
        j = k;
      }
      if (j > i) for (let k = i; k <= j; k++) ev.set(k, Math.min(excess[k], chargerKW));
      i = j + 1;
    } else i++;
  }
  return ev;
}

/** Group consecutive EV hours into sessions, merging runs that straddle midnight. */
function sessionsFrom(N, sHour, sNaive, ts, ev) {
  const idxs = Array.from(ev.keys()).sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < idxs.length) {
    let j = i;
    while (j + 1 < idxs.length && idxs[j + 1] === idxs[j] + 1 &&
           sNaive[idxs[j + 1]] - sNaive[idxs[j]] <= 1) j++;
    let total = 0;
    for (let k = i; k <= j; k++) total += ev.get(idxs[k]);
    const a = idxs[i];
    out.push({
      date: ts[a].slice(0, 10),
      startHour: sHour[a],
      kwh: round3(total),
      hours: j - i + 1,
      _startNaive: sNaive[a],
    });
    i = j + 1;
  }
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev._startNaive + prev.hours === s._startNaive) {
      prev.kwh = round3(prev.kwh + s.kwh);
      prev.hours += s.hours;
      continue;
    }
    merged.push({ ...s });
  }
  for (const s of merged) delete s._startNaive;
  return merged;
}

/**
 * How much to trust the split, 0..1.  Four sanity checks, each worth a share of
 * 0.9 (a detector that only ever sees one household's meter never gets a 1.0):
 * a plausible charging cadence, a plausible charger size, a plausible share of
 * the whole-house energy, and sessions big enough to be a car rather than a
 * kettle.  A record with holes is discounted by its coverage.
 */
function evConfidence({ nSessions, sessionsPerWeek, chargerKW, share, medianSessionKwh, coverage }) {
  if (!nSessions) return 0;
  let c = 0;
  c += sessionsPerWeek >= 0.4 && sessionsPerWeek <= 10 ? 0.25 : 0.08;
  c += chargerKW >= 3 && chargerKW <= 20 ? 0.25 : 0.08;
  c += share >= 0.05 && share <= 0.6 ? 0.2 : 0.05;
  c += medianSessionKwh >= 5 ? 0.2 : 0.05;
  return clamp01(c * (coverage == null ? 1 : Math.max(0.5, coverage)));
}

// ---------------------------------------------------------------- detectPool
/**
 * A pool pump looks nothing like an EV, so it is not found the same way.  An EV
 * is intermittent, which is exactly what makes a 30th-percentile hour-of-day
 * baseline work: on the nights the car is not plugged in, the baseline sees the
 * house alone.  A pool pump runs on a timer EVERY day at the SAME hours, so that
 * baseline swallows it whole.
 *
 * What a pump does leave behind is a rectangular STEP in the day's own profile:
 * a flat block of hours that sits `step` kW above the hours either side of it, at
 * the same clock hour, most days of the year.  So this looks for the step:
 *
 *   for each day, inside the daytime window, find the longest run of consecutive
 *   hours that is flat to within `flatness` kWh; measure `step` as the run's
 *   median minus the mean of the two flanking hours; keep the run when it is at
 *   least `minHours` long and `step` lands between `minKW` and `maxKW`.
 *   Then require such a run on at least `minDayShare` of the days, with one
 *   dominant start hour (`minStartShare` of the runs) - the timer.
 *
 * `opts.evKwhByHour` should be the detected EV series when there is one, so a
 * daytime charging plateau cannot be mistaken for a pump.
 *
 * Returns **null** when nothing matches, which is the common case: most houses
 * have no pool, and a modern variable-speed pump ramps instead of stepping and
 * hides inside the house load.  null therefore means "not found", NOT "no pool" -
 * callers should offer the manual `presets()` pool template either way.  The
 * detected FlexLoad carries `detection.confidence` (0.25 - 0.9); a caller that
 * would rather have an object than a null can treat null as confidence 0.
 */
function detectPool(loadSet, opts = {}) {
  const O = {
    minHours: 3, maxHours: 12, flatness: 0.35, minKW: 0.3, maxKW: 3.0,
    dayStart: 7, dayEnd: 19, minDayShare: 0.30, minStartShare: 0.30,
    ...opts,
  };
  const ts = loadSet.ts, kwhIn = loadSet.kwh, N = ts.length;
  if (!N) return null;

  // Lay the record out day by day so runs never straddle midnight.
  const cal = buildCalendar(loadSet);
  const bounds = dayBounds(cal);
  const ev = opts.evKwhByHour || null;
  const house = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v = kwhIn[i];
    house[i] = Number.isFinite(v) ? Math.max(0, v - (ev ? ev[i] : 0)) : NaN;
  }

  const kwhByHour = new Float64Array(N);
  const runs = [];
  for (let d = 0; d < cal.nDays; d++) {
    const s0 = bounds.starts[d], s1 = s0 + bounds.lens[d];
    const byHour = new Int32Array(24).fill(-1);
    for (let k = s0; k < s1; k++) byHour[cal.hourA[k]] = k;

    let best = null;
    for (let a = O.dayStart; a < O.dayEnd; a++) {
      const ia = byHour[a];
      if (ia < 0 || !Number.isFinite(house[ia])) continue;
      let mx = house[ia], mn = house[ia], b = a;
      for (let h = a + 1; h < O.dayEnd && h - a + 1 <= O.maxHours; h++) {
        const ih = byHour[h];
        if (ih < 0 || !Number.isFinite(house[ih])) break;
        const nmx = Math.max(mx, house[ih]), nmn = Math.min(mn, house[ih]);
        if (nmx - nmn > O.flatness) break;
        mx = nmx; mn = nmn; b = h;
      }
      const len = b - a + 1;
      if (len < O.minHours) continue;

      const vals = [];
      for (let h = a; h <= b; h++) vals.push(house[byHour[h]]);
      const level = medianOf(vals.slice().sort((x, y) => x - y));
      const flank = [];
      if (byHour[a - 1] >= 0 && Number.isFinite(house[byHour[a - 1]])) flank.push(house[byHour[a - 1]]);
      if (b + 1 < 24 && byHour[b + 1] >= 0 && Number.isFinite(house[byHour[b + 1]])) flank.push(house[byHour[b + 1]]);
      if (!flank.length) continue;
      const step = level - flank.reduce((x, y) => x + y, 0) / flank.length;
      if (step < O.minKW || step > O.maxKW) continue;
      const scoreVal = len * step;
      if (!best || scoreVal > best.score) best = { a, b, len, step, score: scoreVal, byHour };
    }
    if (best) runs.push({ d, ...best });
  }
  if (!runs.length) return null;

  const dayShare = runs.length / cal.nDays;
  const startHist = new Map();
  for (const r of runs) startHist.set(r.a, (startHist.get(r.a) || 0) + 1);
  let domHour = 0, domN = 0;
  for (const [h, n] of startHist) if (n > domN) { domN = n; domHour = h; }
  const startShare = domN / runs.length;
  if (dayShare < O.minDayShare || startShare < O.minStartShare) return null;

  let total = 0, stepSum = 0, hoursSum = 0;
  const sessions = [];
  for (const r of runs) {
    let sess = 0;
    for (let h = r.a; h <= r.b; h++) {
      const k = r.byHour[h];
      const add = round3(Math.min(r.step, house[k]));
      kwhByHour[k] = add; total += add; sess += add;
    }
    stepSum += r.step; hoursSum += r.len;
    sessions.push({ date: ts[r.byHour[r.a]].slice(0, 10), startHour: r.a, kwh: round3(sess), hours: r.len });
  }

  const spanYears = N / HOURS_PER_YEAR;
  const kw = round2(stepSum / runs.length);
  const hoursPerDay = Math.max(1, Math.round(hoursSum / runs.length));
  const confidence = round2(clamp01(0.2 + 0.4 * dayShare + 0.3 * startShare));

  return {
    id: "pool1",
    kind: "pool",
    name: "Pool pump",
    source: "detected",
    kwhByHour,
    annualKwh: round3(total / spanYears),
    detection: {
      method:
        `Rectangular daytime step: on each day, the longest run of consecutive hours between ` +
        `${pad2(O.dayStart)}:00 and ${pad2(O.dayEnd)}:00 that is flat to within ${O.flatness} kWh ` +
        `and sits ${O.minKW}-${O.maxKW} kW above the hours either side of it. Found on ` +
        `${(100 * dayShare).toFixed(0)}% of days, ${(100 * startShare).toFixed(0)}% of them ` +
        `starting at ${pad2(domHour)}:00, averaging ${kw} kW for ${hoursPerDay} h.`,
      chargerKW: kw,
      sessions,
      sessionsPerWeek: round2(runs.length / (spanYears * DETECTOR_WEEKS_PER_YEAR)),
      medianSessionKwh: round3(medianOf(sessions.map((s) => s.kwh).sort((a, b) => a - b))),
      startHour: domHour,
      hoursPerDay,
      dayShare: round2(dayShare),
      confidence,
    },
    // As for the EV: a detected load stays where it was recorded until the visitor
    // opts in to moving it.
    schedule: {
      mode: "asRecorded", daysPerWeek: 7,
      window: [domHour, Math.min(24, domHour + hoursPerDay)],
      daylightFraction: 1.0, overnightWindow: [1, 5],
      maxKW: Math.max(kw, 0.1), followSolar: false, hoursPerDay,
    },
    scale: 1.0,
  };
}

// ------------------------------------------------------------------- reshape
// mode "asRecorded": a FlexLoad that arrives without a mode is never silently moved
// into solar hours.  Manual templates (`presets()`) opt in to "spread" explicitly.
const DEFAULT_SCHEDULE = {
  mode: "asRecorded",
  daysPerWeek: 5,
  window: [8, 15],
  daylightFraction: 0.9,
  overnightWindow: [1, 5],
  maxKW: 8,
  followSolar: true,
  hoursPerDay: 4,
};

/**
 * The hourly kWh a flexible load adds back to the base load.
 *
 *   cal = { N, ts, dayIdx:Int32Array, dayDow:Int8Array (0=Sun, one per DAY),
 *           hourA:Int8Array (clock hour per slot), nDays [, solarIdx] }
 *       - exactly what `core/engine.js` prepare() already builds, and what
 *         `buildCalendar(loadSet)` above returns.
 *   solarShape - optional weighting for `followSolar`.  Accepted as
 *       length N (per slot), length 8760 (a per-kW standard-time profile; indexed
 *       through cal.solarIdx when present, otherwise derived from cal.ts), or
 *       length 24 (an average day).  Anything else is ignored and the window is
 *       filled flat.
 *
 * Windows are half-open clock ranges: window [8,15] means 08:00..14:00 inclusive.
 *
 * Modes:
 *   "asRecorded"  kwhByHour x scale.  A manual load with no kwhByHour gets a
 *                 nightly 01-05 block sized to annualKwh.
 *   "spread"      per Mon-Sun week, take the week's kWh (recorded x scale, or
 *                 annualKwh/52.18 pro-rated for a partial week), split it evenly
 *                 over `daysPerWeek` days chosen in the fixed priority
 *                 Mon,Tue,Wed,Thu,Fri,Sat,Sun; on each of those days put
 *                 `daylightFraction` into `window` (weighted by solarShape when
 *                 `followSolar`, flat otherwise) and the rest flat into
 *                 `overnightWindow`; cap every hour at `maxKW` and spill the
 *                 overflow to the nearest hours of the SAME day.
 *   kind "pool"   flat `maxKW` for `hoursPerDay` hours from `window[0]` every day,
 *                 sized so the annual total matches `annualKwh x scale`.
 *
 * Energy is conserved exactly: if a day physically cannot hold the load even at
 * 24 x maxKW, the remainder is dumped into the day's first slot rather than lost
 * (and that is the only way an hour can exceed maxKW).
 */
function reshape(flex, calIn, solarShape) {
  // engine.js's prepare() names the per-slot clock hour `hour`; accept either.
  const cal = calIn.hourA ? calIn : { ...calIn, hourA: calIn.hour };
  const N = cal.N;
  const out = new Float64Array(N);
  const sch = { ...DEFAULT_SCHEDULE, ...(flex.schedule || {}) };
  const scale = flex.scale == null ? 1 : flex.scale;
  const rec = flex.kwhByHour && flex.kwhByHour.length === N ? flex.kwhByHour : null;
  const cap = sch.maxKW > 0 ? sch.maxKW : Infinity;
  const bounds = dayBounds(cal);

  if (sch.mode === "asRecorded" && rec) {
    for (let i = 0; i < N; i++) out[i] = rec[i] * scale;
    return out;
  }
  if (flex.kind === "pool") return poolBlock(out, flex, cal, sch, scale, bounds);
  if (sch.mode !== "spread") return nightlyBlock(out, flex, cal, sch, scale, bounds, cap);

  // ---- spread -------------------------------------------------------------
  const frac = clamp01(sch.daylightFraction);
  const perWeek = Math.max(1, Math.min(7, Math.round(sch.daysPerWeek)));
  const [wLo, wHi] = normWindow(sch.window, [8, 15]);
  const [nLo, nHi] = normWindow(sch.overnightWindow, [1, 5]);
  const weight = solarWeighter(cal, solarShape, sch.followSolar);

  const shift = (cal.dayDow[0] + 6) % 7;          // align weeks to Monday
  const weeks = [];
  for (let d = 0; d < cal.nDays; d++) {
    const w = Math.floor((d + shift) / 7);
    (weeks[w] || (weeks[w] = [])).push(d);
  }

  for (const days of weeks) {
    if (!days) continue;
    let total;
    if (rec) {
      total = 0;
      for (const d of days) {
        const s0 = bounds.starts[d], s1 = s0 + bounds.lens[d];
        for (let k = s0; k < s1; k++) total += rec[k];
      }
      total *= scale;
    } else {
      total = (flex.annualKwh || 0) * scale / WEEKS_PER_YEAR * (days.length / 7);
    }
    if (!(total > EPS)) continue;                  // a week with no load stays empty

    const ordered = days.slice().sort((a, b) =>
      DOW_PRIORITY.indexOf(cal.dayDow[a]) - DOW_PRIORITY.indexOf(cal.dayDow[b]));
    const chargeDays = ordered.slice(0, Math.min(perWeek, ordered.length));
    const perDay = total / chargeDays.length;

    for (const day of chargeDays) {
      let left = place(out, cal, bounds, day, wLo, wHi, perDay * frac, cap, weight);
      left += place(out, cal, bounds, day, nLo, nHi, perDay * (1 - frac), cap, null);
      if (left > EPS) left = placeNearest(out, cal, bounds, day, wLo, wHi, left, cap);
      if (left > EPS) dump(out, bounds, day, left);
    }
  }
  return out;
}

function normWindow(w, dflt) {
  if (!Array.isArray(w) || w.length < 2) return dflt;
  let lo = Math.max(0, Math.min(24, Math.round(w[0])));
  let hi = Math.max(0, Math.min(24, Math.round(w[1])));
  if (!(hi > lo)) return dflt;
  return [lo, hi];
}

/** A function slot -> weight, or null for "flat". */
function solarWeighter(cal, shape, followSolar) {
  if (!followSolar || !shape || !shape.length) return null;
  const n = shape.length;
  if (n === cal.N) return (k) => Math.max(1e-3, shape[k]);
  if (n === 24) return (k) => Math.max(1e-3, shape[cal.hourA[k]]);
  if (n >= 8760) {
    if (cal.solarIdx) return (k) => Math.max(1e-3, shape[cal.solarIdx[k]]);
    const idx = buildCalendar({ ts: cal.ts }).solarIdx;
    return (k) => Math.max(1e-3, shape[idx[k]]);
  }
  return null;
}

/** Distribute `amount` over `idxs` weighted by `w`, never exceeding `capKWh`. */
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

function place(out, cal, bounds, day, lo, hi, amount, cap, weight) {
  if (!(amount > EPS)) return 0;
  const s0 = bounds.starts[day], s1 = s0 + bounds.lens[day];
  const idxs = [], w = [];
  for (let k = s0; k < s1; k++) {
    const h = cal.hourA[k];
    if (h >= lo && h < hi) { idxs.push(k); w.push(weight ? weight(k) : 1); }
  }
  return idxs.length ? spread(out, idxs, w, amount, cap) : amount;
}

/** Spill into whatever hours of the day still have headroom, closest to the window first. */
function placeNearest(out, cal, bounds, day, lo, hi, amount, cap) {
  const s0 = bounds.starts[day], s1 = s0 + bounds.lens[day];
  const idxs = [], w = [], mid = (lo + hi) / 2;
  for (let k = s0; k < s1; k++) { idxs.push(k); w.push(1 / (1 + Math.abs(cal.hourA[k] - mid))); }
  return idxs.length ? spread(out, idxs, w, amount, cap) : amount;
}

/** Last resort so energy is never lost: put the remainder in the day's first slot. */
function dump(out, bounds, day, amount) {
  const s0 = bounds.starts[day];
  if (s0 >= 0 && bounds.lens[day] > 0) out[s0] += amount;
}

/** Manual load, "asRecorded": a nightly block inside the overnight window. */
function nightlyBlock(out, flex, cal, sch, scale, bounds, cap) {
  const [nLo, nHi] = normWindow(sch.overnightWindow, [1, 5]);
  const perDay = (flex.annualKwh || 0) * scale / DAYS_PER_YEAR;
  if (!(perDay > EPS)) return out;
  for (let d = 0; d < cal.nDays; d++) {
    let left = place(out, cal, bounds, d, nLo, nHi, perDay, cap, null);
    if (left > EPS) left = placeNearest(out, cal, bounds, d, nLo, nHi, left, cap);
    if (left > EPS) dump(out, bounds, d, left);
  }
  return out;
}

/** kind "pool": a flat block of `hoursPerDay` hours from window[0], every day. */
function poolBlock(out, flex, cal, sch, scale, bounds) {
  const hoursPerDay = Math.max(1, Math.min(24, Math.round(sch.hoursPerDay || 8)));
  const [startH] = normWindow(sch.window, [10, 18]);
  const maxKW = sch.maxKW > 0 ? sch.maxKW : Infinity;
  const perDay = (flex.annualKwh || 0) * scale / DAYS_PER_YEAR;
  if (!(perDay > EPS)) return out;
  const level = Math.min(maxKW, perDay / hoursPerDay);

  const byHour = new Int32Array(24);
  for (let d = 0; d < cal.nDays; d++) {
    const s0 = bounds.starts[d], s1 = s0 + bounds.lens[d];
    byHour.fill(-1);
    for (let k = s0; k < s1; k++) byHour[cal.hourA[k]] = k;
    let remaining = perDay;
    for (let q = 0; q < 24 && remaining > EPS; q++) {
      const k = byHour[(startH + q) % 24];
      if (k < 0) continue;                        // the missing spring-forward hour
      const take = Math.min(level, remaining, Math.max(0, maxKW - out[k]));
      if (take <= EPS) continue;
      out[k] += take; remaining -= take;
    }
    if (remaining > EPS) dump(out, bounds, d, remaining);
  }
  return out;
}

// ------------------------------------------------------------------- presets
/**
 * Manual FlexLoad templates the Loads tab offers as "add a load".  Each is a
 * complete FlexLoad with `source: "manual"` and `kwhByHour: null`, so
 * `reshape()` sizes it from `annualKwh` alone.  The caller assigns a unique id.
 *
 * The second-EV template deliberately carries EV1's schedule; the UI should copy
 * the detected EV's `annualKwh` and `maxKW` onto it when one was detected.
 */
function presets() {
  return [
    {
      id: "ev2", kind: "ev", name: "Second EV", source: "manual",
      kwhByHour: null, annualKwh: 3600, detection: null,
      schedule: { ...DEFAULT_SCHEDULE, mode: "spread", daysPerWeek: 5, window: [8, 15],
                  daylightFraction: 0.9, overnightWindow: [1, 5], maxKW: 8, followSolar: true },
      scale: 1.0,
      note: "Same schedule as the detected EV; set annualKwh and maxKW from EV 1 if you have one.",
    },
    {
      id: "pool", kind: "pool", name: "Pool pump", source: "manual",
      kwhByHour: null, annualKwh: round3(0.5 * 8 * DAYS_PER_YEAR), detection: null,
      schedule: { mode: "spread", daysPerWeek: 7, window: [10, 18], daylightFraction: 1.0,
                  overnightWindow: [1, 5], maxKW: 0.5, followSolar: false, hoursPerDay: 8 },
      scale: 1.0,
      note: "0.5 kW for 8 hours a day (1,461 kWh/yr).",
    },
    {
      id: "hpwh", kind: "custom", name: "Heat-pump water heater", source: "manual",
      kwhByHour: null, annualKwh: round3(4 * DAYS_PER_YEAR), detection: null,
      schedule: { mode: "spread", daysPerWeek: 7, window: [10, 14], daylightFraction: 1.0,
                  overnightWindow: [1, 5], maxKW: 2.0, followSolar: true, hoursPerDay: 4 },
      scale: 1.0,
      note: "4 kWh/day heated between 10:00 and 14:00 (1,461 kWh/yr).",
    },
    {
      id: "laundry", kind: "custom", name: "Laundry / dishwasher", source: "manual",
      kwhByHour: null, annualKwh: round3(3 * DAYS_PER_YEAR), detection: null,
      schedule: { mode: "spread", daysPerWeek: 7, window: [10, 16], daylightFraction: 0.8,
                  overnightWindow: [1, 5], maxKW: 2.5, followSolar: true, hoursPerDay: 3 },
      scale: 1.0,
      note: "3 kWh/day, mostly moved into the middle of the day (1,096 kWh/yr).",
    },
  ];
}

// ----------------------------------------------------------------- summarize
/** One or two sentences of UI text describing a FlexLoad. */
function summarize(flex) {
  if (!flex) return "";
  const scale = flex.scale == null ? 1 : flex.scale;
  const annual = (flex.annualKwh || 0) * scale;
  const sch = { ...DEFAULT_SCHEDULE, ...(flex.schedule || {}) };
  const kwh = (x) => Math.round(x).toLocaleString("en-US");
  const hr = (h) => `${pad2(((h % 24) + 24) % 24)}:00`;

  const parts = [];
  if (flex.source === "detected" && flex.detection) {
    const d = flex.detection;
    parts.push(
      `${flex.name}: ${kwh(annual)} kWh/yr detected in the meter data` +
      (flex.kind === "ev"
        ? ` - ${d.sessions.length} charging sessions (${d.sessionsPerWeek}/week, median ` +
          `${d.medianSessionKwh} kWh) on a ${d.chargerKW} kW charger`
        : ` - ${d.sessions.length} runs of about ${d.hoursPerDay || sch.hoursPerDay} h at ` +
          `${d.chargerKW} kW`) +
      `, confidence ${Math.round((d.confidence || 0) * 100)}%.`);
  } else {
    parts.push(`${flex.name}: ${kwh(annual)} kWh/yr (entered by hand).`);
  }

  if (flex.kind === "pool") {
    parts.push(`Runs flat at up to ${sch.maxKW} kW for ${sch.hoursPerDay} h from ` +
               `${hr(sch.window[0])} every day.`);
  } else if (sch.mode === "asRecorded") {
    parts.push(flex.kwhByHour
      ? "Left exactly where the meter recorded it."
      : `Placed overnight between ${hr(sch.overnightWindow[0])} and ${hr(sch.overnightWindow[1])}.`);
  } else {
    parts.push(
      `Spread over ${sch.daysPerWeek} day${sch.daysPerWeek === 1 ? "" : "s"} a week ` +
      `(${DOW_PRIORITY.slice(0, Math.min(7, Math.round(sch.daysPerWeek)))
          .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")}), ` +
      `${Math.round(sch.daylightFraction * 100)}% of it between ${hr(sch.window[0])} and ` +
      `${hr(sch.window[1])}${sch.followSolar ? " following the solar shape" : " flat"}, ` +
      `the rest between ${hr(sch.overnightWindow[0])} and ${hr(sch.overnightWindow[1])}, ` +
      `capped at ${sch.maxKW} kW.`);
  }
  if (scale !== 1) parts.push(`Scaled to ${Math.round(scale * 100)}% of the recorded amount.`);
  return parts.join(" ");
}

// ------------------------------------------------------------------- exports
var __default = {
  detectEV, detectPool, reshape, presets, summarize,
  buildCalendar, DEFAULT_SCHEDULE, EV_TUNING,
};

const _internal = { buildBaseline, inferChargerKW, detectRuns, sessionsFrom, percentile, medianOf, spread, dayBounds };

return __default;
})();
var FlexLoad = __ns_FlexLoad;

/* ===== core/engine.js ===================================================== */
var __ns_SolarEngine = (function () {
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
 *    (delivery + that provider's generation).  An unknown provider id falls back to
 *    the SAME utility's default provider (result.tariffTerms.providerFallback = true),
 *    then to delivery + `<utilityId>_generation`; anything else throws.
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

const FlexLoad = __ns_FlexLoad;

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
function setFlexReshape(fn) { _flexReshape = typeof fn === "function" ? fn : null; }
/** Which reshape implementation is live: "flexload" once core/flexload.js is wired in. */
function flexReshapeSource() { return _flexReshape ? "flexload" : "engine-fallback"; }

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
const MIN_USABLE_DAYS = 300;

function prepare(data, opts) {
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

  const years = new Set();
  for (let i = 0; i < N; i++) years.add(+ts[i].slice(0, 4));
  const hol = holidaySet(Array.from(years));

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
      cachedDayType = (dow === 0 || dow === 6 || hol.has(y + "-" + mo + "-" + dd)) ? 1 : 0;
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
function profileFor(solarProfiles, weatherKey) {
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
function reshapeFlex(flex, cal, solarShape) {
  if (_flexReshape) {
    const out = _flexReshape(flex, cal, solarShape);
    if (out && out.length === cal.N) return out;
  }
  return fallbackReshape(flex, cal, solarShape);
}

// ---------------------------------------------------------------- rates
function planById(tariffs, id) {
  return resolvePlan(tariffs, id).plan;
}
/**
 * Which plan prices this run.  An empty id asks for the utility's default plan
 * (`plans[].default === true`, else the first; mirrors core/tariff.js defaultPlan()).
 * An id the tariff does not list falls back to that same default and says so.
 */
function resolvePlan(t, id) {
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
function resolveProvider(t, providerId) {
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
function tariffAccPlus(t) {
  const n = (t && t.nbt) || {};
  if (typeof n.acc_plus_adder_per_kwh === "number" && isFinite(n.acc_plus_adder_per_kwh)) return n.acc_plus_adder_per_kwh;
  throw new Error("tariff " + ((t && t.utility && t.utility.id) || "?") + " has no nbt.acc_plus_adder_per_kwh");
}

/** Average Retail Export Compensation Rate (SCE: "EEC Adjustment"), $/kWh, from the file. */
function tariffArecr(t) {
  const n = (t && t.nbt) || {};
  if (typeof n.eec_adjustment_per_kwh === "number" && isFinite(n.eec_adjustment_per_kwh)) return n.eec_adjustment_per_kwh;
  throw new Error("tariff " + ((t && t.utility && t.utility.id) || "?") + " has no nbt.eec_adjustment_per_kwh");
}

/**
 * Baseline allocation (kWh/day, { summer, winter }) for a region of utility.baselineRegions,
 * falling back to the file's default region (meta.baseline_region) and then to
 * meta.baseline_kwh_per_day.  Mirrors core/tariff.js baselineAllocation().
 */
function resolveBaseline(t, region) {
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
const DEFAULT_TRUE_UP_MONTH = 10;
const isMonth = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12;
function resolveTrueUpMonth(t, override) {
  if (isMonth(override)) return override;
  const f = t && t.nbt && t.nbt.true_up_month;
  return isMonth(f) ? f : DEFAULT_TRUE_UP_MONTH;
}

/**
 * Per-hour import/export prices + period codes for one (plan, provider).
 *
 * accPlus     undefined / null = the tariff file's nbt.acc_plus_adder_per_kwh;
 *             a number is an explicit override.
 * opts        { baselineRegion, trueUpMonth, municipalSurchargeFactor } - all optional,
 *             see DEFAULTS.
 */
function buildRates(ctx, planId, providerIdIn, applyNbc, climate, accPlus, capExport, opts) {
  const t = ctx.tariffs, planRes = resolvePlan(t, planId), plan = planRes.plan;
  const o = opts || {};
  const prov = resolveProvider(t, providerIdIn);
  const providerId = prov.id;
  const N = ctx.N;
  const imp = new Float64Array(N), exp = new Float64Array(N);
  const per = new Uint8Array(N), summer = new Uint8Array(N);
  const nbc = applyNbc ? (t.nbt.nonbypassable_charges_per_kwh || 0) : 0;
  const accPlusUsed = (accPlus === undefined || accPlus === null) ? tariffAccPlus(t) : +accPlus;
  const arecr = tariffArecr(t);
  const baseline = resolveBaseline(t, o.baselineRegion);
  const baselinePct = (typeof plan.baseline_credit_pct === "number" && plan.baseline_credit_pct > 0)
    ? plan.baseline_credit_pct : 1;
  // CCA export adder: one key in all three utility files, applied to any non-bundled
  // provider (provider id differs from utility.id).
  const uidForAdder = t.utility && t.utility.id;
  const adder = (uidForAdder && providerId !== uidForAdder) ? (t.nbt.cca_export_adder_per_kwh || 0) : 0;
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
      c = cache[key] = { p: PERIOD_INDEX[pid] === undefined ? 2 : PERIOD_INDEX[pid],
                         r: full + nbc + gen * munFactor + cpaSurcharge };
    }
    per[i] = c.p; imp[i] = c.r; summer[i] = su;
    exp[i] = t.nbt.export_rates[dt ? "weekend" : "weekday"][mo - 1][h] + adder;
  }
  return { plan, planRequested: planRes.requested, planFallback: planRes.fallback,
           imp, exp, period: per, summer,
           providerId, providerRequested: prov.requested, providerFallback: prov.fallback,
           accPlus: accPlusUsed, arecr,
           capExport, munFactor, cpaSurcharge,
           baselineCredit: plan.baseline_credit_per_kwh || 0,
           baselineAllow: { summer: baseline.summer, winter: baseline.winter },
           baselineSummerMonths: baseline.summerMonths || plan.summer_months,
           baselineRegion: baseline.region, baselineRegionFallback: baseline.fallback,
           baselineCreditPct: baselinePct,
           fixed: plan.fixed_charge_per_day, min: plan.minimum_charge_per_day,
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
           trueUpMonth: r.trueUpMonth };
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
function buildScenario(ctx, params, opts) {
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
                        municipalSurchargeFactor: p.municipalSurchargeFactor }),
    weatherKey: p.weatherKey,
    _pv: null,
  };
}

/**
 * The CA Climate Credit is a flat per-billing-period credit.  Taken from the tariff
 * file (meta.climate_credit); a tariff that does not publish one gets none.
 */
function climateCredit(ctx, p) {
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
function pvFor(scn, alloc) {
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
function settlementPoints(ctx, tum) {
  const M = ctx.nMonths, pts = [];
  for (let m = 0; m < M; m++) if (ctx.monthNum[m] === tum) pts.push(m);
  if (!pts.length) return [M - 1];
  if (pts.length > 1 && M - 12 * (pts.length - 1) < 12) pts.shift();
  return pts;
}

/**
 * Turn monthly energy totals into a bill, NBT-style:
 *   subtotal = fixed + energy - baseline credit, floored at the minimum charge;
 *   export credits then offset the subtotal down to (not below) that floor;
 *   the unused balance rolls forward and is cashed out at NSC at true-up.
 * The credit bank runs round the record as a cycle (settlementPoints above): the bank
 * left at the end of the record is CARRIED into the record's first month, never
 * forfeited, and reported as `trailing`.
 */
function settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred) {
  const M = ctx.nMonths;
  const blSummer = r.baselineSummerMonths || r.plan.summer_months;
  const blPct = r.baselineCreditPct || 1;

  // ---- 1. everything that does not depend on the credit bank, month by month
  const subtotalA = new Float64Array(M), floorA = new Float64Array(M);
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
    const credit = r.baselineCredit * Math.min(mImpKwh[m], allow);
    const energy = mImpCost[m];
    const floor = Math.max(r.min * days, fixed);
    let subtotal = fixed + energy - credit;
    let minApplied = 0;
    if (subtotal < floor) { minApplied = floor - subtotal; subtotal = floor; }
    // The CA Climate Credit is a flat bill credit, not an energy charge: it lands after
    // the export offset and CAN push the bill below the fixed charge.
    let climate = 0;
    if (r.climate && r.climate.amount && r.climate.months.indexOf(ctx.monthNum[m]) >= 0) {
      climate = r.climate.amount * share;
    }
    subtotalA[m] = subtotal; floorA[m] = floor; expKwhA[m] = expKwh; expCredA[m] = expCred;
    // The ACC Plus adder is the one export credit that MAY offset fixed and
    // non-bypassable charges, so it is settled outside the credit bank.
    accPlusA[m] = (r.accPlus || 0) * expKwh;
    climateA[m] = climate;
    if (pre) pre[m] = { days, calDays, fixed, energy, credit, minApplied, forfeitKwh, forfeit$ };
  }

  // ---- 2. the credit bank, round the cycle, starting empty in the month after the
  // record's last settlement point.
  const points = settlementPoints(ctx, r.trueUpMonth);
  const isPoint = new Uint8Array(M);
  for (const k of points) isPoint[k] = 1;
  const start = (points[points.length - 1] + 1) % M;
  const usedA = new Float64Array(M), trueUpA = new Float64Array(M);
  const forfeitSettleA = new Float64Array(M), balA = new Float64Array(M);
  let bal$ = 0, balKwh = 0, endBank$ = 0, endBankKwh = 0;
  for (let j = 0; j < M; j++) {
    const m = (start + j) % M;
    bal$ += expCredA[m]; balKwh += expKwhA[m];
    const used = Math.min(bal$, Math.max(0, subtotalA[m] - floorA[m]));
    if (bal$ > EPS) { balKwh *= (1 - used / bal$); }
    bal$ -= used;
    let trueUp = 0, forfeitCredit = 0;
    if (isPoint[m]) {
      // Schedule NBT SC 4.e.i, in order: the credit bank is first reduced by the
      // "Average Retail Export Compensation Rate" applied to net surplus kWh, THEN the
      // net surplus kWh are paid at Net Surplus Compensation.  The ARECR is about three
      // times the NSC rate, so a bank built out of cheap midday exports is wiped out
      // entirely and the customer keeps only the NSC payment - which is exactly the
      // penalty for an array sized to annual kWh offset rather than to self-consumption.
      const reduction = Math.min(bal$, r.arecr * balKwh);
      trueUp = balKwh * r.nsc;
      forfeitCredit = Math.max(0, reduction - trueUp);
      bal$ -= reduction;               // any residual rolls into the new relevant period
      balKwh = 0;
    }
    if (m === M - 1) { endBank$ = bal$; endBankKwh = balKwh; }
    usedA[m] = used; trueUpA[m] = trueUp; forfeitSettleA[m] = forfeitCredit; balA[m] = bal$;
  }

  // ---- 3. totals and rows, in record order
  let total = 0, forfeitedTotal = forfeitedCap, exportValue = 0;
  const rows = detail ? [] : null;
  for (let m = 0; m < M; m++) {
    const bill = subtotalA[m] - usedA[m] - climateA[m] - accPlusA[m] - trueUpA[m];
    total += bill;
    exportValue += usedA[m] + accPlusA[m] + trueUpA[m];   // dollars sourced from exported kWh
    forfeitedTotal += forfeitSettleA[m];
    if (rows) {
      const q = pre[m];
      rows.push({ key: ctx.monthKey[m], days: q.days, calendarDays: q.calDays, fixed: q.fixed,
                  energy: q.energy, baselineCredit: -q.credit, minimumAdj: q.minApplied,
                  exportCreditUsed: -usedA[m], accPlus: -accPlusA[m],
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
           exportValue, settledMonths: points.map((k) => ctx.monthKey[k]), periods, trailing };
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
function runHours(scn, params, detail) {
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
  const valid = ctx.gapHours ? ctx.valid : null;
  for (let i = 0; i < N; i++) {
    if (valid && !valid[i]) continue;
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

  const years = ctx.years;
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
    exportRevenue: billing.exportValue / years,
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
const DEFAULTS = {
  planes: [],                 // [{ id, profile: Float64Array(8760), panels, shading }]
  panelsByPlane: null,        // optional override of planes[].panels
  panelW: 460, batteries: 1, battKWh: 10, battKW: 5,
  rte: 0.90, minReserve: 0.20,
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
  strategy: "tou_arbitrage", gridCharge: false, exportThreshold: 0.5,
  exportLimitKW: 0,
};
function withDefaults(p) {
  const o = { __defaulted: true };
  for (const k in DEFAULTS) o[k] = (p && p[k] !== undefined) ? p[k] : DEFAULTS[k];
  return o;
}

/**
 * Replay one real billing period out of the load history and price it, so the model
 * can be checked line-by-line against a paper bill.  Dates are inclusive, "YYYY-MM-DD".
 * Always uses the RECORDED load: no flexible-load rescheduling, no additions.
 */
function billPeriod(ctx, params, startDate, endDate) {
  const p = withDefaults(params);
  const scn = buildScenario(ctx, Object.assign({}, p, { flex: [], planes: [], baseLoadScale: 1 }));
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

/** One scenario run with no panels and no battery: the no-system arm of a baseline. */
function noSystem(scn, p, detail) {
  const zero = Object.assign({}, p, { batteries: 0, panelsByPlane: scn.planes.map(() => 0) });
  return runHours(scn, zero, detail);
}

/**
 * The four savings numbers every result carries, given the two no-system bills.
 * A no-system baseline exports nothing, so the whole of exportRevenue is the system's;
 * the remainder of the saving is avoided retail import cost.  Shared with the
 * optimizer's sweep so the split is defined in exactly one place.
 */
function attachSavings(res, sameFlexBill, asRecordedBill) {
  res.savingsVsSameFlex = sameFlexBill - res.bill;
  res.savingsVsAsRecorded = asRecordedBill - res.bill;
  res.importSavingsVsSameFlex = res.savingsVsSameFlex - res.exportRevenue;
  res.importSavingsVsAsRecorded = res.savingsVsAsRecorded - res.exportRevenue;
  return res;
}

/** The two no-system arms every result is measured against. */
function baselines(ctx, p, detail) {
  const scnSame = buildScenario(ctx, p);
  const scnRec = buildScenario(ctx, p, { flexMode: "asRecorded" });
  return {
    scnSame, scnRec,
    sameFlex: noSystem(scnSame, p, detail),
    asRecorded: noSystem(scnRec, p, detail),
  };
}

/** Full run for one configuration, including the two no-system baselines. */
function simulate(ctx, params, opts) {
  const p = withDefaults(params), detail = !!(opts && opts.detail);
  const b = baselines(ctx, p, detail);
  const res = runHours(b.scnSame, p, detail);

  res.baselineSameFlex = b.sameFlex;
  res.baselineAsRecorded = b.asRecorded;
  attachSavings(res, b.sameFlex.bill, b.asRecorded.bill);
  res.flexShiftOnlySavings = b.asRecorded.bill - b.sameFlex.bill;
  res.years = ctx.years;
  res.usableDays = ctx.usableDays;
  res.flexNanHours = b.scnSame.flexNanHours || 0;
  return res;
}

/** Same configuration priced on every plan, so the UI can show the best one. */
function billOnAllPlans(ctx, params) {
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
function billOnAllProviders(ctx, params) {
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

const _internal = { holidaySet, isDST, spread, fallbackReshape, dayBounds,
                           shadingFactors, PERIOD_IDS, EXP_BANDS, bandOf, DOW_PRIORITY };

const SolarEngine = {
  prepare, buildScenario, runHours, simulate, billPeriod, billOnAllPlans, billOnAllProviders,
  baselines, attachSavings, buildRates, settle, settlementPoints, planById, resolvePlan,
  resolveTrueUpMonth, profileFor, pvFor, climateCredit,
  resolveProvider, resolveBaseline, tariffAccPlus, tariffArecr,
  MIN_USABLE_DAYS, DEFAULT_TRUE_UP_MONTH,
  reshapeFlex, setFlexReshape, flexReshapeSource,
  withDefaults, DEFAULTS, _internal,
};
var __default = SolarEngine;

return __default;
})();
var SolarEngine = __ns_SolarEngine;

/* ===== core/finance.js ==================================================== */
var __ns_SolarFinance = (function () {
/* =============================================================================
 * core/finance.js - turns one year of simulated bill savings into 25 years of money.
 *
 * Deliberately separate from engine.js: the hourly physics does not depend on any
 * price, so every cost/finance control can be re-priced against cached simulation
 * results without touching the 17,700-hour loop.  That is what makes the cost and
 * finance sliders feel instant while the system sliders take a worker round-trip.
 *
 * The central approximation (shown to the user in the method panel):
 *     savings_y = importSavings_1 x escalation^(y-1)      x degradationBlend(y)
 *               + exportRevenue_1 x exportEscalation^(y-1) x degradationBlend(y)
 * The two halves escalate differently on purpose.  Avoided import cost rides retail
 * rates; export credits are locked to the ACC vintage for nine years and are not
 * tied to retail rates at all, so escalating them alongside the bill would inflate the
 * value of every exported kWh and push the optimiser toward an oversized array.
 * The dispatch is simulated once at year-1 condition and the result is scaled,
 * rather than re-simulating a slightly smaller array and pack every year.  The error
 * is second-order (the bill mix shifts a little as production falls) and it buys a
 * ~2,000x speedup, which is what lets the optimizer sweep 400+ configurations.
 *
 * Three ways to pay for it (financing.mode):
 *   cash   the whole net cost at year 0.
 *   loan   a down payment at year 0 plus level monthly payments (summed to annual
 *          rows) on a principal of netCost x share x (1 + dealer fee).
 *   lease  no upfront at all, escalating annual payments and an optional buyout;
 *          a third party owns the system, so no homeowner incentive applies and
 *          O&M / inverter / battery replacement are not the customer's problem.
 * Savings accrue in all three.
 * ========================================================================== */

const DEFAULTS = {
  costPerW: 3.00,            // $/W DC, installed, before incentives
  costPerKwh: 1000,          // $/kWh usable storage, installed
  adder: 0,                  // fixed install adder (panel upgrade, trenching, ...)
  taxCreditPct: 0,           // homeowner-claimed 25D - terminated for 2026 installs
  // How a third-party credit reaches the customer.  "none" | "discount" | "vendor".
  incentiveMode: "vendor",
  discountPct: 0,            // mode "discount": straight % off system price
  vendorCreditPct: 0.40,     // mode "vendor": the credit the vendor claims - context only
  passThroughPct: 0.34,      // mode "vendor": points off the system price they pass on
  sgipPerKwh: 0,             // SGIP storage rebate, $/kWh usable (closed as of 2026)
  rebates: 0,                // any other one-off rebate $ (CPA Sun Storage, ...)
  horizon: 25,               // analysis years
  escalation: 0.045,         // retail rate escalation, nominal $/yr
  exportEscalation: 0.0,     // export credits are locked to a fixed ACC vintage
  investReturn: 0.07,        // nominal return on the same cash in the market
  discountRate: 0.025,       // inflation / real-terms discount
  panelDeg: 0.005,           // /yr production loss
  battDeg: 0.02,             // /yr usable capacity loss
  battReplYear: 20,
  battReplFraction: 0.5,     // of today's $/kWh
  omPerYear: 150,            // O&M + insurance, escalates with inflation
  inverterYear: 12,
  inverterPerW: 0.15,
  resaleValue: 0,            // home value credited at the horizon
  // Bills, savings and loan payments arrive through the year, not on 31 December,
  // so every year's flows are dated mid-year (the upfront price is day one).  Booking
  // them at year end would credit a borrower with a year of market return on money
  // already paid out and make a dear short loan look cheaper than cash.
  midYear: true,
  financing: {
    mode: "cash",                                                    // "cash"|"loan"|"lease"
    loan: { sharePct: 1.0, apr: 0.0699, termYears: 15, dealerFeePct: 0.0 },
    lease: { monthly: 180, escalatorPct: 0.029, termYears: 25, buyout: 0 },
  },
};

const FIN_MODES = ["cash", "loan", "lease"];

function num(v, d) { const x = +v; return (v === undefined || v === null || isNaN(x)) ? d : x; }

function withDefaults(f) {
  const o = {};
  for (const k in DEFAULTS) {
    if (k === "financing") continue;
    const d = DEFAULTS[k], v = f ? f[k] : undefined;
    if (v === undefined || v === null) o[k] = d;
    else if (typeof d === "string" || typeof d === "boolean") o[k] = v;
    else o[k] = isNaN(v) ? d : +v;
  }
  const g = (f && f.financing) || {};
  const D = DEFAULTS.financing;
  o.financing = {
    mode: FIN_MODES.indexOf(g.mode) >= 0 ? g.mode : D.mode,
    loan: {
      sharePct: Math.max(0, Math.min(1, num(g.loan && g.loan.sharePct, D.loan.sharePct))),
      apr: Math.max(0, num(g.loan && g.loan.apr, D.loan.apr)),
      termYears: Math.max(1, Math.round(num(g.loan && g.loan.termYears, D.loan.termYears))),
      dealerFeePct: Math.max(0, num(g.loan && g.loan.dealerFeePct, D.loan.dealerFeePct)),
    },
    lease: {
      monthly: Math.max(0, num(g.lease && g.lease.monthly, D.lease.monthly)),
      escalatorPct: num(g.lease && g.lease.escalatorPct, D.lease.escalatorPct),
      termYears: Math.max(1, Math.round(num(g.lease && g.lease.termYears, D.lease.termYears))),
      buyout: Math.max(0, num(g.lease && g.lease.buyout, D.lease.buyout)),
    },
  };
  return o;
}

/**
 * The share of the sticker price the customer never pays.
 *   "none"     nothing
 *   "discount" a straight negotiated discount
 *   "vendor"   the lease-to-own pitch: the vendor claims a Section 48E credit it can
 *              only claim because it owns the system, and passes part of it on as
 *              points off the price.  passThroughPct is those points - 34 means the
 *              customer pays 66% of the sticker price.  vendorCreditPct is carried
 *              only as context for the helper line; it does not enter the arithmetic,
 *              because what reaches the customer is a price, not a credit.
 * Under a lease the customer buys nothing, so no ownership incentive applies at all.
 */
function effectiveDiscount(f) {
  if (f.financing && f.financing.mode === "lease") return 0;
  if (f.incentiveMode === "discount") return Math.max(0, Math.min(0.95, f.discountPct));
  if (f.incentiveMode === "vendor") return Math.max(0, Math.min(0.95, f.passThroughPct));
  return 0;
}

/**
 * When each year's cash flow is dated, in years from install: [0, 0.5, 1.5, ...]
 * under the mid-year convention, [0, 1, 2, ...] at year end.
 */
function flowTimes(H, midYear = true) {
  const t = [0];
  for (let y = 1; y <= H; y++) t.push(midYear ? y - 0.5 : y);
  return t;
}

/** Present value of `cf` at `rate`; `times` dates each entry (default: year end). */
function npvOf(cf, rate, times) {
  let v = 0;
  for (let y = 0; y < cf.length; y++) v += cf[y] / Math.pow(1 + rate, times ? times[y] : y);
  return v;
}

/** Bisection IRR on a cash-flow array starting at year 0. Null if it never crosses. */
function irrOf(cf, times) {
  let lo = -0.9, hi = 3.0;
  let flo = npvOf(cf, lo, times), fhi = npvOf(cf, hi, times);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npvOf(cf, mid, times);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** First year the running total turns positive, linearly interpolated. */
function crossing(series) {
  for (let y = 1; y < series.length; y++) {
    if (series[y] >= 0) {
      const prev = series[y - 1];
      return (y - 1) + (prev < 0 ? (-prev) / (series[y] - prev) : 0);
    }
  }
  return null;
}

/** Level monthly payment on `principal` at nominal `apr` over `months`. */
function loanPayment(principal, apr, months) {
  if (months <= 0) return 0;
  const i = apr / 12;
  if (Math.abs(i) < 1e-12) return principal / months;
  return principal * i / (1 - Math.pow(1 + i, -months));
}

/**
 * Monthly amortization summed into annual rows.  Returns the level monthly `payment`,
 * one `rows` entry per year { year, payment, interest, principal, balance }, plus
 * `totalInterest`, `termYears` and the `principal` borrowed.
 * The final month absorbs rounding so the balance lands exactly on zero.
 */
function amortize(principal, apr, termYears) {
  const months = Math.max(1, Math.round(termYears * 12));
  const pay = loanPayment(principal, apr, months);
  const i = apr / 12;
  const rows = [];
  let bal = principal;
  for (let y = 1; y <= Math.ceil(months / 12); y++) {
    let yPay = 0, yInt = 0, yPrin = 0;
    for (let mo = 0; mo < 12; mo++) {
      const idx = (y - 1) * 12 + mo;
      if (idx >= months) break;
      const interest = bal * i;
      let principalPart = pay - interest;
      let payment = pay;
      if (idx === months - 1 || principalPart > bal) {      // last payment clears the note
        principalPart = bal;
        payment = principalPart + interest;
      }
      bal -= principalPart;
      yPay += payment; yInt += interest; yPrin += principalPart;
    }
    rows.push({ year: y, payment: yPay, interest: yInt, principal: yPrin,
                balance: Math.abs(bal) < 1e-9 ? 0 : bal });
  }
  let totalInterest = 0;
  for (const r of rows) totalInterest += r.interest;
  return { payment: pay, rows, totalInterest, termYears: months / 12, principal };
}

/**
 * @param sim  { savings, importSavings, exportRevenue, bill, baselineBill,
 *               pvKwh, kwdc, battKWhTotal }
 *             `savings` is year-1 bill savings in dollars; `bill` the with-system
 *             annual bill; `baselineBill` today's annual bill.
 * @param f    finance inputs (see DEFAULTS)
 */
function evaluate(sim, f) {
  f = withDefaults(f);
  const mode = f.financing.mode;
  const isLease = mode === "lease";
  // Backward compatible: a sim that carries only `savings` is treated as all-import.
  const exportRev = sim.exportRevenue || 0;
  const importSav = sim.importSavings !== undefined ? sim.importSavings : (sim.savings - exportRev);
  const watts = sim.kwdc * 1000;
  const solarCost = watts * f.costPerW;
  const storageCost = sim.battKWhTotal * f.costPerKwh;
  const gross = solarCost + storageCost + (watts > 0 || sim.battKWhTotal > 0 ? f.adder : 0);
  const disc = effectiveDiscount(f);
  const discounted = gross * (1 - disc);
  // A leased system is never bought, so no homeowner credit or rebate applies to it.
  const itc = isLease ? 0 : discounted * f.taxCreditPct;
  const sgip = isLease ? 0 : sim.battKWhTotal * f.sgipPerKwh;
  const rebates = isLease ? 0 : f.rebates;
  const netCost = isLease ? gross : Math.max(0, discounted - itc - sgip - rebates);

  const H = Math.max(1, Math.round(f.horizon));
  const times = flowTimes(H, f.midYear !== false);

  // ----------------------------------------------------------------- financing
  const pay = new Array(H + 1).fill(0);
  let upfront = 0, schedule = [], amort = null, principal = 0, dealerFee = 0;
  if (mode === "loan") {
    const L = f.financing.loan;
    dealerFee = netCost * L.sharePct * L.dealerFeePct;
    principal = netCost * L.sharePct * (1 + L.dealerFeePct);
    upfront = netCost * (1 - L.sharePct);
    amort = amortize(principal, L.apr, L.termYears);
    schedule = amort.rows;
    for (const r of schedule) if (r.year <= H) pay[r.year] = r.payment;
    // A term longer than the analysis horizon leaves a debt: pay it off at the horizon
    // so the comparison is like-for-like with cash.  A term that ends on or before the
    // horizon has already amortised to zero by then, so this adds nothing there.
    const atH = schedule.find((r) => r.year === H);
    if (atH) pay[H] += atH.balance;
  } else if (isLease) {
    const L = f.financing.lease;
    const term = Math.min(L.termYears, H);
    for (let y = 1; y <= term; y++) {
      pay[y] = L.monthly * 12 * Math.pow(1 + L.escalatorPct, y - 1);
      schedule.push({ year: y, payment: pay[y], interest: 0, principal: 0, balance: 0 });
    }
    if (L.buyout > 0 && L.termYears <= H) {
      pay[L.termYears] += L.buyout;
      const row = schedule[L.termYears - 1];
      if (row) row.payment = pay[L.termYears];
    }
  } else {
    upfront = netCost;
  }

  // How much of the saving is attributable to panels vs. pack, used to blend the
  // two degradation rates.  Cost share is a crude but stable proxy.  With no hardware
  // cost to divide - a price knob driven to zero, which is exactly what breakEven()
  // does - fall back to what is physically installed, so a zero-priced array still
  // degrades at the panel rate and never picks up the pack's replacement reset.
  const hardwareCost = solarCost + storageCost;
  let wS = 1;
  if (hardwareCost > 0) wS = solarCost / hardwareCost;
  else if (watts <= 0 && sim.battKWhTotal > 0) wS = 0;      // a pack and no panels
  const wB = 1 - wS;

  // netSav is what the system earns each year before any financing: savings less
  // O&M and replacements (plus the resale credit at the horizon).  cf is netSav
  // less the year's loan or lease payment.  The two are kept apart because the
  // "pays for itself" and project-IRR figures below are about the asset, while
  // NPV and wealth are about the household's actual money.
  const cf = [-upfront], netSav = [0], savings = [0], om = [0], extras = [0], prod = [0], payments = [pay[0] || 0];
  for (let y = 1; y <= H; y++) {
    const sFac = Math.pow(1 - f.panelDeg, y - 1);
    // capacity resets when the pack is replaced
    const bAge = (f.battReplYear > 0 && y > f.battReplYear) ? y - f.battReplYear : y;
    const bFac = Math.pow(1 - f.battDeg, bAge - 1);
    const esc = Math.pow(1 + f.escalation, y - 1);
    const escX = Math.pow(1 + f.exportEscalation, y - 1);
    const deg = wS * sFac + wB * bFac;
    const sav = importSav * esc * deg + exportRev * escX * deg;
    // Under a lease the third party owns and maintains the hardware.
    const o = isLease ? 0 : f.omPerYear * Math.pow(1 + f.discountRate, y - 1);
    let ex = 0;
    if (!isLease) {
      if (sim.battKWhTotal > 0 && y === Math.round(f.battReplYear)) ex += sim.battKWhTotal * f.costPerKwh * f.battReplFraction;
      if (watts > 0 && y === Math.round(f.inverterYear)) ex += watts * f.inverterPerW;
    }
    const resale = isLease ? 0 : f.resaleValue;
    const earned = sav - o - ex + (y === H ? resale : 0);
    const net = earned - pay[y];
    cf.push(net); netSav.push(earned); savings.push(sav); om.push(o); extras.push(ex); payments.push(pay[y]);
    prod.push(sim.pvKwh * sFac);
  }

  const cum = [], dcum = [];
  let run = 0, drun = 0;
  for (let y = 0; y <= H; y++) {
    run += cf[y]; cum.push(run);
    drun += cf[y] / Math.pow(1 + f.investReturn, times[y]); dcum.push(drun);
  }

  const npv = npvOf(cf, f.investReturn, times);
  // IRR is the return on an investment, so it needs one: the first money to move
  // must be an outlay.  A stream that starts positive (a loan whose payments sit
  // below the savings from year one) and only dips negative at a battery
  // replacement decades later still has a sign change, and bisection would
  // dutifully return a deeply negative "rate" that describes nothing.
  const firstMove = cf.find((v) => Math.abs(v) > 1e-9);
  const irr = firstMove !== undefined && firstMove < 0 ? irrOf(cf, times) : null;

  // The asset on its own, before financing.  "Pays for itself" is the year the
  // system's cumulative earnings (netSav) have covered everything it will ever
  // cost: the upfront share plus every loan or lease payment, interest and buyout
  // included.  For cash that is the classic simple payback exactly (total cost =
  // netCost, netSav = cf); for a loan it no longer reads "day one" merely because
  // the payment sits below the saving, and a dear loan takes longer, as it should.
  // The discounted twin discounts both sides at the investment return.
  // projectIrr is the return the system earns on its cash price, whoever pays it -
  // the number to hold against a loan's APR.  `irr` above stays the levered return
  // on the household's own cash flows, which is undefined with nothing down.
  let totalCost = upfront;
  for (let y = 1; y <= H; y++) totalCost += pay[y];
  const pb = [-totalCost], dpb = [-upfront];
  let dTotal = upfront;
  for (let y = 1; y <= H; y++) dTotal += pay[y] / Math.pow(1 + f.investReturn, times[y]);
  dpb[0] = -dTotal;
  for (let y = 1; y <= H; y++) {
    pb.push(pb[y - 1] + netSav[y]);
    dpb.push(dpb[y - 1] + netSav[y] / Math.pow(1 + f.investReturn, times[y]));
  }
  const payback = totalCost > 0 ? crossing(pb) : 0;
  const discountedPayback = dTotal > 0 ? crossing(dpb) : 0;
  const projectIrr = netCost > 0 ? irrOf([-netCost].concat(netSav.slice(1)), times) : null;

  // "Same cash in the market" comparison, stated as two end-of-horizon numbers.
  // Both arms start from the same cash: what buying this system outright costs
  // (`netCost`; the sticker price under a lease, where nothing is bought).  The
  // market arm leaves all of it invested.  The system arm spends `upfront` of it
  // - all the price for cash, the down payment for a loan, nothing for a lease -
  // keeps the rest invested, and reinvests every year's net cash flow (savings
  // less O&M, replacements and any loan or lease payment) at the same return from
  // the day it arrives.  Counting only the cash flows would forget the borrower's
  // still-invested principal and make a cheap loan look worse than paying cash.
  // The identity wealthSystem - wealthInvest = NPV x (1 + r)^H holds in every mode.
  // Because the pool is this system's own price, the two absolute numbers are not
  // comparable across systems of different price; their gap (NPV) is.
  const cashRef = netCost;
  const wealthInvest = cashRef * Math.pow(1 + f.investReturn, H);
  let wealthSystem = (cashRef - upfront) * Math.pow(1 + f.investReturn, H);
  for (let y = 1; y <= H; y++) wealthSystem += cf[y] * Math.pow(1 + f.investReturn, H - times[y]);

  // LCOE over PV generated (storage cost included - it is part of what you bought).
  let costPV = upfront, kwhPV = 0;
  for (let y = 1; y <= H; y++) {
    costPV += (om[y] + extras[y] + payments[y]) / Math.pow(1 + f.discountRate, times[y]);
    kwhPV += prod[y] / Math.pow(1 + f.discountRate, times[y]);
  }
  const lcoe = kwhPV > 0 ? costPV / kwhPV : null;

  // Lifetime cost of energy service = what you pay the utility plus what you paid
  // for the system (and for the money), in present value.  The no-system arm is the
  // same sum with savings = 0, which is how "min lifetime cost" stays comparable.
  let lifetime = upfront, lifetimeNoSystem = 0;
  for (let y = 1; y <= H; y++) {
    const escY = Math.pow(1 + f.escalation, y - 1), dis = Math.pow(1 + f.discountRate, times[y]);
    // The with-system bill in year y is today's bill escalated, less that year's
    // saving - which already carries the escalation split (import at retail,
    // export locked) and the degradation blend, so lifetime cost and NPV agree
    // on how much a slowly fading array is worth.
    const billY = sim.baselineBill * escY - savings[y];
    lifetime += (billY + om[y] + extras[y] + payments[y]) / dis;
    lifetimeNoSystem += (sim.baselineBill * escY) / dis;
  }

  // What the customer writes a cheque for each month: the loan's level payment, or a
  // lease's first-year payment spread over twelve (which is the quoted monthly unless
  // a buyout lands in year 1).  Cash buys nothing on instalment.
  let monthlyPayment = 0;
  if (mode === "loan") monthlyPayment = amort ? amort.payment : 0;
  else if (isLease) monthlyPayment = (pay[1] || 0) / 12;

  const firstYearPayment = pay[1] || 0;
  const firstYearMonthlyOutlay = firstYearPayment / 12 + (sim.bill || 0) / 12;
  const currentMonthlyBill = (sim.baselineBill || 0) / 12;

  return {
    inputs: f, gross, itc, sgip, rebates, netCost,
    solarCost, storageCost,
    effectiveDiscount: disc, discountValue: gross - discounted,
    effectiveCostPerW: f.costPerW * (1 - disc), effectiveCostPerKwh: f.costPerKwh * (1 - disc),
    cashflows: cf, savingsByYear: savings, omByYear: om, extrasByYear: extras,
    paymentsByYear: payments,
    cumulative: cum, discountedCumulative: dcum, flowTimes: times,
    npv, irr, projectIrr,
    payback, discountedPayback, totalCost,
    // When the household's own running cash turns positive (0 = from day one).
    cashFlowPayback: crossing(cum),
    loanPaidOffYear: amort ? Math.min(amort.termYears, H) : null,
    netSavingsByYear: netSav,
    lcoe, lifetimeCost: lifetime, lifetimeCostNoSystem: lifetimeNoSystem,
    wealthInvest, wealthSystem, wealthDelta: wealthSystem - wealthInvest, cashRef,
    firstYearSavings: savings[1] || 0,
    importSavings: importSav, exportRevenue: exportRev,
    horizon: H,
    // financing
    financingMode: mode, upfront, downPayment: isLease ? 0 : upfront,
    loanPrincipal: principal, dealerFee, monthlyPayment,
    totalInterest: amort ? amort.totalInterest : 0,
    financingSchedule: schedule,
    firstYearPayment, firstYearMonthlyOutlay, currentMonthlyBill,
    monthlyOutlayDelta: firstYearMonthlyOutlay - currentMonthlyBill,
  };
}

/**
 * Price at which NPV crosses zero, holding everything else fixed.
 *
 * NPV is very nearly linear in $/W and $/kWh - both scale the year-0 outlay and
 * nothing else - but not exactly: the degradation blend weights panels against pack
 * by their COST share, so moving one price also tilts the savings stream a little.
 * On a system carrying both, the straight two-point line misses by thousands of
 * dollars, so it is used only as the first guess and secant steps land on the root.
 * Returns null when there is no root to find: a price NPV does not respond to has no
 * break-even, and under a lease the sticker price is not what the customer pays.
 */
function breakEven(sim, f, key) {
  const npvAt = (price) => evaluate(sim, Object.assign({}, f, { [key]: price })).npv;
  const at0 = npvAt(0), at1 = npvAt(1);
  const slope = at1 - at0;
  if (Math.abs(slope) < 1e-9) return null;
  let x0 = 0, y0 = at0;
  let x1 = -at0 / slope, y1 = npvAt(x1);
  for (let i = 0; i < 40 && Math.abs(y1) > 1e-6; i++) {
    const step = y1 * (x1 - x0) / (y1 - y0);
    if (!isFinite(step) || step === 0) break;
    x0 = x1; y0 = y1;
    x1 -= step; y1 = npvAt(x1);
  }
  // Only report a price that really does zero the NPV.  `slope` is dollars of NPV per
  // dollar of price, so this asks that the answer be right to a millionth of a $/W -
  // and refuses the huge number the secant wanders to when NPV is all but flat.
  return Math.abs(y1) <= Math.abs(slope) * 1e-6 ? x1 : null;
}

const SolarFinance = { evaluate, breakEven, withDefaults, effectiveDiscount,
                       npvOf, irrOf, flowTimes, crossing, loanPayment, amortize, DEFAULTS };
var __default = SolarFinance;

return __default;
})();
var SolarFinance = __ns_SolarFinance;

/* ===== core/optimizer.js ================================================== */
var __ns_SolarOptimizer = (function () {
/* =============================================================================
 * core/optimizer.js - picks the configuration, and answers "how sure are we?"
 *
 * Split in two on purpose:
 *   searchGrid()  runs the expensive hourly physics (worker side, ~0.2 s)
 *   priceGrid()   re-prices already-simulated cells (main thread, ~15 ms)
 * so moving a cost or finance slider never re-runs a simulation.
 *
 * Panels are allocated across roof planes GREEDILY by marginal annual bill saving:
 * at each step one extra panel is simulated on every plane that still has room and
 * the best one is kept.  Value per added panel declines (the array outgrows
 * self-consumption), so the greedy path is monotone - the allocation for n panels is
 * always the allocation for n-1 plus one - which means the order can be computed once
 * per grid run and replayed for every battery count.
 * ========================================================================== */

const Engine = __ns_SolarEngine;
const Finance = __ns_SolarFinance;

/**
 * "Highest IRR" and "fastest payback" both rank among systems that actually make
 * money (NPV > 0).  IRR is the project IRR - the return the system earns on its
 * cash price, whoever pays it - so the objective means the same thing under cash,
 * a loan and a lease; the levered `irr` is undefined with nothing down and
 * inflated with a little down.  Without the NPV gate a lease would hand "highest
 * IRR" to the smallest array, whose fine project return the lessor keeps while the
 * lessee's payments outrun the savings.  Money-losers rank below every earner,
 * ordered by NPV so the least bad wins if nothing else does.
 */
function irrRank(c) {
  const v = c.projectIrr !== undefined ? c.projectIrr : c.irr;
  if (!(c.npv > 0) || typeof v !== "number") return -Infinity;
  return v;
}

/** Fewest years to pay for itself, among systems that make money; never = last. */
function paybackRank(c) {
  if (!(c.npv > 0) || typeof c.payback !== "number") return Infinity;
  return c.payback;
}

const OBJECTIVES = {
  npv: { label: "Maximum NPV", better: (a, b) => a.npv > b.npv },
  lifetime: { label: "Lowest lifetime cost", better: (a, b) => a.lifetimeCost < b.lifetimeCost },
  irr: {
    label: "Highest IRR",
    better: function (a, b) {
      const ra = irrRank(a), rb = irrRank(b);
      // Ties are the undefined ends of the scale (and, with no outlay, every cell
      // that pays for itself from year one sits there): money decides.
      return ra === rb ? a.npv > b.npv : ra > rb;
    },
  },
  payback: {
    label: "Fastest payback",
    better: function (a, b) {
      const ra = paybackRank(a), rb = paybackRank(b);
      return ra === rb ? a.npv > b.npv : ra < rb;
    },
  },
};

/** Per-plane panel caps: explicit opts.planeCaps (array or {id: cap}), else plane.maxPanels. */
function resolveCaps(planes, planeCaps) {
  return planes.map(function (pl, k) {
    let cap;
    if (Array.isArray(planeCaps)) cap = planeCaps[k];
    else if (planeCaps && typeof planeCaps === "object") cap = planeCaps[pl.id];
    if (cap === undefined || cap === null) cap = pl.maxPanels;
    if (cap === undefined || cap === null) cap = Infinity;
    return Math.max(0, cap);
  });
}

/** alloc after `n` greedy steps. */
function allocAt(order, nPlanes, n) {
  const a = new Array(nPlanes).fill(0);
  for (let i = 0; i < n && i < order.length; i++) a[order[i]]++;
  return a;
}

/**
 * The greedy fill order: order[i] is the plane that gets the (i+1)-th panel.
 * `cells` is filled with the winning simulation of each step, so the sweep never
 * re-simulates the battery count the ordering was computed at.
 */
function allocationOrder(scn, p, maxPanelsTotal, caps, batteries, cells) {
  const nP = scn.planes.length;
  const alloc = new Array(nP).fill(0);
  const order = [];
  for (let n = 1; n <= maxPanelsTotal; n++) {
    let bestVal = -Infinity, bestK = -1, bestRes = null;
    for (let k = 0; k < nP; k++) {
      if (alloc[k] + 1 > caps[k]) continue;
      alloc[k]++;
      const res = Engine.runHours(scn, Object.assign({}, p, { panelsByPlane: alloc.slice(), batteries }), false);
      alloc[k]--;
      if (-res.bill > bestVal) { bestVal = -res.bill; bestK = k; bestRes = res; }
    }
    if (bestK < 0) break;                       // every plane is full
    alloc[bestK]++;
    order.push(bestK);
    if (cells) cells.set(n, bestRes);
  }
  return order;
}

/** Hard caps on the search grid, whatever the caller asks for. */
const MAX_SEARCH_PANELS = 200;
const MAX_SEARCH_BATTERIES = 20;

/**
 * Sweep total panels x batteries, allocating panels across planes greedily.
 * opts = { maxPanelsTotal, maxBatteries, planeCaps, step, greedyBatteries, onProgress }
 */
function searchGrid(ctx, params, opts) {
  opts = opts || {};
  const p = Engine.withDefaults(params);
  let maxPanelsTotal = opts.maxPanelsTotal;
  if (maxPanelsTotal === undefined) maxPanelsTotal = opts.maxPanels;   // older spelling
  if (maxPanelsTotal === undefined) maxPanelsTotal = 60;
  let maxBatteries = opts.maxBatteries === undefined ? 6 : opts.maxBatteries;
  // A crafted share link (`#maxb=100000`) must not hang the worker: the sweep is
  // (panels + 1) x (batteries + 1) full-year simulations, so both axes are capped.
  const capAxis = (v, cap, d, name) => {
    let n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) n = d;
    if (n > cap) {
      if (typeof console !== "undefined") console.warn(`searchGrid: ${name} ${n} clamped to ${cap}`);
      n = cap;
    }
    return n;
  };
  maxPanelsTotal = capAxis(maxPanelsTotal, MAX_SEARCH_PANELS, 60, "maxPanelsTotal");
  maxBatteries = capAxis(maxBatteries, MAX_SEARCH_BATTERIES, 6, "maxBatteries");
  const step = opts.step || 1;
  const gb = Math.max(0, Math.min(maxBatteries, opts.greedyBatteries === undefined ? 0 : opts.greedyBatteries));

  const b = Engine.baselines(ctx, p, false);
  const scn = b.scnSame;
  const nP = scn.planes.length;
  const caps = resolveCaps(scn.planes, opts.planeCaps);
  let capTotal = 0;
  for (const c of caps) capTotal += c;
  const nMax = Math.min(maxPanelsTotal, capTotal);

  const cache = new Map();
  const order = nP ? allocationOrder(scn, p, nMax, caps, gb, cache) : [];

  const panelList = [];
  for (let n = 0; n <= order.length; n += step) panelList.push(n);
  if (panelList[panelList.length - 1] !== order.length) panelList.push(order.length);
  const battList = [];
  for (let i = 0; i <= maxBatteries; i++) battList.push(i);

  const cells = [];
  let done = 0;
  const total = panelList.length * battList.length;
  for (let pi = 0; pi < panelList.length; pi++) {
    const n = panelList[pi];
    const alloc = allocAt(order, nP, n);
    for (let bi = 0; bi < battList.length; bi++) {
      const nb = battList[bi];
      const res = (nb === gb && cache.has(n)) ? cache.get(n)
        : Engine.runHours(scn, Object.assign({}, p, { panelsByPlane: alloc, batteries: nb }), false);
      Engine.attachSavings(res, b.sameFlex.bill, b.asRecorded.bill);
      cells.push(res);
      if (opts.onProgress && (++done % 40 === 0)) opts.onProgress(done, total);
    }
  }
  if (opts.onProgress) opts.onProgress(total, total);
  return {
    cells, panelList, battList,
    planes: scn.planes.map((pl, k) => ({ id: pl.id, name: pl.name, cap: caps[k] })),
    allocationOrder: order, greedyBatteries: gb,
    baselineSameFlex: b.sameFlex, baselineAsRecorded: b.asRecorded,
    flexShiftOnlySavings: b.asRecorded.bill - b.sameFlex.bill,
    weatherKey: scn.weatherKey,
    years: ctx.years !== undefined ? ctx.years : ctx.nDays / 365, hours: ctx.N,
  };
}

/** Attach financial metrics to every simulated cell and pick the winner. */
function priceGrid(grid, finance, objective, basis) {
  // Tolerate priceGrid(grid, fin, basis) as the architecture doc writes it.
  if (basis === undefined && (objective === "sameFlex" || objective === "asRecorded")) {
    basis = objective; objective = "npv";
  }
  const obj = OBJECTIVES[objective] ? objective : "npv";
  // Default basis is "sameFlex": the no-system bill with the SAME flexible-load
  // schedule, so the numbers credit the hardware only.  Re-timing an EV to midday is
  // free and is reported separately as grid.flexShiftOnlySavings.
  const asRec = basis === "asRecorded";
  const baseline = asRec ? grid.baselineAsRecorded : grid.baselineSameFlex;
  const cells = grid.cells.map(function (c) {
    const savings = asRec ? c.savingsVsAsRecorded : c.savingsVsSameFlex;
    // The two halves of the saving escalate at different rates, so they travel apart.
    const exportRev = c.exportRevenue || 0;
    let importSav = asRec ? c.importSavingsVsAsRecorded : c.importSavingsVsSameFlex;
    if (importSav === undefined) importSav = savings - exportRev;
    const fin = Finance.evaluate({
      savings, importSavings: importSav, exportRevenue: exportRev,
      bill: c.bill, baselineBill: baseline.bill,
      pvKwh: c.pvKwh, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal,
    }, finance);
    return {
      panels: c.panels, panelsByPlane: c.panelsByPlane, planeIds: c.planeIds,
      batteries: c.batteries, kwdc: c.kwdc, battKWhTotal: c.battKWhTotal,
      savings, importSavings: importSav, exportRevenue: exportRev,
      bill: c.bill, importKwh: c.importKwh, exportKwh: c.exportKwh,
      pvKwh: c.pvKwh, pvKwhByPlane: c.pvKwhByPlane, loadKwh: c.loadKwh, baseLoadKwh: c.baseLoadKwh,
      cycles: c.cycles, selfSufficiency: c.selfSufficiency,
      solarFraction: c.solarFraction, clippedKwh: c.clippedKwh,
      npv: fin.npv, irr: fin.irr, projectIrr: fin.projectIrr,
      payback: fin.payback, discountedPayback: fin.discountedPayback,
      cashFlowPayback: fin.cashFlowPayback, totalCost: fin.totalCost,
      netCost: fin.netCost, lifetimeCost: fin.lifetimeCost, lcoe: fin.lcoe,
      wealthSystem: fin.wealthSystem, wealthInvest: fin.wealthInvest,
      firstYearSavings: fin.firstYearSavings,
      firstYearMonthlyOutlay: fin.firstYearMonthlyOutlay,
      currentMonthlyBill: fin.currentMonthlyBill,
      financingMode: fin.financingMode, monthlyPayment: fin.monthlyPayment,
      finance: fin,
    };
  });
  let best = null;
  const better = OBJECTIVES[obj].better;
  cells.forEach(function (c) {
    if (c.panels === 0 && c.batteries === 0) return;   // "do nothing" is the baseline, not a candidate
    if (!best || better(c, best)) best = c;
  });
  // Doing nothing still wins if every real option destroys value.
  const doNothing = cells.find((c) => c.panels === 0 && c.batteries === 0);
  if (best && best.npv <= 0 && obj === "npv") best.beatenByDoingNothing = true;
  return { cells, best, doNothing,
           panelList: grid.panelList, battList: grid.battList, planes: grid.planes,
           baseline, objective: obj, basis: asRec ? "asRecorded" : "sameFlex" };
}

function findCell(priced, panels, batteries) {
  return priced.cells.find((c) => c.panels === panels && c.batteries === batteries);
}

/**
 * +-20% tornado on the inputs that actually move the answer.  Price-side factors
 * re-price the cached cell; a flexible-load factor is a simulation input, so the
 * caller supplies the two extra simulated savings numbers (or we skip that bar).
 */
function tornado(cell, finance, baselineBill, flexVariants) {
  const simOf = (o) => ({
    savings: o.savings, importSavings: o.importSavings, exportRevenue: o.exportRevenue,
    bill: o.bill, baselineBill: o.baselineBill === undefined ? baselineBill : o.baselineBill,
    pvKwh: cell.pvKwh, kwdc: cell.kwdc, battKWhTotal: cell.battKWhTotal,
  });
  const sim = simOf(cell);
  const base = Finance.evaluate(sim, finance).npv;
  const f = Finance.withDefaults(finance);
  const rows = [
    ["Solar $/W", "costPerW"], ["Storage $/kWh", "costPerKwh"],
    ["Rate escalation", "escalation"], ["Investment return", "investReturn"],
  ].map(function (r) {
    const lo = Object.assign({}, f); lo[r[1]] = f[r[1]] * 0.8;
    const hi = Object.assign({}, f); hi[r[1]] = f[r[1]] * 1.2;
    return { label: r[0], low: Finance.evaluate(sim, lo).npv - base,
             high: Finance.evaluate(sim, hi).npv - base };
  });
  if (flexVariants) {
    const mk = (v) => Finance.evaluate(simOf(v), f).npv - base;
    rows.push({ label: flexVariants.label || "Flexible load kWh/yr",
                low: mk(flexVariants.low), high: mk(flexVariants.high) });
  }
  rows.sort((a, b) => Math.max(Math.abs(b.low), Math.abs(b.high)) - Math.max(Math.abs(a.low), Math.abs(a.high)));
  return { base, rows };
}

const SolarOptimizer = { searchGrid, priceGrid, findCell, tornado, allocationOrder,
                         allocAt, resolveCaps, OBJECTIVES };
var __default = SolarOptimizer;

return __default;
})();
var SolarOptimizer = __ns_SolarOptimizer;

/* ===== core/worker.js ==================================================== */
/* =============================================================================
 * core/worker.js - the Blob-worker body.
 *
 * This file is NOT an ES module.  It is a classic script that expects the four core
 * namespaces to already exist in its scope:
 *
 *     SolarEngine   SolarFinance   SolarOptimizer   FlexLoad
 *
 * `node core/bundle-for-worker.mjs` concatenates core/flexload.js, core/engine.js,
 * core/finance.js, core/optimizer.js and this file into app/worker-bundle.js - the
 * one generated file in the repo, and it is committed.  The UI fetches that file as
 * text and starts it either as a Blob Worker or, where a CSP forbids Blob workers,
 * on the main thread behind a postMessage-shaped shim:
 *
 *     new Function("self", src)(shim)       // shim = { onmessage, postMessage }
 *
 * so nothing here may touch `window` or `document`, and `self` must be the only
 * global it writes to.
 *
 * -----------------------------------------------------------------------------
 * PROTOCOL
 * -----------------------------------------------------------------------------
 * in  { type:"init", load, tariffs, solar }        solar = { byPlane: { planeId: SolarProfiles } }
 * out { type:"ready", quality, hours, days, plans, providers, flexImpl }
 *
 * in  { type:"grid", id, params, maxPanelsTotal, maxBatteries, planeCaps, step }
 * out { type:"progress", id, done, total }   ... repeatedly
 * out { type:"grid", id, grid }
 *
 * in  { type:"detail", id, params, panelsByPlane, batteries, weatherKeys }
 * out { type:"detail", id, detail }
 *
 * in  { type:"validate", id, params, start, end }
 * out { type:"validate", id, result }
 *
 * out { type:"error", id, message, stack }        on any thrown exception
 *
 * `params.planes` may omit `profile`: the worker fills it from the cached SolarProfiles
 * for that plane at `params.weatherKey`, which is why init carries the solar bundle.
 * ========================================================================== */

(function (global) {
  "use strict";

  var E = SolarEngine, F = SolarFinance, O = SolarOptimizer;
  var ctx = null, solar = null;

  function post(msg) { global.postMessage(msg); }

  /** Give every plane a concrete 8760 profile for the requested weather year. */
  function hydrate(params) {
    var p = Object.assign({}, params || {});
    var key = p.weatherKey || "tmy";
    p.planes = (p.planes || []).map(function (pl) {
      if (pl.profile) return pl;
      var sp = solar && solar.byPlane ? solar.byPlane[pl.id] : null;
      return Object.assign({}, pl, { profile: sp ? E.profileFor(sp, key) : null });
    });
    return p;
  }

  /** The period id per hour for the weekday schedule, for the UI's TOU strip. */
  function scheduleStrip(planId) {
    var plan = E.planById(ctx.tariffs, planId), out = {};
    ["summer", "winter"].forEach(function (s) {
      out[s] = plan.schedule[s].weekday.slice();
      out[s + "Weekend"] = plan.schedule[s].weekend.slice();
    });
    return out;
  }

  /** +-20% on every flexible load, for the tornado's simulation-side bar. */
  function flexVariants(params, panelsByPlane, batteries) {
    var base = params.flex || [];
    if (!base.length) return null;
    var mk = function (mult) {
      var q = hydrate(Object.assign({}, params, {
        panelsByPlane: panelsByPlane, batteries: batteries,
        flex: base.map(function (f) {
          return Object.assign({}, f, { scale: (f.scale == null ? 1 : f.scale) * mult });
        }),
      }));
      var r = E.simulate(ctx, q, {});
      return { savings: r.savingsVsSameFlex, importSavings: r.importSavingsVsSameFlex,
               exportRevenue: r.exportRevenue, bill: r.bill,
               baselineBill: r.baselineSameFlex.bill };
    };
    return { label: "Flexible load kWh/yr", low: mk(0.8), high: mk(1.2) };
  }

  var HANDLERS = {
    init: function (m) {
      ctx = E.prepare({ load: m.load, tariffs: m.tariffs });
      solar = m.solar || null;
      post({ type: "ready", quality: ctx.quality, hours: ctx.N, days: ctx.nDays,
             years: ctx.years, flexImpl: E.flexReshapeSource(),
             plans: ctx.tariffs.plans.map(function (p) { return { id: p.id, name: p.name }; }),
             providers: Object.keys(ctx.tariffs.providers || {}).map(function (k) {
               return { id: k, name: (ctx.tariffs.providers[k] || {}).name || k };
             }) });
    },

    grid: function (m) {
      var grid = O.searchGrid(ctx, hydrate(m.params), {
        maxPanelsTotal: m.maxPanelsTotal, maxBatteries: m.maxBatteries,
        planeCaps: m.planeCaps, step: m.step, greedyBatteries: m.greedyBatteries,
        onProgress: function (done, total) { post({ type: "progress", id: m.id, done: done, total: total }); },
      });
      post({ type: "grid", id: m.id, grid: grid });
    },

    detail: function (m) {
      var params = hydrate(Object.assign({}, m.params, {
        panelsByPlane: m.panelsByPlane, batteries: m.batteries,
      }));
      var res = E.simulate(ctx, params, { detail: true });
      res.plans = E.billOnAllPlans(ctx, params);
      res.providers = E.billOnAllProviders(ctx, params);
      res.schedule = scheduleStrip(params.planId);
      res.flexVariants = flexVariants(m.params, m.panelsByPlane, m.batteries);
      // One run per weather year, so the UI can show the production spread.
      res.weather = (m.weatherKeys || []).map(function (w) {
        var q = hydrate(Object.assign({}, params, { weatherKey: w.key, planes: (m.params.planes || []) }));
        var s = E.simulate(ctx, q, {});
        return { key: w.key, label: w.label, group: w.group, pvKwh: s.pvKwh, bill: s.bill,
                 savings: s.savingsVsSameFlex, importSavings: s.importSavingsVsSameFlex,
                 exportRevenue: s.exportRevenue, baselineBill: s.baselineSameFlex.bill };
      });
      // The hourly arrays are only meaningful to the charts that ask for them.
      if (!m.wantHourly) delete res.hourly;
      post({ type: "detail", id: m.id, detail: res });
    },

    validate: function (m) {
      post({ type: "validate", id: m.id,
             result: E.billPeriod(ctx, m.params || {}, m.start, m.end) });
    },
  };

  global.onmessage = function (e) {
    var m = e.data || {};
    try {
      var h = HANDLERS[m.type];
      if (!h) throw new Error("unknown message type: " + m.type);
      if (m.type !== "init" && !ctx) throw new Error("worker received '" + m.type + "' before 'init'");
      h(m);
    } catch (err) {
      // `code`, `usableDays` and `phase` let the page tell "your file is too short"
      // (E.prepare throws INSUFFICIENT_DATA) apart from a bug.
      post({ type: "error", id: m.id, phase: m.type, message: (err && err.message) || String(err),
             userMessage: err && err.userMessage, code: err && err.code,
             usableDays: err && err.usableDays, stack: err && err.stack });
    }
  };
})(typeof self !== "undefined" ? self : this);
