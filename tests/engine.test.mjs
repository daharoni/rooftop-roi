/* =============================================================================
 * tests/engine.test.mjs - node --test tests/
 *
 * Every assertion from the prototype's suite is carried over; the ones that are now
 * someone else's job (orientation interpolation -> core/pv.js, EV detection ->
 * core/flexload.js) are replaced by the contract the engine actually owns: planes,
 * shading, generic flexible loads, dispatch, NBT billing.
 * ========================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import Engine from "../core/engine.js";
import { loadSet, evFlex, poolFlex, plane, refParams,
         RAW_LOAD, SOLAR, TARIFF, REFERENCE } from "./fixtures/agoura.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);
const sum = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };

const LOAD = loadSet();
const ctx = Engine.prepare({ load: LOAD, tariffs: TARIFF });
const P = (over = {}) => Engine.withDefaults(refParams(over.panels === undefined ? 20 : over.panels,
                                                       over.batteries === undefined ? 1 : over.batteries,
                                                       over));

// ------------------------------------------------------------------ mini fixture
/** A 2-day July dataset with hand-checkable numbers. */
function miniData(opts = {}) {
  const ts = [], kwh = [], ev = [];
  for (const d of ["2025-07-01", "2025-07-02"]) {
    for (let h = 0; h < 24; h++) {
      ts.push(`${d}T${String(h).padStart(2, "0")}:00`);
      const b = opts.load === undefined ? 1.0 : opts.load;
      const e = opts.ev ? opts.ev(d, h) : 0;
      ev.push(e); kwh.push(b + e);
    }
  }
  // 3 kWh/kW at standard hours 10-13 => wall-clock 11-14 in July (PDT)
  const profile = new Float64Array(8760);
  for (let doy = 1; doy <= 365; doy++) for (const h of [10, 11, 12, 13]) profile[(doy - 1) * 24 + h] = 3.0;

  const flat = (v) => Array.from({ length: 12 }, () => new Array(24).fill(v));
  const rate = (v) => ({ sce: v, cpa_lean: v, cpa_clean: v, cpa_green: v, delivery: v * 0.6, sce_generation: v * 0.4 });
  const sched = (p) => new Array(24).fill(p);
  const tariffs = {
    meta: { baseline_kwh_per_day: { summer: 0, winter: 0 }, escalation: { recommended_default: 0.04 } },
    providers: { sce: { name: "SCE" } },
    plans: [{
      id: "MINI", name: "Mini", summer_months: [7],
      fixed_charge_per_day: 0.50, minimum_charge_per_day: 0.40, baseline_credit_per_kwh: 0,
      period_ids: ["on", "mid", "off", "super_off"],
      schedule: { summer: { weekday: sched("off"), weekend: sched("off") },
                  winter: { weekday: sched("off"), weekend: sched("off") } },
      rates: { summer: { on: rate(0.6), mid: rate(0.4), off: rate(0.30) },
               winter: { on: rate(0.5), mid: rate(0.4), off: rate(0.30), super_off: rate(0.2) } },
    }],
    nbt: { export_rates: { weekday: flat(opts.exportRate ?? 0.10), weekend: flat(opts.exportRate ?? 0.10) },
           cpa_export_adder_per_kwh: 0, net_surplus_compensation_per_kwh: 0.05,
           nonbypassable_charges_per_kwh: 0.02, true_up_month: 7 },
    incentives: { federal_itc_residential_pct: 0, sgip_residential_per_kwh: 0 },
  };
  return {
    ctx: Engine.prepare({ load: { meta: {}, ts, kwh: Float64Array.from(kwh), exportKwh: null }, tariffs }),
    profile, ev: Float64Array.from(ev),
  };
}
/** Params for the mini fixture: 1 kW of array, no flexible loads, no climate credit. */
function miniParams(mini, over = {}) {
  return Engine.withDefaults({
    planes: [{ id: "p1", profile: mini.profile, panels: 1, shading: { annual: 0 } }],
    panelW: 1000, batteries: 0, planId: "MINI", providerId: "sce",
    flex: [], strategy: "self_consumption", climateCreditOff: true,
    accPlusAdder: 0, ngom: true, ...over,
  });
}

