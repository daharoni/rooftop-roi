/* tests/synthload.test.mjs - run with: node --test tests/
 *
 * A synthetic LoadSet must be indistinguishable from a parsed one to the engine,
 * so the checks compare against the real demo household's own LoadSet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SL = await import(path.join(ROOT, "core/synthload.js"));
const GB = (await import(path.join(ROOT, "core/greenbutton.js"))).default;
const { detectEV } = await import(path.join(ROOT, "core/flexload.js"));
const Engine = await import(path.join(ROOT, "core/engine.js"));
const TARIFF = JSON.parse(read("data/tariffs/sce.json"));

const MONTHLY = [620, 540, 500, 480, 520, 640, 900, 980, 800, 600, 560, 640];
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };

test("month totals equal the inputs to within 0.01 kWh", () => {
  for (const endMonth of ["2025-08", "2026-02", "2024-12"]) {
    const ls = SL.synthesize({ monthlyKwh: MONTHLY, endMonth });
    const got = new Array(12).fill(0);
    for (let i = 0; i < ls.ts.length; i++) got[+ls.ts[i].slice(5, 7) - 1] += ls.kwh[i];
    for (let m = 0; m < 12; m++) assert.ok(Math.abs(got[m] - MONTHLY[m]) < 0.01, `${endMonth} month ${m + 1}: ${got[m]}`);
    assert.ok(Math.abs(ls.meta.totalKwh - sum(MONTHLY)) < 0.01);
  }
});

test("LoadSet shape matches what the parser produces", () => {
  const ls = SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2025-08", utilityId: "sce" });
  assert.ok(ls.kwh instanceof Float64Array);
  assert.equal(ls.exportKwh, null);
  assert.equal(ls.ts.length, ls.kwh.length);
  assert.equal(ls.meta.source, "synthetic");
  assert.equal(ls.meta.tz, "America/Los_Angeles");
  assert.equal(ls.meta.intervalMinutes, 60);
  assert.deepEqual(ls.meta.gapsFilled, []);
  assert.equal(ls.meta.nHours, ls.ts.length);
  assert.equal(ls.meta.start, ls.ts[0]);
  assert.equal(ls.meta.end, ls.ts[ls.ts.length - 1]);
  assert.deepEqual(ls.meta.monthlyKwh, MONTHLY);
  assert.ok(Array.isArray(ls.meta.notes) && ls.meta.notes.length > 0);
  for (const s of ls.ts) assert.match(s, /^\d{4}-\d\d-\d\dT\d\d:00$/);
  for (const v of ls.kwh) assert.ok(Number.isFinite(v) && v >= 0);
});

test("hours per year are 8760 less the spring-forward hour (leap years add a day)", () => {
  assert.equal(SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2025-08" }).meta.nHours, 8759);
  assert.equal(SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2024-12" }).meta.nHours, 8783); // 2024 has Feb 29
  // A span with no March has no spring-forward day.
  const ls = SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2025-02" });
  assert.equal(ls.meta.nHours, 8760 + 24 * 0 - 1);   // Mar 2024 is inside; Mar 2025 is not
});

test("ts is strictly increasing in clock time and follows the greenbutton DST convention", () => {
  const ls = SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2025-08" });
  for (let i = 1; i < ls.ts.length; i++) assert.ok(ls.ts[i] > ls.ts[i - 1], ls.ts[i]);
  // Compare against the parsed demo year covering the same span.
  const real = GB.parse(read("data/demo/demo-sce-usage-2024-09.csv"), { filename: "demo-sce-usage-2024-09.csv" });
  assert.equal(ls.ts.length, real.ts.length);
  assert.deepEqual(ls.ts, real.ts);
  const day = (d) => ls.ts.filter((s) => s.startsWith(d)).length;
  assert.equal(day("2025-03-09"), 23);
  assert.equal(day("2024-11-03"), 24);
  assert.equal(day("2025-03-10"), 24);
});

test("weekend days follow the calendar", () => {
  const flat = new Array(12).fill(720);
  const ls = SL.synthesize({ monthlyKwh: flat, endMonth: "2025-08" });
  const daily = new Map();
  for (let i = 0; i < ls.ts.length; i++) { const d = ls.ts[i].slice(0, 10); daily.set(d, (daily.get(d) || 0) + ls.kwh[i]); }
  // Two ordinary weekdays in one month have identical energy; a Saturday differs by the ratio.
  assert.ok(Math.abs(daily.get("2025-01-07") - daily.get("2025-01-08")) < 1e-9);
  assert.notEqual(daily.get("2025-01-07").toFixed(6), daily.get("2025-01-04").toFixed(6));
});

test("seasonalSplit sums to the input and has twelve positive months", () => {
  for (const a of [1200, 7200.5, 15000]) {
    const s = SL.seasonalSplit(a);
    assert.equal(s.length, 12);
    assert.ok(Math.abs(sum(s) - a) < 1e-9);
    for (const v of s) assert.ok(v > 0);
  }
  assert.throws(() => SL.seasonalSplit(0), (e) => typeof e.userMessage === "string");
  assert.throws(() => SL.seasonalSplit(NaN), (e) => typeof e.userMessage === "string");
});

test("bad input is rejected with a homeowner message", () => {
  const bad = [
    new Array(11).fill(500), new Array(13).fill(500), null, undefined, "x",
    [...MONTHLY.slice(0, 11), -1], [...MONTHLY.slice(0, 11), NaN], [...MONTHLY.slice(0, 11), Infinity],
    [...MONTHLY.slice(0, 11), "500"], new Array(12).fill(0),
  ];
  for (const b of bad) {
    assert.throws(() => SL.synthesize({ monthlyKwh: b, endMonth: "2025-08" }),
      (e) => e instanceof Error && typeof e.userMessage === "string" && e.userMessage.length > 10 && !/—/.test(e.userMessage));
  }
  assert.throws(() => SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "Aug 2025" }), (e) => !!e.userMessage);
});

test("a month of zero is allowed when another month has usage", () => {
  const m = [...MONTHLY]; m[0] = 0;
  const ls = SL.synthesize({ monthlyKwh: m, endMonth: "2025-08" });
  assert.ok(Math.abs(ls.meta.totalKwh - sum(m)) < 0.01);
});

test("default endMonth is the last complete month", () => {
  const ls = SL.synthesize({ monthlyKwh: MONTHLY });
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  assert.equal(ls.meta.end.slice(0, 7), prev.toISOString().slice(0, 7));
});

test("detectEV finds nothing in a synthetic household", () => {
  const ls = SL.synthesize({ monthlyKwh: MONTHLY, endMonth: "2025-08" });
  assert.equal(detectEV(ls), null);
});

test("the engine accepts a synthetic LoadSet", () => {
  const ls = SL.synthesize({ monthlyKwh: SL.seasonalSplit(9000), endMonth: "2025-08", utilityId: "sce" });
  const ctx = Engine.prepare({ load: ls, tariffs: TARIFF });
  assert.ok(ctx.usableDays >= 360);
  assert.ok(Math.abs((ctx.N - 0) - ls.meta.nHours) === 0);
});
