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
  MAX_LIST, NAME_MAX, cleanName, TABS, CODEC_VERSION,
} from "../app/state.js";
import { BATTERY_PRESETS, applyPreset, presetOptions, matchPreset } from "../app/ui/presets.js";

/** A state with something changed at every level of nesting. */
function scenario() {
  const s = freshState();
  s.site.lat = 34.15;
  s.site.lon = -118.75;
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
  assert.equal(h, "v=2&cw=2.5", "a versioned hash: v first, then only what differs");
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
  assert.deepEqual(fromStorage({ v: 2 }, freshState()), freshState());
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

test("share links and storage never carry coordinates finer than ~1 km", async () => {
  const S = await import("../app/state.js");
  assert.equal(S.roundCoord(34.1456789), 34.15, "roundCoord keeps two decimals");
  assert.equal(S.roundCoord(-118.7612345), -118.76, "...for negative longitudes too");
  const s = JSON.parse(JSON.stringify(S.DEFAULTS));
  s.site.lat = 34.1456789; s.site.lon = -118.7612345;
  const h = S.toHash(s);
  assert.ok(h.includes("lat=34.15") && h.includes("lon=-118.76"), `hash rounds the site: ${h.slice(0, 40)}`);
  assert.ok(!h.includes("34.1456"), "and the precise point never appears");
});

// ------------------------------------------------------- hardening (P0 #10)

test("a malformed percent sequence never throws and is reported", () => {
  const report = {};
  let s;
  assert.doesNotThrow(() => { s = fromHash("#lat=%E0%A4%A&cw=2.5", freshState(), report); });
  assert.equal(s.site.lat, null, "the damaged key falls back to its default");
  assert.equal(s.fin.costPerW, 2.5, "the readable keys still apply");
  assert.equal(report.damaged, true);
  assert.deepEqual(report.keys, ["lat"]);
});

test("damaged plane and flex fields fall back without losing the token", () => {
  const report = {};
  const s = fromHash("roof=p1:25:%ZZ:10:0:0:Good%20name;p2:30:200:8:0:0:%E0%A4", freshState(), report);
  assert.equal(s.roof.planes.length, 2);
  assert.equal(s.roof.planes[0].azimuth, 180, "unreadable azimuth -> default");
  assert.equal(s.roof.planes[0].name, "Good name");
  assert.equal(s.roof.planes[1].name, "Roof face", "unreadable name -> default name");
  assert.equal(report.damaged, true);
});

test("plane and flex names with ; : % & , = round-trip exactly once-decoded", () => {
  const nasty = "A;b:c%d&e,f=g %20 x";
  const s = freshState();
  s.roof.planes = [{ id: "p1", name: nasty, tilt: 22, azimuth: 190, maxPanels: 12,
    shading: { annual: 0.1 }, costAdder: 0, polygon: null, gutterEdge: null }];
  s.flex = [{ id: "ev1", kind: "ev", name: nasty, source: "manual", annualKwh: 3000, kwhByHour: null,
    detection: null, schedule: { mode: "asRecorded", daysPerWeek: 5, window: [8, 15],
      daylightFraction: 0.9, overnightWindow: [1, 5], maxKW: 8, followSolar: true }, scale: 1 }];
  const h = toHash(s);
  const back = fromHash(h, freshState());
  assert.equal(back.roof.planes[0].name, nasty);
  assert.equal(back.roof.planes[0].azimuth, 190);
  assert.equal(back.flex[0].name, nasty);
  assert.equal(toHash(back), h, "and re-encoding is stable");
});

test("names are capped at 40 characters", () => {
  const s = freshState();
  s.roof.planes = [{ id: "p1", name: "x".repeat(200), tilt: 20, azimuth: 180, maxPanels: 10,
    shading: { annual: 0 }, costAdder: 0 }];
  assert.equal(fromHash(toHash(s), freshState()).roof.planes[0].name.length, 40);
});

test("out-of-range, unparseable and off-enum scalars become the default, never null", () => {
  const report = {};
  const s = fromHash("maxb=100000&maxp=5000&panelW=x&pw=null&strat=foo&hz=2.5&lapr=abc&obj=bogus&gcharge=maybe",
    freshState(), report);
  assert.equal(s.system.maxBatteries, DEFAULTS.system.maxBatteries);
  assert.equal(s.system.maxPanels, DEFAULTS.system.maxPanels);
  assert.equal(s.system.panelW, 460);
  assert.equal(s.system.strategy, "tou_arbitrage");
  assert.equal(s.fin.horizon, 25, "an integer key refuses 2.5");
  assert.equal(s.fin.financing.loan.apr, DEFAULTS.fin.financing.loan.apr);
  assert.equal(s.ui.objective, "npv");
  assert.equal(s.system.gridCharge, false);
  assert.equal(report.damaged, true);
});

test("in-range values pass the schema untouched", () => {
  const s = fromHash("maxb=12&pw=400&strat=self_consumption&tum=4&breg=10", freshState());
  assert.equal(s.system.maxBatteries, 12);
  assert.equal(s.system.panelW, 400);
  assert.equal(s.system.strategy, "self_consumption");
  assert.equal(s.fin.trueUpMonth, 4);
  assert.equal(s.site.baselineRegion, "10");
});

test("storage values pass the same schema", () => {
  const s = fromStorage({ v: 1, pw: null, maxb: 1e6, strat: "foo", cw: 2.2 }, freshState());
  assert.equal(s.system.panelW, 460);
  assert.equal(s.system.maxBatteries, 6);
  assert.equal(s.system.strategy, "tou_arbitrage");
  assert.equal(s.fin.costPerW, 2.2);
});

test("a newer version is applied as far as this build understands it, and flagged; unversioned reads as v1", () => {
  const rep = {};
  const s = fromStorage({ v: 99, cw: 2.2, someFutureKey: 7 }, freshState(), rep);
  assert.equal(s.fin.costPerW, 2.2, "a key this build understands still applies");
  assert.equal(rep.damaged, true, "and the session is flagged");
  const hrep = {};
  assert.equal(fromHash("v=99&cw=2.2", freshState(), hrep).fin.costPerW, 2.2, "a link follows the same policy");
  assert.equal(hrep.damaged, true);
  const quiet = {};
  assert.equal(fromStorage({ cw: 2.2 }, freshState(), quiet).fin.costPerW, 2.2);
  assert.equal(quiet.damaged, undefined, "an unversioned session is not damage");
  const vq = {};
  fromHash("v=1&cw=2.2", freshState(), vq);
  assert.equal(vq.damaged, undefined);
});

test("the new engine fields round-trip through both codecs", () => {
  const s = freshState();
  s.site.baselineRegion = "9";
  s.fin.trueUpMonth = 7;
  const h = fromHash(toHash(s), freshState());
  assert.equal(h.site.baselineRegion, "9");
  assert.equal(h.fin.trueUpMonth, 7);
  const st = fromStorage(JSON.parse(JSON.stringify(toStorage(s))), freshState());
  assert.equal(st.site.baselineRegion, "9");
  assert.equal(st.fin.trueUpMonth, 7);
  const out = fromHash("tum=13", freshState());
  assert.equal(out.fin.trueUpMonth, null, "month 13 -> default (null = engine decides)");
});

test("the existing-solar acknowledgement lives in storage, never in a link", () => {
  const s = freshState();
  s.ui.existingSolarAck = true;
  assert.equal(toHash(s), "");
  assert.equal(fromStorage(toStorage(s), freshState()).ui.existingSolarAck, true);
});

test("legacy unversioned links still parse", () => {
  const s = fromHash("cw=2.1&roof=p1:20:169:30:0.05:0:South%20face", freshState());
  assert.equal(s.fin.costPerW, 2.1);
  assert.equal(s.roof.planes[0].name, "South face");
  assert.equal(s.roof.planes[0].azimuth, 169);
});

test("a hostile link cannot name prototype keys or flood the roof and flex lists", () => {
  const rep = {};
  const planes = Array.from({ length: 30 }, (_, i) => `__proto__:20:180:200:0:0:n${i}`).join(";");
  const h = "v=1&util=constructor&plan=__proto__&prov=prototype&roof=" + planes
    + "&ovp=__proto__:5;constructor:7&flex=" + Array.from({ length: 20 }, (_, i) => `constructor:ev:3000:manual`).join(";");
  const st = fromHash(h, freshState(), rep);
  assert.equal(st.site.utilityId, null);
  assert.equal(st.tariff.planId, null);
  assert.equal(st.tariff.providerId, null);
  assert.equal(st.roof.planes.length, MAX_LIST);
  assert.equal(st.flex.length, MAX_LIST);
  for (const p of st.roof.planes) assert.match(p.id, /^p\d+$/);
  for (const f of st.flex) assert.match(f.id, /^f\d+$/);
  assert.equal(st.system.override.panelsByPlane, null);
  assert.equal(rep.damaged, true);
  assert.equal(typeof ({}).polluted, "undefined");
  assert.equal(Object.getPrototypeOf(st.system.override), Object.prototype);
});

// ------------------------------------------- 2026-10-03 adversarial review

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("names are cut by code point: an emoji at the 40th position never leaves a lone surrogate", () => {
  const emojis = ["\u{1F600}", "\u{1F3E0}", "\u{1F697}", "\u{1F1FA}\u{1F1F8}", "\u{1F468}\u200D\u{1F469}", "\u00E9", "\u65E5"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let it = 0; it < 400; it++) {
    // A prefix of 35-45 UTF-16 units, so the cut lands on every side of a pair.
    const pre = "x".repeat(35 + Math.floor(rnd() * 11));
    let name = pre;
    for (let k = 0; k < 4; k++) name += emojis[Math.floor(rnd() * emojis.length)];
    const s = freshState();
    s.roof.planes = [{ id: "p1", name, tilt: 20, azimuth: 180, maxPanels: 10, shading: { annual: 0 }, costAdder: 0 }];
    s.flex = [{ id: "f1", kind: "ev", name, source: "manual", annualKwh: 3000, kwhByHour: null, detection: null,
      schedule: { mode: "spread", daysPerWeek: 5, window: [8, 15], daylightFraction: 0.9, overnightWindow: [1, 5],
        maxKW: 8, followSolar: true }, scale: 1 }];
    const rep = {};
    let h;
    assert.doesNotThrow(() => { h = toHash(s, rep); }, name);
    assert.equal(rep.damaged, undefined, "nothing had to be dropped: " + JSON.stringify(name));
    const back = fromHash(h, freshState());
    for (const n of [back.roof.planes[0].name, back.flex[0].name]) {
      assert.ok(!LONE.test(n), "no lone surrogate in " + JSON.stringify(n));
      assert.ok(Array.from(n).length <= NAME_MAX);
    }
    assert.equal(toHash(back), h, "stable once cut");
  }
});

test("cleanName strips lone surrogates already in a name, from storage or a paste", () => {
  assert.equal(cleanName("ab\uD83Dcd", "x"), "abcd");
  assert.equal(cleanName("\uDE00", "fallback"), "fallback");
  assert.equal(cleanName("x".repeat(39) + "\u{1F600}", "f"), "x".repeat(39) + "\u{1F600}");
  assert.equal(cleanName({ toString() { throw new Error("no"); } }, "f"), "f");
  const st = fromStorage({ v: 1, planes: [{ id: "p1", name: "Roof \uD83D", tilt: 20, azimuth: 180, maxPanels: 10 }] }, freshState());
  assert.equal(st.roof.planes[0].name, "Roof");
});

test("toHash never throws: an unencodable or broken token is dropped and reported", () => {
  const s = freshState();
  s.fin.costPerW = 2.5;
  s.roof.planes = [null, { id: "p2", name: "ok", tilt: 20, azimuth: 180, maxPanels: 10, shading: { annual: 0 }, costAdder: 0 }];
  s.site.tz = "Bad\uD800";                      // a lone surrogate in a scalar
  const rep = {};
  let h;
  assert.doesNotThrow(() => { h = toHash(s, rep); });
  assert.equal(rep.damaged, true);
  assert.ok(rep.keys.includes("roof") && rep.keys.includes("tz"));
  const back = fromHash(h, freshState());
  assert.equal(back.fin.costPerW, 2.5, "the good keys are still written");
  assert.equal(back.roof.planes.length, 1);
  assert.equal(back.roof.planes[0].id, "p2");
});

test("a damaged link key keeps the stored value instead of resetting it to the default", () => {
  const stored = freshState();
  stored.site.lat = 34.15; stored.site.lon = -118.75; stored.fin.costPerW = 2.2;
  const rep = {};
  const s = fromHash("#lat=%E0%A4%A&lon=-118.5&cw=abc", stored, rep);
  assert.equal(s.site.lat, 34.15, "lat keeps its stored value");
  assert.equal(s.site.lon, -118.5, "lon from the link still applies");
  assert.equal(s.fin.costPerW, 2.2);
  assert.deepEqual(rep.keys, ["lat", "cw"]);
});

test("storage: a null plane does not crash toHash on every reload", () => {
  const rep = {};
  const s = fromStorage({ v: 1, planes: [null] }, freshState(), rep);
  assert.deepEqual(s.roof.planes, []);
  assert.equal(rep.damaged, true);
  assert.doesNotThrow(() => toHash(s));
  const t = fromStorage({ v: 1, planes: "nope", flex: [3, null, { kind: "ev", annualKwh: 2500 }] }, freshState(), {});
  assert.deepEqual(t.roof.planes, []);
  assert.equal(t.flex.length, 1);
  assert.equal(t.flex[0].kind, "ev");
  assert.doesNotThrow(() => toHash(t));
});

test("storage: stored planes and loads go through the link's field coercion", () => {
  const rep = {};
  const s = fromStorage({ v: 1,
    planes: [{ id: "__proto__", name: 42, tilt: 900, azimuth: "west", maxPanels: -3, shading: { annual: 7 },
      costAdder: 1e12, polygon: [[34, -118], ["x", 1]], gutterEdge: [0, 9] },
      { id: "p2", name: "ok", tilt: 25, azimuth: 200, maxPanels: 12, shading: { annual: 0.1 }, costAdder: 0,
        polygon: [[34, -118], [34.1, -118], [34.1, -118.1]], gutterEdge: [0, 1] }],
    flex: [{ id: "ev1", kind: "custom", name: "Car", source: "robot", annualKwh: 2500,
      schedule: { daysPerWeek: 99, window: [8, 99], maxKW: "fast", followSolar: false, hoursPerDay: 4 },
      scale: 1, detection: { confidence: 0.8 } }],
  }, freshState(), rep);
  const [a, b] = s.roof.planes;
  assert.equal(a.id, "p1");
  assert.equal(a.name, "42");
  assert.equal(a.tilt, 20);
  assert.equal(a.azimuth, 180);
  assert.equal(a.maxPanels, 20);
  assert.equal(a.shading.annual, 0);
  assert.equal(a.costAdder, 0);
  assert.equal(a.polygon, null);
  assert.equal(a.gutterEdge, null);
  assert.deepEqual(b.polygon, [[34, -118], [34.1, -118], [34.1, -118.1]]);
  assert.deepEqual(b.gutterEdge, [0, 1]);
  const f = s.flex[0];
  assert.equal(f.kind, "custom");
  assert.equal(f.source, "manual");
  assert.equal(f.annualKwh, 2500);
  assert.equal(f.schedule.mode, "asRecorded", "no mode stays as recorded, never silently spread");
  assert.equal(f.schedule.daysPerWeek, 5);
  assert.deepEqual(f.schedule.window, [8, 15]);
  assert.equal(f.schedule.followSolar, false);
  assert.equal(f.schedule.hoursPerDay, 4);
  assert.equal(f.detection.confidence, 0.8);
});

test("storage: a __proto__ key never becomes a prototype, and `in` never reads through one", () => {
  const raw = JSON.parse('{"v":2,"__proto__":{"cw":9,"planes":[null]},"ovp":{"__proto__":3,"p1":4},'
    + '"customTariff":{"__proto__":{"polluted":true},"plans":[]},"flex":[{"id":"f1","kind":"ev","annualKwh":3000,"detection":{"__proto__":{"x":1}}}]}');
  const rep = {};
  let s;
  assert.doesNotThrow(() => { s = fromStorage(raw, freshState(), rep); });
  assert.equal(s.fin.costPerW, DEFAULTS.fin.costPerW, "cw from the prototype is not read");
  assert.deepEqual(s.roof.planes, []);
  assert.deepEqual(s.system.override.panelsByPlane, { p1: 4 });
  assert.equal(Object.getPrototypeOf(s.tariff.custom), Object.prototype);
  assert.equal(s.tariff.custom.polluted, undefined);
  assert.equal(Object.getPrototypeOf(s.flex[0].detection), Object.prototype);
  assert.equal(typeof ({}).polluted, "undefined");
  assert.doesNotThrow(() => toHash(s));
});

test("storage: ovp, customTariff and scalars that are the wrong shape are flagged, not applied", () => {
  const rep = {};
  const base = freshState();
  base.fin.costPerW = 2.4;
  const s = fromStorage({ v: 1, ovp: [1, 2], customTariff: "x", cw: "cheap" }, base, rep);
  assert.equal(s.system.override.panelsByPlane, null);
  assert.equal(s.tariff.custom, null);
  assert.equal(s.fin.costPerW, 2.4, "an unreadable stored scalar keeps the base value");
  assert.ok(["ovp", "customTariff", "cw"].every((k) => rep.keys.includes(k)));
});

test("a link whose roof list is unreadable keeps the stored roof instead of a blank default", () => {
  const base = freshState();
  base.roof.planes = [{ id: "p1", name: "Kept face", tilt: 25, azimuth: 170, maxPanels: 22,
    shading: { annual: 0 }, costAdder: 0, polygon: [[34.1, -118.7], [34.1, -118.6]], gutterEdge: null }];
  const rep = {};
  const s = fromHash("v=1&roof=%&ovp=p1:%", clone(base), rep);
  assert.equal(s.roof.planes.length, 1);
  assert.equal(s.roof.planes[0].name, "Kept face");
  assert.ok(Array.isArray(s.roof.planes[0].polygon), "the traced outline survives");
  assert.equal(s.system.override.panelsByPlane, null);
  assert.equal(rep.damaged, true);
  assert.deepEqual([...new Set(rep.keys)].sort(), ["ovp", "roof"]);
});

test("storage and links drop flexible loads that describe no real load", () => {
  // fromStorage({ flex: [{}] }) used to come back as a silent 0-kWh custom load.
  const rep = {};
  const empty = fromStorage({ v: 1, flex: [{}] }, freshState(), rep);
  assert.deepEqual(empty.flex, []);
  assert.equal(rep.damaged, true);
  assert.ok(rep.keys.includes("flex"));

  const good = { id: "ev1", kind: "ev", annualKwh: 3000, source: "manual", name: "Car",
    schedule: { mode: "spread", daysPerWeek: 5, window: [9, 15] } };
  const bad = [
    { ...good, id: "k", kind: "rocket" },                        // unknown kind
    { ...good, id: "z", annualKwh: 0 },                          // no energy
    { ...good, id: "n", annualKwh: -5 },
    { ...good, id: "i", annualKwh: Infinity },
    { ...good, id: "s", annualKwh: "lots" },
    { ...good, id: "x", schedule: "nightly" },                   // schedule is not an object
    { ...good, id: "m", schedule: { mode: "teleport" } },        // unknown mode
    { ...good, id: "w", schedule: { mode: "spread", window: "8-15" } },   // window not a pair
  ];
  const r2 = {};
  const s = fromStorage({ v: 1, flex: [good, ...bad] }, freshState(), r2);
  assert.deepEqual(s.flex.map((f) => f.id), ["ev1"]);
  assert.equal(s.flex[0].schedule.mode, "spread");
  assert.equal(r2.keys.filter((k) => k === "flex").length, bad.length);

  // A stored session's loads survive a link whose every flex token is unusable.
  const base = clone(s);
  const r3 = {};
  const viaLink = fromHash("v=1&flex=f1:rocket:3000:manual;f2:ev:0:manual", base, r3);
  assert.deepEqual(viaLink.flex.map((f) => f.id), ["ev1"]);
  assert.equal(r3.damaged, true);
  // ...and a mixed link keeps the usable token only.
  const mixed = fromHash("v=1&flex=f1:rocket:3000:manual;f2:pool:1800:manual", freshState(), {});
  assert.deepEqual(mixed.flex.map((f) => [f.id, f.kind, f.annualKwh]), [["f2", "pool", 1800]]);
});

// ------------------------------------------------------------------ v2 additions

const NEW_KEYS = [
  ["system.battPreset", "pw3", "bp"], ["fin.costPerBattery", 4500, "cb"], ["fin.resilienceValue", 600, "rv"],
  ["fin.vppPerBattery", 350, "vpp"], ["fin.microinverters", true, "micro"],
  ["quote.kwDc", 8.2, "qkw"], ["quote.batteries", 2, "qb"], ["quote.battKWh", 13.5, "qbk"],
  ["quote.price", 41000, "qpr"], ["quote.annualKwh", 12400, "qkwh"], ["quote.monthly", 199, "qmo"],
  ["existing.kwDc", 5.5, "xkw"], ["existing.planeId", "p1", "xpl"], ["existing.nem", "nem2", "xnem"],
  ["existing.since", 2016, "xyr"],
];

test("every v2 key round-trips through the hash and through storage", () => {
  for (const [path, value, key] of NEW_KEYS) {
    const s = freshState();
    setPath(s, path, value);
    const h = toHash(s);
    assert.ok(h.includes(key + "="), key + " appears in the hash");
    assert.deepEqual(getPath(fromHash(h, freshState()), path), value, path + " via hash");
    assert.deepEqual(getPath(fromStorage(JSON.parse(JSON.stringify(toStorage(s))), freshState()), path), value, path + " via storage");
  }
});

test("nullable quote numbers are omitted when null and rejected out of range", () => {
  const h = toHash(Object.assign(freshState(), { baseLoadScale: 1.2 }));
  assert.ok(!/q(kw|b|bk|pr|kwh|mo)=|x(kw|pl|nem|yr)=/.test(h), "defaults never appear");
  assert.equal(toStorage(freshState()).qkw, undefined);
  const rep = {};
  const s = fromHash("v=2&qkw=99&qb=2.5&xnem=bogus", freshState(), rep);
  assert.equal(s.quote.kwDc, null);
  assert.equal(s.quote.batteries, 0);
  assert.equal(s.existing.nem, "none");
  assert.deepEqual(rep.keys.sort(), ["qb", "qkw", "xnem"]);
});

test("existing.since reads null from an old link, and an out-of-range year is flagged", () => {
  assert.equal(fromHash("v=2&xkw=5&xnem=nem2", freshState()).existing.since, null);
  assert.equal(freshState().existing.since, null);
  const rep = {};
  const s = fromHash("v=2&xyr=1980", freshState(), rep);
  assert.equal(s.existing.since, null);
  assert.deepEqual(rep.keys, ["xyr"]);
  const rep2 = {};
  assert.equal(fromHash("v=2&xyr=2016.5", freshState(), rep2).existing.since, null);
  assert.deepEqual(rep2.keys, ["xyr"]);
});

test("the version 1 to 2 migration restores the old defaults a v1 link left out", () => {
  assert.equal(CODEC_VERSION, 2);
  assert.equal(fromHash("v=1&tab=roof", freshState()).fin.costPerW, 3.0, "v1, no cw: the old default");
  assert.equal(fromHash("v=1&tab=roof", freshState()).system.rte, 0.9);
  // A link with no version is read as today's: a hand-written "#tab=quote" must not price at $3.00.
  assert.equal(fromHash("tab=quote", freshState()).fin.costPerW, 2.75, "no v on a link: current defaults");
  assert.equal(fromHash("v=abc&tab=quote", freshState()).fin.costPerW, 2.75, "unreadable v: current defaults");
  // A v2 link that omits cw/rte means the v2 defaults, even over a session that holds the old ones.
  const oldSession = fromStorage({ hz: 20 }, freshState());
  assert.equal(oldSession.fin.costPerW, 3.0);
  assert.equal(fromHash("v=2&bkwh=12", oldSession).fin.costPerW, 2.75, "a v2 link beats the stored old price");
  assert.equal(fromHash("v=2&bkwh=12", oldSession).system.rte, 0.88);
  assert.equal(fromHash("v=2&tab=roof", freshState()).fin.costPerW, 2.75, "v=2 means today's default");
  assert.equal(fromHash("v=2&tab=roof", freshState()).system.rte, 0.88);
  assert.equal(fromHash("v=1&cw=2.2", freshState()).fin.costPerW, 2.2, "an explicit value is kept");
  assert.equal(fromHash("v=1&cw=2.2", freshState()).system.rte, 0.9);
  assert.equal(fromStorage({ v: 1, hz: 20 }, freshState()).fin.costPerW, 3.0, "storage migrates too");
  assert.equal(fromStorage({ hz: 20 }, freshState()).system.rte, 0.9);
  assert.equal(fromStorage({ v: 2, hz: 20 }, freshState()).fin.costPerW, 2.75);
});

test("a heat-pump flexible load keeps annualKwh, cop and balance point through both codecs", () => {
  const s = freshState();
  s.flex = [{ id: "hp1", kind: "heatpump", name: "Heat pump", annualKwh: 2800, source: "manual",
    kwhByHour: new Float64Array(4), detection: null,
    schedule: { mode: "asRecorded", daysPerWeek: 7, window: [0, 24], daylightFraction: 0.5, overnightWindow: [1, 5], maxKW: 5, followSolar: false },
    scale: 1, heatpump: { annualKwh: 2800, cop: 2.6, balanceC: 14.5, mode: "heating" } }];
  const h = toHash(s);
  const a = fromHash(h, freshState()).flex[0];
  assert.deepEqual(a.heatpump, { annualKwh: 2800, cop: 2.6, balanceC: 14.5, mode: "heating" });
  assert.equal(a.kind, "heatpump");
  assert.equal(a.kwhByHour, null);
  const b = fromStorage(JSON.parse(JSON.stringify(toStorage(s))), freshState()).flex[0];
  assert.deepEqual(b.heatpump, a.heatpump);
  assert.equal(b.kwhByHour, null);
  // An old 15-field EV token is unchanged and carries no heatpump block.
  const ev = fromHash("v=2&flex=f1:ev:3000:manual:asRecorded:5:8:15:0.9:1:5:8:1:1:EV", freshState()).flex[0];
  assert.equal(ev.heatpump, undefined);
});

test("TABS gains quote after dashboard", () => {
  assert.deepEqual(TABS, ["dashboard", "quote", "roof", "loads", "bills", "assumptions"]);
});

test("battery presets: apply, list and match", () => {
  const sys = freshState().system;
  const pw = applyPreset(sys, "pw3");
  assert.deepEqual([pw.battKWh, pw.battKW, pw.rte, pw.battPreset], [13.5, 11.5, 0.89, "pw3"]);
  assert.equal(sys.battKWh, 10, "the input is not mutated");
  const keep = applyPreset(pw, "custom");
  assert.deepEqual([keep.battKWh, keep.battKW, keep.battPreset], [13.5, 11.5, "custom"]);
  assert.equal(presetOptions()[0].v, "custom");
  assert.equal(presetOptions().length, BATTERY_PRESETS.length);
  assert.equal(matchPreset(pw), "pw3");
  assert.equal(matchPreset({ battKWh: 13.505, battKW: 11.5 }), "pw3");
  assert.equal(matchPreset(sys), "custom");
});
