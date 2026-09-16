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
//   wind             km/h at 10 m  (NOT m/s — see docs/solar-model.md, this matches the
//                                   validated reference model)
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The only error type `fetchYears` ever rejects with. `userMessage` is safe to show in the
 * UI verbatim; `code` is one of "offline" | "http" | "api" | "timeout" | "aborted" | "data".
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
  // Dec 31 of year y is covered only if the cutoff has passed into year y+1.
  return Date.UTC(y, 0, 1) <= cutoff && cutoff >= Date.UTC(y, 11, 31) ? y : y - 1;
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

const DB_NAME = "rooftop-roi";
const DB_STORE = "weather";

/** IndexedDB-backed cache (browsers). Falls back to memory if IndexedDB is unusable. */
export function indexedDbCache({ dbName = DB_NAME, storeName = DB_STORE } = {}) {
  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        // The `loads` store belongs to app/state.js; create it only if we are making the
        // database from scratch so the two modules can share one database version.
        if (!db.objectStoreNames.contains("loads")) db.createObjectStore("loads");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return dbPromise;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.onabort = t.onerror = () => reject(t.error);
      if (req) req.onsuccess = () => resolve(req.result);
      else t.oncomplete = () => resolve(undefined);
    });
  };
  return {
    kind: "indexeddb",
    async get(key) {
      try {
        return (await tx("readonly", (s) => s.get(key))) ?? null;
      } catch {
        return null; // a cache miss is never fatal
      }
    },
    async set(key, value) {
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
  const nodeFs = () => (fsPromise ||= import("node:fs/promises"));
  const nodePath = () => import("node:path");
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
  for (let i = 0; i < HOURS_PER_YEAR; i++) {
    // Radiation is the mean over the PRECEDING hour, so the local hour starting at
    // starts[i] is the sample labelled one hour later.
    const j = Math.round((starts[i] + HOUR_MS - firstUtcMs) / HOUR_MS);
    if (j < 0 || j >= n) {
      missing++;
      temp[i] = 15;
      continue;
    }
    ghi[i] = Math.max(0, num(sw[j], 0));
    dni[i] = Math.max(0, num(dn[j], 0));
    dhi[i] = Math.max(0, num(df[j], 0));
    bhi[i] = Math.max(0, num(dr[j], 0));
    temp[i] = num(t2[j], 15);
    wind[i] = Math.max(0, num(ws[j], 0));
  }
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
    source: "open-meteo-archive-era5",
    units: { irradiance: "W/m2", temp: "degC", wind: "km/h" },
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function archiveUrl({ lat, lon, year, elevationM, today }) {
  // One extra day either side so every local-standard hour of `year` — including the
  // UTC+offset overhang at both ends — has a sample.
  const start = `${year - 1}-12-31`;
  const lastAvailable = new Date(
    (today ? today.getTime() : Date.now()) - ARCHIVE_LAG_DAYS * DAY_MS,
  );
  const wanted = Date.UTC(year + 1, 0, 1);
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

async function fetchRawYear({ lat, lon, year, elevationM, signal, fetchImpl, today }) {
  const url = archiveUrl({ lat, lon, year, elevationM, today });
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch)
    throw new WeatherUnavailableError("No fetch implementation available", {
      code: "offline",
      year,
    });
  let res;
  try {
    res = await doFetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (cause) {
    const aborted = cause?.name === "AbortError";
    throw new WeatherUnavailableError(`Weather request for ${year} failed: ${cause?.message}`, {
      code: aborted ? "aborted" : "offline",
      year,
      cause,
      userMessage: aborted
        ? "Weather download cancelled."
        : "Couldn't reach the weather service (Open-Meteo). Solar production can't be " +
          "estimated until you're back online; the rest of the tool still works.",
    });
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json())?.reason || "").slice(0, 200);
    } catch {
      /* body was not JSON */
    }
    throw new WeatherUnavailableError(
      `Weather service returned HTTP ${res.status} for ${year}${detail ? ": " + detail : ""}`,
      {
        code: res.status === 429 ? "api" : "http",
        year,
        userMessage:
          res.status === 429
            ? "The free weather service is rate-limiting this browser. Wait a minute and try again."
            : `The weather service couldn't return ${year} (HTTP ${res.status}). Try again later.`,
      },
    );
  }
  let json;
  try {
    json = await res.json();
  } catch (cause) {
    throw new WeatherUnavailableError(`Weather response for ${year} was not JSON`, {
      code: "data",
      year,
      cause,
    });
  }
  if (json?.error)
    throw new WeatherUnavailableError(`Weather API error for ${year}: ${json.reason}`, {
      code: "api",
      year,
      userMessage: `The weather service rejected the request for ${year}: ${json.reason}`,
    });
  return json;
}

/**
 * Fetch (or read from cache) one weather year per entry in `years`.
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
 * @param {Function} [o.onProgress]   ({ year, index, total, fromCache }) => void
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
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new WeatherUnavailableError("fetchYears needs a numeric lat/lon", {
      code: "data",
      userMessage: "Pick a location first — the solar model needs coordinates.",
    });
  const list = (years && years.length ? years : defaultYears(today ? new Date(today) : undefined))
    .map(Number)
    .filter(Number.isFinite);

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const year = list[i];
    const key = cacheKey(lat, lon, year);
    let raw = null;
    let fromCache = false;
    try {
      raw = await cache?.get?.(key);
      fromCache = !!raw;
    } catch {
      raw = null; // a broken cache must never break the fetch
    }
    if (!raw) {
      if (cacheOnly)
        throw new WeatherUnavailableError(`No cached weather for ${key}`, {
          code: "offline",
          year,
          userMessage:
            "No stored weather for this location and the network is unavailable, so solar " +
            "production can't be estimated yet.",
        });
      raw = await fetchRawYear({ lat, lon, year, elevationM, signal, fetchImpl, today });
      try {
        await cache?.set?.(key, raw);
      } catch {
        /* cache write failures are not user-visible */
      }
    }
    out.push(toWeatherYear(raw, { year, lat, lon }));
    onProgress?.({ year, index: i, total: list.length, fromCache });
  }
  return out;
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
  latestCompleteYear,
  memoryCache,
  offsetFromLongitude,
  standardHourStartsUtc,
  standardOffsetSeconds,
  toWeatherYear,
  tryFetchYears,
  weatherYearFromArrays,
  zoneOffsetSeconds,
};
