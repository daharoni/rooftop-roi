/* core/weather.js — run with: node --test tests/
 *
 * Offline except the final block, which hits the Open-Meteo archive and skips (loudly)
 * when the network is unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  ARCHIVE_LAG_DAYS,
  DAY_OF_HOUR,
  MONTH_OF_HOUR,
  WeatherUnavailableError,
  cacheKey,
  defaultYears,
  ERROR_BODY_TIMEOUT_MS,
  RETRY_TIMEOUT_CAP_MS,
  fetchYears,
  fileCache,
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
} from "../core/weather.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const PST = -8 * 3600;

// ---------------------------------------------------------------------------
// Year selection
// ---------------------------------------------------------------------------

test("default year range: the 11 most recent COMPLETE years, allowing for the archive lag", () => {
  // Mid-September 2026: 2025 is long finished, so 2015..2025.
  assert.deepEqual(defaultYears(new Date("2026-09-16T12:00:00Z")), [
    2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
  ]);
  // 2 January 2026: the archive still trails ~5 days, so 2025 is not complete yet.
  assert.equal(latestCompleteYear(new Date("2026-01-02T00:00:00Z")), 2024);
  // By 10 January the lag has cleared the year boundary.
  assert.equal(latestCompleteYear(new Date("2026-01-10T00:00:00Z")), 2025);
  assert.equal(defaultYears(new Date("2026-01-02T00:00:00Z")).at(-1), 2024);
  assert.equal(defaultYears(new Date("2026-01-02T00:00:00Z")).length, 11);
  assert.ok(ARCHIVE_LAG_DAYS >= 1 && ARCHIVE_LAG_DAYS <= 14);
});

test("default year range: a custom count still ends at the last complete year", () => {
  const ys = defaultYears(new Date("2026-06-01T00:00:00Z"), 3);
  assert.deepEqual(ys, [2023, 2024, 2025]);
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test("cache key: coordinates are rounded to a 0.05 degree grid before anything is sent", () => {
  assert.equal(cacheKey(34.16, -118.74, 2020), "34.15,-118.75,2020");
  assert.equal(cacheKey(34.1449, -118.7501, 2020), "34.15,-118.75,2020");
  // Two houses on the same block share a key (and therefore one cached download).
  assert.equal(cacheKey(34.1401, -118.7399, 2020), cacheKey(34.1449, -118.7401, 2020));
  assert.equal(cacheKey(0, 0, 1999), "0.00,0.00,1999");
});

test("memory cache round-trips and misses return null", async () => {
  const c = memoryCache();
  assert.equal(await c.get("nope"), null);
  await c.set("k", { a: 1 });
  assert.deepEqual(await c.get("k"), { a: 1 });
  await c.clear();
  assert.equal(await c.get("k"), null);
});

test("file cache round-trips through the filesystem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooftop-wx-"));
  try {
    const c = fileCache({ dir });
    assert.equal(await c.get("34.15,-118.75,2020"), null);
    await c.set("34.15,-118.75,2020", { hello: "world" });
    // A fresh instance must read what the first one wrote.
    assert.deepEqual(await fileCache({ dir }).get("34.15,-118.75,2020"), { hello: "world" });
    assert.ok(fs.readdirSync(dir).length === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

test("standard offsets are the non-DST ones, in both hemispheres", () => {
  assert.equal(standardOffsetSeconds("America/Los_Angeles"), -8 * 3600);
  assert.equal(standardOffsetSeconds("America/New_York"), -5 * 3600);
  assert.equal(standardOffsetSeconds("Australia/Sydney"), 10 * 3600); // DST is +11
  assert.equal(standardOffsetSeconds("Asia/Kolkata"), 5.5 * 3600); // half-hour zone
  assert.equal(standardOffsetSeconds("Europe/Berlin"), 3600);
  assert.equal(standardOffsetSeconds("UTC"), 0);
  assert.equal(standardOffsetSeconds("Not/AZone"), null);
});

test("zone offsets follow DST at a given instant", () => {
  assert.equal(zoneOffsetSeconds("America/Los_Angeles", Date.UTC(2021, 0, 15)), -8 * 3600);
  assert.equal(zoneOffsetSeconds("America/Los_Angeles", Date.UTC(2021, 6, 15)), -7 * 3600);
});

test("longitude fallback gives whole-hour offsets", () => {
  assert.equal(offsetFromLongitude(-118.75), -8 * 3600);
  assert.equal(offsetFromLongitude(0), 0);
  assert.equal(offsetFromLongitude(151.2), 10 * 3600);
});

// ---------------------------------------------------------------------------
// Local-standard-time conversion
// ---------------------------------------------------------------------------

/** A fake Open-Meteo archive response whose value at each hour encodes its UTC instant. */
function fakeResponse({ year, utcOffsetSeconds = -25200, tz = "America/Los_Angeles" } = {}) {
  const startUtc = Date.UTC(year - 1, 11, 31); // request start_date, at 00:00 local
  const n = 24 * (368 + (year % 4 === 0 ? 1 : 0));
  const time = [];
  const stamp = [];
  for (let i = 0; i < n; i++) {
    const utc = startUtc + i * 3600000;
    time.push(new Date(utc + utcOffsetSeconds * 1000).toISOString().slice(0, 16));
    stamp.push(utc / 3600000); // hours since epoch — unique per hour
  }
  return {
    latitude: 34.13,
    longitude: -118.72,
    elevation: 280,
    timezone: tz,
    utc_offset_seconds: utcOffsetSeconds,
    hourly: {
      time,
      shortwave_radiation: stamp,
      direct_normal_irradiance: stamp.map(() => 1),
      diffuse_radiation: stamp.map(() => 2),
      direct_radiation: stamp.map(() => 3),
      temperature_2m: stamp.map(() => 20),
      wind_speed_10m: stamp.map(() => 5),
    },
  };
}

