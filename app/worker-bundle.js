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
 *   charger kW = median of the top decile of overnight excess; every hour is capped
 *           at it, and at the metered kWh for that hour.
 *
 * NaN hours (a gap the parser could not fill) are treated as absent: they never
 * enter a baseline and never carry EV energy.
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
  const sessionsPerWeek = sessions.length / (spanYears * 52.1775);
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
      sessionsPerWeek: round2(runs.length / (spanYears * 52.1775)),
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

function sumRange(arr, a, b) { let s = 0; for (let k = a; k <= b; k++) s += arr[k]; return s; }

// ------------------------------------------------------------------- reshape
const DEFAULT_SCHEDULE = {
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

  for (let d = 0; d < cal.nDays; d++) {
    const s0 = bounds.starts[d], s1 = s0 + bounds.lens[d];
    const byHour = new Int32Array(24).fill(-1);
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
function prepare(data) {
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
function reshapeFlex(flex, cal, solarShape) {
  if (_flexReshape) {
    const out = _flexReshape(flex, cal, solarShape);
    if (out && out.length === cal.N) return out;
  }
  return fallbackReshape(flex, cal, solarShape);
}

// ---------------------------------------------------------------- rates
function planById(tariffs, id) {
  for (let i = 0; i < tariffs.plans.length; i++) if (tariffs.plans[i].id === id) return tariffs.plans[i];
  return tariffs.plans[0];
}
function rateFor(rates, provider) {
  if (rates == null) return 0;
  if (typeof rates[provider] === "number") return rates[provider];
  return (rates.delivery || 0) + (rates.sce_generation || 0);
}

/** Per-hour import/export prices + period codes for one (plan, provider). */
function buildRates(ctx, planId, providerId, applyNbc, climate, accPlus, capExport) {
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
function buildScenario(ctx, params, opts) {
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
 * Turn monthly energy totals into a bill, NBT-style:
 *   subtotal = fixed + energy - baseline credit, floored at the minimum charge;
 *   export credits then offset the subtotal down to (not below) that floor;
 *   the unused balance rolls forward and is cashed out at NSC at true-up.
 */
function settle(r, ctx, mImpCost, mImpKwh, mExpCred, mExpKwh, detail, mPvKwh, mBandKwh, mBandCred) {
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
const DEFAULTS = {
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
function baselines(ctx, p, detail) {
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
function simulate(ctx, params, opts) {
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
    const b = baselines(ctx, q, false);
    const withSys = runHours(b.scnSame, q, false);
    return { id, name: (ctx.tariffs.providers[id] || {}).name || id,
             bill: withSys.bill, baselineSameFlex: b.sameFlex.bill,
             savings: b.sameFlex.bill - withSys.bill };
  });
}

const _internal = { holidaySet, isDST, spread, fallbackReshape, dayBounds,
                           shadingFactors, PERIOD_IDS, EXP_BANDS, bandOf, DOW_PRIORITY };

const SolarEngine = {
  prepare, buildScenario, runHours, simulate, billPeriod, billOnAllPlans, billOnAllProviders,
  baselines, buildRates, settle, planById, profileFor, pvFor, climateCredit,
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

function npvOf(cf, rate) {
  let v = 0;
  for (let y = 0; y < cf.length; y++) v += cf[y] / Math.pow(1 + rate, y);
  return v;
}

/** Bisection IRR on a cash-flow array starting at year 0. Null if it never crosses. */
function irrOf(cf) {
  let lo = -0.9, hi = 3.0;
  let flo = npvOf(cf, lo), fhi = npvOf(cf, hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npvOf(cf, mid);
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
 * Monthly amortization summed into annual rows.
 * Returns { payment /*monthly*​/, rows: [{ year, payment, interest, principal, balance }],
 *           totalInterest, termYears }.
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
    // so the comparison is like-for-like with cash.
    const atH = schedule.find((r) => r.year === H);
    if (schedule.length > H && atH) pay[H] += atH.balance;
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
  // two degradation rates.  Cost share is a crude but stable proxy.
  let wS = gross > 0 ? solarCost / Math.max(1e-9, solarCost + storageCost) : 1;
  if (!isFinite(wS)) wS = 1;
  const wB = 1 - wS;

  const cf = [-upfront], savings = [0], om = [0], extras = [0], prod = [0], payments = [pay[0] || 0];
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
    const net = sav - o - ex - pay[y] + (y === H ? resale : 0);
    cf.push(net); savings.push(sav); om.push(o); extras.push(ex); payments.push(pay[y]);
    prod.push(sim.pvKwh * sFac);
  }

  const cum = [], dcum = [];
  let run = 0, drun = 0;
  for (let y = 0; y <= H; y++) {
    run += cf[y]; cum.push(run);
    drun += cf[y] / Math.pow(1 + f.investReturn, y); dcum.push(drun);
  }

  const npv = npvOf(cf, f.investReturn);
  // IRR is the return on an investment, so it needs one: the first money to move
  // must be an outlay.  A stream that starts positive (a loan whose payments sit
  // below the savings from year one) and only dips negative at a battery
  // replacement decades later still has a sign change, and bisection would
  // dutifully return a deeply negative "rate" that describes nothing.
  const firstMove = cf.find((v) => Math.abs(v) > 1e-9);
  const irr = firstMove !== undefined && firstMove < 0 ? irrOf(cf) : null;

  // "Same cash in the market" comparison, stated as two end-of-horizon numbers.
  // Both arms start from the same cash: what buying the system outright costs
  // (`netCost`; the sticker price under a lease, where nothing is bought).  The
  // market arm leaves all of it invested.  The system arm spends `upfront` of it
  // - all of it for cash, the down payment for a loan, nothing for a lease -
  // keeps the rest invested, and reinvests every year's net cash flow (savings
  // less O&M, replacements and any loan or lease payment) at the same return.
  // Counting only the cash flows would forget the borrower's still-invested
  // principal and make a cheap loan look worse than paying cash.  The identity
  // wealthSystem - wealthInvest = NPV x (1 + r)^H holds in every mode.
  const cashRef = netCost;
  const wealthInvest = cashRef * Math.pow(1 + f.investReturn, H);
  let wealthSystem = (cashRef - upfront) * Math.pow(1 + f.investReturn, H);
  for (let y = 1; y <= H; y++) wealthSystem += cf[y] * Math.pow(1 + f.investReturn, H - y);

  // LCOE over PV generated (storage cost included - it is part of what you bought).
  let costPV = upfront, kwhPV = 0;
  for (let y = 1; y <= H; y++) {
    costPV += (om[y] + extras[y] + payments[y]) / Math.pow(1 + f.discountRate, y);
    kwhPV += prod[y] / Math.pow(1 + f.discountRate, y);
  }
  const lcoe = kwhPV > 0 ? costPV / kwhPV : null;

  // Lifetime cost of energy service = what you pay the utility plus what you paid
  // for the system (and for the money), in present value.  The no-system arm is the
  // same sum with savings = 0, which is how "min lifetime cost" stays comparable.
  let lifetime = upfront, lifetimeNoSystem = 0;
  for (let y = 1; y <= H; y++) {
    const escY = Math.pow(1 + f.escalation, y - 1), dis = Math.pow(1 + f.discountRate, y);
    const escXY = Math.pow(1 + f.exportEscalation, y - 1);
    // The bill is net of export credits; only its charge side follows retail rates.
    const billY = (sim.bill + exportRev) * escY - exportRev * escXY;
    lifetime += (billY + om[y] + extras[y] + payments[y]) / dis;
    lifetimeNoSystem += (sim.baselineBill * escY) / dis;
  }

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
    cumulative: cum, discountedCumulative: dcum,
    npv, irr,
    payback: crossing(cum), discountedPayback: crossing(dcum),
    lcoe, lifetimeCost: lifetime, lifetimeCostNoSystem: lifetimeNoSystem,
    wealthInvest, wealthSystem, wealthDelta: wealthSystem - wealthInvest, cashRef,
    firstYearSavings: savings[1] || 0,
    importSavings: importSav, exportRevenue: exportRev,
    horizon: H,
    // financing
    financingMode: mode, upfront, downPayment: mode === "loan" ? upfront : (mode === "cash" ? netCost : 0),
    loanPrincipal: principal, dealerFee,
    monthlyPayment: mode === "loan" ? (amort ? amort.payment : 0)
                  : isLease ? (pay[1] || 0) / 12 : 0,
    totalInterest: amort ? amort.totalInterest : 0,
    financingSchedule: schedule,
    firstYearPayment, firstYearMonthlyOutlay, currentMonthlyBill,
    monthlyOutlayDelta: firstYearMonthlyOutlay - currentMonthlyBill,
  };
}

/**
 * Price at which NPV crosses zero, holding everything else fixed.  NPV is exactly
 * linear in $/W and $/kWh (both scale the year-0 outlay and nothing else), so two
 * evaluations pin the line - no search needed.
 */
function breakEven(sim, f, key) {
  const a = evaluate(sim, Object.assign({}, f, { [key]: 0 })).npv;
  const b = evaluate(sim, Object.assign({}, f, { [key]: 1 })).npv;
  const slope = b - a;
  if (Math.abs(slope) < 1e-9) return null;
  return -a / slope;
}

const SolarFinance = { evaluate, breakEven, withDefaults, effectiveDiscount,
                       npvOf, irrOf, crossing, loanPayment, amortize, DEFAULTS };
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

const OBJECTIVES = {
  npv: { label: "Maximum NPV", better: (a, b) => a.npv > b.npv },
  lifetime: { label: "Lowest lifetime cost", better: (a, b) => a.lifetimeCost < b.lifetimeCost },
  irr: { label: "Highest IRR", better: (a, b) => (a.irr === null ? -9 : a.irr) > (b.irr === null ? -9 : b.irr) },
  payback: { label: "Fastest payback", better: (a, b) => (a.payback === null ? 999 : a.payback) < (b.payback === null ? 999 : b.payback) },
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

/**
 * Sweep total panels x batteries, allocating panels across planes greedily.
 * opts = { maxPanelsTotal, maxBatteries, planeCaps, step, greedyBatteries, onProgress }
 */
function searchGrid(ctx, params, opts) {
  opts = opts || {};
  const p = Engine.withDefaults(params);
  const maxPanelsTotal = opts.maxPanelsTotal === undefined
    ? (opts.maxPanels === undefined ? 60 : opts.maxPanels) : opts.maxPanelsTotal;
  const maxBatteries = opts.maxBatteries === undefined ? 6 : opts.maxBatteries;
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
      res.savingsVsSameFlex = b.sameFlex.bill - res.bill;
      res.savingsVsAsRecorded = b.asRecorded.bill - res.bill;
      res.importSavingsVsSameFlex = res.savingsVsSameFlex - res.exportRevenue;
      res.importSavingsVsAsRecorded = res.savingsVsAsRecorded - res.exportRevenue;
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
    years: ctx.nDays / 365, hours: ctx.N,
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
      pvKwh: c.pvKwh, pvKwhByPlane: c.pvKwhByPlane,
      cycles: c.cycles, selfSufficiency: c.selfSufficiency,
      solarFraction: c.solarFraction, clippedKwh: c.clippedKwh,
      npv: fin.npv, irr: fin.irr, payback: fin.payback, discountedPayback: fin.discountedPayback,
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
  const base = Finance.evaluate(simOf(cell), finance).npv;
  const f = Finance.withDefaults(finance);
  const rows = [
    ["Solar $/W", "costPerW"], ["Storage $/kWh", "costPerKwh"],
    ["Rate escalation", "escalation"], ["Investment return", "investReturn"],
  ].map(function (r) {
    const lo = Object.assign({}, f); lo[r[1]] = f[r[1]] * 0.8;
    const hi = Object.assign({}, f); hi[r[1]] = f[r[1]] * 1.2;
    const sim = simOf(cell);
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
      post({ type: "error", id: m.id, message: (err && err.message) || String(err),
             stack: err && err.stack });
    }
  };
})(typeof self !== "undefined" ? self : this);
