/* tests/format.test.mjs - one number-formatting rule: separators, attached units, compact only when asked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMoney, fmtCompact, fmtPer } from "../app/ui/format.js";

test("fmtPer attaches the unit and keeps thousands separators", () => {
  assert.equal(fmtPer(2347, "/kWh"), "$2,347/kWh");
  assert.equal(fmtPer(5.03, "/W", 2), "$5.03/W");
  assert.equal(fmtPer(0.187, "/kWh", 3), "$0.187/kWh");
  assert.equal(fmtPer(null, "/W", 2), "—/W".replace("—/W", "—" + "/W"));
});

test("fmtMoney full figures; fmtCompact only abbreviates from $10k", () => {
  assert.equal(fmtMoney(2929), "$2,929");
  assert.equal(fmtMoney(-4603), "−$4,603");
  assert.equal(fmtCompact(16000), "$16k");
  assert.equal(fmtCompact(2569), "$2,569");
});