// ================================================================== 1. periods
test("tariff period lookup - seasons, weekday/weekend, holidays", () => {
  const plan = Engine.planById(TARIFF, "TOU-D-PRIME");
  const r = Engine.buildRates(ctx, "TOU-D-PRIME", "sce", false);
  const find = (stamp) => LOAD.ts.indexOf(stamp);
  const PID = Engine._internal.PERIOD_IDS;

  const idSummerWeekdayPeak = find("2025-07-15T17:00");     // Tue 5pm July
  const idSummerWeekendPeak = find("2025-07-19T17:00");     // Sat 5pm July
  const idJuly4 = find("2025-07-04T17:00");                 // Friday, but a holiday
  const idWinterNoon = find("2025-01-15T12:00");            // Wed noon January
  const idWinterEve = find("2025-01-15T18:00");

  assert.ok(idSummerWeekdayPeak > 0 && idWinterNoon > 0, "found the sample timestamps");
  assert.equal(PID[r.period[idSummerWeekdayPeak]], "on", "summer weekday 5pm -> on-peak");
  assert.equal(PID[r.period[idSummerWeekendPeak]], "mid", "summer weekend 5pm -> mid-peak");
  assert.equal(PID[r.period[idJuly4]], "mid", "July 4 weekday 5pm -> weekend schedule (holiday)");
  assert.equal(PID[r.period[idWinterNoon]], "super_off", "winter noon -> super-off-peak");
  assert.equal(PID[r.period[idWinterEve]], "mid", "winter 6pm -> mid-peak");
  assert.ok(r.summer[idSummerWeekdayPeak] === 1 && r.summer[idWinterNoon] === 0,
            "season flag follows plan.summer_months");

  const munF = (TARIFF.meta.bill_validation || {}).generation_municipal_surcharge_factor || 0;
  const onRate = plan.rates.summer.on;
  near(r.imp[idSummerWeekdayPeak], onRate.sce + (onRate.sce - onRate.delivery) * munF, 1e-9,
       "on-peak import price = plan rate + generation municipal surcharge");

  const rc = Engine.buildRates(ctx, "TOU-D-PRIME", "cpa_green", false);
  const stack = onRate.cpa_clean - onRate.delivery - onRate.sce_generation + 0.02433;
  near(rc.imp[idSummerWeekdayPeak],
       onRate.cpa_green + (onRate.cpa_green - onRate.delivery - stack) * munF
         + TARIFF.meta.bill_validation.cpa_energy_surcharge_per_kwh, 1e-9,
       "CPA import price carries the CPA energy surcharge and a generation-only municipal surcharge");
  near(stack, 0.03535, 1e-9, "the CCA surcharge stack backs out to the documented $0.03535/kWh");

  assert.notEqual(rc.imp[idSummerWeekdayPeak], r.imp[idSummerWeekdayPeak],
                  "CPA Green prices differ from SCE bundled");
  near(rc.exp[idSummerWeekdayPeak] - r.exp[idSummerWeekdayPeak],
       TARIFF.nbt.cpa_export_adder_per_kwh, 1e-9, "CPA export adder applied to export price");
  assert.ok(ctx.solarIdx.every((v) => v >= 0 && v < 8760),
            "every hour maps into an 8760 solar profile index");
});

test("clock time (load, tariffs) vs standard time (solar) alignment", () => {
  const at = (stamp) => LOAD.ts.indexOf(stamp);
  const solarHour = (stamp) => ctx.solarIdx[at(stamp)] % 24;
  const solarDoy = (stamp) => Math.floor(ctx.solarIdx[at(stamp)] / 24) + 1;

  assert.equal(solarHour("2025-07-15T12:00"), 11, "summer noon PDT reads solar hour 11");
  assert.equal(solarHour("2025-01-15T12:00"), 12, "winter noon PST reads solar hour 12");
  assert.ok(solarHour("2025-07-15T00:00") === 23
            && solarDoy("2025-07-15T00:00") === solarDoy("2025-07-14T12:00"),
            "summer midnight PDT rolls back to hour 23 of the previous day");

  const r = Engine.buildRates(ctx, "TOU-D-PRIME", "sce", false);
  assert.equal(Engine._internal.PERIOD_IDS[r.period[at("2025-07-15T17:00")]], "on",
               "tariff periods still use CLOCK time - 5pm PDT is on-peak, not 4pm");

  const lens = {};
  for (let d = 0; d < ctx.nDays; d++) lens[ctx.dayLen[d]] = (lens[ctx.dayLen[d]] || 0) + 1;
  assert.ok(lens[23] >= 1, `${lens[23] || 0} short (spring-forward) days handled`);
  assert.equal(ctx.N, LOAD.ts.length, "all hourly slots consumed (no 24-per-day assumption)");
  const days = (new Date(LOAD.ts[ctx.N - 1].slice(0, 10)) - new Date(LOAD.ts[0].slice(0, 10))) / 86400000 + 1;
  assert.equal(ctx.nDays, days, "day count comes from elapsed calendar days, not hours/24");
  near(ctx.years, days / 365, 1e-12, "annualisation divides by elapsed days / 365");
  assert.equal(ctx.cal.N, ctx.N, "cal.N matches");
  assert.equal(ctx.cal.dayDow.length, ctx.nDays, "cal.dayDow is one entry per day");
  assert.ok(ctx.cal.hourA instanceof Int8Array && ctx.cal.dayIdx instanceof Int32Array,
            "cal carries the typed arrays flexload.js expects");
});

