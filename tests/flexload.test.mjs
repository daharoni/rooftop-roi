/* tests/flexload.test.mjs — run with: node --test tests/
 *
 * The detector is checked against the prototype's own output
 * (tests/fixtures/load-agoura-hills.json `ev_kwh` / `ev_sessions`), parsed live
 * out of data/demo, so a change to either module shows up here.
 * `reshape` is checked on small hand-built calendars where the answer is obvious.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GB = (await import(path.join(ROOT, "core/greenbutton.js"))).default;
const FL = (await import(path.join(ROOT, "core/flexload.js"))).default;

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pad2 = (n) => String(n).padStart(2, "0");
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };

const FIXTURE = JSON.parse(read("tests/fixtures/load-agoura-hills.json"));

// The demo household, parsed once and shared by every test below.
const LOAD = GB.mergeLoadSets([
  GB.parse(read("data/demo/demo-sce-usage-2024-09.csv")),
  GB.parse(read("data/demo/demo-sce-usage-2025-09.csv")),
]);
const CAL = FL.buildCalendar(LOAD);
const EV = FL.detectEV(LOAD);

/** Pearson correlation of two equal-length series. */
function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db);
}

const within = (got, want, pct) => Math.abs(got - want) <= Math.abs(want) * pct;

// ---------------------------------------------------------------------------
// 1. detectEV against the prototype
// ---------------------------------------------------------------------------
test("detectEV: charger, sessions and annual energy match the reference detector", () => {
  const d = EV.detection;
  assert.equal(EV.kind, "ev");
  assert.equal(EV.source, "detected");
  assert.equal(EV.kwhByHour.length, LOAD.ts.length);

  assert.ok(within(d.chargerKW, 8.0, 0.05), `chargerKW ${d.chargerKW} not within 5% of 8.0`);
  assert.ok(within(d.sessions.length, 254, 0.05), `${d.sessions.length} sessions, expected ~254`);
  assert.ok(within(EV.annualKwh, 3582, 0.05), `${EV.annualKwh} kWh/yr, expected ~3582`);
  assert.ok(within(d.sessionsPerWeek, 2.41, 0.05), `${d.sessionsPerWeek} sessions/week`);
  assert.ok(within(d.medianSessionKwh, 26.64, 0.05), `median session ${d.medianSessionKwh} kWh`);
  assert.ok(d.confidence > 0.5 && d.confidence <= 1, `confidence ${d.confidence}`);
  assert.match(d.method, /Two-pass hour-of-day baseline/);
});

test("detectEV: the hourly split tracks the fixture's ev_kwh", () => {
  const fx = FIXTURE.ev_kwh;
  assert.equal(EV.kwhByHour.length, fx.length);
  const c = corr(Array.from(EV.kwhByHour), fx);
  assert.ok(c > 0.95, `correlation with the fixture is ${c.toFixed(4)}`);
  const mine = sum(EV.kwhByHour), theirs = sum(fx);
  assert.ok(within(mine, theirs, 0.03), `total ${mine.toFixed(1)} vs ${theirs.toFixed(1)} kWh`);
});

test("detectEV: sessions line up with the fixture's ev_sessions", () => {
  const mine = EV.detection.sessions, theirs = FIXTURE.ev_sessions;
  assert.ok(within(mine.length, theirs.length, 0.05));
  const k = Math.min(mine.length, theirs.length);
  let matched = 0;
  for (let i = 0; i < k; i++) {
    if (mine[i].date === theirs[i].date && mine[i].startHour === theirs[i].start_hour) matched++;
  }
  assert.ok(matched / k > 0.9, `${matched}/${k} sessions share a date and start hour`);
});

test("detectEV: never claims more EV than the meter recorded, and never goes negative", () => {
  for (let i = 0; i < LOAD.ts.length; i++) {
    assert.ok(EV.kwhByHour[i] >= 0, `negative EV at ${LOAD.ts[i]}`);
    assert.ok(EV.kwhByHour[i] <= LOAD.kwh[i] + 1e-9, `EV > metered at ${LOAD.ts[i]}`);
    assert.ok(EV.kwhByHour[i] <= EV.detection.chargerKW + 1e-9, `EV > charger at ${LOAD.ts[i]}`);
  }
});