test("conversion: 8760 hours in local standard time, Feb 29 dropped", () => {
  const wy = toWeatherYear(fakeResponse({ year: 2020 }), { year: 2020 }); // leap year
  assert.equal(wy.ghi.length, 8760);
  assert.equal(wy.tz, "America/Los_Angeles");
  assert.equal(wy.utcOffsetSeconds, PST, "DST is stripped: the series is PST all year");
  assert.equal(wy.elevation, 280);
  assert.equal(wy.missingHours, 0);

  // Slot 0 is 00:00 PST on 1 January; its radiation sample is the one labelled 01:00 PST
  // (the mean over the PRECEDING hour), i.e. 09:00 UTC.
  assert.equal(wy.ghi[0], Date.UTC(2020, 0, 1, 9) / 3600000);
  // Slot 1416 must be 1 March, not 29 February: Feb 29 is skipped, not squashed.
  const mar1 = 59 * 24;
  assert.equal(MONTH_OF_HOUR[mar1], 3);
  assert.equal(DAY_OF_HOUR[mar1], 1);
  assert.equal(wy.ghi[mar1], Date.UTC(2020, 2, 1, 9) / 3600000);
  // The slot before it is 23:00 PST on 28 February, whose preceding-hour sample is the
  // one labelled 00:00 PST on 29 February — the leap DAY is dropped, not the 24 hours of
  // weather that straddle its boundary.
  assert.equal(wy.ghi[mar1 - 1], Date.UTC(2020, 1, 29, 8) / 3600000);
  // A whole leap day of samples is skipped between the two slots.
  assert.equal(wy.ghi[mar1] - wy.ghi[mar1 - 1], 25);
});

test("conversion: no DST jump — noon in January and in July are both 20:00 UTC", () => {
  const wy = toWeatherYear(fakeResponse({ year: 2021 }), { year: 2021 });
  const jan = 9 * 24 + 12; // day 10 of the year = 10 January, 12:00 PST
  const jul = 189 * 24 + 12; // day 190 = 9 July, 12:00 PST
  // Both read the sample labelled 13:00 PST = 21:00 UTC. Under DST the July one would
  // have been 20:00 UTC — that shift is exactly what this module removes.
  assert.equal(wy.ghi[jan], Date.UTC(2021, 0, 10, 21) / 3600000);
  assert.equal(wy.ghi[jul], Date.UTC(2021, 6, 9, 21) / 3600000);
  assert.equal(wy.ghi[jul] - wy.ghi[jan], jul - jan, "a 365-day calendar of flat 24 h days");
});