// ================================================================== 2. NBT math
test("NBT billing on a hand-computed 2-day example", () => {
  // 1 kW array, 3 kWh/kW for 4 midday hours = 12 kWh/day PV; 1 kWh/h load = 24/day.
  // PV to load 4 kWh, export 8 kWh, import 20 kWh. Two identical days.
  const mini = miniData();
  const p = miniParams(mini);
  const scn = Engine.buildScenario(mini.ctx, p);
  const out = Engine.runHours(scn, p, true);
  const years = mini.ctx.nDays / 365;
  const total = out.bill * years;

  near(out.importKwh * years, 40, 1e-6, "import = 2 days x 20 kWh");
  near(out.exportKwh * years, 16, 1e-6, "export = 2 days x 8 kWh");
  near(out.pvKwh * years, 24, 1e-6, "PV = 2 days x 12 kWh");
  near(total, 13.00 - 1.60, 1e-6, "bill = fixed 1.00 + energy 12.00 - export credit 1.60");
  near(out.monthly[0].fixed, 1.00, 1e-9, "monthly fixed charge line");
  near(out.monthly[0].energy, 12.00, 1e-9, "monthly energy line");
  near(out.monthly[0].exportCreditUsed, -1.60, 1e-9, "export credit line");

  // Now make exports big enough to hit the minimum-charge floor and roll credits.
  const m2 = miniData({ exportRate: 1.50 });
  const p2 = miniParams(m2);
  const out2 = Engine.runHours(Engine.buildScenario(m2.ctx, p2), p2, true);
  const total2 = out2.bill * (m2.ctx.nDays / 365);
  near(out2.monthly[0].exportCreditUsed, -12.00, 1e-6, "credits offset only down to the minimum charge");
  near(out2.monthly[0].trueUp, -0.40, 1e-6, "leftover 8 kWh cashed out at NSC $0.05/kWh");
  near(total2, 1.00 - 0.40, 1e-6, "bill floors at $1.00 then true-up pays $0.40 => $0.60");
  assert.ok(out2.monthly[0].bill >= 1.00 - 0.40 - 1e-9, "bill never falls below the floor before true-up");

  // ACC Plus: paid on every exported kWh, and the one credit that may go below the floor.
  const m3 = miniData();
  const p3 = miniParams(m3, { accPlusAdder: 0.016 });
  const out3 = Engine.runHours(Engine.buildScenario(m3.ctx, p3), p3, true);
  near(out3.monthly[0].accPlus, -16 * 0.016, 1e-9, "ACC Plus pays $0.016 on each of 16 exported kWh");
  near(out3.bill * (m3.ctx.nDays / 365), 11.40 - 0.256, 1e-6, "ACC Plus comes straight off the bill");

  const m4 = miniData({ exportRate: 1.50 });
  const p4 = miniParams(m4, { accPlusAdder: 0.016 });
  const out4 = Engine.runHours(Engine.buildScenario(m4.ctx, p4), p4, true);
  assert.ok(out4.monthly[0].bill < 1.00, "ACC Plus can take the bill below the fixed-charge floor");

  // Creditable export capped at modelled PV for paired storage with no NGOM.
  const m5 = miniData();
  const p5 = miniParams(m5, { accPlusAdder: 0, ngom: false, batteries: 1, battKWh: 40,
                              battKW: 40, strategy: "export_arbitrage", exportThreshold: 0 });
  const out5 = Engine.runHours(Engine.buildScenario(m5.ctx, p5), p5, true);
  assert.ok(out5.monthly[0].forfeitedKwh > 0, "exporting more than the array produced forfeits the excess");
  assert.ok(out5.monthly[0].forfeitedCredit > 0, "and the forfeited kWh are stripped at the top prices");
  const p5n = miniParams(m5, { accPlusAdder: 0, ngom: true, batteries: 1, battKWh: 40,
                               battKW: 40, strategy: "export_arbitrage", exportThreshold: 0 });
  const out5n = Engine.runHours(Engine.buildScenario(m5.ctx, p5n), p5n, true);
  near(out5n.monthly[0].forfeitedKwh, 0, 1e-9, "an NGOM removes the export cap entirely");
  assert.ok(out5n.bill < out5.bill, "...and the bill is lower for it");

  // Grid-charging and exporting must never combine.
  const mg = miniData();
  const pg = miniParams(mg, { strategy: "export_arbitrage", exportThreshold: 0, gridCharge: true,
                              batteries: 1, battKWh: 40, battKW: 40 });
  const outg = Engine.runHours(Engine.buildScenario(mg.ctx, pg), pg, true);
  let battExported = 0;
  for (let i = 0; i < 48; i++) battExported += outg.hourly.battExport[i];
  near(battExported, 0, 1e-9, "with grid-charging on, the battery never exports");
});

// ================================================================== 3. reserve
for (const strat of ["self_consumption", "tou_arbitrage", "export_arbitrage", "backup_only"]) {
  test(`battery reserve and capacity limits hold under ${strat}`, () => {
    const p = P({ panels: 30, batteries: 3, minReserve: 0.2, strategy: strat,
                  gridCharge: true, exportThreshold: 0.25 });
    const out = Engine.runHours(Engine.buildScenario(ctx, p), p, true);
    const cap = p.batteries * p.battKWh, floor = cap * p.minReserve;
    let minSoc = Infinity, maxSoc = -Infinity, maxRate = 0;
    for (let i = 0; i < ctx.N; i++) {
      const s = out.hourly.soc[i];
      if (s < minSoc) minSoc = s;
      if (s > maxSoc) maxSoc = s;
      const rate = out.hourly.pvToBatt[i] + out.hourly.gridToBatt[i]
                 + out.hourly.battToLoad[i] + out.hourly.battExport[i];
      if (rate > maxRate) maxRate = rate;
    }
    assert.ok(minSoc >= floor - 1e-7, `SOC never below the reserve (${minSoc} vs ${floor})`);
    assert.ok(maxSoc <= cap + 1e-7, `SOC never above usable capacity (${maxSoc} of ${cap})`);
    assert.ok(maxRate <= p.batteries * p.battKW + 1e-7, "hourly throughput within the inverter limit");
  });
}

