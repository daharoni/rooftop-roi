/* tests/sizing.test.mjs - SCE's interconnection sizing arithmetic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Sizing, { sceCap, recentAnnualKwh, SCE_KWH_PER_AC_KW } from "../core/sizing.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);

test("SCE counts CEC-AC kW x 1,728 kWh/yr against the last 12 months", () => {
  assert.equal(SCE_KWH_PER_AC_KW, 1728, "720 x 0.20 x 12");
  const cap = sceCap({ annualKwh: 13840, panelW: 460, acFactor: 0.9 });
  near(cap.kwhPerPanel, 0.46 * 0.9 * 1728, 1e-9, "a 460 W panel at 0.90 counts as 715 kWh/yr");
  assert.equal(cap.panelsAt100, 19, "19 panels stay under 100% (no paperwork)");
  assert.equal(cap.panelsAt150, 29, "29 panels is the most SCE accepts at 150%");
  assert.ok(cap.estimatedKwh(29) <= 1.5 * 13840 && cap.estimatedKwh(30) > 1.5 * 13840, "30 would be refused");
  assert.equal(sceCap({ annualKwh: 13840, panelW: 460, acFactor: 0.87 }).panelsAt150, 30,
               "a lower AC rating per panel lets one more panel through");
  assert.equal(sceCap({ annualKwh: 0, panelW: 460 }), null, "nothing to size against -> null");
  assert.equal(Sizing.sceCap, sceCap, "default export carries the same functions");
});

test("recentAnnualKwh sums the most recent 365 days only, scaling short records", () => {
  const ts = [], kwh = [];
  const start = Date.UTC(2024, 8, 1);
  for (let d = 0; d < 400; d++) for (let h = 0; h < 24; h++) {
    const t = new Date(start + (d * 24 + h) * 3600000);
    ts.push(t.toISOString().slice(0, 13) + ":00");
    kwh.push(d < 35 ? 100 : 1);                       // the first 35 days are huge and must drop out
  }
  near(recentAnnualKwh({ ts, kwh }), 365 * 24, 1e-6, "400 days of data -> only the last 365 count");
  near(recentAnnualKwh({ ts: ts.slice(0, 100 * 24), kwh: kwh.slice(0, 100 * 24) }),
       (35 * 24 * 100 + 65 * 24) * 365 / 100, 400, "100 days scale up to a year (within a DST hour)");
  assert.equal(recentAnnualKwh({ ts: ts.slice(0, 24 * 10), kwh: kwh.slice(0, 240) }), null, "10 days is too little to guess from");
  assert.equal(recentAnnualKwh(null), null, "no load set -> null");
});