test("detectEV: a household with no EV gets no sessions and no confidence", () => {
  const ts = [], kwh = [];
  for (let d = 1; d <= 40; d++) {
    for (let h = 0; h < 24; h++) {
      ts.push(`2025-06-${pad2(d <= 30 ? d : d - 30)}T${pad2(h)}:00`.replace("2025-06-", d <= 30 ? "2025-06-" : "2025-07-"));
      kwh.push(0.5 + 0.3 * Math.sin(h / 24 * 2 * Math.PI));
    }
  }
  const flat = { meta: {}, ts, kwh: Float64Array.from(kwh), exportKwh: null };
  const ev = FL.detectEV(flat);
  assert.equal(ev.detection.sessions.length, 0);
  assert.equal(ev.detection.confidence, 0);
  assert.equal(sum(ev.kwhByHour), 0);
});

// ---------------------------------------------------------------------------
// 2. detectPool
// ---------------------------------------------------------------------------
test("detectPool: returns null for the demo household, which has no pool", () => {
  assert.equal(FL.detectPool(LOAD, { evKwhByHour: EV.kwhByHour }), null);
});

test("detectPool: finds a flat 1 kW midday block when one is there", () => {
  const ts = [], kwh = [];
  const start = Date.UTC(2025, 3, 1);
  for (let d = 0; d < 120; d++) {
    const day = new Date(start + d * 86400000);
    const ds = `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
    for (let h = 0; h < 24; h++) {
      ts.push(`${ds}T${pad2(h)}:00`);
      let v = 0.4 + 0.25 * Math.sin((h - 6) / 24 * 2 * Math.PI) + ((d * 7 + h * 13) % 11) * 0.01;
      if (h >= 10 && h < 16) v += 1.0;                 // the pump
      kwh.push(v);
    }
  }
  const ls = { meta: {}, ts, kwh: Float64Array.from(kwh), exportKwh: null };
  const pool = FL.detectPool(ls);
  assert.ok(pool, "expected a pool to be detected");
  assert.equal(pool.kind, "pool");
  assert.equal(pool.detection.startHour, 10);
  assert.ok(pool.detection.hoursPerDay >= 5 && pool.detection.hoursPerDay <= 7,
    `hoursPerDay ${pool.detection.hoursPerDay}`);
  assert.ok(within(pool.detection.chargerKW, 1.0, 0.25), `level ${pool.detection.chargerKW} kW`);
  assert.ok(pool.detection.confidence > 0.5);
});

// ---------------------------------------------------------------------------
// 3. reshape
// ---------------------------------------------------------------------------
/** A calendar of `nDays` whole days starting on a Monday, no DST inside it. */
function mondayCal(nDays = 28, start = "2025-06-02") {
  const ts = [];
  const t0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  for (let d = 0; d < nDays; d++) {
    const day = new Date(t0 + d * 86400000);
    const ds = `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
    for (let h = 0; h < 24; h++) ts.push(`${ds}T${pad2(h)}:00`);
  }
  return FL.buildCalendar({ ts });
}

/** A per-kW standard-time solar shape: a half-sine between 07:00 and 18:00. */
function solarShape() {
  const s = new Float64Array(8760);
  for (let d = 0; d < 365; d++) {
    for (let h = 7; h < 18; h++) s[d * 24 + h] = Math.sin((h - 7) / 11 * Math.PI);
  }
  return s;
}
const SHAPE = solarShape();

test("reshape asRecorded: reproduces the fixture's ev_kwh exactly", () => {
  const out = FL.reshape({ ...EV, schedule: { ...EV.schedule, mode: "asRecorded" } }, CAL, SHAPE);
  assert.equal(out.length, FIXTURE.ev_kwh.length);
  let bad = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i] - FIXTURE.ev_kwh[i]) > 1e-9) bad++;
  assert.equal(bad, 0, `${bad} hours differ from the fixture's ev_kwh`);
});

test("reshape asRecorded: scale multiplies the recorded shape", () => {
  const out = FL.reshape({ ...EV, scale: 1.2, schedule: { ...EV.schedule, mode: "asRecorded" } }, CAL, SHAPE);
  assert.ok(Math.abs(sum(out) - 1.2 * sum(EV.kwhByHour)) < 1e-6);
});