test("minReserve = 0 lets the pack run to empty", () => {
  const p = P({ panels: 30, batteries: 2, minReserve: 0, strategy: "self_consumption" });
  const out = Engine.runHours(Engine.buildScenario(ctx, p), p, true);
  let minSoc = Infinity;
  for (let i = 0; i < ctx.N; i++) minSoc = Math.min(minSoc, out.hourly.soc[i]);
  assert.ok(minSoc >= -1e-9 && minSoc < 0.5, `min SOC ${minSoc} kWh`);
});

// ================================================================== 4. balance
test("hourly energy balance holds for every hour", () => {
  const p = P({ panels: 26, batteries: 2, strategy: "export_arbitrage",
                gridCharge: true, exportThreshold: 0.25, exportLimitKW: 6 });
  const scn = Engine.buildScenario(ctx, p);
  const out = Engine.runHours(scn, p, true);
  const h = out.hourly;
  let badLoad = 0, badPv = 0, badSoc = 0, clipped = 0, worst = 0;
  const eff = Math.sqrt(p.rte);
  let soc = null;
  for (let i = 0; i < ctx.N; i++) {
    const L = scn.load[i];
    const e1 = Math.abs(L - (h.pvToLoad[i] + h.battToLoad[i] + h.gridToLoad[i]));
    const e2 = Math.abs(h.pv[i] - (h.pvToLoad[i] + h.pvToBatt[i] + h.pvExport[i] + h.clipped[i]));
    if (e1 > 1e-9) badLoad++;
    if (e2 > 1e-9) badPv++;
    worst = Math.max(worst, e1, e2);
    if (h.clipped[i] > 0) clipped++;
    if (soc !== null) {
      const want = soc + (h.pvToBatt[i] + h.gridToBatt[i]) * eff - (h.battToLoad[i] + h.battExport[i]) / eff;
      if (Math.abs(want - h.soc[i]) > 1e-7) badSoc++;
    }
    soc = h.soc[i];
  }
  assert.equal(badLoad, 0, `load = PV->load + batt->load + grid->load everywhere (worst ${worst})`);
  assert.equal(badPv, 0, "PV = PV->load + PV->batt + export + clipped for all hours");
  assert.equal(badSoc, 0, "SOC evolves exactly by round-trip-efficiency bookkeeping");
  assert.ok(clipped > 0, `export limit produces clipping (${clipped} hours)`);
  near(out.selfSufficiency, 1 - out.importKwh / out.loadKwh, 1e-9, "self-sufficiency matches import/load");
});

// ================================================================== 5. planes
test("multiple planes: PV sums and pvKwhByPlane reconciles", () => {
  const south = plane(10, { id: "south" });
  const west = plane(14, { id: "west", azimuth: 240 });
  const both = Engine.withDefaults(refParams(0, 1, { planes: [south, west] }));
  const onlyS = Engine.withDefaults(refParams(0, 1, { planes: [plane(10, { id: "south" })] }));
  const onlyW = Engine.withDefaults(refParams(0, 1, { planes: [plane(14, { id: "west", azimuth: 240 })] }));

  const rB = Engine.runHours(Engine.buildScenario(ctx, both), both, false);
  const rS = Engine.runHours(Engine.buildScenario(ctx, onlyS), onlyS, false);
  const rW = Engine.runHours(Engine.buildScenario(ctx, onlyW), onlyW, false);

  near(rB.pvKwh, rS.pvKwh + rW.pvKwh, 1e-9, "two-plane PV is the sum of the two single-plane runs");
  assert.equal(rB.pvKwhByPlane.length, 2, "pvKwhByPlane has one entry per plane");
  near(rB.pvKwhByPlane[0], rS.pvKwh, 1e-9, "plane 1 production matches its solo run");
  near(rB.pvKwhByPlane[1], rW.pvKwh, 1e-9, "plane 2 production matches its solo run");
  near(rB.pvKwhByPlane[0] + rB.pvKwhByPlane[1], rB.pvKwh, 1e-9, "pvKwhByPlane reconciles with pvKwh");
  assert.deepEqual(rB.panelsByPlane, [10, 14], "panelsByPlane reports the allocation");
  assert.deepEqual(rB.planeIds, ["south", "west"], "plane ids come back with the result");
  near(rB.kwdc, 24 * 0.460, 1e-12, "kW DC = total panels x panelW");
  assert.ok(rW.pvKwh < rS.pvKwh * 14 / 10, "a west face yields less per panel than a south face");

  // PV is exactly linear in panel count - the optimizer depends on it.
  const p1 = Engine.withDefaults(refParams(0, 0, { planes: [plane(1)] }));
  const scn1 = Engine.buildScenario(ctx, p1);
  const one = Engine.runHours(scn1, Object.assign({}, p1, { panelsByPlane: [1] }), false);
  const seven = Engine.runHours(scn1, Object.assign({}, p1, { panelsByPlane: [7] }), false);
  near(seven.pvKwh, 7 * one.pvKwh, 1e-9, "PV(n) = n x PV(1) exactly");
});

