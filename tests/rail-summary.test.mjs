/* tests/rail-summary.test.mjs - closed-group summaries and the changed-from-default check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSummary, groupChanged } from "../app/ui/controls.js";
import knobs from "../app/ui/knobs.js";
import { freshState } from "../app/state.js";

test("explicit summaries read the current state", () => {
  const s = freshState();
  assert.match(groupSummary(knobs.price({}), s), /^\$\d+\.\d\d\/W · \$[\d,]+\/kWh$/);
  s.fin.financing.mode = "cash";
  assert.equal(groupSummary(knobs.financing(), s), "Cash");
  s.fin.financing.mode = "loan"; s.fin.financing.loan.apr = 0.065; s.fin.financing.loan.termYears = 20;
  assert.equal(groupSummary(knobs.financing(), s), "Loan 6.5% · 20 yr");
  assert.match(groupSummary(knobs.future({}, false, s), s), /% invested · [\d.]+%\/yr rates$/);
});

test("derived summary uses the first two visible items", () => {
  const g = { group: "x", items: [
    { path: "a", kind: "select", opts: [{ v: 1, t: "One" }] },
    { path: "b", kind: "range", pct: 0, show: () => false },
    { path: "c", kind: "check", label: "On when true" },
    { path: "d", kind: "range", unit: " W" },
  ] };
  assert.equal(groupSummary(g, { a: 1, b: 0.5, c: true, d: 9 }), "One · On when true");
  assert.equal(groupSummary(g, { a: 1, c: false, d: 9 }), "One · 9 W");
});

test("groupChanged compares with DEFAULTS", () => {
  const s = freshState();
  const g = knobs.price({});
  assert.equal(groupChanged(g, s), false);
  s.fin.costPerW += 1;
  assert.equal(groupChanged(g, s), true);
});