test("conversion: the offset the API happened to return does not change the answer", () => {
  // Open-Meteo may label a whole-year request in PDT or PST depending on when it is asked.
  const a = toWeatherYear(fakeResponse({ year: 2021, utcOffsetSeconds: -25200 }), { year: 2021 });
  const b = toWeatherYear(fakeResponse({ year: 2021, utcOffsetSeconds: -28800 }), { year: 2021 });
  assert.deepEqual(Array.from(a.ghi.subarray(0, 48)), Array.from(b.ghi.subarray(0, 48)));
  assert.equal(a.utcOffsetSeconds, b.utcOffsetSeconds);
});

test("conversion: nulls become zero (and 15 C), and an empty response is a typed error", () => {
  const raw = fakeResponse({ year: 2021 });
  raw.hourly.shortwave_radiation[100] = null;
  raw.hourly.temperature_2m[100] = null;
  raw.hourly.wind_speed_10m[100] = null;
  const wy = toWeatherYear(raw, { year: 2021 });
  assert.ok(wy.ghi.every(Number.isFinite));
  assert.ok(wy.temp.every(Number.isFinite));
  assert.ok(wy.temp.every((v) => v > -80 && v < 70), "a null temperature becomes 15 C, not 0");
  assert.throws(
    () => toWeatherYear({ hourly: { time: [] } }, { year: 2021 }),
    (e) => e instanceof WeatherUnavailableError && e.code === "data" && !!e.userMessage,
  );
});

test("conversion: a response that is too short to cover the year is rejected", () => {
  const raw = fakeResponse({ year: 2021 });
  for (const k of Object.keys(raw.hourly)) raw.hourly[k] = raw.hourly[k].slice(0, 2000);
  assert.throws(
    () => toWeatherYear(raw, { year: 2021 }),
    (e) => e instanceof WeatherUnavailableError && e.code === "data",
  );
});

test("standardHourStartsUtc: index is (dayOfYear-1)*24 + hour", () => {
  const s = standardHourStartsUtc(2021, PST);
  assert.equal(s.length, 8760);
  for (let i = 1; i < s.length; i++) assert.equal(s[i] - s[i - 1], 3600000);
  assert.equal(new Date(s[0]).toISOString(), "2021-01-01T08:00:00.000Z");
  assert.equal(new Date(s[8759]).toISOString(), "2022-01-01T07:00:00.000Z");
});

test("weatherYearFromArrays builds a usable synthetic year", () => {
  const wy = weatherYearFromArrays({ year: 2030, ghi: [1, 2, 3], lat: 1, lon: 2 });
  assert.equal(wy.ghi.length, 8760);
  assert.equal(wy.ghi[2], 3);
  assert.equal(wy.temp[100], 15, "temperature defaults to 15 C, not 0");
  assert.equal(wy.source, "synthetic");
});

// ---------------------------------------------------------------------------
// Failure modes — must never throw anything but WeatherUnavailableError
// ---------------------------------------------------------------------------

const site = { lat: 34.15, lon: -118.75, years: [2020] };

test("offline: fetchYears rejects with a typed error carrying a user-facing message", async () => {
  const err = await fetchYears({
    ...site,
    cache: memoryCache(),
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof WeatherUnavailableError);
  assert.equal(err.code, "offline");
  assert.equal(err.year, 2020);
  assert.match(err.userMessage, /weather/i);
  assert.ok(err.cause instanceof TypeError, "the original failure is preserved as cause");
});

test("offline: tryFetchYears never rejects", async () => {
  const r = await tryFetchYears({
    ...site,
    cache: memoryCache(),
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof WeatherUnavailableError);
  assert.ok(r.message.length > 20);
});

test("an aborted download is reported as 'aborted', not as an outage", async () => {
  const err = await fetchYears({
    ...site,
    cache: memoryCache(),
    fetchImpl: async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  }).then(null, (e) => e);
  assert.equal(err.code, "aborted");
});

// Retries use a 1 ms backoff here so the suite stays fast; production waits 1.5/3/6 s.
const FAST = { retryDelayMs: 1, timeoutMs: 2000 };
const okResponse = (raw) => ({ ok: true, status: 200, json: async () => raw });
const httpResponse = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  json: async () => ({ reason: "nope" }),
});
/** A fetch that answers from a script of responses, one per call, and counts calls. */
function scripted(...steps) {
  const f = async (url, init) => {
    const step = steps[Math.min(f.calls++, steps.length - 1)];
    return typeof step === "function" ? step(url, init) : step;
  };
  f.calls = 0;
  return f;
}