test("shading derates production, annually and by month", () => {
  const clear = Engine.withDefaults(refParams(0, 0, { planes: [plane(20, { shading: { annual: 0 } })] }));
  const shaded = Engine.withDefaults(refParams(0, 0, { planes: [plane(20, { shading: { annual: 0.25 } })] }));
  const rc = Engine.runHours(Engine.buildScenario(ctx, clear), clear, false);
  const rs = Engine.runHours(Engine.buildScenario(ctx, shaded), shaded, false);
  near(rs.pvKwh, rc.pvKwh * 0.75, 1e-9, "a 25% annual shading loss removes exactly 25% of production");

  const monthly = new Array(12).fill(0);
  monthly[0] = 0.5;                                   // January only
  const janOnly = Engine.withDefaults(refParams(0, 0, { planes: [plane(20, { shading: { monthly } })] }));
  const rj = Engine.runHours(Engine.buildScenario(ctx, janOnly), janOnly, true);
  const janClear = Engine.runHours(Engine.buildScenario(ctx, clear), clear, true);
  const janIdx = janClear.monthly.map((m, i) => (+m.key.slice(5, 7) === 1 ? i : -1)).filter((i) => i >= 0);
  assert.ok(janIdx.length > 0, "the record covers at least one January");
  for (const i of janIdx) {
    assert.ok(rj.monthly[i].importKwh > janClear.monthly[i].importKwh,
              "January shading raises January imports");
  }
  const febIdx = janClear.monthly.findIndex((m) => +m.key.slice(5, 7) === 2);
  near(rj.monthly[febIdx].importKwh, janClear.monthly[febIdx].importKwh, 1e-9,
       "and leaves every other month untouched");
  assert.ok(rj.pvKwh < rc.pvKwh && rj.pvKwh > rs.pvKwh, "monthly shading sits between no shading and 25% flat");

  // No shading block at all = no derate: the raw profile, straight through.
  const rawPlane = { id: "p1", profile: Float64Array.from(SOLAR.profiles.tmy), panels: 20 };
  const bare = Engine.withDefaults(refParams(0, 0, { planes: [rawPlane] }));
  const rb = Engine.runHours(Engine.buildScenario(ctx, bare), bare, false);
  let raw = 0;
  for (let i = 0; i < ctx.N; i++) raw += SOLAR.profiles.tmy[ctx.solarIdx[i]] * 20 * 0.460;
  near(rb.pvKwh, raw / ctx.years, 1e-6, "an omitted shading block derates nothing");
  const oriented = Engine.withDefaults(refParams(0, 0, { planes: [plane(20)] }));
  const ro = Engine.runHours(Engine.buildScenario(ctx, oriented), oriented, false);
  assert.ok(ro.pvKwh < rb.pvKwh,
            "...so the adapter's monthly orientation derate for azimuth 169 shows up as a small loss");
  near(ro.pvKwh, rc.pvKwh * 0.993, rc.pvKwh * 0.004, "which is under 1% for a 11-degree azimuth error");
});

test("profileFor resolves weather keys and percentile aliases", () => {
  const tmy = Engine.profileFor(SOLAR, "tmy");
  assert.equal(tmy.length, 8760, "tmy profile is 8760 long");
  assert.equal(Engine.profileFor(SOLAR, "2020"), SOLAR.profiles["2020"], "a year key resolves to itself");
  const p90 = SOLAR.meta.percentiles.p90_year;
  assert.equal(Engine.profileFor(SOLAR, "p90"), SOLAR.profiles[p90], "p90 resolves through meta.percentiles");
  assert.equal(Engine.profileFor(SOLAR, "nonsense"), SOLAR.profiles.tmy, "an unknown key falls back to tmy");
  assert.equal(Engine.profileFor({ profiles: { a: tmy }, percentiles: { p50Year: "a" } }, "p50"), tmy,
               "the core/pv.js percentile spelling works too");
});

// ================================================================== 6. flex loads
test("flexible loads: base load = recorded minus every detected series", () => {
  const p = P({ flex: [evFlex()] });
  const scn = Engine.buildScenario(ctx, p);
  const recorded = sum(ctx.recorded), evTot = sum(RAW_LOAD.ev_kwh);
  near(sum(scn.baseLoad), recorded - evTot, 1e-6, "base = recorded - detected EV");
  near(sum(scn.load), recorded, recorded * 1e-9, "and the rescheduled EV puts every kWh back");
  near(sum(scn.flex), evTot, evTot * 1e-9, "the flex channel carries exactly the EV energy");
});

test("flexible loads: the schedule lands where it says it does", () => {
  const p = P({ flex: [evFlex()] });
  const scn = Engine.buildScenario(ctx, p);
  const s = scn.flexSeries[0].series;
  const sch = evFlex().schedule;
  let win = 0, night = 0, other = 0, over = 0;
  for (let i = 0; i < ctx.N; i++) {
    const h = ctx.hour[i];
    if (h >= sch.window[0] && h < sch.window[1]) win += s[i];
    else if (h >= sch.overnightWindow[0] && h < sch.overnightWindow[1]) night += s[i];
    else other += s[i];
    if (s[i] > sch.maxKW + 1e-6) over++;
  }
  const tot = sum(s);
  near(win / tot, sch.daylightFraction, 0.005, "the daylight share matches daylightFraction");
  near(night / tot, 1 - sch.daylightFraction, 0.005, "the remainder charges inside the overnight window");
  near(other / tot, 0, 1e-6, "nothing lands outside those two windows at default settings");
  assert.equal(over, 0, `no hour exceeds the ${sch.maxKW} kW cap`);
});

