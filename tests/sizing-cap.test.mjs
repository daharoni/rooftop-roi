/* tests/sizing.extra.test.mjs - sizingCapFor gate and NaN-gap scaling in recentAnnualKwh. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Sizing, { sizingCapFor, sceCap, recentAnnualKwh } from "../core/sizing.js";

const sys = { panelW: 460, acFactor: 0.9 };

test("sizingCapFor: only SCE gets a cap", () => {
  const cap = sizingCapFor("sce", 13840, sys);
  assert.ok(cap, "SCE with data -> cap");
  assert.equal(cap.panelsAt150, 29);
  assert.equal(cap.panelsAt150, sceCap({ annualKwh: 13840, ...sys }).panelsAt150, "same as sceCap");
  for (const u of ["pge", "sdge", "", null, undefined, "SCE"]) {
    assert.equal(sizingCapFor(u, 13840, sys), null, `utility ${JSON.stringify(u)} -> null`);
  }
  assert.equal(Sizing.sizingCapFor, sizingCapFor, "default export carries it");
});

test("sizingCapFor: no usable usage -> null, even for SCE", () => {
  for (const kwh of [null, undefined, 0, -5, NaN]) {
    assert.equal(sizingCapFor("sce", kwh, sys), null, `kwh ${kwh}`);
  }
  assert.equal(sizingCapFor("sce", 13840), null, "missing system opts -> null, no throw");
  assert.equal(sizingCapFor("sce", 13840, { panelW: 0, acFactor: 0.9 }), null);
});

function series(days, f) {
  const ts = [], kwh = [], start = Date.UTC(2024, 0, 1);
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    ts.push(new Date(start + (d * 24 + h) * 3600000).toISOString().slice(0, 13) + ":00");
    kwh.push(f(d, h));
  }
  return { ts, kwh };
}
const within = (a, b, pct, msg) => assert.ok(Math.abs(a - b) / b <= pct, `${msg}: ${a} vs ${b}`);

test("recentAnnualKwh: NaN days are treated as missing, not zero", () => {
  const full = series(365, () => 1.5);
  const gappy = series(365, (d) => (d % 12 === 5 ? NaN : 1.5));       // 30 NaN days
  assert.equal(gappy.kwh.filter(Number.isNaN).length, 30 * 24);
  const total = recentAnnualKwh(full);
  within(total, 365 * 24 * 1.5, 1e-9, "ungapped baseline");
  within(recentAnnualKwh(gappy), total, 0.01, "30 NaN days stay within 1% of the ungapped total");
});

test("recentAnnualKwh: an all-NaN window is null", () => {
  assert.equal(recentAnnualKwh(series(200, () => NaN)), null);
});

test("recentAnnualKwh: gaps in a short record scale once, not twice", () => {
  const full = series(100, () => 2);
  const gappy = series(100, (d) => (d % 10 === 3 ? NaN : 2));         // 10 NaN days
  within(recentAnnualKwh(full), 365 * 24 * 2, 0.005, "short record scales to a year");
  within(recentAnnualKwh(gappy), 365 * 24 * 2, 0.01, "short + gappy still lands on the year");
});
