/* =============================================================================
 * core/greenbutton.js - read a household's interval data into a LoadSet.
 *
 * Pure ES module, no dependencies, runs in the browser and in Node 24.
 * NOTHING here touches the network and nothing is persisted: the caller hands in
 * the text of a file the visitor dropped on the page and gets back numbers.
 *
 * PRIVACY: every parser deliberately throws away the identifying header fields
 * that utilities staple to these exports (customer name, service address, account
 * number, meter/serial number, ESPI UsagePoint titles).  The only two things kept
 * from a header block are `meta.zip` (needed to pick a tariff) and
 * `meta.utilityHint` (needed to pick a tariff library).  See `DISCARDED_FIELDS`
 * and `findZip()`.
 *
 * -----------------------------------------------------------------------------
 * OUTPUT - LoadSet (docs/ARCHITECTURE.md)
 * -----------------------------------------------------------------------------
 *   { meta: { source, tz, start, end, nHours, totalKwh, intervalMinutes,
 *             gapsFilled: [...], notes: [...], zip, utilityHint,
 *             quality: { hours, days, years, missing, filled, partialHours } },
 *     ts:  string[],             // "YYYY-MM-DDTHH:00" LOCAL CLOCK time, hour start
 *     kwh: Float64Array,         // delivered (import) kWh in that hour
 *     exportKwh: Float64Array | null }   // received kWh, null when the meter never exports
 *
 * Timestamps are local prevailing (clock) time exactly as the utility printed
 * them, so a spring-forward day has 23 entries and a fall-back day has 24 entries
 * with the duplicated clock hour SUMMED into one slot.  The engine maps clock time
 * back onto local standard time when it looks up a solar profile.
 *
 * Gaps: a run of <= 3 missing hours is interpolated from the same hour on the
 * nearest adjacent days and listed in `meta.gapsFilled`; a longer run is left as
 * NaN and counted in `meta.quality.missing`.
 *
 * DST rules are the US federal ones (2nd Sunday of March -> 1st Sunday of
 * November).  Every utility this tool supports is in the US; a non-US export will
 * still parse, it just will not get the spring-forward special case.
 * ========================================================================== */

// ----------------------------------------------------------------- constants
const NBSP = /[   ﻿]/g;
const MAX_FILL_RUN = 3;               // hours; longer gaps stay NaN
const HOURS_PER_YEAR = 8766;          // 365.25 * 24

// ------------------------------------------------------------------- errors
/**
 * A file we understood but cannot use.  Same convention as `GeocodeError`
 * (core/geocode.js): `message` is for logs, `userMessage` is a sentence the UI can
 * show as-is, `code` is machine-readable ("coarse-interval").
 */