test("flexible loads: weekly energy, charging days and weekday priority", () => {
  const p = P({ flex: [evFlex()] });
  const s = Engine.buildScenario(ctx, p).flexSeries[0].series;
  const raw = RAW_LOAD.ev_kwh;
  const shift = (ctx.dayDow[0] + 6) % 7;
  const byWeek = {};
  for (let d = 0; d < ctx.nDays; d++) { const w = ((d + shift) / 7) | 0; (byWeek[w] = byWeek[w] || []).push(d); }
  const dayKwh = (arr, d) => { let t = 0; const s0 = ctx.dayStart[d];
    for (let k = s0; k < s0 + ctx.dayLen[d]; k++) t += arr[k]; return t; };

  let badWeekEnergy = 0, badCount = 0, weekendCharged = 0, fullWeeks = 0, activeWeeks = 0;
  for (const w of Object.keys(byWeek)) {
    const days = byWeek[w];
    const before = days.reduce((t, d) => t + dayKwh(raw, d), 0);
    const after = days.reduce((t, d) => t + dayKwh(s, d), 0);
    if (Math.abs(before - after) > 1e-6) badWeekEnergy++;
    if (before <= 1e-9) { if (after > 1e-9) badCount++; continue; }
    activeWeeks++;
    const charging = days.filter((d) => dayKwh(s, d) > 1e-9);
    if (days.length === 7) {
      fullWeeks++;
      if (charging.length !== 5) badCount++;
      if (charging.some((d) => ctx.dayDow[d] === 0 || ctx.dayDow[d] === 6)) weekendCharged++;
      const per = charging.map((d) => dayKwh(s, d));
      if (Math.max(...per) - Math.min(...per) > 1e-6) badCount++;
    }
  }
  assert.equal(badWeekEnergy, 0, `every one of ${Object.keys(byWeek).length} weeks keeps its own kWh`);
  assert.ok(activeWeeks > 90 && fullWeeks > 90, `${fullWeeks} full Mon-Sun weeks checked`);
  assert.equal(badCount, 0, "each full week charges on exactly 5 days, with equal kWh on each");
  assert.equal(weekendCharged, 0, "5 days/week never charges on a Saturday or Sunday");

  for (const n of [1, 3, 5, 7]) {
    const q = P({ flex: [evFlex({ schedule: { daysPerWeek: n } })] });
    const out = Engine.buildScenario(ctx, q).flexSeries[0].series;
    near(sum(out), sum(raw), sum(raw) * 1e-9, `${n} day(s)/week: annual kWh unchanged`);
  }
  const s7 = Engine.buildScenario(ctx, P({ flex: [evFlex({ schedule: { daysPerWeek: 7 } })] })).flexSeries[0].series;
  const s1 = Engine.buildScenario(ctx, P({ flex: [evFlex({ schedule: { daysPerWeek: 1 } })] })).flexSeries[0].series;
  let all7 = true, onlyMon = true;
  for (const w of Object.keys(byWeek)) {
    const days = byWeek[w];
    if (days.length !== 7 || days.reduce((t, d) => t + dayKwh(raw, d), 0) <= 1e-9) continue;
    if (days.some((d) => dayKwh(s7, d) <= 1e-9)) all7 = false;
    if (days.filter((d) => dayKwh(s1, d) > 1e-9).some((d) => ctx.dayDow[d] !== 1)) onlyMon = false;
  }
  assert.ok(all7, "7 days/week charges on every day of every active week");
  assert.ok(onlyMon, "1 day/week charges only on Mondays");
});

test("flexible loads: caps bind without losing energy, and scale/asRecorded behave", () => {
  const raw = RAW_LOAD.ev_kwh, rawTotal = sum(raw);
  const tight = P({ flex: [evFlex({ schedule: { daysPerWeek: 1, window: [12, 13], maxKW: 8 } })] });
  const outT = Engine.buildScenario(ctx, tight).flexSeries[0].series;
  near(sum(outT), rawTotal, rawTotal * 1e-9, "energy is conserved when the caps bind and charge spills");
  let overT = 0;
  for (let i = 0; i < ctx.N; i++) if (outT[i] > 8 + 1e-6) overT++;
  assert.equal(overT, 0, "spilled charge still respects the cap");

  const asRec = P({ flex: [evFlex({ schedule: { mode: "asRecorded" } })] });
  const sRec = Engine.buildScenario(ctx, asRec).flexSeries[0].series;
  for (let i = 0; i < ctx.N; i++) {
    if (Math.abs(sRec[i] - raw[i]) > 1e-12) assert.fail(`asRecorded changed hour ${i}`);
  }
  assert.ok(true, "schedule.mode 'asRecorded' returns the metered profile untouched");

  const scaled = P({ flex: [evFlex({ scale: 1.2 })] });
  near(sum(Engine.buildScenario(ctx, scaled).flexSeries[0].series), rawTotal * 1.2, rawTotal * 1e-6,
       "scale 1.2 adds 20% more energy");

  // A second EV is just another FlexLoad on the same schedule.
  const two = P({ flex: [evFlex(), evFlex({ id: "ev2", source: "manual", kwhByHour: null,
                                            annualKwh: RAW_LOAD.meta.ev_kwh_per_year })] });
  const scn2 = Engine.buildScenario(ctx, two);
  const a = sum(scn2.flexSeries[0].series), b = sum(scn2.flexSeries[1].series);
  near(b / a, 1, 0.02, "a manual second EV of the same annual kWh roughly doubles EV energy");
  assert.equal(scn2.flexSeries.length, 2, "both flexible loads are reported separately");
});

