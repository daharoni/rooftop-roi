/* =============================================================================
 * state.test.mjs — the two persistence codecs.
 *
 * What matters here is not that the functions run, but that a scenario
 * survives the trip: a link someone pastes into an email has to reproduce the
 * sender's screen, and a reload has to reproduce the last session.  So every
 * test is a round trip, and the interesting cases are the ones where a value
 * equals its default (must be omitted) or is a nested structure (planes,
 * flexible loads, the financing block).
 * ========================================================================== */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS, freshState, clone, getPath, setPath,
  toHash, fromHash, toStorage, fromStorage,
} from "../app/state.js";

/** A state with something changed at every level of nesting. */
function scenario() {
  const s = freshState();
  s.site.lat = 34.145;
  s.site.lon = -118.76;
  s.site.elevationM = 280;
  s.site.tz = "America/Los_Angeles";
  s.site.utilityId = "sce";
  s.site.addressLabel = "1 Main St, Agoura Hills CA";     // must never persist
  s.baseLoadScale = 1.15;
  s.tariff.planId = "TOU-D-PRIME";
  s.tariff.providerId = "cpa_green";
  s.system.panelW = 440;
  s.system.gridCharge = true;
  s.system.strategy = "export_arbitrage";
  s.system.override.batteries = 2;
  s.fin.costPerW = 2.65;
  s.fin.horizon = 30;
  s.fin.financing.mode = "loan";
  s.fin.financing.loan.apr = 0.0549;
  s.fin.financing.loan.termYears = 20;
  s.fin.financing.lease.monthly = 210;
  s.ui.tab = "money";
  s.ui.objective = "irr";
  s.ui.weatherKey = "p90";
  s.roof.planes = [
    { id: "p1", name: "South face", tilt: 20, azimuth: 169, maxPanels: 30,
      shading: { annual: 0.05 }, costAdder: 0, polygon: [[34.1, -118.7], [34.2, -118.8]], gutterEdge: [0, 1] },
    { id: "p2", name: "West face", tilt: 27, azimuth: 262, maxPanels: 12,
      shading: { annual: 0.12 }, costAdder: 1500, polygon: null, gutterEdge: null },
  ];
  s.flex = [
    { id: "ev1", kind: "ev", name: "Model Y", source: "detected", annualKwh: 3582,
      kwhByHour: null, detection: { chargerKW: 8.02, confidence: 0.8 },
      schedule: { mode: "spread", daysPerWeek: 5, window: [9, 16], daylightFraction: 0.85,
                  overnightWindow: [1, 5], maxKW: 8, followSolar: true },
      scale: 1.2 },
    { id: "pool", kind: "pool", name: "Pool pump", source: "manual", annualKwh: 1461,
      kwhByHour: null, detection: null,
      schedule: { mode: "spread", daysPerWeek: 7, window: [10, 18], daylightFraction: 1,
                  overnightWindow: [1, 5], maxKW: 0.5, followSolar: false },
      scale: 1 },
  ];
  return s;
}

// ------------------------------------------------------------------ paths

test("getPath and setPath walk nested keys", () => {
  const s = freshState();
  setPath(s, "fin.financing.loan.apr", 0.05);
  assert.equal(getPath(s, "fin.financing.loan.apr"), 0.05);
  assert.equal(getPath(s, "fin.financing.nope.deep"), undefined);
});

test("clone is deep and leaves the original alone", () => {
  const a = scenario();
  const b = clone(a);
  b.roof.planes[0].tilt = 99;
  b.fin.financing.loan.apr = 0.99;
  assert.equal(a.roof.planes[0].tilt, 20);
  assert.equal(a.fin.financing.loan.apr, 0.0549);
});

// ------------------------------------------------------------------- hash

test("a default state produces an empty hash", () => {
  assert.equal(toHash(freshState()), "");
});