export class LoadFileError extends Error {
  constructor(message, { code = "unusable", userMessage, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LoadFileError";
    this.code = code;
    this.userMessage = userMessage ||
      "This file could not be used. Download your hourly or 15-minute interval data and try again.";
  }
}

/** Where each utility hides the interval-granularity choice in its Green Button download. */
const REDOWNLOAD_HINTS = {
  sce: "On sce.com, open Data Sharing & Download (Green Button \"Download My Data\"), choose " +
       "the 15-minute or hourly interval usage option rather than daily or billing-period " +
       "totals, pick a date range of up to a year, and download as CSV.",
  pge: "On pge.com, open Energy Usage Details > Green Button \"Download My Data\", choose " +
       "\"Export usage for a range of days\" (that file is 15-minute or hourly) rather than the " +
       "bill-period export, and download as CSV.",
  sdge: "On sdge.com, open My Energy Center > Green Button \"Download My Data\", choose the " +
        "15-minute or hourly interval option rather than daily, and download as CSV.",
};
const GENERIC_HINT = "In your utility's Green Button \"Download My Data\" page, choose the " +
  "15-minute or hourly interval option (not daily, monthly or billing-period totals) and " +
  "download again.";

function utilityOf(hint) {
  const h = String(hint || "").toLowerCase();
  if (h.startsWith("sce")) return "sce";
  if (h.startsWith("pge") || h.startsWith("pg&e")) return "pge";
  if (h.startsWith("sdge") || h.startsWith("sdg&e")) return "sdge";
  return null;
}

/** The error for a file whose readings are coarser than an hour (daily, monthly...). */
function coarseIntervalError(minutes, utilityHint) {
  const u = utilityOf(utilityHint);
  const what = minutes >= 1440 * 27 ? "monthly" : minutes >= 1440 ? "daily" : `${minutes}-minute`;
  return new LoadFileError(
    `interval data is ${minutes}-minute (${what}); hourly or finer is required`,
    {
      code: "coarse-interval",
      userMessage:
        `This file has ${what} readings. Rooftop ROI needs hourly or 15-minute interval data, ` +
        `because solar, batteries and time-of-use prices all change hour by hour. ` +
        (u ? REDOWNLOAD_HINTS[u] : GENERIC_HINT),
    });
}

// --------------------------------------------------------------- tiny utils
const pad2 = (n) => (n < 10 ? "0" + n : "" + n);

/** Remove a UTF-8 BOM and normalise the non-breaking spaces SCE pads fields with. */
function clean(s) {
  return String(s == null ? "" : s).replace(NBSP, " ").trim();
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Hours since the Unix epoch, treating the naive local clock stamp as if it were UTC. */
function hourKey(y, mo, d, h) {
  return Date.UTC(y, mo - 1, d, h) / 3600000;
}

function keyParts(k) {
  const dt = new Date(k * 3600000);
  return {
    y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(), h: dt.getUTCHours(),
  };
}

function fmtKey(k) {
  const p = keyParts(k);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:00`;
}

function dateOfKey(k) {
  const p = keyParts(k);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** Day-of-month of the `n`th `dow` (0=Sun) in `month` (1-12) of `year`. */
function nthWeekday(year, month, dow, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
}

/** "YYYY-MM-DD" of the US spring-forward / fall-back date in `year`. */
function dstStartDate(year) { return `${year}-03-${pad2(nthWeekday(year, 3, 0, 2))}`; }
function dstEndDate(year) { return `${year}-11-${pad2(nthWeekday(year, 11, 0, 1))}`; }

function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// -------------------------------------------------------------- CSV plumbing
/**
 * Tolerant RFC-4180-ish tokenizer over the WHOLE text (so a quoted field may
 * contain the delimiter or a newline).  "Tolerant" means a quote only opens a
 * field at the start of that field, and a quoted field only ends on a quote that
 * is followed by the delimiter, a newline or EOF.  That keeps an unbalanced quote
 * in a vendor preamble (SCE writes `"For location: ...` with no closing quote)
 * from swallowing the rest of the file.
 */
export function parseCsvRows(text, delim) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        const nx = text[i + 1];
        if (nx === undefined || nx === delim || nx === "\n" || nx === "\r") { inQ = false; i++; continue; }
        field += c; i++; continue;                 // stray quote inside the field
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Find a vendor CSV's header row: the first row within the first `limit` rows whose
 * cleaned, lower-cased cells satisfy `matches`.  The utilities all bury their column
 * header under a preamble of identifying fields, and every one of them is found this
 * way, so the scan lives here rather than once per parser.
 *
 * Returns `{ hdr, cells }`, or null when no row matches.
 */
function findHeaderRow(rows, limit, matches) {
  for (let i = 0; i < rows.length && i < limit; i++) {
    const cells = rows[i].map((c) => clean(c).toLowerCase());
    if (matches(cells)) return { hdr: i, cells };
  }
  return null;
}

/** Index of the first column whose name starts with `prefix`, or -1. */
function colStarting(cells, prefix) {
  return cells.findIndex((c) => c.startsWith(prefix));
}

/**
 * The preamble above the column header, as one string for `findZip` to scan.
 * This is the ONLY thing a parser does with those rows - they hold the customer
 * name, service address and account number, and nothing but a ZIP is carried out.
 */
function headerBlock(rows, hdr) {
  return rows.slice(0, hdr).map((r) => r.join(",")).join("\n");
}

const DELIMS = [",", ";", "\t", "|"];

/** Pick the delimiter that yields the most consistent field count over the sample. */
export function sniffDelimiter(text) {
  const sample = text.slice(0, 200000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 60);
  let best = ",", bestScore = -1;
  for (const d of DELIMS) {
    const counts = sample.map((l) => l.split(d).length - 1).filter((c) => c > 0);
    if (counts.length < 2) continue;
    counts.sort((a, b) => a - b);
    const typical = median(counts);
    const agree = counts.filter((c) => c === typical).length;
    const score = agree * typical;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ------------------------------------------------------------ stamp plumbing
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "MM/DD/YYYY", "YYYY-MM-DD", "M/D/YY", "DD-Mon-YYYY" -> {y,mo,d} (US month-first). */
export function parseDateParts(s) {
  const t = clean(s);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return { y, mo: +m[1], d: +m[2] };            // US convention: month first
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/.exec(t);
  if (m) {
    const mo = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo) return { y, mo, d: +m[1] };
  }
  return null;
}

/** "1:00PM", "01:00 PM", "13:00", "13:00:00", "2400" -> {h, mi}. */
export function parseTimeParts(s) {
  const t = clean(s).toUpperCase();
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(AM|PM)$/.exec(t);
  if (m) {
    let h = +m[1] % 12;
    if (m[4] === "PM") h += 12;
    return { h, mi: +m[2] };
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?$/.exec(t);
  if (m) return { h: +m[1], mi: +m[2] };
  m = /^(\d{1,2})\s*(AM|PM)$/.exec(t);
  if (m) { let h = +m[1] % 12; if (m[2] === "PM") h += 12; return { h, mi: 0 }; }
  return null;
}

/**
 * A single combined field, e.g. "09/01/2025 12:00AM", "2025-09-01T00:15:00" or
 * "2025-09-01T07:15:00.000Z".  A trailing "Z" or "+hh:mm" / "-hhmm" offset is
 * returned as `off` (minutes east of UTC) for the caller to convert; the clock
 * fields are always the ones printed.
 */
export function parseStamp(s) {
  const t = clean(s);
  if (!t) return null;
  const m = /^(\S+)[T\s]+(.+)$/.exec(t);
  if (m) {
    const d = parseDateParts(m[1]);
    let rest = m[2], off = null;
    const om = /\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))$/i.exec(rest);
    if (om && /\d/.test(rest.slice(0, om.index))) {
      off = om[1] ? 0 : (om[2] === "-" ? -1 : 1) * (+om[3] * 60 + +om[4]);
      rest = rest.slice(0, om.index);
    }
    const tm = parseTimeParts(rest);
    if (d && tm) {
      const p = { y: d.y, mo: d.mo, d: d.d, h: tm.h, mi: tm.mi };
      if (off != null) p.off = off;
      return p;
    }
    return null;
  }
  const d = parseDateParts(t);
  return d ? { y: d.y, mo: d.mo, d: d.d, h: 0, mi: 0 } : null;
}

function stampKeyHour(p) { return hourKey(p.y, p.mo, p.d, p.h); }

function num(s) {
  const t = clean(s).replace(/[$,]/g, "");
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// ------------------------------------------------------------------- scrub
/**
 * The identifying fields we refuse to carry out of a parser.  Kept as a list so
 * the tests can assert on it and so the Assumptions tab can quote it.
 */
export const DISCARDED_FIELDS = [
  "customer name", "service address", "mailing address", "account number",
  "service account", "meter number", "meter serial", "usage point id",
  "service id", "SA ID", "premise id", "phone", "email",
];

/**
 * Pull a ZIP out of a header block and nothing else.  Deliberately narrow: we
 * only accept a 5-digit group that sits after a US state abbreviation, after a
 * "zip"/"postal" label, or at the end of a comma-separated address line - so an
 * account number like 8009999999 can never be mistaken for one.
 */
export function findZip(headerText) {
  const t = String(headerText || "").replace(NBSP, " ");
  let m = /\b(?:zip|postal)(?:\s*code)?\b\s*[:,=]?\s*"?(\d{5})(?:-\d{4})?\b/i.exec(t);
  if (m) return m[1];
  m = /\b(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+(\d{5})(?:-\d{4})?\b/.exec(t);
  if (m) return m[2];
  m = /,\s*(\d{5})(?:-\d{4})?\s*"?\s*$/m.exec(t);
  if (m) return m[1];
  return null;
}

// ------------------------------------------------------------ format sniffing
/**
 * Decide which parser to use from the text itself (the filename is only a
 * tie-breaker, because browsers hand us whatever the user renamed the file to).
 */
export function detectFormat(text, opts = {}) {
  const head = stripBom(String(text || "")).slice(0, 8000);
  const low = head.toLowerCase().replace(NBSP, " ");
  const name = String(opts.filename || "").toLowerCase();

  if (/<\?xml|<feed[\s>]|<entry[\s>]|intervalblock|espi|<usagepoint/i.test(head)) return "espi-xml";
  if (low.includes("energy usage information") ||
      low.includes("energy consumption time period start")) return "sce-csv";
  if (/type\s*,\s*date\s*,\s*start\s*time\s*,\s*end\s*time\s*,\s*usage/.test(low) ||
      (low.includes("electric usage") && low.includes("usage (kwh)"))) return "pge-csv";
  if (/meter\s*number\s*,\s*date\s*,\s*start\s*time\s*,\s*duration\s*,\s*consumption/.test(low) ||
      (low.includes("consumption") && low.includes("generation") && low.includes("meter number"))) return "sdge-csv";

  if (name.includes("sce")) return "sce-csv";
  if (name.includes("pge") || name.includes("pg&e") || name.includes("pacificgas")) return "pge-csv";
  if (name.includes("sdge") || name.includes("sdg&e")) return "sdge-csv";
  if (name.endsWith(".xml")) return "espi-xml";
  return "generic-csv";
}

// ----------------------------------------------------------------- toHourly
/**
 * Fold a list of intervals onto the hourly local-clock grid.
 *
 * intervals: [{ start, durationMinutes, kwh, exportKwh }]
 *   `start` is a naive LOCAL CLOCK stamp - either "YYYY-MM-DDTHH:MM" or
 *   {y,mo,d,h,mi}.  Sub-hourly intervals are summed into the hour that contains
 *   their start.  Two 60-minute intervals with the same clock label (the DST
 *   fall-back hour) are summed into one slot.
 *
 * Returns { ts, kwh, exportKwh, intervalMinutes, gapsFilled, notes, quality }.
 */
export function toHourly(intervals, opts = {}) {
  const slots = new Map();                 // hourKey -> { kwh, exp, n }
  const durations = [];
  let anyExport = false;

  for (const iv of intervals) {
    const p = typeof iv.start === "string" ? parseStamp(iv.start) : iv.start;
    if (!p) continue;
    const k = stampKeyHour(p);
    const dur = iv.durationMinutes || 60;
    durations.push(dur);
    const e = iv.exportKwh || 0;
    if (e) anyExport = true;
    const cur = slots.get(k);
    if (cur) { cur.kwh += iv.kwh; cur.exp += e; cur.n++; cur.min += dur; }
    else slots.set(k, { kwh: iv.kwh, exp: e, n: 1, min: dur });
  }
  let intervalMinutes = durations.length ? modeOf(durations) : 60;
  // A file with no usable duration information still gives itself away by its
  // spacing: one reading a day lands every 24th slot.
  if (intervalMinutes <= 60 && slots.size >= 3) {
    const ks = Array.from(slots.keys()).sort((a, b) => a - b);
    const gaps = [];
    for (let q = 1; q < ks.length; q++) gaps.push(ks[q] - ks[q - 1]);
    gaps.sort((a, b) => a - b);
    const typical = median(gaps);
    if (typical >= 2) intervalMinutes = Math.round(typical * 60);
  }
  // Coarser than hourly cannot be spread onto hours honestly (P0 #7): refuse it.
  if (intervalMinutes > 60) throw coarseIntervalError(intervalMinutes, opts.utilityHint || opts.source);
  return buildSeries(slots, {
    ...opts,
    intervalMinutes,
    anyExport: anyExport || !!opts.exportChannel,
    expectedPerHour: Math.max(1, Math.round(60 / Math.min(60, intervalMinutes))),
  });
}

function modeOf(arr) {
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
  let best = arr[0], bn = 0;
  for (const [v, n] of c) if (n > bn) { bn = n; best = v; }
  return best;
}

/**
 * Shared back-end of `toHourly` and `mergeLoadSets`: take a map of
 * hourKey -> {kwh, exp, n}, lay it on a continuous grid, note DST oddities,
 * fill short gaps and NaN long ones.
 */
function buildSeries(slots, opts) {
  const notes = [];
  const gapsFilled = [];
  const keys = Array.from(slots.keys()).sort((a, b) => a - b);
  if (!keys.length) {
    return {
      ts: [], kwh: new Float64Array(0), exportKwh: null,
      intervalMinutes: opts.intervalMinutes || 60, gapsFilled, notes: ["no readings found"],
      quality: { hours: 0, days: 0, years: 0, missing: 0, filled: 0, partialHours: 0 },
    };
  }

  // -- DST bookkeeping -------------------------------------------------------
  const first = keyParts(keys[0]), last = keyParts(keys[keys.length - 1]);
  const springDates = new Set(), fallDates = new Set();
  for (let y = first.y; y <= last.y; y++) { springDates.add(dstStartDate(y)); fallDates.add(dstEndDate(y)); }

  const expected = opts.expectedPerHour || 1;

  // -- partial sub-hourly hours (P1) ------------------------------------------
  // A 15-minute hour with readings missing would otherwise be summed short and look
  // like a quiet hour.  At least half the hour present: scale it up to 60 minutes.
  // Less than half: drop it, so it is filled or NaN-ed below exactly like a gap.
  let partialScaled = 0, partialDropped = 0;
  if (expected > 1) {
    for (const k of keys) {
      const s = slots.get(k);
      if (s.min == null || s.n > expected || s.min >= 60) continue;
      if (s.min >= 30) {
        const f = 60 / s.min;
        s.kwh *= f; s.exp *= f; s.min = 60;
        partialScaled++;
      } else {
        slots.delete(k);
        partialDropped++;
      }
    }
    if (partialDropped) {
      for (let q = keys.length - 1; q >= 0; q--) if (!slots.has(keys[q])) keys.splice(q, 1);
    }
    if (partialScaled) {
      notes.push(`${partialScaled} hours had only some of their ${opts.intervalMinutes}-minute ` +
                 `readings (at least half); each was scaled up to a full hour`);
    }
    if (partialDropped) {
      notes.push(`${partialDropped} hours had less than half of their ` +
                 `${opts.intervalMinutes}-minute readings and were treated as missing`);
    }
    if (!keys.length) {
      return {
        ts: [], kwh: new Float64Array(0), exportKwh: null,
        intervalMinutes: opts.intervalMinutes || 60, gapsFilled, notes: notes.concat(["no readings found"]),
        quality: { hours: 0, days: 0, years: 0, missing: 0, filled: 0, partialHours: partialScaled + partialDropped },
      };
    }
  }

  const dupDays = new Map();
  for (const k of keys) {
    const s = slots.get(k);
    if (s.n > expected) {
      const d = dateOfKey(k);
      if (!dupDays.has(d)) dupDays.set(d, []);
      dupDays.get(d).push(k);
    }
  }
  for (const [d, ks] of dupDays) {
    const where = ks.map((k) => `${pad2(keyParts(k).h)}:00`).join(", ");
    notes.push(fallDates.has(d)
      ? `${d} ${where} duplicated (DST fall-back 25-hour day); the readings were summed into one hour slot`
      : `${d} ${where} duplicated (not a DST date); readings summed`);
  }

  // -- build the continuous grid --------------------------------------------
  // The grid runs from the first to the last reading, so every hole in it is a
  // real gap; a ragged first/last day simply is not part of the record.
  const kStart = keys[0], kEnd = keys[keys.length - 1];
  const grid = [];                       // { key, val | undefined }
  const missingKeys = [];
  for (let k = kStart; k <= kEnd; k++) {
    if (slots.has(k)) { grid.push(k); continue; }
    const d = dateOfKey(k);
    if (springDates.has(d)) {
      // one missing clock hour on the spring-forward date is not a gap
      let present = 0;
      for (let h = 0; h < 24; h++) if (slots.has(k - keyParts(k).h + h)) present++;
      if (present === 23) {
        notes.push(`${d} has 23 hours (DST spring-forward); hour ${pad2(keyParts(k).h)}:00 ` +
                   `does not exist in local clock time and was not treated as a gap`);
        continue;
      }
    }
    grid.push(k);
    missingKeys.push(k);
  }

  // -- gap runs --------------------------------------------------------------
  const missingSet = new Set(missingKeys);
  let filled = 0, stillMissing = 0;
  let i = 0;
  while (i < missingKeys.length) {
    let j = i;
    while (j + 1 < missingKeys.length && missingKeys[j + 1] === missingKeys[j] + 1) j++;
    const runLen = j - i + 1;
    if (runLen <= MAX_FILL_RUN) {
      for (let q = i; q <= j; q++) {
        const k = missingKeys[q];
        const vals = [], exps = [];
        for (const off of [1, 2, 3]) {
          for (const sgn of [-1, 1]) {
            const nk = k + sgn * off * 24;
            const s = slots.get(nk);
            if (s && !missingSet.has(nk) && Number.isFinite(s.kwh)) {
              vals.push(s.kwh); exps.push(Number.isFinite(s.exp) ? s.exp : 0);
            }
          }
          if (vals.length) break;
        }
        const fill = vals.length ? round3(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
        const fillE = exps.length ? round3(exps.reduce((a, b) => a + b, 0) / exps.length) : 0;
        slots.set(k, { kwh: fill, exp: fillE, n: 0 });
        gapsFilled.push({
          ts: fmtKey(k), kwh: fill,
          method: vals.length ? "mean of the same hour on adjacent days" : "zero (no neighbours)",
        });
        filled++;
      }
    } else {
      for (let q = i; q <= j; q++) {
        slots.set(missingKeys[q], { kwh: NaN, exp: NaN, n: 0 });
        stillMissing++;
      }
      notes.push(`${fmtKey(missingKeys[i])} .. ${fmtKey(missingKeys[j])}: ${runLen} consecutive ` +
                 `hours missing (longer than ${MAX_FILL_RUN} h) - left as NaN`);
    }
    i = j + 1;
  }

  // -- emit ------------------------------------------------------------------
  const N = grid.length;
  const ts = new Array(N);
  const kwh = new Float64Array(N);
  const exp = new Float64Array(N);
  const days = new Set();
  let total = 0;
  for (let q = 0; q < N; q++) {
    const k = grid[q], s = slots.get(k);
    ts[q] = fmtKey(k);
    kwh[q] = Number.isNaN(s.kwh) ? NaN : round3(s.kwh);
    exp[q] = Number.isNaN(s.exp) ? NaN : round3(s.exp);
    if (!Number.isNaN(kwh[q])) total += kwh[q];
    days.add(ts[q].slice(0, 10));
  }

  let hasExport = false;
  for (let q = 0; q < N; q++) if (exp[q] > 0) { hasExport = true; break; }
  if (opts.anyExport && !hasExport) {
    notes.push("Received (export) energy is 0 kWh over the whole record - no existing PV/export.");
  }

  return {
    ts, kwh, exportKwh: hasExport ? exp : null,
    totalKwh: round3(total),
    intervalMinutes: opts.intervalMinutes || 60,
    gapsFilled, notes,
    quality: {
      hours: N, days: days.size, years: N / HOURS_PER_YEAR,
      missing: stillMissing, filled,
      partialHours: partialScaled + partialDropped,   // scaled up + dropped as gaps
    },
  };
}

function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function finish(series, meta) {
  return {
    meta: {
      source: meta.source,
      tz: meta.tz || "America/Los_Angeles",
      start: series.ts.length ? series.ts[0] : null,
      end: series.ts.length ? series.ts[series.ts.length - 1] : null,
      nHours: series.ts.length,
      totalKwh: series.totalKwh || 0,
      intervalMinutes: series.intervalMinutes,
      gapsFilled: series.gapsFilled,
      notes: dedupe((meta.notes || []).concat(series.notes)),
      zip: meta.zip || null,
      utilityHint: meta.utilityHint || null,
      quality: series.quality,
    },
    ts: series.ts,
    kwh: series.kwh,
    exportKwh: series.exportKwh,
  };
}

// ------------------------------------------------------------------ SCE CSV
/**
 * SCE "Energy Usage Information" export.
 *
 *   12 preamble lines (one of them an unbalanced quote), then
 *   Date,Energy Consumption time Period Start,Energy Consumption time Period End,Delivered,Received
 *   "09/01/2025 ","09/01/2025 12:00AM ","09/01/2025 01:00AM ","1.398","0.000"
 *
 * Fields are padded with U+00A0, times are 12-hour with and without a leading
 * zero, and the file may carry a UTF-8 BOM.  On the fall-back date SCE emits 25
 * rows with one duplicated clock label; on the spring-forward date, 23.
 */
export function parseSceCsv(text, opts = {}) {
  const raw = stripBom(String(text));
  const rows = parseCsvRows(raw, ",");
  const header = raw.slice(0, raw.search(/^\s*"?Date\s*,/mi) + 1 || 4000);

  const intervals = [];
  let bad = 0;
  for (const r of rows) {
    if (r.length < 5) continue;
    const p = parseStamp(r[1]);
    if (!p) continue;
    const end = parseStamp(r[2]);
    const delivered = num(r[3]);
    const received = num(r[4]);
    if (delivered == null) { bad++; continue; }
    let dur = 60;
    if (end) {
      const d = (Date.UTC(end.y, end.mo - 1, end.d, end.h, end.mi) -
                 Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)) / 60000;
      // Any positive span counts (a daily export is 1440 and must be refused, not
      // squeezed into one hour); "11:59PM"-style inclusive ends round up.
      if (d > 0) dur = d >= 14 && d % 5 === 4 ? d + 1 : d;
    }
    intervals.push({ start: p, durationMinutes: dur, kwh: delivered, exportKwh: received || 0 });
  }
  if (!intervals.length) throw new Error("SCE CSV: no interval rows found");

  const series = toHourly(intervals, { ...opts, exportChannel: true, utilityHint: "sce" });
  const notes = [];
  if (bad) notes.push(`${bad} unparseable rows skipped`);
  notes.push("Timestamps are the local prevailing (clock) time printed by SCE (PDT in summer, " +
             "PST in winter), one entry per metered hour, period START.");
  return finish(series, {
    source: "sce-csv", tz: opts.tz || "America/Los_Angeles",
    zip: findZip(header), utilityHint: "sce", notes,
  });
}

// ----------------------------------------------------------------- PG&E CSV
/**
 * PG&E "Electric usage" Green Button download.
 *
 *   Name,JANE DOE                       <- discarded
 *   Address,"1 Main St, Oakland, CA 94610"   <- only the ZIP is kept
 *   Account Number,1234567890           <- discarded
 *   Service,Electric service
 *
 *   Electric usage
 *   TYPE,DATE,START TIME,END TIME,USAGE (kWh),COST,NOTES
 *   Electric usage,2025-06-01,00:00,00:14,0.12,$0.04,
 *
 * 15-minute or hourly.  Gas rows (`TYPE` not containing "electric") are ignored.
 * A negative USAGE is treated as export (NEM meters write the received energy as
 * a negative delivered value).
 */
export function parsePgeCsv(text, opts = {}) {
  const raw = stripBom(String(text));
  const rows = parseCsvRows(raw, ",");
  const found = findHeaderRow(rows, 60, (cells) =>
    cells.includes("date") && cells.some((c) => c.startsWith("start time")));
  const col = found && {
    type: found.cells.indexOf("type"),
    date: found.cells.indexOf("date"),
    start: colStarting(found.cells, "start time"),
    end: colStarting(found.cells, "end time"),
    usage: colStarting(found.cells, "usage"),
  };
  if (!col || col.usage < 0) throw new Error("PG&E CSV: no TYPE,DATE,START TIME,... header row found");
  const hdr = found.hdr;

  const headerText = headerBlock(rows, hdr);
  const intervals = [];
  let bad = 0, skippedGas = 0;
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= col.usage) continue;
    if (col.type >= 0) {
      const t = clean(r[col.type]).toLowerCase();
      if (t && !t.includes("electric")) { skippedGas++; continue; }
    }
    const d = parseDateParts(r[col.date]);
    const t0 = parseTimeParts(r[col.start]);
    if (!d || !t0) { if (clean(r[col.date])) bad++; continue; }
    const v = num(r[col.usage]);
    if (v == null) { bad++; continue; }
    let dur = 60;
    if (col.end >= 0) {
      const t1 = parseTimeParts(r[col.end]);
      if (t1) {
        let mins = (t1.h * 60 + t1.mi) - (t0.h * 60 + t0.mi);
        if (mins < 0) mins += 1440;
        // PG&E prints the INCLUSIVE last minute of the interval ("00:00" -> "00:14")
        dur = mins + 1 >= 15 && mins % 5 === 4 ? mins + 1 : (mins || 60);
      }
    }
    intervals.push({
      start: { y: d.y, mo: d.mo, d: d.d, h: t0.h, mi: t0.mi },
      durationMinutes: dur,
      kwh: v > 0 ? v : 0,
      exportKwh: v < 0 ? -v : 0,
    });
  }
  if (!intervals.length) throw new Error("PG&E CSV: no usage rows found");

  const series = toHourly(intervals, { ...opts, utilityHint: "pge" });
  const notes = ["Customer name, service address and account number were discarded at parse time."];
  if (bad) notes.push(`${bad} unparseable rows skipped`);
  if (skippedGas) notes.push(`${skippedGas} non-electric rows skipped`);
  return finish(series, {
    source: "pge-csv", tz: opts.tz || "America/Los_Angeles",
    zip: findZip(headerText), utilityHint: "pge", notes,
  });
}

// ----------------------------------------------------------------- SDG&E CSV
/**
 * SDG&E Green Button CSV.
 *
 *   <a header block with the account / meter / address>   <- discarded
 *   Meter Number,Date,Start Time,Duration,Consumption,Generation,Net
 *   1234567,09/01/2025,00:00,01:00:00,1.398,0.000,1.398
 *
 * Duration is either "HH:MM:SS" or a plain minute count.  `Consumption` is
 * delivered energy, `Generation` is received.  The meter number is dropped.
 */
export function parseSdgeCsv(text, opts = {}) {
  const raw = stripBom(String(text));
  const rows = parseCsvRows(raw, ",");
  const found = findHeaderRow(rows, 80, (cells) =>
    cells.includes("date") && cells.some((c) => c.startsWith("start time")) &&
    cells.some((c) => c.startsWith("consumption")));
  if (!found) throw new Error("SDG&E CSV: no Meter Number,Date,Start Time,... header row found");
  const { hdr, cells } = found;
  const col = {
    date: cells.indexOf("date"),
    start: colStarting(cells, "start time"),
    dur: colStarting(cells, "duration"),
    cons: colStarting(cells, "consumption"),
    gen: colStarting(cells, "generation"),
  };

  const headerText = headerBlock(rows, hdr);
  const intervals = [];
  let bad = 0;
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= col.cons) continue;
    const d = parseDateParts(r[col.date]);
    const t0 = parseTimeParts(r[col.start]);
    const v = num(r[col.cons]);
    if (!d || !t0 || v == null) { if (clean(r[col.date])) bad++; continue; }
    let dur = 60;
    if (col.dur >= 0) {
      const s = clean(r[col.dur]);
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
      dur = m ? +m[1] * 60 + +m[2] : num(s);
      if (!(dur > 0)) dur = 60;
    }
    const gen = col.gen >= 0 ? (num(r[col.gen]) || 0) : 0;
    intervals.push({
      start: { y: d.y, mo: d.mo, d: d.d, h: t0.h, mi: t0.mi },
      durationMinutes: dur, kwh: v, exportKwh: gen,
    });
  }
  if (!intervals.length) throw new Error("SDG&E CSV: no interval rows found");

  const series = toHourly(intervals, { ...opts, exportChannel: col.gen >= 0, utilityHint: "sdge" });
  const notes = ["Meter number, account number and service address were discarded at parse time."];
  if (bad) notes.push(`${bad} unparseable rows skipped`);
  return finish(series, {
    source: "sdge-csv", tz: opts.tz || "America/Los_Angeles",
    zip: findZip(headerText), utilityHint: "sdge", notes,
  });
}

// ------------------------------------------------------------- XML plumbing
/**
 * A tolerant XML walker.  In a browser it uses the platform DOMParser; in Node
 * (and if DOMParser chokes) it falls back to a small regex/stack parser.  Both
 * produce the same node shape:
 *
 *   { name, lname (lower-case local name), attrs: {}, children: [], text }
 *
 * This is deliberately NOT a conforming XML parser.  It is enough to walk an
 * ESPI Atom feed, and it never evaluates entities, DTDs or external references.
 */
export function xmlWalk(text) {
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      const err = doc.getElementsByTagName("parsererror");
      if (!err || !err.length) {
        // wrap so the DOM path and the fallback path have the same root shape
        return { name: "#document", lname: "#document", attrs: {},
                 children: [fromDom(doc.documentElement)], text: "" };
      }
    } catch { /* fall through to the regex parser */ }
  }
  return xmlWalkFallback(text);
}

function fromDom(el) {
  if (!el) return { name: "#document", lname: "#document", attrs: {}, children: [], text: "" };
  const attrs = {};
  for (const a of el.attributes || []) attrs[a.name.replace(/^.*:/, "")] = a.value;
  const node = {
    name: el.nodeName, lname: String(el.localName || el.nodeName).toLowerCase(),
    attrs, children: [], text: "",
  };
  for (const c of el.childNodes) {
    if (c.nodeType === 1) node.children.push(fromDom(c));
    else if (c.nodeType === 3 || c.nodeType === 4) node.text += c.nodeValue;
  }
  return node;
}

const TAG_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\s*\/\s*([A-Za-z_][\w.\-:]*)\s*>|<\s*([A-Za-z_][\w.\-:]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;
const ATTR_RE = /([\w.\-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

export function xmlWalkFallback(text) {
  const root = { name: "#document", lname: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.text += text.slice(last, m.index);
    last = TAG_RE.lastIndex;
    if (m[1] !== undefined) { top.text += m[1]; continue; }        // CDATA
    if (m[2] !== undefined) {                                       // close tag
      const l = m[2].replace(/^.*:/, "").toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].lname === l) { stack.length = i; break; }
      }
      continue;
    }
    if (m[3] === undefined) continue;                               // comment / PI / doctype
    const attrs = {};
    if (m[4]) {
      ATTR_RE.lastIndex = 0;
      let a;
      while ((a = ATTR_RE.exec(m[4]))) {
        attrs[a[1].replace(/^.*:/, "")] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4];
      }
    }
    const node = {
      name: m[3], lname: m[3].replace(/^.*:/, "").toLowerCase(),
      attrs, children: [], text: "",
    };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  const top = stack[stack.length - 1];
  if (last < text.length) top.text += text.slice(last);
  return root;
}

/** Depth-first, document order, every descendant whose local name matches. */
function findAll(node, lname, out = []) {
  for (const c of node.children) {
    if (c.lname === lname) out.push(c);
    findAll(c, lname, out);
  }
  return out;
}

function firstText(node, lname) {
  for (const c of node.children) {
    if (c.lname === lname) return clean(c.text);
    const deep = firstText(c, lname);
    if (deep !== null) return deep;
  }
  return null;
}

// ------------------------------------------------------------------ ESPI XML
/**
 * ESPI (Green Button "Download my data") Atom feed.
 *
 *   <LocalTimeParameters><dstOffset>3600</dstOffset><tzOffset>-28800</tzOffset>
 *   <UsagePoint><ServiceCategory><kind>0</kind></ServiceCategory></UsagePoint>
 *   <ReadingType><flowDirection>1</flowDirection><powerOfTenMultiplier>0</powerOfTenMultiplier>
 *                <uom>72</uom></ReadingType>
 *   <IntervalBlock><IntervalReading>
 *       <timePeriod><duration>3600</duration><start>1725174000</start></timePeriod>
 *       <value>1398</value></IntervalReading> ...
 *
 * `start` is epoch seconds (UTC).  We convert to LOCAL CLOCK time with
 * tzOffset + dstOffset, using the US DST rule (the feed's dstStartRule /
 * dstEndRule bitfields are not decoded - every supported utility is US).
 *
 * Which ReadingType governs an IntervalBlock: the Atom links say so.  A
 * MeterReading entry links (rel="related") to its ReadingType and to its
 * IntervalBlock collection; an IntervalBlock entry's self/up href sits under that
 * MeterReading; a MeterReading sits under its UsagePoint, which carries
 * ServiceCategory kind (0 = electricity, 1 = gas, 2 = water ...).  Where the feed
 * has no usable links we fall back to document order: a ReadingType governs the
 * blocks that follow it, and a sole ReadingType governs everything.
 *
 * Accepted: blocks whose ReadingType uom is 72 (Wh) - or carries no uom - on a
 * UsagePoint that is electricity or unstated.  Everything else (gas in therms, uom
 * 169; water; demand in W, uom 38; reactive energy...) is skipped and named in
 * meta.notes.  kWh = value * 10^powerOfTenMultiplier / 1000.
 *
 * flowDirection: 1 = forward (delivered, import), 19 = reverse (received, export),
 * 4 = net (positive = import, negative = export, split the way the PG&E and generic
 * parsers split a signed column).  When a feed carries forward or reverse channels
 * AND a net channel, the net channel is dropped so energy is not counted twice.  A
 * negative value never reaches `kwh`.
 *
 * Titles, UsagePoint ids and ServiceLocation blocks are never read.
 */
const SERVICE_KINDS = ["electricity", "gas", "water", "time", "heat", "refuse", "sewerage",
                       "rates", "tvLicence", "internet"];
const UOM_NAMES = { 72: "Wh", 169: "therm", 38: "W", 73: "VArh", 63: "VAr", 61: "VA", 71: "VAh",
                    42: "m3", 119: "ft3", 128: "US gal", 132: "Btu" };

export function parseEspiXml(text, opts = {}) {
  const doc = xmlWalk(stripBom(String(text)));

  const ltp = findAll(doc, "localtimeparameters")[0];
  const tzOffset = ltp ? +(firstText(ltp, "tzoffset") || 0) : -28800;
  const dstOffset = ltp ? +(firstText(ltp, "dstoffset") || 0) : 3600;

  // Walk in document order, remembering which Atom entry (and so which links) each
  // UsagePoint / MeterReading / ReadingType / IntervalBlock came from.
  const ordered = [];
  (function walk(n, entry) {
    for (const c of n.children) {
      const e = c.lname === "entry" ? c : entry;
      if (c.lname === "readingtype") ordered.push({ kind: "rt", node: c, links: espiLinks(entry) });
      else if (c.lname === "intervalblock") ordered.push({ kind: "ib", node: c, links: espiLinks(entry) });
      else if (c.lname === "meterreading") ordered.push({ kind: "mr", node: c, links: espiLinks(entry) });
      else if (c.lname === "usagepoint") {
        const sc = findAll(c, "servicecategory")[0];
        const k = sc ? firstText(sc, "kind") : null;
        ordered.push({ kind: "up", node: c, links: espiLinks(entry),
                       service: k == null || k === "" ? null : +k });
        walk(c, e);
      } else walk(c, e);
    }
  })(doc, null);

  const rts = ordered.filter((o) => o.kind === "rt");
  const mrs = ordered.filter((o) => o.kind === "mr");
  const ups = ordered.filter((o) => o.kind === "up");
  for (const o of rts) o.info = rtInfo(o.node);

  // ---- link resolution ----------------------------------------------------
  const rtBySelf = new Map();
  for (const o of rts) if (o.links.self) rtBySelf.set(o.links.self, o);
  for (const mr of mrs) {
    mr.rt = null;
    for (const h of mr.links.related) if (rtBySelf.has(h)) { mr.rt = rtBySelf.get(h); break; }
    mr.up = ups.find((u) => u.links.self && mr.links.self && isUnder(mr.links.self, u.links.self)) ||
            ups.find((u) => u.links.related.some((h) => h === mr.links.up)) || null;
  }
  const mrOf = (ib) => {
    const at = [ib.links.self, ib.links.up].filter(Boolean);
    return mrs.find((mr) => mr.links.self && at.some((h) => isUnder(h, mr.links.self))) ||
           mrs.find((mr) => at.some((h) => mr.links.related.includes(h))) || null;
  };

  // A sole ReadingType governs the whole feed, including blocks that precede it;
  // otherwise, without links, each one governs the blocks that follow it.
  const soleRt = rts.length === 1 ? rts[0] : null;
  let docRt = soleRt, docUp = null, linked = 0;
  const blocks = [];
  for (const o of ordered) {
    if (o.kind === "rt") { if (!soleRt) docRt = o; continue; }
    if (o.kind === "up") { docUp = o; continue; }
    if (o.kind !== "ib") continue;
    const mr = mrOf(o);
    let rt = mr && mr.rt, up = mr && mr.up;
    if (rt) linked++;
    if (!rt) rt = docRt;
    if (!up) up = ups.length === 1 ? ups[0] : docUp;
    blocks.push({ node: o.node, info: rt ? rt.info : { flow: 1, pot: 0, uom: null },
                  service: up ? up.service : null });
  }

  // ---- what to keep --------------------------------------------------------
  const skipped = new Map();          // description -> readings
  const keep = [];
  for (const b of blocks) {
    const { uom, flow } = b.info;
    const elec = b.service == null || b.service === 0;
    const wh = uom == null || uom === 72;
    if (elec && wh) { keep.push(b); continue; }
    const n = findAll(b.node, "intervalreading").length;
    const svc = b.service == null ? "unstated" : (SERVICE_KINDS[b.service] || `kind ${b.service}`);
    const desc = `${svc} UsagePoint, uom ${uom == null ? "unstated" : uom}` +
      (uom != null && UOM_NAMES[uom] ? ` (${UOM_NAMES[uom]})` : "") + `, flowDirection ${flow}`;
    skipped.set(desc, (skipped.get(desc) || 0) + n);
  }
  const hasDirectional = keep.some((b) => b.info.flow === 1 || b.info.flow === 19);
  let netDropped = 0;

  const intervals = [];
  let sawExport = false, sawNet = false, negFolded = 0;
  for (const b of keep) {
    const { flow, pot } = b.info;
    if (flow === 4 && hasDirectional) {
      netDropped += findAll(b.node, "intervalreading").length;
      continue;
    }
    for (const rd of findAll(b.node, "intervalreading")) {
      const tp = findAll(rd, "timeperiod")[0] || rd;
      const start = +(firstText(tp, "start") || NaN);
      const duration = +(firstText(tp, "duration") || 3600);
      const value = +(firstText(rd, "value") || NaN);
      if (!Number.isFinite(start) || !Number.isFinite(value)) continue;
      const kwh = value * Math.pow(10, pot) / 1000;
      const p = epochToLocalParts(start, tzOffset, dstOffset);
      let imp = 0, exp = 0;
      if (flow === 19) exp = Math.abs(kwh);
      else {
        // forward, net, or anything else: positive is import, negative is export
        if (flow === 4) sawNet = true;
        else if (kwh < 0) negFolded++;
        if (kwh >= 0) imp = kwh; else exp = -kwh;
      }
      if (exp) sawExport = true;
      intervals.push({
        start: p,
        durationMinutes: Math.max(1, Math.round(duration / 60)),
        kwh: imp,
        exportKwh: exp,
      });
    }
  }
  if (!intervals.length) {
    if (skipped.size) {
      const what = Array.from(skipped.keys()).join("; ");
      throw new LoadFileError(`ESPI XML: no electricity readings in Wh (skipped ${what})`, {
        code: "no-electric",
        userMessage: "This Green Button file has no electricity interval readings (it looks like " +
          "gas or another service). Download the electric usage file instead.",
      });
    }
    throw new Error("ESPI XML: no IntervalReading elements found");
  }

  const series = toHourly(intervals, { ...opts, exportChannel: sawExport });
  const notes = [
    "Feed titles, UsagePoint ids and ServiceLocation blocks were never read.",
    `tzOffset ${tzOffset}s, dstOffset ${dstOffset}s; timestamps converted to local clock time ` +
    `using the US DST rule (2nd Sunday of March -> 1st Sunday of November).`,
  ];
  if (rts.length > 1) {
    notes.push(linked === blocks.length
      ? `${rts.length} ReadingType blocks; each IntervalBlock was matched to its ReadingType through the MeterReading links.`
      : `${rts.length} ReadingType blocks; ${linked} of ${blocks.length} IntervalBlocks were matched through ` +
        `MeterReading links, the rest to the ReadingType that precedes them in the document.`);
  }
  for (const [desc, n] of skipped) notes.push(`skipped ${desc}: ${n} readings are not electricity energy in Wh`);
  if (netDropped) notes.push(`skipped ${netDropped} net (flowDirection 4) readings because the feed also has forward/reverse channels`);
  if (sawNet) notes.push("flowDirection 4 (net) readings were split: positive kept as import, negative as export.");
  if (negFolded) notes.push(`${negFolded} negative forward readings were kept as export, never as negative load.`);
  if (sawExport) notes.push("flowDirection 19 readings were kept as export (received) energy.");
  return finish(series, {
    source: "espi-xml", tz: opts.tz || tzToName(tzOffset),
    zip: espiZip(doc), utilityHint: opts.utilityHint || null, notes,
  });
}

/** The Atom links of one entry: { self, up, related: [] }, hrefs normalised. */
function espiLinks(entry) {
  const out = { self: null, up: null, related: [] };
  if (!entry) return out;
  for (const c of entry.children) {
    if (c.lname !== "link" || !c.attrs.href) continue;
    const h = normHref(c.attrs.href), rel = String(c.attrs.rel || "").toLowerCase();
    if (rel === "self") out.self = h;
    else if (rel === "up") out.up = h;
    else if (rel === "related") out.related.push(h);
  }
  return out;
}

/** Path only, no scheme/host, no trailing slash, case-insensitive. */
function normHref(h) {
  return String(h).trim().replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\/+$/, "").toLowerCase();
}