test("HTTP failures are typed: 429 retried 3 times then 'rate-limited', 4xx not retried", async () => {
  const f429 = scripted(httpResponse(429));
  const e429 = await fetchYears({ ...site, ...FAST, cache: memoryCache(), fetchImpl: f429 }).then(
    null,
    (e) => e,
  );
  assert.ok(e429 instanceof WeatherUnavailableError);
  assert.equal(e429.code, "rate-limited");
  assert.match(e429.userMessage, /rate-limit/i);
  assert.equal(f429.calls, 4, "one try plus three retries");

  const f400 = scripted(httpResponse(400));
  const e400 = await fetchYears({ ...site, ...FAST, cache: memoryCache(), fetchImpl: f400 }).then(
    null,
    (e) => e,
  );
  assert.equal(e400.code, "http");
  assert.equal(f400.calls, 1, "a client error is not retried");
});

test("rate limiting: a 429 followed by success recovers transparently", async () => {
  const raw = fakeResponse({ year: 2020 });
  const f = scripted(httpResponse(429, { "retry-after": "0" }), okResponse(raw));
  const cache = memoryCache();
  const years = await fetchYears({ ...site, ...FAST, cache, fetchImpl: f });
  assert.equal(f.calls, 2);
  assert.equal(years[0].ghi.length, 8760);
  assert.ok(await cache.get(cacheKey(34.15, -118.75, 2020)), "the recovered year is cached");
});

test("server errors: 500 three times then success recovers; 500 forever is 'http' after 4 tries", async () => {
  const raw = fakeResponse({ year: 2020 });
  const f = scripted(httpResponse(500), httpResponse(502), httpResponse(503), okResponse(raw));
  const years = await fetchYears({ ...site, ...FAST, cache: memoryCache(), fetchImpl: f });
  assert.equal(f.calls, 4);
  assert.equal(years.length, 1);

  const dead = scripted(httpResponse(500));
  const err = await fetchYears({ ...site, ...FAST, cache: memoryCache(), fetchImpl: dead }).then(
    null,
    (e) => e,
  );
  assert.equal(err.code, "http");
  assert.equal(dead.calls, 4);
  assert.match(err.message, /HTTP 500/);
});

/** A fetch that never answers, but rejects like the real one when its signal aborts. */
const hangingFetch = () =>
  scripted((url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    }),
  );

test("a request that never answers times out as 'timeout' (and is not mistaken for a cancel)", async () => {
  const f = hangingFetch();
  const t0 = Date.now();
  const err = await fetchYears({ ...site, retryDelayMs: 1, timeoutMs: 40, cache: memoryCache(), fetchImpl: f }).then(
    null,
    (e) => e,
  );
  assert.ok(err instanceof WeatherUnavailableError);
  assert.equal(err.code, "timeout");
  assert.match(err.userMessage, /too long/);
  assert.equal(f.calls, 1, "a timeout is surfaced, not retried");
  assert.ok(Date.now() - t0 < 1500);
});

test("a user abort mid-request or mid-backoff is 'aborted', not 'timeout'", async () => {
  const ctrl = new AbortController();
  const p = fetchYears({ ...site, timeoutMs: 5000, signal: ctrl.signal, cache: memoryCache(), fetchImpl: hangingFetch() });
  setTimeout(() => ctrl.abort(), 10);
  assert.equal((await p.then(null, (e) => e)).code, "aborted");

  const ctrl2 = new AbortController();
  const f = scripted(httpResponse(429));
  const p2 = fetchYears({ ...site, retryDelayMs: 5000, signal: ctrl2.signal, cache: memoryCache(), fetchImpl: f });
  setTimeout(() => ctrl2.abort(), 10);
  assert.equal((await p2.then(null, (e) => e)).code, "aborted");
  assert.equal(f.calls, 1, "the abort cut the backoff short");
});