test("the hash carries only what differs from the defaults", () => {
  const s = freshState();
  s.fin.costPerW = 2.5;
  const h = toHash(s);
  assert.equal(h, "cw=2.5");
  assert.ok(!h.includes("hz="), "an untouched horizon must not appear");
});

test("hash round-trips every scalar, plane and flexible load", () => {
  const a = scenario();
  const b = fromHash(toHash(a), freshState());

  assert.equal(b.site.lat, a.site.lat);
  assert.equal(b.site.utilityId, "sce");
  assert.equal(b.baseLoadScale, 1.15);
  assert.equal(b.system.panelW, 440);
  assert.equal(b.system.gridCharge, true);
  assert.equal(b.system.strategy, "export_arbitrage");
  assert.equal(b.system.override.batteries, 2);
  assert.equal(b.fin.costPerW, 2.65);
  assert.equal(b.fin.horizon, 30);
  assert.equal(b.fin.financing.mode, "loan");
  assert.equal(b.fin.financing.loan.apr, 0.0549);
  assert.equal(b.fin.financing.loan.termYears, 20);
  assert.equal(b.fin.financing.lease.monthly, 210);
  assert.equal(b.ui.tab, "money");
  assert.equal(b.ui.objective, "irr");
  assert.equal(b.ui.weatherKey, "p90");

  assert.equal(b.roof.planes.length, 2);
  assert.equal(b.roof.planes[0].id, "p1");
  assert.equal(b.roof.planes[0].name, "South face");
  assert.equal(b.roof.planes[0].azimuth, 169);
  assert.equal(b.roof.planes[0].maxPanels, 30);
  assert.equal(b.roof.planes[0].shading.annual, 0.05);
  assert.equal(b.roof.planes[1].costAdder, 1500);

  assert.equal(b.flex.length, 2);
  assert.equal(b.flex[0].id, "ev1");
  assert.equal(b.flex[0].name, "Model Y");
  assert.equal(b.flex[0].kind, "ev");
  assert.equal(b.flex[0].source, "detected");
  assert.equal(b.flex[0].annualKwh, 3582);
  assert.equal(b.flex[0].schedule.mode, "spread");
  assert.deepEqual(b.flex[0].schedule.window, [9, 16]);
  assert.equal(b.flex[0].schedule.daylightFraction, 0.85);
  assert.equal(b.flex[0].scale, 1.2);
  assert.equal(b.flex[1].schedule.followSolar, false);
  assert.equal(b.flex[1].schedule.maxKW, 0.5);
});

test("the hash never carries a typed address", () => {
  const h = toHash(scenario());
  assert.ok(!h.includes("Main"), "the street address must not reach the URL");
  assert.equal(fromHash(h, freshState()).site.addressLabel, null);
});

test("a hash is stable: encoding it twice gives the same string", () => {
  const a = scenario();
  const once = toHash(a);
  const twice = toHash(fromHash(once, freshState()));
  assert.equal(twice, once);
});

test("a leading # and unknown keys are tolerated", () => {
  const s = fromHash("#cw=2.1&somethingNew=7&hz=30", freshState());
  assert.equal(s.fin.costPerW, 2.1);
  assert.equal(s.fin.horizon, 30);
});

test("an empty or absent hash returns the defaults untouched", () => {
  assert.deepEqual(fromHash("", freshState()), freshState());
  assert.deepEqual(fromHash(undefined, freshState()), freshState());
});

test("booleans survive as booleans, not as the string \"false\"", () => {
  const s = freshState();
  s.system.gridCharge = true;
  const back = fromHash(toHash(s), freshState());
  assert.equal(back.system.gridCharge, true);

  // The default is false, so it is omitted — and must come back false.
  assert.equal(fromHash(toHash(freshState()), freshState()).system.gridCharge, false);
});

/**
 * The hash is a layer, not a snapshot: a key that is absent means "whatever the
 * base already had", which is what lets `?#cw=3.5` change one price without
 * wiping the session it lands on.  Clearing therefore needs an explicit empty
 * key, and both directions are worth pinning down.
 */
