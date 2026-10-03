/* =============================================================================
 * coverage.test.mjs — which ZIPs the Net Billing model is allowed to run for.
 *
 * The nine ZIPs from the 2026-10-02 review (P0 #6): eight publicly owned
 * utilities that the tariff prefixes used to route to an IOU, plus one real SCE
 * ZIP as the control, and a New York ZIP that used to fall back to ids[0].
 * ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import T from "../core/tariff.js";
import { coverageForZip, coverageMessage, NON_NBT_UTILITIES } from "../core/coverage.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tariffs");
const lib = await T.loadLibrary(DIR);

const MUNIS = [
  ["90012", /LADWP/],        // downtown Los Angeles
  ["91101", /Pasadena/],
  ["92501", /Riverside/],
  ["92805", /Anaheim/],
  ["95814", /SMUD/],         // Sacramento
  ["94301", /Palo Alto/],
  ["96001", /Redding/],
  ["91502", /Burbank/],
];

for (const [zip, name] of MUNIS) {
  test(`${zip} is a publicly owned utility and blocks`, () => {
    const c = coverageForZip(zip, lib);
    assert.equal(c.kind, "muni");
    assert.match(c.name, name);
    assert.equal(c.shared, false, "a confident ZIP blocks outright");
    assert.match(coverageMessage(c), /publicly owned utility that is not on Net Billing/);
  });
}

test("91301 (Agoura Hills) is SCE", () => {
  const c = coverageForZip("91301", lib);
  assert.equal(c.kind, "iou");
  assert.equal(c.utilityId, "sce");
});

test("10001 (New York) is outside California, never ids[0]", () => {
  assert.deepEqual(coverageForZip("10001", lib), { kind: "outside" });
  assert.match(coverageMessage({ kind: "outside" }), /California only/);
});

test("a ZIP outside California's 900-961 range is outside even when it starts with 9", () => {
  assert.equal(coverageForZip("97201", lib).kind, "outside");   // Portland
  assert.equal(coverageForZip("96813", lib).kind, "outside");   // Honolulu
});

test("a split ZIP asks instead of blocking, and carries the IOU hint", () => {
  const c = coverageForZip("91107", lib);                       // Pasadena / unincorporated SCE
  assert.equal(c.kind, "muni");
  assert.equal(c.shared, true);
});

test("a city-name match on an otherwise IOU ZIP asks", () => {
  const c = coverageForZip("90056", lib, { city: "Los Angeles" });
  assert.equal(c.kind, "muni");
  assert.equal(c.shared, true);
  assert.equal(coverageForZip("90056", lib, { city: "Ladera Heights" }).kind, "iou");
});

test("no ZIP at all: an out-of-state geocode is outside, a CA one without a match is unknown", () => {
  assert.equal(coverageForZip(null, lib, { state: "Nevada" }).kind, "outside");
  assert.equal(coverageForZip(null, lib, { state: "California", city: "Nowhere" }).kind, "unknown");
});

test("every non-NBT entry names itself and lists at least one ZIP or city", () => {
  for (const u of NON_NBT_UTILITIES) {
    assert.ok(u.name && ["public", "small-iou"].includes(u.owner), u.name);
    assert.ok((u.zips || []).length + (u.shared || []).length + (u.cities || []).length > 0, u.name);
    for (const z of [...(u.zips || []), ...(u.shared || [])]) assert.match(z, /^9\d{4}$/, `${u.name} ${z}`);
  }
});
