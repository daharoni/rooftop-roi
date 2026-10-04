// core/weather.js — hourly weather years from the Open-Meteo historical archive (ERA5).
//
// Everything here runs unchanged in a browser and in Node 24. The only network call is
// to https://archive-api.open-meteo.com (no key, no user data beyond rounded coordinates).
//
// Output contract — a "weatherYear":
//   { year, ghi, dni, dhi, bhi, temp, wind,      // Float64Array(8760) each
//     tz, utcOffsetSeconds, elevation, lat, lon, source, units }
// Series are in LOCAL STANDARD TIME (no DST), index = (dayOfYear-1)*24 + hour,
// Feb 29 dropped, exactly like core/pv.js expects.
//
// Units, as returned by Open-Meteo and consumed by core/pv.js:
//   ghi/dni/dhi/bhi  W/m^2, mean over the hour  (see "preceding hour" note below)
//   temp             deg C
//   wind             km/h at 10 m  (Open-Meteo's unit, kept as is in the cache and the
//                                   weatherYear; core/pv.js converts to m/s for the
//                                   Sandia cell-temperature term — `units.wind` says which)
//
// "Preceding hour" convention: Open-Meteo labels an hourly radiation value with the END of
// the averaging interval, i.e. the value at UTC label T is the mean over (T-1h, T]. Local
// standard hour H therefore reads the sample labelled H+1h (in UTC), and core/pv.js
// evaluates the solar position at the interval midpoint H+30min.

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const HOURLY_VARS = [
  "shortwave_radiation",
  "direct_radiation",
  "diffuse_radiation",
  "direct_normal_irradiance",
  "temperature_2m",
  "wind_speed_10m",
].join(",");

/** The ERA5 archive trails real time by roughly this many days. */
export const ARCHIVE_LAG_DAYS = 5;

/** How many weather years the app asks for by default. */
export const DEFAULT_YEAR_COUNT = 11;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const HOURS_PER_YEAR = 8760;

/** Coordinate quantisation for the cache key (~5.5 km). Also all we ever put on the wire. */
export const CACHE_GRID_DEG = 0.05;

// Network etiquette. Open-Meteo's free tier answers 429 once a client passes its per-minute
// budget, and it WEIGHTS calls by size (roughly one call per 2 weeks x 10 variables), so an
// 11-year site costs a few hundred weighted calls however it is split. Fewer, larger
// requests save round-trips and per-request overhead, not quota.
/** Timeout (fetch + body) for a ONE-year request; a multi-year request gets half as much
 *  again per extra year (4 years: 50 s). Measured cold: ~3 s per year, a 4-year response
 *  is ~1.7 MB of JSON and took 8-14 s from a cold archive. */
export const REQUEST_TIMEOUT_MS = 20000;
/** Per-attempt timeout cap for RETRIES (attempts after the first). A retry follows a fast
 *  429/5xx answer, so it does not need a cold four-year allowance again.
 *
 *  Worst case for one request with the defaults (4 years, 3 retries): first attempt 50 s
 *  + 3 retries x 20 s + backoff 1.5 + 3 + 6 s = 120.5 s; if the server sends Retry-After
 *  at the 30 s cap every time, 50 + 60 + 90 = 200 s. Reading a final error body adds at
 *  most ERROR_BODY_TIMEOUT_MS and never outlives the attempt's own timeout or an abort.
 *  (Before this cap: 4 x 50 s + backoff = 210.5 s, or 290 s with Retry-After.) */
export const RETRY_TIMEOUT_CAP_MS = 20000;
/** A final non-OK response's body (for the server's `reason`) gets at most this long. */
export const ERROR_BODY_TIMEOUT_MS = 5000;
/** Retries after a 429 or 5xx, with exponential backoff (1.5 s, 3 s, 6 s). */
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1500;
/** A server-sent Retry-After is honoured up to this cap, so a page never hangs for long. */
const MAX_RETRY_AFTER_MS = 30000;
/** Consecutive uncached years fetched in ONE request (start_date..end_date spans years).
 *  11 default years = 3 requests (4+4+3) instead of 11; each is still cached per year. */
export const MAX_YEARS_PER_REQUEST = 4;
/** A year whose response is more than this fraction null (in any modelled variable) is
 *  rejected rather than silently modelled as darkness, and never cached. */
export const MAX_NULL_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The only error type `fetchYears` ever rejects with. `userMessage` is safe to show in the
 * UI verbatim; `code` is one of "offline" | "http" | "api" | "rate-limited" | "timeout" |
 * "aborted" | "data".
 */
