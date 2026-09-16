/* =============================================================================
 * core/flexload.js - flexible loads: find them in the meter data, then re-place
 * them on the clock.
 *
 * Pure ES module, no dependencies, browser + Node 24.  No DOM, no network.
 *
 * Two halves:
 *
 *   detectEV(loadSet, opts) -> FlexLoad     split EV charging out of the whole-house
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
export const EV_TUNING = {
  baselineHalfWindowDays: 15,   // +/- days used to build the hour-of-day baseline
  baselinePctile: 0.30,         // robust "house only" percentile (pass 1)
  nightHours: [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9],   // 8PM - 9:59AM
  excessThreshold: 2.0,         // kWh above baseline to call a night hour "EV"
  coreExcess: 4.0,              // a run must peak above this to be a session
  dayFlatness: 1.0,             // max (max-min) excess inside a daytime plateau
  dayLevelLo: 0.70,             // daytime plateau must sit in [lo,hi] x charger kW
  dayLevelHi: 1.20,
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
export function buildCalendar(loadSet) {
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
 *   charger kW = median of the top decile of overnight excess; every hour is capped
 *           at it, and at the metered kWh for that hour.
 *
 * NaN hours (a gap the parser could not fill) are treated as absent: they never
 * enter a baseline and never carry EV energy.
 */
export function detectEV(loadSet, opts = {}) {
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

  // ---- two-pass baseline ---------------------------------------------------
  const base0 = buildBaseline(val, present, nDates, null, false, T);
  let chargerKW = opts.chargerKW || inferChargerKW(val, present, N, sCell, sHour, base0, NIGHT, T);
  const ev0 = detectRuns(N, sCell, sHour, sNaive, val, present, base0, chargerKW, NIGHT, T);

  const exclude = new Uint8Array(nDates * 24);
  for (const i of ev0.keys()) exclude[sCell[i]] = 1;
  const base1 = buildBaseline(val, present, nDates, exclude, true, T);
  chargerKW = opts.chargerKW || inferChargerKW(val, present, N, sCell, sHour, base1, NIGHT, T);
  const ev1 = detectRuns(N, sCell, sHour, sNaive, val, present, base1, chargerKW, NIGHT, T);

  // ---- emit ----------------------------------------------------------------
  const kwhByHour = new Float64Array(N);
  let evTotal = 0, total = 0, dayEv = 0;
  for (let i = 0; i < N; i++) {
    const metered = present[sCell[i]] ? val[sCell[i]] : 0;
    const e = round3(Math.min(ev1.get(i) || 0, metered));
    kwhByHour[i] = e;
    evTotal += e; total += metered;
    if (!NIGHT[sHour[i]]) dayEv += e;
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
    `${T.excessThreshold} kWh are attributed to the EV provided the run peaks above ` +
    `${T.coreExcess} kWh. Daytime window (10AM-7:59PM): only runs of >=2 consecutive hours ` +
    `whose excess is flat (range < ${T.dayFlatness} kWh) and sits between ` +
    `${T.dayLevelLo.toFixed(2)}x and ${T.dayLevelHi.toFixed(2)}x the inferred charger power ` +
    `are attributed to the EV; this separates charging plateaus from air-conditioning, which ` +
    `ramps. Per-hour EV is capped at the inferred charger power of ${chargerKW} kW (median of ` +
    `the top decile of overnight excess). Detected daytime charging = ${dayEv.toFixed(0)} kWh ` +
    `(${evTotal > 0 ? (100 * dayEv / evTotal).toFixed(1) : "0.0"}% of EV energy).`;

  const confidence = evConfidence({
    nSessions: sessions.length, sessionsPerWeek, chargerKW,
    share: total > 0 ? evTotal / total : 0, medianSessionKwh,
    coverage: nUsable / N,
  });

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
    },
    schedule: {
      mode: "spread",
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
function inferChargerKW(val, present, N, sCell, sHour, base, NIGHT, T) {
  const vals = [];
  for (let i = 0; i < N; i++) {
    if (!NIGHT[sHour[i]]) continue;
    const c = sCell[i];
    if (!present[c]) continue;
    const e = val[c] - base[c];
    if (e > T.coreExcess) vals.push(e);
  }
  if (!vals.length) return 8.0;
  vals.sort((a, b) => a - b);
  const top = vals.slice(Math.floor(0.90 * vals.length));
  return round2(medianOf(top));
}

/** The night-run + daytime-plateau scan.  Returns Map(slotIndex -> ev kWh). */
function detectRuns(N, sCell, sHour, sNaive, val, present, base, chargerKW, NIGHT, T) {
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

  // --- day: only flat plateaus that look like the charger
  const loLvl = T.dayLevelLo * chargerKW, hiLvl = T.dayLevelHi * chargerKW;
  i = 0;
  while (i < N) {
    if (!NIGHT[sHour[i]] && excess[i] >= loLvl && excess[i] <= hiLvl) {
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
export function detectPool(loadSet, opts = {}) {
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
    schedule: {
      mode: "spread", daysPerWeek: 7,
      window: [domHour, Math.min(24, domHour + hoursPerDay)],
      daylightFraction: 1.0, overnightWindow: [1, 5],
      maxKW: Math.max(kw, 0.1), followSolar: false, hoursPerDay,
    },
    scale: 1.0,
  };
}

// ------------------------------------------------------------------- reshape
export const DEFAULT_SCHEDULE = {
  mode: "spread",
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
export function reshape(flex, calIn, solarShape) {
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
export function presets() {
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
export function summarize(flex) {
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
export default {
  detectEV, detectPool, reshape, presets, summarize,
  buildCalendar, DEFAULT_SCHEDULE, EV_TUNING,
};

export const _internal = { buildBaseline, inferChargerKW, detectRuns, sessionsFrom, percentile, medianOf, spread, dayBounds };