/** A non-OK response whose body never finishes. `honoursAbort` = rejects when the signal
 *  aborts (like a real fetch body); false = ignores it entirely (the worst case). */
const stalledErrorResponse = (status, honoursAbort, init) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: () =>
    new Promise((_, reject) => {
      if (!honoursAbort) return;
      init.signal.addEventListener("abort", () => {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    }),
});

test("a final error response whose body stalls can't hang: abort and timeout both end it", async () => {
  assert.equal(ERROR_BODY_TIMEOUT_MS, 5000);
  // User abort while the 400's body is stalled: 'aborted', promptly.
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = fetchYears({
    ...site, timeoutMs: 10000, signal: ctrl.signal, cache: memoryCache(),
    fetchImpl: scripted((url, init) => stalledErrorResponse(400, true, init)),
  });
  setTimeout(() => ctrl.abort(), 20);
  const e1 = await p.then(null, (e) => e);
  assert.equal(e1.code, "aborted");
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);

  // A body that ignores the abort altogether: the attempt's timeout still ends the read,
  // and the HTTP status (not a timeout) is what is reported.
  const t1 = Date.now();
  const f = scripted((url, init) => stalledErrorResponse(400, false, init));
  const e2 = await fetchYears({ ...site, timeoutMs: 60, cache: memoryCache(), fetchImpl: f }).then(null, (e) => e);
  assert.equal(e2.code, "http");
  assert.match(e2.message, /HTTP 400 for 2020$/);
  assert.equal(f.calls, 1);
  assert.ok(Date.now() - t1 < 1000, `took ${Date.now() - t1} ms`);

  // A body that is fine still contributes the server's reason.
  const e3 = await fetchYears({ ...site, ...FAST, cache: memoryCache(), fetchImpl: scripted(httpResponse(400)) }).then(null, (e) => e);
  assert.match(e3.message, /HTTP 400 for 2020: nope$/);
});

test("timeout messages name the whole year span and never say '0 s'", async () => {
  const years = [2019, 2020, 2021, 2022];
  const err = await fetchYears({
    ...site, years, timeoutMs: 40, cache: memoryCache(), fetchImpl: hangingFetch(),
    today: new Date("2026-09-16T00:00:00Z"),
  }).then(null, (e) => e);
  assert.equal(err.code, "timeout");
  // 40 ms per year, +50% per extra year: 100 ms for four.
  assert.match(err.message, /for 2019-2022 timed out after 100 ms$/);
  assert.equal(err.year, 2019);

  const ctrl = new AbortController();
  const p = fetchYears({ ...site, years, timeoutMs: 5000, signal: ctrl.signal, cache: memoryCache(), fetchImpl: hangingFetch(), today: new Date("2026-09-16T00:00:00Z") });
  setTimeout(() => ctrl.abort(), 10);
  assert.match((await p.then(null, (e) => e)).message, /for 2019-2022 aborted$/);
});

