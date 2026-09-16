/* core/geocode.js — run with: node --test tests/
 *
 * Offline except the last two tests, which hit Nominatim / Open-Meteo and skip when the
 * network is unavailable. Nominatim's usage policy caps us at 1 request/second, so this
 * file makes at most two live calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AMBIGUOUS_ZIP_PREFIXES,
  ATTRIBUTION,
  GeocodeError,
  IOU_ZIP_PREFIXES,
  PRIVACY_NOTE,
  elevationFor,
  extractZip,
  geocode,
  utilityForZip,
  utilityForZipDetailed,
  zipCentroid,
} from "../core/geocode.js";

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

test("utilityForZip maps the three California IOUs", () => {
  assert.equal(utilityForZip("91301"), "sce"); // Agoura Hills
  assert.equal(utilityForZip("90210"), "sce"); // Beverly Hills
  assert.equal(utilityForZip("92101"), "sdge"); // San Diego
  assert.equal(utilityForZip("94301"), "pge"); // Palo Alto
  assert.equal(utilityForZip("93701"), "pge"); // Fresno
  assert.equal(utilityForZip("95814"), "pge"); // Sacramento
  assert.equal(utilityForZip("123 Main St, San Diego, CA 92101"), "sdge");
  assert.equal(utilityForZip("10001"), null, "out of state -> null, never a guess");
  assert.equal(utilityForZip("not a zip"), null);
  assert.equal(utilityForZip(null), null);
});

test("the IOU prefix tables do not overlap and cover the California range", () => {
  const seen = new Set();
  for (const [id, prefixes] of Object.entries(IOU_ZIP_PREFIXES))
    for (const p of prefixes) {
      assert.match(p, /^\d{3}$/, `${id} prefix ${p} must be three digits`);
      assert.ok(!seen.has(p), `prefix ${p} is claimed twice`);
      seen.add(p);
      assert.ok(p >= "900" && p <= "961", `${p} is outside California's ZIP range`);
    }
  assert.ok(seen.size > 50);
});

test("ambiguous prefixes are flagged rather than silently guessed", () => {
  const clean = utilityForZipDetailed("91301");
  assert.equal(clean.utilityId, "sce");
  assert.equal(clean.confident, true);
  assert.equal(clean.note, null);

  const messy = utilityForZipDetailed("92672"); // San Clemente: SDG&E inside an SCE prefix
  assert.equal(messy.utilityId, "sce");
  assert.equal(messy.confident, false);
  assert.match(messy.note, /SDG&E/);

  for (const p of Object.keys(AMBIGUOUS_ZIP_PREFIXES))
    assert.ok(utilityForZip(p + "01"), `${p} should still resolve to some IOU`);

  assert.deepEqual(utilityForZipDetailed("10001"), {
    utilityId: null, zip: "10001", confident: false, note: null,
  });
});

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
            { latitude: 34.14, longitude: -118.76, name: "Agoura Hills", admin1: "California", elevation: 280 },
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
        json: async () => ({ results: [{ latitude: 34.14, longitude: -118.76, name: "Agoura Hills" }] }),
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

// ---------------------------------------------------------------------------
// Live — skipped offline
// ---------------------------------------------------------------------------

test("live: the reference address resolves near 34.145 N, -118.76 W", async (t) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await geocode("Agoura Hills, CA 91301", { signal: ctrl.signal });
    t.diagnostic(`${r.source}: ${r.lat}, ${r.lon} — ${r.label}`);
    assert.ok(Math.abs(r.lat - 34.145) < 0.2, `lat ${r.lat}`);
    assert.ok(Math.abs(r.lon + 118.76) < 0.2, `lon ${r.lon}`);
    assert.equal(utilityForZip(r.zip || "91301"), "sce");
  } catch (err) {
    assert.ok(err instanceof GeocodeError, "network failures must be typed");
    t.skip(`geocoding unreachable (${err.code}); offline tests still cover the logic`);
  } finally {
    clearTimeout(timer);
  }
});

test("live: elevation for the reference site is a few hundred metres", async (t) => {
  const e = await elevationFor(34.145, -118.76);
  if (e == null) {
    t.skip("elevation API unreachable");
    return;
  }
  t.diagnostic(`elevation ${e} m`);
  assert.ok(e > 100 && e < 600, `${e} m`);
});