test("reshape spread: conserves every Mon-Sun week's energy exactly", () => {
  const out = FL.reshape(EV, CAL, SHAPE);
  const shift = (CAL.dayDow[0] + 6) % 7;
  const before = new Map(), after = new Map();
  for (let i = 0; i < CAL.N; i++) {
    const w = Math.floor((CAL.dayIdx[i] + shift) / 7);
    before.set(w, (before.get(w) || 0) + EV.kwhByHour[i]);
    after.set(w, (after.get(w) || 0) + out[i]);
  }
  assert.ok(before.size > 100, "the demo record should span ~107 weeks");
  for (const [w, v] of before) {
    assert.ok(Math.abs(v - after.get(w)) < 1e-6, `week ${w}: ${v} -> ${after.get(w)}`);
  }
  assert.ok(Math.abs(sum(out) - sum(EV.kwhByHour)) < 1e-6);
});

test("reshape spread: nothing exceeds maxKW", () => {
  const flex = { ...EV, schedule: { ...EV.schedule, maxKW: 6 } };
  const out = FL.reshape(flex, CAL, SHAPE);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i] <= 6 + 1e-9, `${LOAD.ts[i]} = ${out[i]} kWh exceeds the 6 kW cap`);
  }
  assert.ok(Math.abs(sum(out) - sum(EV.kwhByHour)) < 1e-6, "capping must not lose energy");
});

test("reshape spread: 5 days a week puts nothing on a Saturday or Sunday", () => {
  const cal = mondayCal(28);
  const flex = {
    id: "ev2", kind: "ev", name: "Second EV", source: "manual", kwhByHour: null,
    annualKwh: 3650, detection: null, scale: 1,
    schedule: { mode: "spread", daysPerWeek: 5, window: [8, 15], daylightFraction: 0.9,
                overnightWindow: [1, 5], maxKW: 8, followSolar: true },
  };
  const out = FL.reshape(flex, cal, SHAPE);
  let weekend = 0, weekday = 0;
  for (let i = 0; i < cal.N; i++) {
    const dow = cal.dayDow[cal.dayIdx[i]];
    if (dow === 0 || dow === 6) weekend += out[i]; else weekday += out[i];
  }
  assert.equal(weekend, 0, `${weekend} kWh landed on a weekend`);
  assert.ok(Math.abs(weekday - 4 * 3650 / 52.18) < 1e-6, `4 weeks should carry ${4 * 3650 / 52.18} kWh`);
});

test("reshape spread: 7 days a week uses every day; 1 day a week only Mondays", () => {
  const cal = mondayCal(28);
  const base = {
    id: "x", kind: "custom", name: "x", source: "manual", kwhByHour: null,
    annualKwh: 3650, detection: null, scale: 1,
    schedule: { mode: "spread", daysPerWeek: 7, window: [8, 15], daylightFraction: 1,
                overnightWindow: [1, 5], maxKW: 8, followSolar: false },
  };
  const seven = FL.reshape(base, cal, SHAPE);
  const days = new Set();
  for (let i = 0; i < cal.N; i++) if (seven[i] > 1e-12) days.add(cal.dayIdx[i]);
  assert.equal(days.size, 28);

  const one = FL.reshape({ ...base, schedule: { ...base.schedule, daysPerWeek: 1 } }, cal, SHAPE);
  for (let i = 0; i < cal.N; i++) {
    if (one[i] > 1e-12) assert.equal(cal.dayDow[cal.dayIdx[i]], 1, "only Mondays");
  }
  assert.ok(Math.abs(sum(one) - sum(seven)) < 1e-9, "the same energy either way");
});

