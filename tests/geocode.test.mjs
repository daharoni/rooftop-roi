/* core/geocode.js — run with: node --test tests/
 *
 * Offline except the last two tests, which hit Nominatim / Open-Meteo and skip when the
 * network is unavailable. Nominatim's usage policy caps us at 1 request/second, so this
 * file makes at most two live calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cacheKey } from "../core/weather.js";

import {
  ATTRIBUTION,
  GeocodeError,
  PRIVACY_NOTE,
  elevationFor,
  extractZip,
  geocode,
  zipCentroid,
} from "../core/geocode.js";
import { coverageForZip } from "../core/coverage.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import T from "../core/tariff.js";

const TARIFF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tariffs");
const tariffLib = await T.loadLibrary(TARIFF_DIR);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("extractZip finds a 5-digit ZIP anywhere, ZIP+4 included", () => {
  assert.equal(extractZip("91301"), "91301");
  assert.equal(extractZip("  91301-1234 "), "91301");
  assert.equal(extractZip("123 Main St, Agoura Hills, CA 91301"), "91301");
  assert.equal(extractZip("Agoura Hills, CA"), null);
  assert.equal(extractZip(""), null);
  assert.equal(extractZip(null), null);
  assert.equal(extractZip("1234"), null);
});

// Utility routing moved to core/coverage.js (tests/coverage.test.mjs); the old ZIP-prefix
// map that lived here sent Palo Alto and Sacramento to PG&E, which is exactly the bug.

test("the privacy note names the service and the opt-out, and promises nothing else", () => {
  assert.match(PRIVACY_NOTE, /Nominatim/);
  assert.match(PRIVACY_NOTE, /OpenStreetMap/);
  assert.match(PRIVACY_NOTE, /click your roof on the map/);
  assert.match(PRIVACY_NOTE, /Nothing else is sent/);
  assert.ok(PRIVACY_NOTE.length > 200, "it has to actually say what is sent");
  assert.match(ATTRIBUTION, /OpenStreetMap contributors/);
});

// ---------------------------------------------------------------------------
// Request shape and failure handling (no network)
// ---------------------------------------------------------------------------

test("geocode sends only the typed text, to Nominatim, once", async () => {
  const urls = [];
  const res = await geocode("123 Main St, Agoura Hills CA", {
    fetchImpl: async (u) => {
      urls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { lat: "34.1", lon: "-118.7", display_name: "Main St, Agoura Hills", address: { postcode: "91301-1234" } },
        ],
      };
    },
  });
  assert.equal(urls.length, 1);
  const u = new URL(urls[0]);
  assert.equal(u.origin + u.pathname, "https://nominatim.openstreetmap.org/search");
  assert.equal(u.searchParams.get("q"), "123 Main St, Agoura Hills CA");
  assert.equal(u.searchParams.get("countrycodes"), "us");
  assert.equal(u.searchParams.get("limit"), "1");
  assert.deepEqual([...u.searchParams.keys()].sort(), [
    "addressdetails", "countrycodes", "format", "limit", "q",
  ]);
  assert.equal(res.source, "nominatim");
  assert.equal(res.lat, 34.1);
  assert.equal(res.zip, "91301", "ZIP+4 is trimmed to five digits");
});

test("a bare ZIP skips Nominatim entirely and uses the Open-Meteo centroid", async () => {
  const urls = [];
  const res = await geocode(" 91301 ", {
    fetchImpl: async (u) => {
      urls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { latitude: 34.14, longitude: -118.75, name: "Agoura Hills", admin1: "California", elevation: 280 },
          ],
        }),
      };
    },
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/geocoding-api\.open-meteo\.com/);
  assert.ok(!urls[0].includes("nominatim"));
  assert.equal(res.source, "open-meteo");
  assert.equal(res.zip, "91301");
  assert.equal(res.elevationM, 280);
  assert.match(res.label, /Agoura Hills/);
});

test("a Nominatim miss on an address containing a ZIP falls back to the centroid", async () => {
  let calls = 0;
  const res = await geocode("Nowhere Rd, 91301", {
    fetchImpl: async (u) => {
      calls++;
      if (u.includes("nominatim")) return { ok: true, status: 200, json: async () => [] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ latitude: 34.14, longitude: -118.75, name: "Agoura Hills" }] }),
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(res.source, "open-meteo");
});

test("failures are typed, and a miss is distinguishable from an outage", async () => {
  const miss = await geocode("qqqqqqqq", {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  }).then(null, (e) => e);
  assert.ok(miss instanceof GeocodeError);
  assert.equal(miss.code, "notfound");
  assert.match(miss.userMessage, /map/);

  const offline = await geocode("anywhere", {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  }).then(null, (e) => e);
  assert.equal(offline.code, "offline");
  assert.ok(offline.cause instanceof TypeError);

  const empty = await geocode("   ", {}).then(null, (e) => e);
  assert.equal(empty.code, "input");

  const rate = await geocode("anywhere", {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  }).then(null, (e) => e);
  assert.equal(rate.code, "http");
  assert.match(rate.userMessage, /rate-limit/i);

  const badZip = await zipCentroid("abc", {}).then(null, (e) => e);
  assert.equal(badZip.code, "input");
});

test("elevationFor degrades to null instead of throwing", async () => {
  assert.equal(
    await elevationFor(34.1, -118.7, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    null,
  );
  assert.equal(await elevationFor(NaN, 0), null);
  assert.equal(
    await elevationFor(34.1, -118.7, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ elevation: [281.5] }) }),
    }),
    281.5,
  );
});

test("elevationFor puts no finer coordinate on the wire than the weather request", async () => {
  let url = null;
  await elevationFor(34.156789, -118.7512345, {
    fetchImpl: async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ elevation: [280] }) };
    },
  });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin, "https://api.open-meteo.com");
  assert.equal(q.get("latitude"), "34.15", "rounded to the 0.05 deg privacy grid");
  assert.equal(q.get("longitude"), "-118.75");
  assert.deepEqual([...q.keys()].sort(), ["latitude", "longitude"]);
  // The rounded pair must be exactly what core/weather.js would have cached under.
  assert.equal(cacheKey(34.156789, -118.7512345, 2020), "34.15,-118.75,2020");
});

// ---------------------------------------------------------------------------
// Live — skipped offline
// ---------------------------------------------------------------------------

test("live: the reference address resolves near 34.15 N, -118.75 W", { skip: process.env.SKIP_LIVE ? "SKIP_LIVE set" : false }, async (t) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await geocode("Agoura Hills, CA 91301", { signal: ctrl.signal });
    t.diagnostic(`${r.source}: ${r.lat}, ${r.lon} — ${r.label}`);
    assert.ok(Math.abs(r.lat - 34.15) < 0.2, `lat ${r.lat}`);
    assert.ok(Math.abs(r.lon + 118.75) < 0.2, `lon ${r.lon}`);
    const cov = coverageForZip(r.zip || "91301", tariffLib);
    assert.equal(cov.kind, "iou");
    assert.equal(cov.utilityId, "sce");
  } catch (err) {
    assert.ok(err instanceof GeocodeError, "network failures must be typed");
    t.skip(`geocoding unreachable (${err.code}); offline tests still cover the logic`);
  } finally {
    clearTimeout(timer);
  }
});

test("live: elevation for the reference site is a few hundred metres", { skip: process.env.SKIP_LIVE ? "SKIP_LIVE set" : false }, async (t) => {
  const e = await elevationFor(34.15, -118.75);
  if (e == null) {
    t.skip("elevation API unreachable");
    return;
  }
  t.diagnostic(`elevation ${e} m`);
  assert.ok(e > 100 && e < 600, `${e} m`);
});