export class WeatherUnavailableError extends Error {
  constructor(message, { code = "offline", userMessage, cause, year } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WeatherUnavailableError";
    this.code = code;
    this.year = year ?? null;
    this.userMessage =
      userMessage ||
      "Couldn't reach the weather service (Open-Meteo), so solar production can't be " +
        "estimated right now. Everything else on this page still works — reconnect and " +
        "try again, or reload once you're back online.";
  }
}

// ---------------------------------------------------------------------------
// Year selection
// ---------------------------------------------------------------------------

/**
 * The most recent calendar year that is fully present in the archive as of `today`.
 * @param {Date} [today]
 */
export function latestCompleteYear(today = new Date()) {
  const cutoff = today.getTime() - ARCHIVE_LAG_DAYS * DAY_MS;
  const y = new Date(cutoff).getUTCFullYear();
  // `y` is by construction the year `cutoff` falls in, so the only question left is
  // whether the archive has reached that year's Dec 31.
  return cutoff >= Date.UTC(y, 11, 31) ? y : y - 1;
}

/**
 * Default year range: the `count` most recent complete years.
 * @returns {number[]} ascending
 */
export function defaultYears(today = new Date(), count = DEFAULT_YEAR_COUNT) {
  const last = latestCompleteYear(today);
  const out = [];
  for (let y = last - count + 1; y <= last; y++) out.push(y);
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// `toFixed(2)` kills the binary-float dust that 0.05 multiplication leaves behind, and
// `+ 0` folds a -0 result to 0 so a longitude just west of Greenwich is not sent as "-0.00".
const roundGrid = (v) =>
  Number((Math.round(v / CACHE_GRID_DEG) * CACHE_GRID_DEG).toFixed(2)) + 0;

/** Cache key for one site-year: coordinates rounded to CACHE_GRID_DEG. */
export function cacheKey(lat, lon, year) {
  return `${roundGrid(lat).toFixed(2)},${roundGrid(lon).toFixed(2)},${year}`;
}

/** In-memory cache; the fallback everywhere and the whole cache in a plain worker. */
export function memoryCache(map = new Map()) {
  return {
    kind: "memory",
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async clear() {
      map.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// The one IndexedDB opener for the whole app.
//
// app/state.js keeps the LoadSet in store `loads`; this module keeps weather in store
// `weather`.  Both live in database `rooftop-roi`, and IndexedDB only lets
// `onupgradeneeded` create stores, so the two modules MUST open it through the same
// function at the same version: two openers at version 1 meant whichever ran first
// created only its own store and the other one never existed (the weather cache
// silently missed on every read).  Version 2 forces that upgrade on every browser
// that already has the broken version-1 database.
// ---------------------------------------------------------------------------

export const SHARED_DB_NAME = "rooftop-roi";
export const SHARED_DB_VERSION = 2;
export const SHARED_DB_STORES = Object.freeze(["loads", "weather"]);

const DB_NAME = SHARED_DB_NAME;
const DB_STORE = "weather";

const sharedConnections = new Map(); // dbName -> Promise<IDBDatabase>

/**
 * "Forget my data" latch.  Once forgetting has started, no cache in this page
 * may write again: a sunlight fetch still in flight would otherwise call set()
 * after the database was deleted, which silently re-creates it.  The page
 * navigates away right after forgetting, which is what resets the latch.
 */
let forgotten = false;
export function forgetCaches() { forgotten = true; }
export function cachesForgotten() { return forgotten; }

/**
 * Does the shared database exist, without creating it?  Uses
 * indexedDB.databases() where the browser has it (Chromium, Safari, Firefox
 * 126+); resolves null when it cannot tell, and the caller decides.
 */
export async function sharedDbExists({ dbName = SHARED_DB_NAME, idb } = {}) {
  const factory = idb || (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!factory) return false;
  if (typeof factory.databases !== "function") return null;
  try {
    const list = await factory.databases();
    return list.some((d) => d && d.name === dbName);
  } catch {
    return null;
  }
}

/**
 * Open (once per page) the shared database with every store present.  The connection
 * is cached; it closes itself when another tab upgrades or deletes the database
 * (`onversionchange`), and the next call opens a fresh one.  Rejects when IndexedDB is
 * missing or the open is blocked, so callers can fall back to memory.
 */
export function openSharedDb({ dbName = SHARED_DB_NAME, idb } = {}) {
  const factory = idb || (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!factory) return Promise.reject(new Error("IndexedDB unavailable"));
  if (sharedConnections.has(dbName)) return sharedConnections.get(dbName);
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      req = factory.open(dbName, SHARED_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of SHARED_DB_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab wants to upgrade or delete ("Forget my data"): get out of its way.
        try { db.close(); } catch { /* already closed */ }
        dropIfOwn();
      };
      db.onclose = dropIfOwn;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // An older tab still holds version 1 open and has not closed it.
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another open tab"));
  });
  // Every handler forgets the cached promise only while it is still THIS one:
  // a late close of an old connection must not evict the newer connection.
  function dropIfOwn() { if (sharedConnections.get(dbName) === p) sharedConnections.delete(dbName); }
  sharedConnections.set(dbName, p);
  p.catch(dropIfOwn);
  return p;
}

/** Close and forget the cached connection (before deleteDatabase). */
export async function closeSharedDb(dbName = SHARED_DB_NAME) {
  const p = sharedConnections.get(dbName);
  sharedConnections.delete(dbName);
  if (!p) return;
  try { (await p).close(); } catch { /* never opened */ }
}

/** IndexedDB-backed cache (browsers). Falls back to memory if IndexedDB is unusable. */
export function indexedDbCache({ dbName = DB_NAME, storeName = DB_STORE } = {}) {
  const open = () => openSharedDb({ dbName });
  const tx = async (mode, fn, retry = true) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.onabort = t.onerror = () => reject(t.error);
        if (req) req.onsuccess = () => resolve(req.result);
        else t.oncomplete = () => resolve(undefined);
      });
    } catch (err) {
      // The cached connection was closed under us (another tab upgraded): reopen once.
      if (retry && err && err.name === "InvalidStateError") {
        if (forgotten) throw err;                // closed on purpose: do not reopen
        sharedConnections.delete(dbName);
        return tx(mode, fn, false);
      }
      throw err;
    }
  };
  return {
    kind: "indexeddb",
    async get(key) {
      if (forgotten) return null;                // opening would re-create the database
      try {
        return (await tx("readonly", (s) => s.get(key))) ?? null;
      } catch {
        return null; // a cache miss is never fatal
      }
    },
    async set(key, value) {
      if (forgotten) return;                     // never re-create a database being erased
      try {
        await tx("readwrite", (s) => s.put(value, key));
      } catch {
        /* storage full / private mode — keep going without a cache */
      }
    },
    async clear() {
      try {
        await tx("readwrite", (s) => s.clear());
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * File-backed cache for Node (tests, scripts). One JSON file per key under `dir`.
 * `dir` defaults to $ROOFTOP_ROI_WEATHER_CACHE, else `.cache/weather` in the cwd.
 */
export function fileCache({ dir } = {}) {
  const mem = new Map();
  let fsPromise = null;
  let pathPromise = null;
  const nodeFs = () => (fsPromise ||= import("node:fs/promises"));
  const nodePath = () => (pathPromise ||= import("node:path"));
  const baseDir = async () => {
    const path = await nodePath();
    return (
      dir ||
      (typeof process !== "undefined" && process.env?.ROOFTOP_ROI_WEATHER_CACHE) ||
      path.join(typeof process !== "undefined" ? process.cwd() : ".", ".cache", "weather")
    );
  };
  const fileFor = async (key) => {
    const path = await nodePath();
    return path.join(await baseDir(), key.replace(/[^\w.-]/g, "_") + ".json");
  };
  return {
    kind: "file",
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      try {
        const fs = await nodeFs();
        const raw = await fs.readFile(await fileFor(key), "utf8");
        const value = JSON.parse(raw);
        mem.set(key, value);
        return value;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      mem.set(key, value);
      try {
        const fs = await nodeFs();
        const path = await nodePath();
        const file = await fileFor(key);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value));
      } catch {
        /* read-only fs — memory cache still works for this session */
      }
    },
    async clear() {
      mem.clear();
    },
  };
}

let defaultCacheInstance = null;

/** Pick the best cache for the current runtime: IndexedDB > file (Node) > memory. */
export function defaultCache() {
  if (defaultCacheInstance) return defaultCacheInstance;
  try {
    if (typeof indexedDB !== "undefined" && indexedDB) {
      defaultCacheInstance = indexedDbCache();
      return defaultCacheInstance;
    }
  } catch {
    /* fall through */
  }
  if (typeof process !== "undefined" && process.versions?.node) {
    defaultCacheInstance = fileCache();
    return defaultCacheInstance;
  }
  defaultCacheInstance = memoryCache();
  return defaultCacheInstance;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/**
 * UTC offset in seconds for an IANA zone at a given instant, via Intl (no data tables).
 * Returns null if the zone is unknown.
 */
export function zoneOffsetSeconds(tz, atMs) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    });
    const part = fmt.formatToParts(new Date(atMs)).find((p) => p.type === "timeZoneName");
    if (!part) return null;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part.value);
    if (!m) return 0; // bare "GMT"
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 3600 + Number(m[3] || 0) * 60);
  } catch {
    return null;
  }
}