test("reshape spread: daylightFraction splits between the two windows", () => {
  const cal = mondayCal(7);
  const flex = {
    id: "x", kind: "custom", name: "x", source: "manual", kwhByHour: null,
    annualKwh: 5218, detection: null, scale: 1,           // 100 kWh/week
    schedule: { mode: "spread", daysPerWeek: 7, window: [8, 15], daylightFraction: 0.9,
                overnightWindow: [1, 5], maxKW: 8, followSolar: false },
  };
  const out = FL.reshape(flex, cal, SHAPE);
  let day = 0, night = 0, other = 0;
  for (let i = 0; i < cal.N; i++) {
    const h = cal.hourA[i];
    if (h >= 8 && h < 15) day += out[i];
    else if (h >= 1 && h < 5) night += out[i];
    else other += out[i];
  }
  assert.ok(Math.abs(day - 90) < 1e-6, `day window ${day}`);
  assert.ok(Math.abs(night - 10) < 1e-6, `overnight window ${night}`);
  assert.equal(other, 0);
});

test("reshape spread: followSolar weights the window by the solar shape", () => {
  const cal = mondayCal(7);
  const flex = {
    id: "x", kind: "custom", name: "x", source: "manual", kwhByHour: null,
    annualKwh: 5218, detection: null, scale: 1,
    schedule: { mode: "spread", daysPerWeek: 7, window: [8, 15], daylightFraction: 1,
                overnightWindow: [1, 5], maxKW: 8, followSolar: true },
  };
  const solar = FL.reshape(flex, cal, SHAPE);
  const flat = FL.reshape({ ...flex, schedule: { ...flex.schedule, followSolar: false } }, cal, SHAPE);
  assert.ok(Math.abs(sum(solar) - sum(flat)) < 1e-6);

  // hour 12 is nearer the peak of the half-sine than hour 8, so it must get more
  const at = (arr, h) => { let s = 0; for (let i = 0; i < cal.N; i++) if (cal.hourA[i] === h) s += arr[i]; return s; };
  assert.ok(at(solar, 12) > at(solar, 8) * 1.2, "solar weighting should favour midday");
  assert.ok(Math.abs(at(flat, 12) - at(flat, 8)) < 1e-9, "flat mode should not");
});

test("reshape spread: a week with no recorded charging stays empty", () => {
  const cal = mondayCal(14);
  const kwhByHour = new Float64Array(cal.N);
  for (let i = 0; i < cal.N; i++) if (cal.dayIdx[i] < 7 && cal.hourA[i] === 2) kwhByHour[i] = 5;
  const flex = {
    id: "ev", kind: "ev", name: "EV", source: "detected", kwhByHour, annualKwh: 100,
    detection: null, scale: 1,
    schedule: { mode: "spread", daysPerWeek: 5, window: [8, 15], daylightFraction: 0.9,
                overnightWindow: [1, 5], maxKW: 8, followSolar: true },
  };
  const out = FL.reshape(flex, cal, SHAPE);
  for (let i = 0; i < cal.N; i++) if (cal.dayIdx[i] >= 7) assert.equal(out[i], 0);
  assert.ok(Math.abs(sum(out) - 35) < 1e-9);
});

test("reshape asRecorded: a manual load with no kwhByHour falls back to a nightly block", () => {
  const cal = mondayCal(7);
  const flex = {
    id: "x", kind: "custom", name: "x", source: "manual", kwhByHour: null,
    annualKwh: 365.25, detection: null, scale: 1,          // 1 kWh/day
    schedule: { mode: "asRecorded", overnightWindow: [1, 5], maxKW: 3, daysPerWeek: 7,
                window: [8, 15], daylightFraction: 0.9, followSolar: false },
  };
  const out = FL.reshape(flex, cal, SHAPE);
  assert.ok(Math.abs(sum(out) - 7) < 1e-9);
  for (let i = 0; i < cal.N; i++) {
    const h = cal.hourA[i];
    if (h >= 1 && h < 5) assert.ok(Math.abs(out[i] - 0.25) < 1e-9);
    else assert.equal(out[i], 0);
  }
});

test("reshape pool: a flat block of hoursPerDay from window[0], sized to annualKwh", () => {
  const cal = mondayCal(30);
  const pool = FL.presets().find((p) => p.kind === "pool");
  const out = FL.reshape(pool, cal, SHAPE);
  assert.ok(Math.abs(sum(out) - pool.annualKwh * 30 / 365.25) < 1e-6);
  for (let i = 0; i < cal.N; i++) {
    const h = cal.hourA[i];
    if (h >= 10 && h < 18) assert.ok(Math.abs(out[i] - 0.5) < 1e-9, `hour ${h} = ${out[i]}`);
    else assert.equal(out[i], 0, `hour ${h} should be idle`);
  }
});

