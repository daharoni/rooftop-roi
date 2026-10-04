/* tests/heatpump.test.mjs - the heat-pump profile follows the weather and sums to the annual figure. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HP = await import(path.join(ROOT, "core/heatpump.js"));

const pad2 = (n) => String(n).padStart(2, "0");
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** A load set of hourly ts from `from` for `days` days, no DST (January start, short spans
 *  stay inside winter; year-long sets use the real DST rule through a helper below). */
function loadSetFor(startYear, startMo, startDay, days, tz = "America/Los_Angeles") {
  const ts = [];
  // Wall-clock stamps via Intl so DST days have 23/25... keep simple: 23-hour spring day, 24 otherwise.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit" });
  let t = Date.UTC(startYear, startMo - 1, startDay, 8);   // 00:00 PST
  for (let i = 0; i < days * 24; i++, t += 3600000) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    ts.push(`${p.year}-${p.month}-${p.day}T${pad2(+p.hour % 24)}:00`);
  }
  return { ts, kwh: new Float64Array(ts.length).fill(1), exportKwh: null, meta: {} };
}

/** Sinusoidal year: coldest 15 Jan (5 C mean-ish), warmest mid-July, plus a daily swing. */
function synthYear(year, offset = 0) {
  const temp = new Float64Array(8760);
  for (let h = 0; h < 8760; h++) {
    const doy = h / 24;
    temp[h] = 15 + 8 * Math.cos(2 * Math.PI * (doy - 196) / 365) + 4 * Math.sin(2 * Math.PI * ((h % 24) - 9) / 24) + offset;
  }
  return { year, temp, ghi: new Float64Array(8760), dni: new Float64Array(8760), dhi: new Float64Array(8760), wind: new Float64Array(8760) };
}

const flex = (over = {}) => ({ id: "hp", kind: "heatpump", annualKwh: 2500,
  heatpump: { annualKwh: 2500, cop: 3, balanceC: 16, mode: "heating", ...over } });

const yearLoad = loadSetFor(2024, 1, 1, 365);   // 2024 is a leap year; the span stops before Dec 31

test("length matches the load", () => {
  const out = HP.profileFor(flex(), yearLoad, [synthYear(2024)]);
  assert.equal(out.length, yearLoad.kwh.length);
  assert.ok(out instanceof Float64Array);
});

test("a year sums to annualKwh", () => {
  const out = HP.profileFor(flex(), yearLoad, [synthYear(2024)]);
  assert.ok(Math.abs(sum(out) - 2500) < 1, sum(out));
  const big = HP.profileFor(flex({ annualKwh: 4100 }), yearLoad, [synthYear(2024)]);
  assert.ok(Math.abs(sum(big) - 4100) < 1);
});

test("a record shorter than a year is scaled pro rata", () => {
  const ls = loadSetFor(2024, 1, 1, 30);
  const out = HP.profileFor(flex(), ls, [synthYear(2024)]);
  assert.ok(Math.abs(sum(out) - 2500 * 720 / 8760) < 0.5);
});

test("zero in hours at or above the balance temperature", () => {
  const wy = synthYear(2024);
  const out = HP.profileFor(flex({ balanceC: 14 }), yearLoad, [wy]);
  let checked = 0;
  for (let i = 0; i < out.length; i++) {
    const doy = +yearLoad.ts[i].slice(5, 7) , d = +yearLoad.ts[i].slice(8, 10);
    const h = +yearLoad.ts[i].slice(11, 13);
    const idx = (CUM[doy - 1] + d - 1) * 24 + h;
    if (idx < 8760 && wy.temp[idx] >= 14 + 1.5) { assert.equal(out[i], 0); checked++; }   // 1.5 C slack for DST hour shift
  }
  assert.ok(checked > 1000);
});

test("more kWh in January than in July", () => {
  const out = HP.profileFor(flex(), yearLoad, [synthYear(2024)]);
  let jan = 0, jul = 0;
  for (let i = 0; i < out.length; i++) {
    const m = +yearLoad.ts[i].slice(5, 7);
    if (m === 1) jan += out[i]; else if (m === 7) jul += out[i];
  }
  assert.ok(jan > 5 * jul, `${jan} vs ${jul}`);
  assert.equal(jul, 0);   // warmest month never drops below a 16 C balance point in this synthetic year
});

test("climatology fallback when the load's year has no weather", () => {
  const a = synthYear(2019), b = synthYear(2020, 2);
  const out = HP.profileFor(flex(), yearLoad, [a, b]);       // load is 2024
  assert.ok(Math.abs(sum(out) - 2500) < 1);
  // The fallback is the mean of the two years: the same as one year at +1 C.
  const ref = HP.profileFor(flex(), yearLoad, [synthYear(2024, 1)]);
  for (let i = 0; i < out.length; i += 97) assert.ok(Math.abs(out[i] - ref[i]) < 1e-9);
});

test("the matching calendar year is preferred over the climatology", () => {
  const warm = synthYear(2024, 6), cold = synthYear(2023, -6);
  const withMatch = HP.profileFor(flex(), yearLoad, [cold, warm]);
  const warmOnly = HP.profileFor(flex(), yearLoad, [warm]);
  for (let i = 0; i < withMatch.length; i += 101) assert.ok(Math.abs(withMatch[i] - warmOnly[i]) < 1e-9);
});

test("no weather or no demand gives zeros, never a throw", () => {
  assert.equal(sum(HP.profileFor(flex(), yearLoad, [])), 0);
  assert.equal(sum(HP.profileFor(flex({ annualKwh: 0 }), yearLoad, [synthYear(2024)])), 0);
  assert.equal(sum(HP.profileFor(flex({ balanceC: -50 }), yearLoad, [synthYear(2024)])), 0);
});

test("defaultAnnualKwh and describe", () => {
  assert.equal(HP.defaultAnnualKwh({ sqft: 1500 }), 4500);
  assert.equal(HP.defaultAnnualKwh({}), 2500);
  assert.equal(HP.defaultAnnualKwh({ sqft: 100000 }), 8000);
  assert.match(HP.describe(flex()), /2,500 kWh/);
  assert.match(HP.describe(flex()), /61 °F/);
});