test("retries after the first attempt get at most RETRY_TIMEOUT_CAP_MS each", async () => {
  assert.equal(RETRY_TIMEOUT_CAP_MS, 20000);
  // Record every timer the module arms; run them fast so the test stays quick.
  const realSetTimeout = globalThis.setTimeout;
  const armed = [];
  globalThis.setTimeout = (fn, ms, ...a) => {
    armed.push(ms);
    return realSetTimeout(fn, Math.min(ms, 5), ...a);
  };
  let err;
  try {
    const hang = hangingFetch();
    const f = scripted(httpResponse(503), (url, init) => hang(url, init));
    err = await fetchYears({
      ...site, years: [2019, 2020, 2021, 2022], retryDelayMs: 1, cache: memoryCache(), fetchImpl: f,
      today: new Date("2026-09-16T00:00:00Z"),
    }).then(null, (e) => e);
    assert.equal(f.calls, 2);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(err.code, "timeout");
  assert.match(err.message, /2019-2022 timed out after 20 s$/);
  // First attempt 50 s (20 s + 50% per extra year), the retry capped at 20 s.
  assert.equal(armed.filter((ms) => ms === 50000).length, 1, `timers ${armed}`);
  assert.ok(armed.includes(20000), `timers ${armed}`);
});

test("an all-null (or mostly null) response is a typed 'data' error and is never cached", async () => {
  const allNull = fakeResponse({ year: 2020 });
  for (const k of Object.keys(allNull.hourly)) if (k !== "time") allNull.hourly[k] = allNull.hourly[k].map(() => null);
  const cache = memoryCache();
  const err = await fetchYears({ ...site, ...FAST, cache, fetchImpl: scripted(okResponse(allNull)) }).then(
    null,
    (e) => e,
  );
  assert.ok(err instanceof WeatherUnavailableError);
  assert.equal(err.code, "data");
  assert.equal(err.year, 2020);
  assert.match(err.userMessage, /empty data/);
  assert.equal(await cache.get(cacheKey(34.15, -118.75, 2020)), null, "nothing was cached");

  // 25% of hours null in one variable: rejected. 10%: tolerated (filled), and reported.
  const mostly = fakeResponse({ year: 2020 });
  const n = mostly.hourly.time.length;
  mostly.hourly.shortwave_radiation = mostly.hourly.shortwave_radiation.map((v, i) => (i < n * 0.25 ? null : v));
  assert.throws(() => toWeatherYear(mostly, { year: 2020 }), (e) => e.code === "data");
  const some = fakeResponse({ year: 2020 });
  some.hourly.temperature_2m = some.hourly.temperature_2m.map((v, i) => (i % 10 === 0 ? null : v));
  const wy = toWeatherYear(some, { year: 2020 });
  assert.ok(wy.nullHours > 800 && wy.nullHours < 900, `nullHours ${wy.nullHours}`);
});

test("a poisoned (all-null) cache entry is treated as a miss and refetched", async () => {
  const bad = fakeResponse({ year: 2020 });
  bad.hourly.shortwave_radiation = bad.hourly.shortwave_radiation.map(() => null);
  const good = fakeResponse({ year: 2020 });
  const cache = memoryCache();
  await cache.set(cacheKey(34.15, -118.75, 2020), bad);
  const f = scripted(okResponse(good));
  const seen = [];
  const [wy] = await fetchYears({ ...site, ...FAST, cache, fetchImpl: f, onProgress: (p) => seen.push(p.fromCache) });
  assert.equal(f.calls, 1);
  assert.deepEqual(seen, [false]);
  assert.ok(wy.ghi.some((v) => v > 0));
  assert.equal(await cache.get(cacheKey(34.15, -118.75, 2020)), good, "the bad entry was replaced");
  // ... and with cacheOnly it is a clean miss, not a zero-production year.
  await cache.set(cacheKey(34.15, -118.75, 2020), bad);
  const err = await fetchYears({ ...site, cache, cacheOnly: true }).then(null, (e) => e);
  assert.equal(err.code, "offline");
});

/**
 * A fake multi-year archive response with REAL-looking local labels: the request's first
 * label is `${y0 - 1}-12-31T00:00` local, the last `${y1 + 1}-01-01T23:00` (or the archive
 * edge), one fixed offset throughout, and each GHI value encodes its UTC hour.
 */
function fakeRange(y0, y1, { off = -28800, endMs } = {}) {
  const t0 = Date.UTC(y0 - 1, 11, 31) - off * 1000;
  const t1 = endMs ?? Date.UTC(y1 + 1, 0, 1, 23) - off * 1000;
  const time = [];
  const stamp = [];
  for (let t = t0; t <= t1; t += 3600000) {
    time.push(new Date(t + off * 1000).toISOString().slice(0, 16));
    stamp.push(t / 3600000);
  }
  const k = (v) => stamp.map(() => v);
  return {
    latitude: 34.13, longitude: -118.72, elevation: 280,
    timezone: "America/Los_Angeles", utc_offset_seconds: off,
    hourly: {
      time, shortwave_radiation: stamp, direct_normal_irradiance: k(1), diffuse_radiation: k(2),
      direct_radiation: k(3), temperature_2m: k(20), wind_speed_10m: k(5),
    },
  };
}

test("multi-year requests: 11 uncached years take 3 requests, split and cached per year", async () => {
  const years = Array.from({ length: 11 }, (_, i) => 2015 + i);
  const urls = [];
  const f = scripted((url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    return okResponse(fakeRange(Number(q.get("start_date").slice(0, 4)) + 1, Number(q.get("end_date").slice(0, 4)) - 1));
  });
  const cache = memoryCache();
  const progress = [];
  const out = await fetchYears({
    ...site, years, cache, fetchImpl: f, today: new Date("2026-09-16T00:00:00Z"),
    onProgress: (p) => progress.push(p.index),
  });
  assert.equal(f.calls, 3, "was 11 one-year requests");
  assert.deepEqual(
    urls.map((u) => { const q = new URL(u).searchParams; return `${q.get("start_date")}..${q.get("end_date")}`; }),
    ["2014-12-31..2019-01-01", "2018-12-31..2023-01-01", "2022-12-31..2026-01-01"],
  );
  assert.deepEqual(progress, years.map((_, i) => i), "progress still arrives once per year, in order");
  assert.deepEqual(out.map((w) => w.year), years);
  for (const y of years) {
    const entry = await cache.get(cacheKey(34.15, -118.75, y));
    assert.ok(entry, `year ${y} cached on its own key`);
    // Each cached slice is exactly what a one-year request would have returned...
    const single = fakeRange(y, y);
    assert.deepEqual(entry.hourly.time, single.hourly.time, `${y} slice window`);
    // ...and models identically.
    const a = toWeatherYear(entry, { year: y });
    const b = toWeatherYear(single, { year: y });
    assert.deepEqual(Array.from(a.ghi), Array.from(b.ghi));
  }

  // A second pass is all cache; a gap re-fetches only the gap (2 contiguous runs -> 2 calls).
  const again = scripted(() => assert.fail("no network on a warm cache"));
  await fetchYears({ ...site, years, cache, fetchImpl: again });
  const gappy = memoryCache();
  for (const y of [2017, 2018, 2019]) await gappy.set(cacheKey(34.15, -118.75, y), await cache.get(cacheKey(34.15, -118.75, y)));
  const g = scripted((url) => {
    const q = new URL(url).searchParams;
    return okResponse(fakeRange(Number(q.get("start_date").slice(0, 4)) + 1, Number(q.get("end_date").slice(0, 4)) - 1));
  });
  await fetchYears({ ...site, years: [2015, 2016, 2017, 2018, 2019, 2020, 2021], cache: gappy, fetchImpl: g });
  assert.equal(g.calls, 2, "2015-16 and 2020-21");
});

test("sliceYear leaves a one-year response untouched and clips a range to the year window", () => {
  const one = fakeRange(2020, 2020);
  assert.equal(sliceYear(one, 2020), one);
  const s = sliceYear(fakeRange(2019, 2021), 2020);
  assert.equal(s.hourly.time[0], "2019-12-31T00:00");
  assert.equal(s.hourly.time.at(-1), "2021-01-01T23:00");
  assert.equal(s.hourly.time.length, s.hourly.shortwave_radiation.length);
  assert.equal(s.timezone, "America/Los_Angeles");
});

test("an API-level error object is surfaced with its reason", async () => {
  const err = await fetchYears({
    ...site,
    cache: memoryCache(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: true, reason: "Data corrupted at path ''" }),
    }),
  }).then(null, (e) => e);
  assert.equal(err.code, "api");
  assert.match(err.userMessage, /Data corrupted/);
});