/**
 * The zone's STANDARD (non-DST) offset in seconds. Daylight saving always shifts the clock
 * east, so the standard offset is the smaller of the mid-winter and mid-summer offsets —
 * true in both hemispheres.
 */
export function standardOffsetSeconds(tz, year = 2021) {
  const jan = zoneOffsetSeconds(tz, Date.UTC(year, 0, 15));
  const jul = zoneOffsetSeconds(tz, Date.UTC(year, 6, 15));
  if (jan == null || jul == null) return null;
  return Math.min(jan, jul);
}

/** Crude fallback when no zone name is available: 15 deg of longitude per hour. */
export function offsetFromLongitude(lon) {
  return Math.round(lon / 15) * 3600;
}

// ---------------------------------------------------------------------------
// Local-standard-time calendar (8760, Feb 29 dropped)
// ---------------------------------------------------------------------------

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** month (1..12) for each of the 8760 standard-year hour slots. */
export const MONTH_OF_HOUR = (() => {
  const out = new Uint8Array(HOURS_PER_YEAR);
  let i = 0;
  for (let m = 0; m < 12; m++)
    for (let d = 0; d < DAYS_IN_MONTH[m]; d++)
      for (let h = 0; h < 24; h++) out[i++] = m + 1;
  return out;
})();