test("a manual pool pump runs flat inside its window, in both arms", () => {
  const noPool = Engine.buildScenario(ctx, P({ flex: [evFlex()] }));
  const pool = Engine.buildScenario(ctx, P({ flex: [evFlex(), poolFlex()] }));
  near((sum(pool.load) - sum(noPool.load)) / ctx.years, 0.5 * 8 * 365, 4,
       "pool pump adds 0.5 kW x 8 h x 365 = 1,460 kWh/yr");
  let outsideWindow = 0;
  for (let i = 0; i < ctx.N; i++) {
    const h = ctx.hour[i];
    if ((h < 9 || h >= 17) && Math.abs(pool.load[i] - noPool.load[i]) > 1e-9) outsideWindow++;
  }
  assert.equal(outsideWindow, 0, "pool pump runs only inside its 09:00-17:00 window");

  // It is in BOTH arms: the household is adding it either way.
  const rec = Engine.buildScenario(ctx, P({ flex: [evFlex(), poolFlex()] }), { flexMode: "asRecorded" });
  near((sum(rec.load) - sum(ctx.recorded)) / ctx.years, 0.5 * 8 * 365, 4,
       "the as-recorded baseline still carries the manual pool pump");
});

test("baselines: sameFlex vs asRecorded", () => {
  const p = P({ panels: 20, batteries: 1 });
  const res = Engine.simulate(ctx, p, {});
  assert.ok(res.baselineSameFlex && res.baselineAsRecorded, "both baselines are returned");
  assert.equal(res.baselineSameFlex.panels, 0, "the sameFlex baseline has no panels");
  assert.equal(res.baselineAsRecorded.batteries, 0, "the asRecorded baseline has no battery");
  near(res.savingsVsSameFlex, res.baselineSameFlex.bill - res.bill, 1e-12, "savingsVsSameFlex");
  near(res.savingsVsAsRecorded, res.baselineAsRecorded.bill - res.bill, 1e-12, "savingsVsAsRecorded");
  near(res.flexShiftOnlySavings, res.baselineAsRecorded.bill - res.baselineSameFlex.bill, 1e-12,
       "re-timing the flexible loads alone is worth the difference between the two baselines");
  near(res.importSavingsVsSameFlex, res.savingsVsSameFlex - res.exportRevenue, 1e-9,
       "import savings + export revenue = total savings (sameFlex basis)");
  near(res.importSavingsVsAsRecorded, res.savingsVsAsRecorded - res.exportRevenue, 1e-9,
       "...and on the as-recorded basis");
  const zero = Engine.simulate(ctx, P({ panels: 0, batteries: 0 }), {});
  near(zero.exportRevenue, 0, 1e-12, "a system with no panels earns no export revenue");
});

test("export revenue equals the credit lines on the monthly bills", () => {
  const sim = Engine.simulate(ctx, P({ panels: 30, batteries: 1 }), { detail: true });
  assert.ok(sim.exportRevenue > 0, `system earns ${Math.round(sim.exportRevenue)} $/yr from export`);
  const monthly = sim.monthly.reduce((a, m) => a - m.exportCreditUsed - m.accPlus - m.trueUp, 0) / sim.years;
  near(sim.exportRevenue, monthly, 1e-6, "credits used + ACC Plus + true-up payout, month by month");
});

// ================================================================== 7. strategies
test("strategies behave the way the UI claims they do", () => {
  const mk = (over) => {
    const p = P(Object.assign({ panels: 26, batteries: 2 }, over));
    return Engine.runHours(Engine.buildScenario(ctx, p), p, false);
  };
  const backup = mk({ strategy: "backup_only" });
  const self = mk({ strategy: "self_consumption" });
  const tou = mk({ strategy: "tou_arbitrage" });

  // Give export arbitrage a real evening spike to bite on, so the test measures the
  // dispatch rule and not the rate file.
  const spiky = JSON.parse(JSON.stringify(TARIFF));
  for (const dt of ["weekday", "weekend"]) {
    spiky.nbt.export_rates[dt] = spiky.nbt.export_rates[dt].map((row) =>
      row.map((v, h) => (h >= 17 && h <= 21 ? 0.06 + 1.5 * Math.exp(-((h - 19) ** 2) / 2) : v)));
  }
  const spikyCtx = Engine.prepare({ load: LOAD, tariffs: spiky });
  const mkSpiky = (over) => {
    const p = P(Object.assign({ panels: 26, batteries: 2 }, over));
    return Engine.runHours(Engine.buildScenario(spikyCtx, p), p, false);
  };
  const touS = mkSpiky({ strategy: "tou_arbitrage" });
  const exp = mkSpiky({ strategy: "export_arbitrage", exportThreshold: 0.3 });

  assert.ok(backup.dischargeKwh === 0 && backup.chargeKwh === 0, "backup_only never cycles the pack");
  assert.ok(self.dischargeKwh > 0, "self_consumption cycles the pack");
  assert.ok(tou.bill < self.bill + 1e-6, "tou_arbitrage bills no more than self_consumption");
  assert.ok(exp.exportKwh > touS.exportKwh, "export_arbitrage sells into evening price spikes");
  assert.ok(backup.bill > self.bill, "a battery that never cycles saves less than one that does");
  const gc = mk({ strategy: "tou_arbitrage", gridCharge: true });
  assert.ok(gc.importKwh >= tou.importKwh - 1e-6, "grid-charging raises imports (it is buying energy)");
});