test("bad coordinates are rejected before anything is sent", async () => {
  let called = false;
  const err = await fetchYears({
    lat: NaN,
    lon: 0,
    years: [2020],
    cache: memoryCache(),
    fetchImpl: async () => {
      called = true;
    },
  }).then(null, (e) => e);
  assert.ok(err instanceof WeatherUnavailableError);
  assert.equal(err.code, "data");
  assert.equal(called, false);
});

test("cacheOnly never touches the network and reports a clean miss", async () => {
  let called = false;
  const err = await fetchYears({
    ...site,
    cache: memoryCache(),
    cacheOnly: true,
    fetchImpl: async () => {
      called = true;
    },
  }).then(null, (e) => e);
  assert.equal(called, false);
  assert.equal(err.code, "offline");
});

test("a cached year is served without a network call, and a broken cache is survivable", async () => {
  const raw = fakeResponse({ year: 2020 });
  const cache = memoryCache();
  await cache.set(cacheKey(34.15, -118.75, 2020), raw);
  let calls = 0;
  const seen = [];
  const years = await fetchYears({
    ...site,
    cache,
    cacheOnly: true,
    onProgress: (p) => seen.push(p.fromCache),
    fetchImpl: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(seen, [true]);
  assert.equal(years.length, 1);
  assert.equal(years[0].ghi.length, 8760);

  // A cache whose get() throws must not break the fetch.
  const broken = {
    get: async () => {
      throw new Error("IndexedDB is on fire");
    },
    set: async () => {
      throw new Error("still on fire");
    },
  };
  const ok = await fetchYears({ ...site, cache: broken, fetchImpl: async () => ({ ok: true, status: 200, json: async () => raw }) });
  assert.equal(ok.length, 1);
});

test("the request only ever carries rounded coordinates, dates and variable names", async () => {
  let url = null;
  await fetchYears({
    ...site,
    cache: memoryCache(),
    elevationM: 280,
    today: new Date("2026-09-16T00:00:00Z"),
    fetchImpl: async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => fakeResponse({ year: 2020 }) };
    },
  });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin, "https://archive-api.open-meteo.com");
  assert.equal(q.get("latitude"), "34.15");
  assert.equal(q.get("longitude"), "-118.75");
  assert.equal(q.get("start_date"), "2019-12-31");
  assert.equal(q.get("end_date"), "2021-01-01");
  assert.equal(q.get("timezone"), "auto");
  assert.equal(q.get("elevation"), "280");
  assert.match(q.get("hourly"), /shortwave_radiation/);
  assert.deepEqual([...q.keys()].sort(), [
    "elevation", "end_date", "hourly", "latitude", "longitude", "start_date", "timezone",
  ]);
});