function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + "/");
}

/** The one identifying field an ESPI feed may keep: the service location's ZIP. */
function espiZip(doc) {
  const pc = clean(firstText(doc, "postalcode") || "");
  if (/^\d{5}(-\d{4})?$/.test(pc)) return pc.slice(0, 5);
  return findZip(pc);
}

function rtInfo(node) {
  const u = firstText(node, "uom");
  return {
    flow: +(firstText(node, "flowdirection") || 1),
    pot: +(firstText(node, "poweroftenmultiplier") || 0),
    uom: u == null || u === "" ? null : +u,          // null = unstated, read as Wh
  };
}

function tzToName(off) {
  return { "-28800": "America/Los_Angeles", "-25200": "America/Denver",
           "-21600": "America/Chicago", "-18000": "America/New_York" }[String(off)] ||
         "America/Los_Angeles";
}

/** epoch seconds -> naive local clock {y,mo,d,h,mi} under the US DST rule. */
function epochToLocalParts(epochSec, tzOffset, dstOffset) {
  const std = new Date((epochSec + tzOffset) * 1000);
  const y = std.getUTCFullYear();
  let dst = false;
  if (dstOffset) {
    const spring = Date.UTC(y, 2, nthWeekday(y, 3, 0, 2), 2) / 1000 - tzOffset;
    const fall = Date.UTC(y, 10, nthWeekday(y, 11, 0, 1), 2) / 1000 - tzOffset - dstOffset;
    dst = epochSec >= spring && epochSec < fall;
  }
  const loc = new Date((epochSec + tzOffset + (dst ? dstOffset : 0)) * 1000);
  return {
    y: loc.getUTCFullYear(), mo: loc.getUTCMonth() + 1, d: loc.getUTCDate(),
    h: loc.getUTCHours(), mi: loc.getUTCMinutes(),
  };
}