/** day-of-month (1..31) for each of the 8760 slots. */
export const DAY_OF_HOUR = (() => {
  const out = new Uint8Array(HOURS_PER_YEAR);
  let i = 0;
  for (let m = 0; m < 12; m++)
    for (let d = 0; d < DAYS_IN_MONTH[m]; d++)
      for (let h = 0; h < 24; h++) out[i++] = d + 1;
  return out;
})();

/**
 * UTC epoch ms of the START of each of the year's 8760 local-standard hours.
 * Feb 29 is skipped, so slot i is always (dayOfYear-1)*24+hour of a 365-day calendar.
 */
export function standardHourStartsUtc(year, utcOffsetSeconds) {
  const out = new Float64Array(HOURS_PER_YEAR);
  const off = utcOffsetSeconds * 1000;
  for (let i = 0; i < HOURS_PER_YEAR; i++) {
    const m = MONTH_OF_HOUR[i] - 1;
    const d = DAY_OF_HOUR[i];
    const h = i % 24;
    out[i] = Date.UTC(year, m, d, h) - off;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response → weatherYear
// ---------------------------------------------------------------------------

const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Turn one raw Open-Meteo archive response into a local-standard-time weatherYear.
 * Exported so tests can exercise the conversion without a network.
 */
export function toWeatherYear(raw, { year, lat, lon, tz: tzOverride } = {}) {
  const hourly = raw?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length < 24)
    throw new WeatherUnavailableError(`Weather response for ${year} has no hourly data`, {
      code: "data",
      year,
      userMessage:
        "The weather service returned an unexpected response, so solar production can't " +
        "be estimated for this location right now.",
    });

  const tz = tzOverride || raw.timezone || "GMT";
  // Open-Meteo applies ONE fixed offset per request (no DST breaks inside the series), so
  // the whole series can be re-anchored to UTC from the first label.
  const respOffsetMs = (raw.utc_offset_seconds || 0) * 1000;
  const firstUtcMs = Date.parse(hourly.time[0] + ":00Z") - respOffsetMs;

  const stdOffset =
    standardOffsetSeconds(tz) ??
    (raw.utc_offset_seconds != null ? raw.utc_offset_seconds : offsetFromLongitude(lon ?? 0));

  const starts = standardHourStartsUtc(year, stdOffset);
  const n = hourly.time.length;

  const ghi = new Float64Array(HOURS_PER_YEAR);
  const dni = new Float64Array(HOURS_PER_YEAR);
  const dhi = new Float64Array(HOURS_PER_YEAR);
  const bhi = new Float64Array(HOURS_PER_YEAR);
  const temp = new Float64Array(HOURS_PER_YEAR);
  const wind = new Float64Array(HOURS_PER_YEAR);

  const sw = hourly.shortwave_radiation || [];
  const dn = hourly.direct_normal_irradiance || [];
  const df = hourly.diffuse_radiation || [];
  const dr = hourly.direct_radiation || [];
  const t2 = hourly.temperature_2m || [];
  const ws = hourly.wind_speed_10m || [];

  let missing = 0;
  // Nulls per modelled variable (bhi is fetched but unused, so it does not count). A stray
  // null is filled (0, or 15 C) as before; a mostly-null year is an outage, not weather —
  // modelling it would report ~0 kWh/kW and, worse, get cached for good.
  const nulls = [0, 0, 0, 0, 0];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  for (let i = 0; i < HOURS_PER_YEAR; i++) {
    // Radiation is the mean over the PRECEDING hour, so the local hour starting at
    // starts[i] is the sample labelled one hour later.
    const j = Math.round((starts[i] + HOUR_MS - firstUtcMs) / HOUR_MS);
    if (j < 0 || j >= n) {
      missing++;
      temp[i] = 15;
      continue;
    }
    if (!isNum(sw[j])) nulls[0]++;
    if (!isNum(dn[j])) nulls[1]++;
    if (!isNum(df[j])) nulls[2]++;
    if (!isNum(t2[j])) nulls[3]++;
    if (!isNum(ws[j])) nulls[4]++;
    ghi[i] = Math.max(0, num(sw[j], 0));
    dni[i] = Math.max(0, num(dn[j], 0));
    dhi[i] = Math.max(0, num(df[j], 0));
    bhi[i] = Math.max(0, num(dr[j], 0));
    temp[i] = num(t2[j], 15);
    wind[i] = Math.max(0, num(ws[j], 0));
  }
  const nullHours = Math.max(...nulls);
  if (nullHours > HOURS_PER_YEAR * MAX_NULL_FRACTION)
    throw new WeatherUnavailableError(
      `Weather response for ${year} is ${Math.round((100 * nullHours) / HOURS_PER_YEAR)}% empty (null) values`,
      {
        code: "data",
        year,
        userMessage:
          `The weather service returned empty data for ${year}, so solar production can't ` +
          "be estimated right now. Try again later — the rest of the tool still works.",
      },
    );
  if (missing > HOURS_PER_YEAR * 0.02)
    throw new WeatherUnavailableError(
      `Weather response for ${year} covers only ${HOURS_PER_YEAR - missing}/8760 hours`,
      {
        code: "data",
        year,
        userMessage: `The weather archive is missing too much of ${year} to model that year.`,
      },
    );

  return {
    year,
    ghi,
    dni,
    dhi,
    bhi,
    temp,
    wind,
    tz,
    utcOffsetSeconds: stdOffset,
    elevation: num(raw.elevation, null),
    lat: num(raw.latitude, lat ?? null),
    lon: num(raw.longitude, lon ?? null),
    missingHours: missing,
    nullHours,
    source: "open-meteo-archive-era5",
    units: { irradiance: "W/m2", temp: "degC", wind: "km/h" },
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function archiveUrl({ lat, lon, year, endYear = year, elevationM, today }) {
  // One extra day either side so every local-standard hour of every year — including the
  // UTC+offset overhang at both ends — has a sample. `start_date`..`end_date` may span
  // several years; the response is then split per year (sliceYear) and cached per year.
  const start = `${year - 1}-12-31`;
  const lastAvailable = new Date(
    (today ? today.getTime() : Date.now()) - ARCHIVE_LAG_DAYS * DAY_MS,
  );
  const wanted = Date.UTC(endYear + 1, 0, 1);
  const endMs = Math.min(wanted, lastAvailable.getTime());
  const e = new Date(endMs);
  const end = `${e.getUTCFullYear()}-${String(e.getUTCMonth() + 1).padStart(2, "0")}-${String(
    e.getUTCDate(),
  ).padStart(2, "0")}`;
  const p = new URLSearchParams({
    latitude: String(roundGrid(lat)),
    longitude: String(roundGrid(lon)),
    start_date: start,
    end_date: end,
    hourly: HOURLY_VARS,
    timezone: "auto",
  });
  if (elevationM != null && Number.isFinite(elevationM)) p.set("elevation", String(Math.round(elevationM)));
  return `${ARCHIVE_URL}?${p.toString()}`;
}

/**
 * Cut one year's window (Dec 31 of the year before .. Jan 1 of the year after, local labels)
 * out of a possibly multi-year response. The result has exactly the shape a single-year
 * request returns, so the per-year cache entries are interchangeable with older ones.
 * Open-Meteo uses one fixed UTC offset per request, so a slice keeps a valid time axis.
 */
export function sliceYear(raw, year) {
  const time = raw?.hourly?.time;
  if (!Array.isArray(time)) return raw;
  const from = `${year - 1}-12-31T00:00`;
  const to = `${year + 1}-01-01T23:59`;
  let a = 0;
  while (a < time.length && time[a] < from) a++;
  let b = time.length;
  while (b > a && time[b - 1] > to) b--;
  if (a === 0 && b === time.length) return raw; // already one year: keep it as is
  const hourly = {};
  for (const [k, v] of Object.entries(raw.hourly))
    hourly[k] = Array.isArray(v) && v.length === time.length ? v.slice(a, b) : v;
  return { ...raw, hourly };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortedError());
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

function abortedError(year, cause, label = year) {
  return new WeatherUnavailableError(`Weather request${label ? ` for ${label}` : ""} aborted`, {
    code: "aborted",
    year,
    cause,
    userMessage: "Weather download cancelled.",
  });
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
function retryAfterMs(res) {
  let v = null;
  try {
    v = res?.headers?.get?.("retry-after") ?? null;
  } catch {
    return null;
  }
  if (v == null || v === "") return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** "20 s", "1 s" for 999 ms is wrong, so sub-second spans are given in ms. */
function formatDuration(ms) {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${Math.round(ms / 1000)} s`;
}

/**
 * Read a non-OK response's JSON `reason`, bounded: ERROR_BODY_TIMEOUT_MS, the attempt's
 * own timeout, or an abort (all through `ctrl`) end the read, and a body that ignores the
 * abort is abandoned rather than awaited. Never rejects; "" when there is no reason.
 */
async function readErrorDetail(res, ctrl, signal) {
  const stop = ctrl ? ctrl.signal : signal;
  let timer;
  let onStop;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      resolve(null);
    }, ERROR_BODY_TIMEOUT_MS);
    onStop = () => resolve(null);
    if (stop?.aborted) resolve(null);
    else stop?.addEventListener?.("abort", onStop, { once: true });
  });
  try {
    const body = await Promise.race([
      Promise.resolve()
        .then(() => res.json())
        .catch(() => null),
      giveUp,
    ]);
    const reason = body?.reason;
    return typeof reason === "string" ? reason.slice(0, 200) : "";
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener?.("abort", onStop);
  }
}

/**
 * ONE attempt: fetch + read the body under a timeout. The caller's `signal` is linked in,
 * so either the user (code "aborted") or the clock (code "timeout") can stop it.
 * Resolves `{ json }` or `{ status, res, detail }` for a non-2xx answer; rejects typed.
 * For a non-2xx answer the caller will NOT retry (`willRetry(status)` false), the error
 * body is read here, inside the same timeout/abort scope, so it can't hang.
 * `label` names the request in messages ("2019" or "2019-2022").
 */
async function fetchOnce(url, { year, label = year, signal, doFetch, timeoutMs, willRetry }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const onAbort = () => ctrl?.abort();
  if (signal?.aborted) throw abortedError(year, undefined, label);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl?.abort();
  }, timeoutMs);
  const failed = (cause) => {
    if (timedOut)
      return new WeatherUnavailableError(
        `Weather request for ${label} timed out after ${formatDuration(timeoutMs)}`,
        {
          code: "timeout",
          year,
          cause,
          userMessage:
            "The weather service (Open-Meteo) is taking too long to answer, so solar " +
            "production can't be estimated right now. Try again in a minute — the rest of " +
            "the tool still works.",
        },
      );
    if (signal?.aborted || cause?.name === "AbortError") return abortedError(year, cause, label);
    return null;
  };
  try {
    let res;
    try {
      res = await doFetch(url, {
        signal: ctrl ? ctrl.signal : signal,
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      throw (
        failed(cause) ||
        new WeatherUnavailableError(`Weather request for ${label} failed: ${cause?.message}`, {
          code: "offline",
          year,
          cause,
          userMessage:
            "Couldn't reach the weather service (Open-Meteo). Solar production can't be " +
            "estimated until you're back online; the rest of the tool still works.",
        })
      );
    }
    if (!res.ok) {
      const detail = willRetry?.(res.status) ? "" : await readErrorDetail(res, ctrl, signal);
      if (signal?.aborted) throw abortedError(year, undefined, label);
      return { status: res.status, res, detail };
    }
    try {
      return { json: await res.json() };
    } catch (cause) {
      throw (
        failed(cause) ||
        new WeatherUnavailableError(`Weather response for ${label} was not JSON`, {
          code: "data",
          year,
          cause,
        })
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Fetch one archive request, retrying 429 and 5xx answers with exponential backoff
 * (honouring Retry-After). Requests stay strictly sequential — the API asks for that.
 */
async function fetchRawRange({
  lat,
  lon,
  year,
  endYear = year,
  elevationM,
  signal,
  fetchImpl,
  today,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retries = MAX_RETRIES,
  retryDelayMs = RETRY_BASE_DELAY_MS,
}) {
  const url = archiveUrl({ lat, lon, year, endYear, elevationM, today });
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch)
    throw new WeatherUnavailableError("No fetch implementation available", {
      code: "offline",
      year,
    });
  const span = endYear > year ? `${year}-${endYear}` : `${year}`;
  const limitMs = timeoutMs * (1 + 0.5 * (endYear - year));
  const isTransient = (status) => status === 429 || status >= 500;
  for (let attempt = 0; ; attempt++) {
    // Retries get at most RETRY_TIMEOUT_CAP_MS each (see its comment for the worst case).
    const attemptMs = attempt === 0 ? limitMs : Math.min(limitMs, RETRY_TIMEOUT_CAP_MS);
    const r = await fetchOnce(url, {
      year,
      label: span,
      signal,
      doFetch,
      timeoutMs: attemptMs,
      willRetry: (status) => isTransient(status) && attempt < retries,
    });
    if (r.json !== undefined) {
      const json = r.json;
      if (json?.error)
        throw new WeatherUnavailableError(`Weather API error for ${span}: ${json.reason}`, {
          code: "api",
          year,
          userMessage: `The weather service rejected the request for ${span}: ${json.reason}`,
        });
      return json;
    }
    const { status, res, detail } = r;
    const transient = isTransient(status);
    if (transient && attempt < retries) {
      const backoff = retryDelayMs * 2 ** attempt;
      const hinted = retryAfterMs(res);
      await sleep(hinted != null ? Math.min(hinted, MAX_RETRY_AFTER_MS) : backoff, signal).catch(
        () => {
          throw abortedError(year, undefined, span);
        },
      );
      continue;
    }
    const tries = transient ? ` after ${attempt + 1} attempts` : "";
    throw new WeatherUnavailableError(
      `Weather service returned HTTP ${status} for ${span}${tries}${detail ? ": " + detail : ""}`,
      status === 429
        ? {
            code: "rate-limited",
            year,
            userMessage:
              "The free weather service (Open-Meteo) is rate-limiting this browser, so solar " +
              "production can't be estimated right now. Wait a minute and try again — the " +
              "rest of the tool still works.",
          }
        : {
            code: "http",
            year,
            userMessage: `The weather service couldn't return ${span} (HTTP ${status}). Try again later.`,
          },
    );
  }
}

/**
 * Fetch (or read from cache) one weather year per entry in `years`.
 *
 * Cached years are read first; each run of consecutive uncached years is then fetched in
 * requests of up to MAX_YEARS_PER_REQUEST years, one at a time, and split back into one
 * cache entry per year. A year is validated (toWeatherYear: coverage, nulls) BEFORE it is
 * cached, and a cached entry that no longer validates is treated as a miss and refetched,
 * so an empty response can never poison the cache.
 *
 * @param {object} o
 * @param {number} o.lat
 * @param {number} o.lon
 * @param {number[]} [o.years]        default: the 11 most recent complete years
 * @param {number} [o.elevationM]     site elevation; improves the temperature downscaling
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.cache]          { get(key), set(key, value) }; defaults per runtime
 * @param {Function} [o.fetchImpl]    injectable fetch (tests)
 * @param {boolean} [o.cacheOnly]     never touch the network; throw if a year is missing
 * @param {Function} [o.onProgress]   ({ year, index, total, fromCache }) => void, in year order
 * @param {number} [o.timeoutMs]      per one-year request (+50% per extra year); default REQUEST_TIMEOUT_MS
 * @param {number} [o.retries]        429/5xx retries; default MAX_RETRIES
 * @param {number} [o.retryDelayMs]   first backoff; default RETRY_BASE_DELAY_MS
 * @param {number} [o.yearsPerRequest] default MAX_YEARS_PER_REQUEST (1 = one per year)
 * @returns {Promise<object[]>} weatherYear[] in the order of `years`
 * @throws {WeatherUnavailableError} the only error type this function rejects with
 */
export async function fetchYears({
  lat,
  lon,
  years,
  elevationM = null,
  signal,
  cache = defaultCache(),
  fetchImpl,
  cacheOnly = false,
  today,
  onProgress,
  timeoutMs,
  retries,
  retryDelayMs,
  yearsPerRequest = MAX_YEARS_PER_REQUEST,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new WeatherUnavailableError("fetchYears needs a numeric lat/lon", {
      code: "data",
      userMessage: "Pick a location first — the solar model needs coordinates.",
    });
  const list = (years && years.length ? years : defaultYears(today ? new Date(today) : undefined))
    .map(Number)
    .filter(Number.isFinite);

  // Pass 1: everything the cache can answer (and still validates).
  const have = new Array(list.length).fill(null);
  const cached = new Array(list.length).fill(false);
  for (let i = 0; i < list.length; i++) {
    let raw = null;
    try {
      raw = await cache?.get?.(cacheKey(lat, lon, list[i]));
    } catch {
      raw = null; // a broken cache must never break the fetch
    }
    if (!raw) continue;
    try {
      have[i] = toWeatherYear(raw, { year: list[i], lat, lon });
      cached[i] = true;
    } catch {
      /* a stale or empty entry is a miss: refetch it below (and overwrite it) */
    }
  }

  // Pass 2: in year order, fetching runs of consecutive missing years in one request.
  const per = Math.max(1, Math.floor(yearsPerRequest) || 1);
  for (let i = 0; i < list.length; i++) {
    if (!have[i]) {
      const year = list[i];
      if (cacheOnly)
        throw new WeatherUnavailableError(`No cached weather for ${cacheKey(lat, lon, year)}`, {
          code: "offline",
          year,
          userMessage:
            "No stored weather for this location and the network is unavailable, so solar " +
            "production can't be estimated yet.",
        });
      let j = i + 1;
      while (j < list.length && j - i < per && !have[j] && list[j] === list[j - 1] + 1) j++;
      const endYear = list[j - 1];
      const json = await fetchRawRange({
        lat, lon, year, endYear, elevationM, signal, fetchImpl, today, timeoutMs, retries, retryDelayMs,
      });
      for (let k = i; k < j; k++) {
        const raw = j - i > 1 ? sliceYear(json, list[k]) : json;
        have[k] = toWeatherYear(raw, { year: list[k], lat, lon }); // throws BEFORE caching
        try {
          // An abort that lands after the response (Forget my data) still skips the write.
          if (!signal?.aborted) await cache?.set?.(cacheKey(lat, lon, list[k]), raw);
        } catch {
          /* cache write failures are not user-visible */
        }
      }
    }
    onProgress?.({ year: list[i], index: i, total: list.length, fromCache: cached[i] });
  }
  return have;
}

/**
 * Non-throwing wrapper for UI call sites: resolves to
 * `{ ok: true, years }` or `{ ok: false, error, message }`.
 */
export async function tryFetchYears(opts) {
  try {
    return { ok: true, years: await fetchYears(opts) };
  } catch (err) {
    const e =
      err instanceof WeatherUnavailableError
        ? err
        : new WeatherUnavailableError(String(err?.message || err), { code: "offline", cause: err });
    return { ok: false, error: e, message: e.userMessage };
  }
}

/** Build a weatherYear from plain arrays (synthetic skies in tests, imported TMY files). */
export function weatherYearFromArrays({
  year = 2020,
  ghi,
  dni,
  dhi,
  temp,
  wind,
  tz = "GMT",
  utcOffsetSeconds = 0,
  lat = null,
  lon = null,
  elevation = null,
} = {}) {
  const f = (a, fill = 0) => {
    const out = new Float64Array(HOURS_PER_YEAR).fill(fill);
    if (a) out.set(a.length > HOURS_PER_YEAR ? Array.from(a).slice(0, HOURS_PER_YEAR) : a);
    return out;
  };
  return {
    year,
    ghi: f(ghi),
    dni: f(dni),
    dhi: f(dhi),
    bhi: f(null),
    temp: f(temp, 15),
    wind: f(wind),
    tz,
    utcOffsetSeconds,
    elevation,
    lat,
    lon,
    missingHours: 0,
    source: "synthetic",
    units: { irradiance: "W/m2", temp: "degC", wind: "km/h" },
  };
}

export const HOURS = HOURS_PER_YEAR;

export default {
  ARCHIVE_LAG_DAYS,
  CACHE_GRID_DEG,
  DEFAULT_YEAR_COUNT,
  DAY_OF_HOUR,
  HOURS,
  MONTH_OF_HOUR,
  WeatherUnavailableError,
  cacheKey,
  defaultCache,
  defaultYears,
  fetchYears,
  fileCache,
  indexedDbCache,
  openSharedDb,
  closeSharedDb,
  sharedDbExists,
  forgetCaches,
  cachesForgotten,
  SHARED_DB_NAME,
  SHARED_DB_VERSION,
  SHARED_DB_STORES,
  latestCompleteYear,
  memoryCache,
  offsetFromLongitude,
  sliceYear,
  standardHourStartsUtc,
  standardOffsetSeconds,
  toWeatherYear,
  tryFetchYears,
  weatherYearFromArrays,
  zoneOffsetSeconds,
};