test("reshape pool: too much energy for hoursPerDay runs extra hours rather than breaking maxKW", () => {
  const cal = mondayCal(7);
  const pool = {
    id: "pool", kind: "pool", name: "Pool", source: "manual", kwhByHour: null,
    annualKwh: 0.5 * 12 * 365.25, detection: null, scale: 1,
    schedule: { mode: "spread", daysPerWeek: 7, window: [10, 18], daylightFraction: 1,
                overnightWindow: [1, 5], maxKW: 0.5, followSolar: false, hoursPerDay: 8 },
  };
  const out = FL.reshape(pool, cal, SHAPE);
  assert.ok(Math.abs(sum(out) - 0.5 * 12 * 7) < 1e-6, "energy is conserved");
  for (let i = 0; i < cal.N; i++) assert.ok(out[i] <= 0.5 + 1e-9, "the cap holds");
  const hoursOn = new Set();
  for (let i = 0; i < cal.N; i++) if (out[i] > 1e-12) hoursOn.add(cal.hourA[i]);
  assert.equal(hoursOn.size, 12);
});

test("reshape: scale is applied to manual loads too", () => {
  const cal = mondayCal(7);
  const pool = FL.presets().find((p) => p.kind === "pool");
  const one = FL.reshape(pool, cal, SHAPE);
  const two = FL.reshape({ ...pool, scale: 2, schedule: { ...pool.schedule, maxKW: 2 } }, cal, SHAPE);
  assert.ok(Math.abs(sum(two) - 2 * sum(one)) < 1e-6);
});

test("reshape: works on the real DST calendar, where two days are 23 hours long", () => {
  const out = FL.reshape(EV, CAL, SHAPE);
  assert.equal(out.length, CAL.N);
  for (let i = 0; i < out.length; i++) assert.ok(Number.isFinite(out[i]));
  assert.ok(Math.abs(sum(out) - sum(EV.kwhByHour)) < 1e-6);
});

// ---------------------------------------------------------------------------
// 4. presets + summarize
// ---------------------------------------------------------------------------
test("presets: four manual templates, every one a valid FlexLoad", () => {
  const ps = FL.presets();
  assert.equal(ps.length, 4);
  const cal = mondayCal(28);
  for (const p of ps) {
    assert.equal(p.source, "manual");
    assert.equal(p.kwhByHour, null);
    assert.equal(p.detection, null);
    assert.ok(["ev", "pool", "custom"].includes(p.kind));
    assert.ok(p.annualKwh > 0);
    assert.ok(p.schedule && Array.isArray(p.schedule.window));
    const out = FL.reshape(p, cal, SHAPE);
    const expected = p.kind === "pool" ? p.annualKwh * 28 / 365.25 : p.annualKwh * 4 / 52.18;
    assert.ok(Math.abs(sum(out) - expected) < 1e-6, `${p.id}: ${sum(out)} vs ${expected}`);
  }
  const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
  assert.ok(Math.abs(byId.pool.annualKwh - 0.5 * 8 * 365.25) < 0.01);
  assert.ok(Math.abs(byId.hpwh.annualKwh - 4 * 365.25) < 0.01);
  assert.ok(Math.abs(byId.laundry.annualKwh - 3 * 365.25) < 0.01);
  assert.deepEqual(byId.ev2.schedule.window, FL.DEFAULT_SCHEDULE.window);
});

test("summarize: says what was detected and where it will be put", () => {
  const s = FL.summarize(EV);
  assert.match(s, /Electric vehicle/);
  assert.match(s, /3,582 kWh\/yr detected/);
  assert.match(s, /8\.02 kW charger/);
  assert.match(s, /Mon, Tue, Wed, Thu, Fri/);
  assert.match(s, /between 08:00 and 15:00/);

  const pool = FL.summarize(FL.presets().find((p) => p.kind === "pool"));
  assert.match(pool, /entered by hand/);
  assert.match(pool, /0\.5 kW for 8 h from 10:00/);

  assert.match(FL.summarize({ ...EV, scale: 1.2 }), /Scaled to 120%/);
  assert.equal(FL.summarize(null), "");
});