// ----------------------------------------------------------- UTC -> local
const LOCAL_FMT = new Map();

/**
 * Convert a stamp that carried a UTC offset (`p.off`, minutes east of UTC) to the
 * naive local clock time of `tz`, with the platform's own zone rules
 * (Intl.DateTimeFormat - no library).  Two UTC hours that land on the same local
 * clock hour (the fall-back hour) are later summed into one slot, as everywhere else.
 */
function toLocalClock(p, tz, cache) {
  const utcMs = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - p.off * 60000;
  const hourMs = Math.floor(utcMs / 3600000) * 3600000;
  let base = cache.get(hourMs);
  if (!base) {
    let fmt = LOCAL_FMT.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      LOCAL_FMT.set(tz, fmt);
    }
    const parts = {};
    for (const x of fmt.formatToParts(new Date(hourMs))) parts[x.type] = x.value;
    base = { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute };
    cache.set(hourMs, base);
  }
  // Every US zone is a whole number of hours off UTC, so the minutes carry straight
  // over.  A zone that is not (base.mi != 0) is formatted minute by minute instead.
  if (base.mi === 0) return { y: base.y, mo: base.mo, d: base.d, h: base.h, mi: Math.round((utcMs - hourMs) / 60000) };
  const parts = {};
  for (const x of LOCAL_FMT.get(tz).formatToParts(new Date(utcMs))) parts[x.type] = x.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute };
}