// ================================================================== 8. bill replay
test("the CA Climate Credit lands in both arms and cancels out of savings", () => {
  const withCC = Engine.simulate(ctx, P({ panels: 20, batteries: 1 }), { detail: true });
  const ccMonths = withCC.monthly.filter((m) => m.climateCredit !== 0);
  assert.ok(ccMonths.length > 0 && ccMonths.every((m) => Math.abs(m.climateCredit + 36) < 1e-9),
            `CA Climate Credit of $36 applied in ${ccMonths.length} monthly bills`);
  assert.ok(ccMonths.every((m) => [8, 9].includes(+m.key.slice(5, 7))),
            "climate credit lands only in August and September");
  const noCC = Engine.simulate(ctx, P({ panels: 20, batteries: 1, climateCreditOff: true }), {});
  near(withCC.savingsVsSameFlex, noCC.savingsVsSameFlex, 1e-6, "it cancels out of savings");
  assert.ok(withCC.bill < noCC.bill, "...but it does lower the modelled bill");
});

test("the reference SCE bill replays to $749.41 against the paper $749.37", () => {
  const R = REFERENCE.billReplay;
  const v = Engine.billPeriod(ctx, { planId: "TOU-D-PRIME", providerId: "cpa_green" }, R.start, R.end);
  assert.equal(v.days, R.days, "billing period is 29 days");
  near(v.byPeriod.on.kwh, R.kwh.on, 1.5, "on-peak kWh matches the paper bill");
  near(v.byPeriod.mid.kwh, R.kwh.mid, 1.5, "mid-peak kWh matches the paper bill");
  near(v.byPeriod.off.kwh, R.kwh.off, 1.5, "off-peak kWh matches the paper bill");
  near(v.totalKwh, R.kwh.total, 1.5, "total kWh matches the paper bill");
  near(v.climateCredit, -36, 1e-9, "the -$36 climate credit is on the replayed bill");
  near(v.total, R.model, 0.01, "the model still totals $749.41");
  assert.ok(Math.abs(v.total - R.actual) / R.actual < 0.06,
            `modelled charges $${v.total.toFixed(2)} within 6% of the actual $${R.actual}`);
  // The replay uses the RECORDED load: flexible-load rescheduling must not touch it.
  const v2 = Engine.billPeriod(ctx, refParams(40, 3), R.start, R.end);
  near(v2.totalKwh, v.totalKwh, 1e-9, "panels, batteries and flex schedules never move the replay");
});

// ================================================================== 9. fallback parity
test("the engine's fallback reshape reproduces the prototype's spreadEV exactly", async () => {
  const p = P({ panels: 27, batteries: 1 });
  const withFlexload = Engine.simulate(ctx, p, {});
  const src = Engine.flexReshapeSource();
  try {
    Engine.setFlexReshape(null);
    assert.equal(Engine.flexReshapeSource(), "engine-fallback", "the fallback can be forced");
    const fallback = Engine.simulate(ctx, p, {});
    // The prototype's numbers, to the cent.
    near(fallback.bill, 686.21198, 0.005, "prototype bill for 27 panels + 1 battery");
    near(fallback.baselineSameFlex.bill, 5469.59251, 0.01, "prototype same-flex baseline bill");
    // core/flexload.js spreads a manual load over 52.18 weeks instead of 365/7 days,
    // which moves the pool pump by ~1 kWh/yr and nothing else.
    near(withFlexload.bill, fallback.bill, 2.0, "flexload.js agrees with the fallback to ~$2/yr");
    near(withFlexload.pvKwh, fallback.pvKwh, 1e-9, "and produces identical PV");
  } finally {
    if (src === "flexload") {
      const m = await import("../core/flexload.js");
      Engine.setFlexReshape(m.reshape);
    }
  }
});

test("prepare() survives unfilled gaps and reports them", () => {
  const holed = loadSet();
  holed.kwh = Float64Array.from(holed.kwh);
  holed.kwh[100] = NaN; holed.kwh[101] = NaN;
  const c = Engine.prepare({ load: holed, tariffs: TARIFF });
  assert.equal(c.quality.unfilledHours, 2, "unfilled hours are counted");
  assert.equal(c.recorded[100], 0, "and priced as zero rather than poisoning the bill");
  assert.ok(isFinite(Engine.simulate(c, P({ panels: 10, batteries: 0 }), {}).bill), "the bill stays finite");
});
