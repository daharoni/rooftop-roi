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
import {
  coverageForZip, coverageMessage, NON_NBT_UTILITIES, coverageDecision, answerCoverage, ANSWER_MUNI, ANSWER_OTHER,
} from "../core/coverage.js";
import { freshState, toHash, fromHash, toStorage, fromStorage } from "../app/state.js";

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

test("a ZIP whose prefix two IOUs share asks, and names nobody by default", () => {
  for (const [zip, want] of [["92672", ["sce", "sdge"]], ["92630", ["sce", "sdge"]], ["93101", ["pge", "sce"]],
    ["93210", ["pge", "sce"]], ["93501", ["pge", "sce"]], ["93601", ["pge", "sce"]]]) {
    const c = coverageForZip(zip, lib);
    assert.equal(c.kind, "iou", zip);
    assert.equal(c.ambiguous, true, zip);
    assert.equal(c.utilityId, null, `${zip}: no silent pick`);
    assert.deepEqual([...c.candidates].sort(), want, zip);
  }
  const one = coverageForZip("92101", lib);                     // San Diego: SDG&E only
  assert.equal(one.ambiguous, false);
  assert.equal(one.utilityId, "sdge");
});

test("ZIPs that straddle a public utility's line ask instead of blocking (2026-10-03 review)", () => {
  for (const [zip, name] of [["91307", /LADWP/], ["91311", /LADWP/], ["90732", /LADWP/], ["90047", /LADWP/],
    ["92507", /Riverside/]]) {
    const c = coverageForZip(zip, lib);
    assert.equal(c.kind, "muni", zip);
    assert.equal(c.shared, true, `${zip} is shared, so the person is asked`);
    assert.match(c.name, name);
  }
});

test("no ZIP appears in two utilities' lists", () => {
  const seen = new Map();
  for (const u of NON_NBT_UTILITIES) {
    for (const z of [...(u.zips || []), ...(u.shared || [])]) {
      assert.ok(!seen.has(z), `${z} is in both ${seen.get(z)} and ${u.name}`);
      seen.set(z, u.name);
    }
  }
});

// ------------------------------------------- the decision the UI acts on

const nameOf = (id) => ({ sce: "Southern California Edison", pge: "PG&E", sdge: "SDG&E" }[id] || id);
const decide = (zip, prior) => coverageDecision(coverageForZip(zip, lib), { zip, ids: lib.ids, nameOf, prior });

test("92672 (San Clemente) asks SCE vs SDG&E through the same question path as a split muni ZIP", () => {
  const d = decide("92672");
  assert.ok(d.ask, "it asks");
  assert.equal(d.utilityId, undefined, "and decides nothing on its own");
  const values = d.ask.options.map((o) => o.value);
  assert.deepEqual(values.filter((v) => v !== ANSWER_OTHER).sort(), ["sce", "sdge"]);
  assert.match(d.ask.text, /92672/);
  assert.deepEqual(answerCoverage(coverageForZip("92672", lib), "sdge"), { utilityId: "sdge" });
  assert.ok(answerCoverage(coverageForZip("92672", lib), ANSWER_OTHER).block);
  assert.deepEqual(answerCoverage(coverageForZip("92672", lib), null), { superseded: true });
});

test("the chosen utility is persisted, and a reload with that prior does not re-ask", () => {
  const s = freshState();
  s.site.utilityId = answerCoverage(coverageForZip("92672", lib), "sdge").utilityId;
  const fromLink = fromHash(toHash(s), freshState());
  const fromStore = fromStorage(JSON.parse(JSON.stringify(toStorage(s))), freshState());
  assert.equal(fromLink.site.utilityId, "sdge");
  assert.equal(fromStore.site.utilityId, "sdge");
  assert.deepEqual(decide("92672", fromStore.site.utilityId), { utilityId: "sdge" });
  assert.ok(decide("92672", "pge").ask, "a prior that is not a candidate still asks");
});

test("a confident muni ZIP blocks even with a prior IOU choice; a split one honours the prior", () => {
  assert.ok(decide("90012", "sce").block, "LADWP downtown blocks regardless");
  const q = decide("91107");
  assert.ok(q.ask);
  assert.equal(q.ask.options[0].value, ANSWER_MUNI);
  assert.ok(answerCoverage(coverageForZip("91107", lib), ANSWER_MUNI).block);
  assert.deepEqual(decide("91107", "sce"), { utilityId: "sce" });
  assert.deepEqual(decide("91301"), { utilityId: "sce" });
  assert.ok(decide("10001").block);
});