test("an absent roof key leaves the base's planes alone", () => {
  const a = scenario();
  const withPlanes = fromHash(toHash(a), freshState());
  assert.equal(withPlanes.roof.planes.length, 2);

  a.roof.planes = [];
  assert.equal(toHash(a).includes("roof="), false, "an empty roof is the default, so it is not encoded");
  assert.equal(fromHash(toHash(a), withPlanes).roof.planes.length, 2);
});

test("an explicit empty roof= or flex= key clears them", () => {
  const base = fromHash(toHash(scenario()), freshState());
  assert.equal(base.roof.planes.length, 2);
  assert.equal(base.flex.length, 2);

  const cleared = fromHash("roof=&flex=", base);
  assert.equal(cleared.roof.planes.length, 0);
  assert.equal(cleared.flex.length, 0);
});

// ---------------------------------------------------------------- storage

test("storage round-trips everything the hash does, plus polygons", () => {
  const a = scenario();
  const raw = toStorage(a);
  const b = fromStorage(JSON.parse(JSON.stringify(raw)), freshState());

  assert.equal(b.fin.financing.loan.termYears, 20);
  assert.equal(b.ui.objective, "irr");
  assert.deepEqual(b.roof.planes[0].polygon, [[34.1, -118.7], [34.2, -118.8]]);
  assert.deepEqual(b.roof.planes[0].gutterEdge, [0, 1]);
  assert.equal(b.flex[0].detection.chargerKW, 8.02);
});

test("storage omits defaults and the typed address", () => {
  const raw = toStorage(freshState());
  assert.deepEqual(Object.keys(raw), ["v"], "a default session stores only its version");

  const withAddress = toStorage(scenario());
  assert.ok(!JSON.stringify(withAddress).includes("Main"), "the street address must not be stored");
});

test("storage drops the detected hourly slice, which lives in IndexedDB", () => {
  const a = scenario();
  a.flex[0].kwhByHour = new Float64Array([1, 2, 3]);
  const raw = toStorage(a);
  assert.equal(raw.flex[0].kwhByHour, null);
  assert.equal(a.flex[0].kwhByHour.length, 3, "the live state keeps its arrays");
});

test("storage keeps a custom tariff", () => {
  const a = freshState();
  a.tariff.custom = { meta: { custom: true }, plans: [{ id: "mine" }] };
  const b = fromStorage(toStorage(a), freshState());
  assert.equal(b.tariff.custom.plans[0].id, "mine");
});

test("a corrupt or empty storage payload falls back to the defaults", () => {
  assert.deepEqual(fromStorage(null, freshState()), freshState());
  assert.deepEqual(fromStorage("not an object", freshState()), freshState());
  assert.deepEqual(fromStorage({}, freshState()), freshState());
});

test("hash beats storage, which is what makes a shared link authoritative", () => {
  const stored = freshState();
  stored.fin.costPerW = 2.0;
  stored.ui.tab = "bills";

  const base = fromStorage(toStorage(stored), freshState());
  const merged = fromHash("cw=3.5", base);

  assert.equal(merged.fin.costPerW, 3.5, "the link wins on what it names");
  assert.equal(merged.ui.tab, "bills", "and leaves the rest of the session alone");
});

test("the per-plane panel override survives both codecs", () => {
  const a = scenario();
  a.system.override.panelsByPlane = { p1: 22, p2: 8 };
  assert.deepEqual(fromHash(toHash(a), freshState()).system.override.panelsByPlane, { p1: 22, p2: 8 });
  assert.deepEqual(fromStorage(toStorage(a), freshState()).system.override.panelsByPlane, { p1: 22, p2: 8 });
});

test("DEFAULTS is not mutated by any of this", () => {
  const before = JSON.stringify(DEFAULTS);
  const a = scenario();
  fromHash(toHash(a), freshState());
  fromStorage(toStorage(a), freshState());
  assert.equal(JSON.stringify(DEFAULTS), before);
});