// ---------------------------------------------------------------------------
// Live archive — skipped offline
// ---------------------------------------------------------------------------

test("live: one real year from the Open-Meteo archive matches the stored fixture", { skip: process.env.SKIP_LIVE ? "SKIP_LIVE set" : false }, async (t) => {
  const gz = path.join(FIXTURES, "weather-agoura-hills.json.gz");
  if (!fs.existsSync(gz)) {
    t.skip("weather fixture missing");
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let live;
  try {
    [live] = await fetchYears({
      lat: 34.15,
      lon: -118.75,
      years: [2017],
      elevationM: 280,
      cache: memoryCache(),
      signal: ctrl.signal,
    });
  } catch (err) {
    assert.ok(err instanceof WeatherUnavailableError, "network failures must be typed");
    t.skip(`Open-Meteo unreachable (${err.code}); offline tests still cover the conversion`);
    return;
  } finally {
    clearTimeout(timer);
  }

  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8")).years["2017"];
  const time = Array.from({ length: fx.n }, (_, i) =>
    new Date(Date.parse(fx.t0 + ":00Z") + i * 3600000).toISOString().slice(0, 16),
  );
  const stored = toWeatherYear(
    {
      ...fx.meta,
      hourly: {
        time,
        shortwave_radiation: fx.ghi,
        direct_normal_irradiance: fx.dni,
        diffuse_radiation: fx.dhi,
        direct_radiation: fx.bhi,
        temperature_2m: fx.tempX10.map((v) => v / 10),
        wind_speed_10m: fx.windX10.map((v) => v / 10),
      },
    },
    { year: 2017, lat: 34.15, lon: -118.75 },
  );

  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const dGhi = 100 * (sum(live.ghi) / sum(stored.ghi) - 1);
  t.diagnostic(`live vs stored 2017 GHI: ${dGhi.toFixed(3)}%  (tz ${live.tz}, elev ${live.elevation})`);
  assert.equal(live.tz, "America/Los_Angeles");
  assert.equal(live.utcOffsetSeconds, PST);
  assert.ok(Math.abs(dGhi) < 0.5, `annual GHI drifted ${dGhi.toFixed(2)}% from the fixture`);
  assert.ok(sum(live.ghi) / 1000 > 1500 && sum(live.ghi) / 1000 < 2200, "plausible SoCal GHI");
});