// --------------------------------------------------------------- generic CSV
/**
 * Last-resort parser: any delimited text with a timestamp column and a kWh
 * column.  The delimiter is sniffed (`, ; TAB |`) and the header row is the first
 * row in the first 40 that names both a time-ish and an energy-ish column.
 *
 * LIMITS (documented because this path guesses):
 *   - timestamps without an offset are taken as LOCAL CLOCK time; a stamp with a
 *     trailing "Z" or "+hh:mm"/"-hhmm" offset (fractional seconds allowed) is
 *     converted to the local clock of `opts.tz` (default America/Los_Angeles) with
 *     Intl.DateTimeFormat, and a note says so.
 *   - ambiguous numeric dates are read US-style, month first (03/04 = 4 March... no:
 *     = March 4th).
 *   - values must already be ENERGY in kWh for the interval.  A column of average
 *     kW, or of Wh, is not converted.
 *   - one meter channel plus at most one export channel; multi-meter files should
 *     be split before upload.
 *   - the interval length is taken from the start/end (or duration) columns when
 *     present, otherwise from the gap between the first two rows.
 */
export function parseGenericCsv(text, opts = {}) {
  const raw = stripBom(String(text));
  const delim = opts.delimiter || sniffDelimiter(raw);
  const rows = parseCsvRows(raw, delim).filter((r) => r.length > 1);

  const TIME_RE = /(date|time|timestamp|interval|period|start|read)/i;
  const KWH_RE = /(kwh|usage|consumption|delivered|energy|import|value|quantity)/i;
  const EXP_RE = /(received|generation|export|surplus|produced|delivered to grid)/i;
  const DUR_RE = /(duration|length|interval\s*(min|len))/i;

  let hdr = -1, cells = null;
  for (let i = 0; i < rows.length && i < 40; i++) {
    const c = rows[i].map((x) => clean(x));
    const hasTime = c.some((x) => TIME_RE.test(x));
    const hasKwh = c.some((x) => KWH_RE.test(x));
    const numeric = c.filter((x) => num(x) != null).length;
    if (hasTime && hasKwh && numeric <= 1) { hdr = i; cells = c; break; }
  }
  if (hdr < 0) throw new Error("generic CSV: could not find a header row naming a time column and a kWh column");

  const low = cells.map((c) => c.toLowerCase());
  const firstMatch = (re) => low.findIndex((c) => re.test(c));
  const expCol = firstMatch(EXP_RE);
  let kwhCol = -1, kwhScore = -1;
  for (let i = 0; i < low.length; i++) {
    if (i === expCol || !KWH_RE.test(low[i])) continue;
    const s = /kwh/.test(low[i]) ? 3 : /usage|consumption|delivered/.test(low[i]) ? 2 : 1;
    if (s > kwhScore) { kwhScore = s; kwhCol = i; }
  }
  if (kwhCol < 0) throw new Error("generic CSV: no kWh column found");

  const durCol = firstMatch(DUR_RE);
  // A single combined timestamp column, or a date column plus a start-time column.
  let dtCol = -1, dateCol = -1, timeCol = -1, endCol = -1;
  for (let i = 0; i < low.length; i++) {
    if (i === kwhCol || i === expCol || i === durCol) continue;
    if (!TIME_RE.test(low[i])) continue;
    if (/end/.test(low[i])) { if (endCol < 0) endCol = i; continue; }
    if (/^date$/.test(low[i]) || /\bdate\b/.test(low[i]) && !/time/.test(low[i])) { if (dateCol < 0) dateCol = i; continue; }
    if (/time/.test(low[i]) && dateCol >= 0 && timeCol < 0) { timeCol = i; continue; }
    if (dtCol < 0) dtCol = i;
  }
  if (dtCol < 0 && dateCol < 0) throw new Error("generic CSV: no timestamp column found");

  const tz = opts.tz || "America/Los_Angeles";
  const tzCache = new Map();
  const intervals = [];
  let bad = 0, prev = null, inferredDur = null, converted = 0, convertedOff = null;
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= kwhCol) continue;
    let p = null;
    if (dateCol >= 0 && timeCol >= 0) {
      const d = parseDateParts(r[dateCol]), t = parseTimeParts(r[timeCol]);
      if (d && t) p = { y: d.y, mo: d.mo, d: d.d, h: t.h, mi: t.mi };
    } else {
      p = parseStamp(r[dtCol >= 0 ? dtCol : dateCol]);
    }
    const v = num(r[kwhCol]);
    if (!p || v == null) { if (r.some((x) => clean(x))) bad++; continue; }

    let dur = null;
    if (durCol >= 0) {
      const s = clean(r[durCol]);
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
      dur = m ? +m[1] * 60 + +m[2] : num(s);
      if (!(dur > 0)) dur = null;
    }
    if (dur == null && endCol >= 0) {
      const e = parseTimeParts(r[endCol]) || parseStamp(r[endCol]);
      if (e) {
        let mins = ((e.h * 60 + e.mi) - (p.h * 60 + p.mi) + 1440) % 1440;
        if (mins % 5 === 4) mins += 1;             // inclusive-last-minute style
        if (mins > 0) dur = mins;
      }
    }
    if (dur == null && prev) {
      if (inferredDur == null) {
        const dm = (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) -
                    Date.UTC(prev.y, prev.mo - 1, prev.d, prev.h, prev.mi)) / 60000;
        if (dm > 0 && dm <= 60) inferredDur = dm;
      }
      dur = inferredDur;
    }
    prev = p;
    // Durations above are measured on the stamps as printed; only then is a stamp
    // with a UTC offset moved onto the local clock.
    if (p.off != null) {
      if (convertedOff == null) convertedOff = p.off;
      p = toLocalClock(p, tz, tzCache);
      converted++;
    }
    const exp = expCol >= 0 ? (num(r[expCol]) || 0) : 0;
    // With no export column a negative value IS the export (a NEM meter writes received
    // energy as negative delivered); with one, a stray negative is simply floored at zero.
    intervals.push({
      start: p, durationMinutes: dur || 60,
      kwh: Math.max(0, v),
      exportKwh: exp || (expCol < 0 && v < 0 ? -v : 0),
    });
  }
  if (!intervals.length) throw new Error("generic CSV: no data rows parsed");

  const series = toHourly(intervals, opts);
  const notes = [
    `Generic CSV: delimiter ${JSON.stringify(delim)}, timestamp column ` +
    `${JSON.stringify(cells[dateCol >= 0 && timeCol >= 0 ? dateCol : (dtCol >= 0 ? dtCol : dateCol)])}` +
    `, energy column ${JSON.stringify(cells[kwhCol])}` +
    (expCol >= 0 ? `, export column ${JSON.stringify(cells[expCol])}` : "") + ".",
    converted
      ? "Values are assumed to be kWh of energy per interval; no unit conversion is applied."
      : "Values are assumed to be kWh of energy per interval in local clock time; no unit or " +
        "time-zone conversion is applied.",
  ];
  if (converted) {
    const o = convertedOff, sign = o < 0 ? "-" : "+", a = Math.abs(o);
    const first = o === 0 ? "Z" : `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
    notes.push(`${converted} of ${intervals.length} timestamps carried a UTC offset (the first ` +
               `was ${first}) and were converted to ${tz} local clock time.`);
  }
  if (bad) notes.push(`${bad} unparseable rows skipped`);
  return finish(series, {
    source: "generic-csv", tz: opts.tz || "America/Los_Angeles",
    zip: opts.zip || findZip(rows.slice(0, hdr).map((r) => r.join(" ")).join("\n")),
    utilityHint: opts.utilityHint || null, notes,
  });
}

// --------------------------------------------------------------------- parse
const PARSERS = {
  "sce-csv": parseSceCsv,
  "pge-csv": parsePgeCsv,
  "sdge-csv": parseSdgeCsv,
  "espi-xml": parseEspiXml,
  "generic-csv": parseGenericCsv,
};

/**
 * Auto-detect the format and parse.  `opts.filename` is only a tie-breaker for
 * `detectFormat`; `opts.format` forces one.  If the detected parser throws we
 * fall back to the generic CSV path before giving up, so a slightly-off vendor
 * export still lands.
 */
export function parse(text, opts = {}) {
  const src = stripBom(String(text || ""));
  if (!src.trim()) throw new Error("empty file");
  const fmt = opts.format || detectFormat(src, opts);
  const fn = PARSERS[fmt] || parseGenericCsv;
  try {
    return fn(src, opts);
  } catch (err) {
    // A file we read correctly but cannot use (daily data) must not be re-read as
    // something else; its userMessage is the answer.
    if (err instanceof LoadFileError) throw err;
    if (fmt === "generic-csv" || fmt === "espi-xml") throw err;
    const ls = parseGenericCsv(src, opts);
    ls.meta.notes.unshift(`${fmt} parser failed (${err.message}); fell back to the generic CSV reader.`);
    return ls;
  }
}

// ------------------------------------------------------------- mergeLoadSets
/**
 * Concatenate LoadSets chronologically.
 *
 *   - the sets are ordered by their first timestamp;
 *   - where two sets cover the same clock hour the LATER set's value wins
 *     (utilities re-issue corrected data in the newer export) and the overlap is
 *     counted in a note - but only a finite value ever wins: a NaN never overwrites;
 *   - when more than 5% of the overlapping hours differ by more than 5%, a note says
 *     the files may be from different meters;
 *   - quality.missing is recounted from the merged series;
 *   - the join is then re-gridded, so a hole BETWEEN two exports is filled
 *     (<= 3 h) or NaN-ed and reported exactly like a hole inside one.
 */
export function mergeLoadSets(sets) {
  const list = (sets || []).filter((s) => s && s.ts && s.ts.length);
  if (!list.length) throw new Error("mergeLoadSets: nothing to merge");
  if (list.length === 1) return list[0];

  const ordered = list.slice().sort((a, b) => (a.ts[0] < b.ts[0] ? -1 : a.ts[0] > b.ts[0] ? 1 : 0));
  // Only a finite reading is ever written: a NaN (an unfilled gap in one export)
  // must not overwrite the real value another export has for that hour.  Hours that
  // no export has a value for are simply absent, so buildSeries re-fills or NaN-s
  // them and counts them like any other gap.
  const slots = new Map();
  let overlap = 0, compared = 0, disagree = 0;
  let anyExport = false;
  for (const ls of ordered) {
    for (let i = 0; i < ls.ts.length; i++) {
      const v = ls.kwh[i];
      if (!Number.isFinite(v)) continue;
      const p = parseStamp(ls.ts[i]);
      const k = stampKeyHour(p);
      const prev = slots.get(k);
      if (prev) {
        overlap++;
        compared++;
        const big = Math.max(Math.abs(prev.kwh), Math.abs(v));
        if (Math.abs(prev.kwh - v) > 0.05 * big && Math.abs(prev.kwh - v) > 0.01) disagree++;
      }
      const e = ls.exportKwh ? ls.exportKwh[i] : 0;
      slots.set(k, { kwh: v, exp: Number.isFinite(e) ? e : 0, n: 1 });
    }
    if (ls.exportKwh) anyExport = true;      // subsumes every per-hour value in this set
  }

  const intervalMinutes = Math.min(...ordered.map((s) => s.meta.intervalMinutes || 60));
  const series = buildSeries(slots, { intervalMinutes, anyExport, expectedPerHour: 1 });
  // Count what is actually NaN in the merged series, not what buildSeries happened to fill.
  let nan = 0;
  for (const v of series.kwh) if (Number.isNaN(v)) nan++;
  series.quality.missing = nan;

  const sources = Array.from(new Set(ordered.map((s) => s.meta.source)));
  const notes = [];
  if (overlap) notes.push(`${overlap} clock hours were present in more than one export; ` +
                          `the later export's value was kept.`);
  if (compared && disagree > 0.05 * compared) {
    notes.push(`${disagree} of ${compared} overlapping hours differ by more than 5% between ` +
               `exports; the files may be from different meters or accounts. Check that every ` +
               `file is for the same home.`);
  }
  for (const ls of ordered) for (const n of ls.meta.notes) if (!notes.includes(n)) notes.push(n);

  const zip = ordered.map((s) => s.meta.zip).find(Boolean) || null;
  const hint = ordered.map((s) => s.meta.utilityHint).find(Boolean) || null;
  const out = finish(series, {
    source: sources.length === 1 ? sources[0] : "merged",
    tz: ordered[0].meta.tz, zip, utilityHint: hint, notes,
  });
  out.meta.gapsFilled = ordered.reduce((a, s) => a.concat(s.meta.gapsFilled || []), [])
    .concat(series.gapsFilled);
  out.meta.quality.filled = out.meta.gapsFilled.length;
  out.meta.quality.partialHours = ordered.reduce((a, s) => a + ((s.meta.quality && s.meta.quality.partialHours) || 0), 0);
  out.meta.sources = sources;
  return out;
}

// ------------------------------------------------------------------- exports
export default {
  LoadFileError,
  parse, detectFormat, parseSceCsv, parsePgeCsv, parseSdgeCsv, parseEspiXml,
  parseGenericCsv, toHourly, mergeLoadSets,
  parseCsvRows, sniffDelimiter, parseDateParts, parseTimeParts, parseStamp,
  findZip, xmlWalk, xmlWalkFallback, DISCARDED_FIELDS,
};

export const _internal = { buildSeries, nthWeekday, dstStartDate, dstEndDate, epochToLocalParts };
