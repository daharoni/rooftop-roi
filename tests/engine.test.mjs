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
import { readFileSync } from "node:fs";
import { loadSet, evFlex, poolFlex, plane, refParams,
         RAW_LOAD, SOLAR, TARIFF, REFERENCE } from "./fixtures/agoura.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);
const sum = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };

const LOAD = loadSet();
const ctx = Engine.prepare({ load: LOAD, tariffs: TARIFF });
// The prototype-parity numbers below were calibrated on SCE's 2026-06-01 rates; they run
// on a frozen copy of that file so a later (correct) rate update cannot move them.
const TARIFF_2026_06 = JSON.parse(readFileSync(new URL("./fixtures/sce-2026-06-01.json", import.meta.url), "utf8"));
const ctxFrozen = Engine.prepare({ load: LOAD, tariffs: TARIFF_2026_06 });
// The reference bill replayed at the prices printed on it (calibration override,
// meta.bill_validation.bill_rates): shift every column of the TOU-D-PRIME summer cells
// except sce_generation by (printed delivery - shipped delivery) and use the printed
// Base Services Charge.  That restores the as-billed cells exactly, including the
// generation share the municipal surcharge is levied on.
const BR = TARIFF.meta.bill_validation.bill_rates;
const TARIFF_AS_BILLED = (() => {
  const t = JSON.parse(JSON.stringify(TARIFF));
  const p = t.plans.find((x) => x.id === TARIFF.meta.bill_validation.plan);
  p.fixed_charge_per_day = BR.fixed_charge_per_day;
  for (const pid of ["on", "mid", "off", "super_off"]) {
    const src = pid === "super_off" ? "off" : pid;
    const cell = p.rates.summer[pid];
    const shift = BR.delivery.summer[src] - cell.delivery;
    for (const k of Object.keys(cell)) if (k !== "sce_generation") cell[k] = +(cell[k] + shift).toFixed(6);
  }
  return t;
})();
const ctxBilled = Engine.prepare({ load: LOAD, tariffs: TARIFF_AS_BILLED });
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
           cca_export_adder_per_kwh: 0, net_surplus_compensation_per_kwh: 0.05,
           nonbypassable_charges_per_kwh: 0.02, true_up_month: 7,
           acc_plus_adder_per_kwh: 0, eec_adjustment_per_kwh: 0.05981 },
    incentives: { federal_itc_residential_pct: 0, sgip_residential_per_kwh: 0 },
  };
  return {
    ctx: Engine.prepare({ load: { meta: {}, ts, kwh: Float64Array.from(kwh), exportKwh: null }, tariffs },
                        { minUsableDays: 0 }),
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
  // The Agoura Hills generation municipal surcharge is city-specific: priced only when asked.
  const munF = TARIFF.meta.bill_validation.generation_municipal_surcharge_factor;
  assert.ok(munF > 0, "sce.json carries the reference city's factor for the bill replay");
  const MUN = { municipalSurchargeFactor: munF };
  const r = Engine.buildRates(ctx, "TOU-D-PRIME", "sce", false, null, undefined, true, MUN);
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

  const onRate = plan.rates.summer.on;
  near(r.imp[idSummerWeekdayPeak], onRate.sce + (onRate.sce - onRate.delivery) * munF, 1e-9,
       "on-peak import price = plan rate + generation municipal surcharge");

  const plain = Engine.buildRates(ctx, "TOU-D-PRIME", "sce", false);
  near(plain.imp[idSummerWeekdayPeak], onRate.sce, 1e-12, "no municipal surcharge unless the caller passes one");
  assert.equal(plain.munFactor, 0, "...and the run reports a factor of 0");

  const rc = Engine.buildRates(ctx, "TOU-D-PRIME", "cpa_green", false, null, undefined, true, MUN);
  const stack = onRate.cpa_clean - onRate.delivery - onRate.sce_generation + 0.02433;
  near(rc.imp[idSummerWeekdayPeak],
       onRate.cpa_green + (onRate.cpa_green - onRate.delivery - stack) * munF
         + TARIFF.meta.bill_validation.cpa_energy_surcharge_per_kwh, 1e-9,
       "CPA import price carries the CPA energy surcharge and a generation-only municipal surcharge");
  near(stack, 0.03535, 1e-9, "the CCA surcharge stack backs out to the documented $0.03535/kWh");

  assert.notEqual(rc.imp[idSummerWeekdayPeak], r.imp[idSummerWeekdayPeak],
                  "CPA Green prices differ from SCE bundled");
  near(rc.exp[idSummerWeekdayPeak] - r.exp[idSummerWeekdayPeak],
       TARIFF.nbt.cca_export_adder_per_kwh, 1e-9, "CCA export adder applied to export price");
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

  // Now make exports big enough to hit the credit floor and roll credits.  Export credit
  // may offset energy only down to the fixed charge ($1.00) PLUS the non-bypassable
  // charges on the month's imports (40 kWh x $0.02 = $0.80): Schedule NBT lets credits
  // offset generation and delivery, never NBCs or the fixed charge.
  const m2 = miniData({ exportRate: 1.50 });
  const p2 = miniParams(m2);
  const out2 = Engine.runHours(Engine.buildScenario(m2.ctx, p2), p2, true);
  const total2 = out2.bill * (m2.ctx.nDays / 365);
  near(out2.monthly[0].nonBypassable, 0.80, 1e-9, "NBCs on 40 imported kWh at $0.02");
  near(out2.monthly[0].exportCreditUsed, -(13.00 - 1.80), 1e-6, "credits offset only down to fixed + NBCs");
  // 16 kWh earned $24; $11.20 used leaves $12.80.  But 16 kWh exported against 40 kWh
  // imported is no Net Surplus Electricity: no ARECR debit, no NSC, and the $12.80
  // carries into the next relevant period.
  near(out2.monthly[0].trueUp, 0, 1e-12, "a net importer (16 out, 40 in) gets no NSC");
  near(out2.monthly[0].forfeitedCredit, 0, 1e-12, "...and no ARECR debit");
  // (The 2-day record is a one-month cycle, so the balance also holds the carry from the
  // previous pass round it; the point is that nothing was taken from the $12.80.)
  assert.ok(out2.monthly[0].creditBalance >= 12.80 - 1e-9, "the unused $12.80 carries forward whole");
  near(total2, 1.80, 1e-6, "bill floors at fixed + NBCs ($1.80)");

  // Net surplus is kWh exported minus kWh imported over the relevant period, whatever
  // happened to the dollars (Schedule NBT SC 5.d, PG&E; SC 4.e.i, SCE).  Load 0.2 kWh/h:
  // export 2 x 4 x 2.8 = 22.4 kWh, import 2 x 20 x 0.2 = 8 kWh, surplus 14.4 kWh.
  // Subtotal $1.00 + 8 x $0.30 = $3.40, floor $1.00 + 8 x $0.02 = $1.16, room $2.24.
  const ms = miniData({ exportRate: 1.50, load: 0.2 });
  const ps = miniParams(ms);
  const outS = Engine.runHours(Engine.buildScenario(ms.ctx, ps), ps, true);
  const mS = outS.monthly[0];
  near(mS.exportKwh - mS.importKwh, 14.4, 1e-9, "14.4 kWh of net surplus");
  near(mS.exportCreditUsed, -2.24, 1e-9, "credit fills the room down to fixed + NBCs");
  near(mS.trueUp, -14.4 * 0.05, 1e-9, "NSC on the 14.4 net surplus kWh");
  near(mS.forfeitedCredit, 14.4 * (0.05981 - 0.05), 1e-9,
       "the bank is debited ARECR x 14.4 kWh; net of the NSC that is the credit lost");
  near(mS.bill, 3.40 - 2.24 - 0.72, 1e-9, "the bill is the floor less the NSC payout");
  // A bank already spent still gets NSC on its surplus kWh; the ARECR debit stops at zero.
  const me = miniData({ exportRate: 0.01, load: 0.2 });
  const pe = miniParams(me);
  const mE = Engine.runHours(Engine.buildScenario(me.ctx, pe), pe, true).monthly[0];
  near(mE.exportCreditUsed, -0.224, 1e-9, "all $0.224 of credit is used on the month");
  near(mE.trueUp, -14.4 * 0.05, 1e-9, "NSC is paid on the kWh even with an empty bank");
  near(mE.creditBalance, 0, 1e-12, "the debit never takes the bank below zero");
  near(mE.bill, 3.40 - 0.224 - 0.72, 1e-9, "and never becomes a charge");
  // The ARECR debits export credit only, never the ACC Plus adder (PG&E NBT SC 5.d).
  // $0.10 exports: $2.24 of export credit fills the $2.24 room exactly, so the adder
  // (22.4 x $0.016 = $0.3584) is banked whole; the $0.86 debit finds no export credit.
  const ma = miniData({ exportRate: 0.10, load: 0.2 });
  const pa = miniParams(ma, { accPlusAdder: 0.016 });
  const mA = Engine.runHours(Engine.buildScenario(ma.ctx, pa), pa, true).monthly[0];
  near(mA.exportCreditUsed, -2.24, 1e-9, "export credit fills the room");
  near(mA.accPlus, 0, 1e-12, "no room is left for the adder");
  near(mA.trueUp, -0.72, 1e-9, "NSC on the 14.4 surplus kWh");
  assert.ok(mA.creditBalance >= 22.4 * 0.016 - 1e-9, "the banked adder survives the true-up untouched");

  // ACC Plus: earned on every exported kWh and applied like export credit.
  const m3 = miniData();
  const p3 = miniParams(m3, { accPlusAdder: 0.016 });
  const out3 = Engine.runHours(Engine.buildScenario(m3.ctx, p3), p3, true);
  near(out3.monthly[0].accPlusEarned, -16 * 0.016, 1e-9, "ACC Plus earns $0.016 on each of 16 exported kWh");
  near(out3.monthly[0].accPlus, -16 * 0.016, 1e-9, "...and all of it fits on this bill");
  near(out3.bill * (m3.ctx.nDays / 365), 11.40 - 0.256, 1e-6, "ACC Plus comes off the bill above the floor");
  near(out3.accPlusRevenue, 0.256 / (m3.ctx.nDays / 365), 1e-9, "accPlusRevenue annualises the adder applied");

  // ...but it is a bill credit, not cash: it never takes the month below fixed + NBCs.
  const m4 = miniData({ exportRate: 1.50 });
  const p4 = miniParams(m4, { accPlusAdder: 0.016 });
  const out4 = Engine.runHours(Engine.buildScenario(m4.ctx, p4), p4, true);
  near(out4.monthly[0].accPlusEarned, -0.256, 1e-9, "the adder is still earned");
  near(out4.monthly[0].accPlus, 0, 1e-12, "...but no room is left above the floor for it");
  near(out4.bill, out2.bill, 1e-9, "so the bill is the no-adder bill: ACC Plus is never paid out as cash");
  near(out4.accPlusRevenue, 0, 1e-12, "and the adder realises nothing");
  assert.ok(out4.monthly[0].bill - out4.monthly[0].trueUp >= 1.80 - 1e-9, "the month stays at or above fixed + NBCs");
  assert.ok(out4.accPlusRevenue <= out4.exportRevenue, "accPlusRevenue is a subset of exportRevenue");

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
  const last = withCC.monthly[withCC.monthly.length - 1];
  assert.equal(last.key, "2026-09", "the record ends in September 2026...");
  assert.equal(last.days, 9, "...nine days into it");
  near(last.climateCredit, -36 * 9 / 30, 1e-9, "a partial edge month gets the credit prorated by days present");
  const whole = ccMonths.filter((m) => m !== last);
  assert.ok(whole.length > 0 && whole.every((m) => Math.abs(m.climateCredit + 36) < 1e-9),
            `CA Climate Credit of $36 applied in ${whole.length} whole monthly bills`);
  assert.ok(ccMonths.every((m) => [8, 9].includes(+m.key.slice(5, 7))),
            "climate credit lands only in August and September");
  const noCC = Engine.simulate(ctx, P({ panels: 20, batteries: 1, climateCreditOff: true }), {});
  near(withCC.savingsVsSameFlex, noCC.savingsVsSameFlex, 1e-6, "it cancels out of savings");
  assert.ok(withCC.bill < noCC.bill, "...but it does lower the modelled bill");
});

test("the reference SCE bill replays to $749.41 against the paper $749.37", () => {
  const R = REFERENCE.billReplay;
  // The plan now carries SCE's 2026-10-01 rates; replay at the bill's own printed prices
  // and fixed charge (meta.bill_validation.bill_rates), not by re-blessing the plan.
  const asBilled = TARIFF_AS_BILLED.plans.find((x) => x.id === "TOU-D-PRIME").rates.summer;
  for (const pid of ["on", "mid", "off"]) {
    near(asBilled[pid].cpa_green, BR.rates.summer[pid], 1e-9, "override restores the printed " + pid + " rate");
  }
  // Agoura Hills' municipal surcharge is on this bill; the engine prices it only when asked.
  const mun = TARIFF.meta.bill_validation.generation_municipal_surcharge_factor;
  const v = Engine.billPeriod(ctxBilled, { planId: "TOU-D-PRIME", providerId: "cpa_green",
                                           municipalSurchargeFactor: mun }, R.start, R.end);
  assert.equal(v.days, R.days, "billing period is 29 days");
  near(v.byPeriod.on.kwh, R.kwh.on, 1.5, "on-peak kWh matches the paper bill");
  near(v.byPeriod.mid.kwh, R.kwh.mid, 1.5, "mid-peak kWh matches the paper bill");
  near(v.byPeriod.off.kwh, R.kwh.off, 1.5, "off-peak kWh matches the paper bill");
  near(v.totalKwh, R.kwh.total, 1.5, "total kWh matches the paper bill");
  near(v.climateCredit, -36, 1e-9, "the -$36 climate credit is on the replayed bill");
  near(v.total, R.model, 0.01, "the model still totals $749.41");
  const noMun = Engine.billPeriod(ctxBilled, { planId: "TOU-D-PRIME", providerId: "cpa_green" }, R.start, R.end);
  assert.ok(noMun.total < v.total - 1, "without the city's factor the replay omits that surcharge");
  assert.ok(Math.abs(v.total - R.actual) / R.actual < 0.06,
            `modelled charges $${v.total.toFixed(2)} within 6% of the actual $${R.actual}`);
  // The replay uses the RECORDED load: flexible-load rescheduling must not touch it.
  const v2 = Engine.billPeriod(ctxBilled, refParams(40, 3), R.start, R.end);
  near(v2.totalKwh, v.totalKwh, 1e-9, "panels, batteries and flex schedules never move the replay");
});

// ================================================================== 9. fallback parity
test("the engine's fallback reshape reproduces the prototype's spreadEV exactly", async () => {
  const p = P({ panels: 27, batteries: 1 });
  const withFlexload = Engine.simulate(ctxFrozen, p, {});
  const src = Engine.flexReshapeSource();
  try {
    Engine.setFlexReshape(null);
    assert.equal(Engine.flexReshapeSource(), "engine-fallback", "the fallback can be forced");
    const fallback = Engine.simulate(ctxFrozen, p, {});
    // The prototype's numbers, to the cent.
    // Two deliberate departures from the prototype, both pinned here:
    //  - the climate credit in the record's 9-day final September is prorated (9/30 of
    //    $36), which raises BOTH bills by $25.20 over the record;
    //  - net surplus is kWh exported minus kWh imported over each relevant period, not
    //    the kWh "left behind" unused bank dollars, so this net-exporting system
    //    (about 8,000 kWh out, 2,800 in) is paid NSC on its surplus kWh.
    const ccDelta = 36 * (1 - 9 / 30) / ctxFrozen.years;
    near(fallback.baselineSameFlex.bill, 5469.59251 + ccDelta, 0.01, "prototype same-flex baseline bill + prorated climate credit");
    near(fallback.bill, 593.25709, 0.005, "27 panels + 1 battery (prototype $686.21 before the two changes)");
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
  assert.equal(c.recorded[100], 0, "the recorded series holds 0 there so nothing downstream sees a NaN");
  assert.equal(c.valid[100], 0, "...but the hour is masked out of the simulation, not priced as zero usage");
  assert.ok(isFinite(Engine.simulate(c, P({ panels: 10, batteries: 0 }), {}).bill), "the bill stays finite");
});

// ================================================================== 10. other utilities
// No engine test touched pge.json or sdge.json before, which is how an SCE-only ACC Plus
// adder, ARECR and baseline allowance went unnoticed (review 2026-10-02, P0 #2 and #9).
import fs from "node:fs";
import Tariff from "../core/tariff.js";

const readTariff = (id) => JSON.parse(fs.readFileSync(new URL(`../data/tariffs/${id}.json`, import.meta.url), "utf8"));

/** Every number reachable from `v` (objects, arrays, typed arrays) must be finite. */
function assertAllFinite(v, path = "result", seen = new Set()) {
  if (typeof v === "number") { assert.ok(Number.isFinite(v), `${path} is ${v}`); return; }
  if (!v || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  if (ArrayBuffer.isView(v)) {
    for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) assert.fail(`${path}[${i}] is ${v[i]}`);
    return;
  }
  for (const k of Object.keys(v)) assertAllFinite(v[k], `${path}.${k}`, seen);
}

for (const id of ["pge", "sdge"]) {
  test(`${id}.json runs end to end on the reference household with its own tariff terms`, () => {
    const t = readTariff(id);
    const c = Engine.prepare({ load: loadSet(), tariffs: t });
    const plan = Tariff.defaultPlan(t), prov = Tariff.defaultProvider(t);
    for (const [panels, batteries] of [[0, 0], [20, 1], [40, 2]]) {
      const p = Engine.withDefaults(refParams(panels, batteries, { planId: plan.id, providerId: prov }));
      const res = Engine.simulate(c, p, { detail: true });
      assertAllFinite(res, `${id} ${panels}p/${batteries}b`);
      const terms = res.tariffTerms;
      assert.equal(terms.providerId, prov, "the requested provider prices the run");
      assert.equal(terms.providerFallback, false, "no provider fallback for a known provider");
      assert.equal(terms.accPlusAdder, t.nbt.acc_plus_adder_per_kwh, "ACC Plus adder comes from the file");
      assert.equal(terms.accPlusAdder, Tariff.accPlusAdder(t), "...and agrees with core/tariff.js");
      assert.equal(terms.arecr, t.nbt.eec_adjustment_per_kwh, "ARECR comes from the file");
      assert.equal(terms.arecr, Tariff.arecr(t), "...and agrees with core/tariff.js");
      assert.equal(terms.trueUpMonth, t.nbt.true_up_month, "true-up month comes from the file");
      assert.equal(terms.baselineRegion, Tariff.defaultBaselineRegion(t), "default baseline region");
      const accLines = res.monthly.reduce((a, m) => a - m.accPlusEarned, 0);
      const accWant = res.monthly.reduce((a, m) => a + m.exportKwh, 0) * t.nbt.acc_plus_adder_per_kwh;
      near(accLines, accWant, 1e-6, "every month earns the file's adder x creditable export");
      const accUsed = res.monthly.reduce((a, m) => a - m.accPlus, 0);
      assert.ok(accUsed <= accLines + 1e-9, "no more adder reaches the bills than was earned");
      near(res.accPlusRevenue, accUsed / res.years, 1e-9, "accPlusRevenue = the adder that reached a bill, per year");
      assert.ok(res.accPlusRevenue <= res.exportRevenue + 1e-9, "accPlusRevenue is a subset of exportRevenue");
    }
    // An explicit override still wins over the file.
    const over = Engine.simulate(c, Engine.withDefaults(refParams(30, 1,
      { planId: plan.id, providerId: prov, accPlusAdder: 0.05 })), {});
    assert.equal(over.tariffTerms.accPlusAdder, 0.05, "accPlusAdder param overrides the file");
  });
}

test("SDG&E TOU-DR1 baseline credit runs to 130% of the region's allocation", () => {
  const t = readTariff("sdge");
  const c = Engine.prepare({ load: loadSet(), tariffs: t });
  const br = t.utility.baselineRegions;
  // Monthly rows come from runHours with detail (simulate's baseline arms carry none).
  const rows = (over) => {
    const p = Engine.withDefaults(refParams(0, 0, { planId: "TOU-DR1", providerId: "sdge", ...over }));
    return Engine.runHours(Engine.buildScenario(c, p), p, true);
  };
  for (const region of ["coastal", "desert"]) {
    const out = rows({ baselineRegion: region });
    assert.equal(out.tariffTerms.baselineRegion, region, "the requested region is used");
    assert.equal(out.tariffTerms.baselineCreditPct, 1.3, "TOU-DR1 credits 130% of baseline");
    const a = br.allocations[region];
    let beyond100 = 0;
    for (const m of out.monthly) {
      const daily = br.summer_months.includes(+m.key.slice(5, 7)) ? a.summer : a.winter;
      const want = 0.10702 * Math.min(m.importKwh, daily * m.days * 1.3);
      near(-m.baselineCredit, want, 1e-6, `${region} ${m.key} baseline credit`);
      if (m.importKwh > daily * m.days * 1.0 + 1) beyond100++;
    }
    assert.ok(beyond100 > 0, `${region}: some months import more than 100% of baseline, so 130% bites`);
  }
  const coastal = rows({ baselineRegion: "coastal" }), desert = rows({ baselineRegion: "desert" });
  assert.ok(desert.bill < coastal.bill, "a larger desert allocation means a larger credit and a lower bill");
  assert.equal(rows({ planId: "TOU-ELEC" }).tariffTerms.baselineCreditPerKwh, 0, "TOU-ELEC has no credit");
  const bogus = rows({ baselineRegion: "nowhere" });
  assert.equal(bogus.tariffTerms.baselineRegion, Tariff.defaultBaselineRegion(t), "unknown region -> default");
  assert.equal(bogus.tariffTerms.baselineRegionFallback, true, "...and the fallback is flagged");
  const sim = Engine.simulate(c, Engine.withDefaults(refParams(0, 0, { planId: "TOU-DR1", providerId: "sdge" })), {});
  assert.ok(sim.baselineAsRecorded.bill > 0, "the no-system arm prices too");
});

test("PG&E E-TOU-C baseline follows the chosen territory", () => {
  const t = readTariff("pge");
  const c = Engine.prepare({ load: loadSet(), tariffs: t });
  const bill = (region) => {
    const p = Engine.withDefaults(refParams(0, 0, { planId: "E-TOU-C", providerId: "pge", baselineRegion: region }));
    return Engine.runHours(Engine.buildScenario(c, p), p, false);
  };
  const x = bill("X"), w = bill("W");
  assert.equal(x.tariffTerms.baselineCreditPct, 1, "PG&E credits 100% of baseline");
  assert.deepEqual(w.tariffTerms.baselineKwhPerDay,
                   { summer: t.utility.baselineRegions.allocations.W.summer,
                     winter: t.utility.baselineRegions.allocations.W.winter }, "territory W allocation");
  assert.notEqual(x.bill, w.bill, "the territory moves the bill");
});

// ================================================================== 11. gaps
test("gap hours are excluded from annualisation, not priced as zero usage", () => {
  const full = Engine.prepare({ load: loadSet(), tariffs: TARIFF });
  const holed = loadSet();
  holed.kwh = Float64Array.from(holed.kwh);
  // Blank 60 whole days spread through the record (every 12th day).
  let blanked = 0;
  for (let d = 5; d < full.nDays && blanked < 60; d += 12, blanked++) {
    const s0 = full.dayStart[d];
    for (let k = s0; k < s0 + full.dayLen[d]; k++) holed.kwh[k] = NaN;
  }
  assert.equal(blanked, 60, "60 days blanked");
  const c = Engine.prepare({ load: holed, tariffs: TARIFF });
  near(c.quality.usableDays, full.nDays - 60, 1e-9, "quality.usableDays excludes the blank days");
  near(c.years, (full.nDays - 60) / 365, 1e-12, "years counts usable days only");
  near(c.quality.annualKwh, full.quality.annualKwh, full.quality.annualKwh * 0.01,
       "annual kWh within 1% of the ungapped record");
  const p = Engine.withDefaults(refParams(20, 1, { flex: [] }));
  const a = Engine.simulate(full, p, {}), b = Engine.simulate(c, p, {});
  assertAllFinite(b, "gapped result");
  near(b.loadKwh, a.loadKwh, a.loadKwh * 0.01, "simulated annual load within 1%");
  near(b.pvKwh, a.pvKwh, a.pvKwh * 0.02, "PV is counted over the same usable hours");
  near(b.baselineSameFlex.bill, a.baselineSameFlex.bill, a.baselineSameFlex.bill * 0.03,
       "the no-system bill is not understated by the gap");
});

test("fewer than 300 usable days is refused with a message for the UI", () => {
  const short = loadSet();
  const n = 24 * 200;
  short.ts = short.ts.slice(0, n); short.kwh = short.kwh.slice(0, n);
  assert.throws(() => Engine.prepare({ load: short, tariffs: TARIFF }),
                (e) => e.code === "INSUFFICIENT_DATA" && /usable days/.test(e.message) && e.usableDays < 300);
  // Mostly-NaN data (a daily-interval file read as hourly) is refused the same way.
  const sparse = loadSet();
  sparse.kwh = Float64Array.from(sparse.kwh, (v, i) => (i % 24 === 0 ? v : NaN));
  assert.throws(() => Engine.prepare({ load: sparse, tariffs: TARIFF }), /usable days/);
});

test("a NaN inside a flexible load's kwhByHour is treated as 0 and counted", () => {
  const ev = evFlex();
  ev.kwhByHour = Float64Array.from(ev.kwhByHour);
  ev.kwhByHour[500] = NaN; ev.kwhByHour[501] = Infinity;
  ev.kwhByHour[502] = -Infinity;
  const res = Engine.simulate(ctx, P({ flex: [ev, poolFlex()] }), {});
  assertAllFinite(res, "result with a NaN flex hour");
  assert.ok(res.flexNanHours >= 3, `bad flex hours are counted (${res.flexNanHours})`);
  // Exactly as if those hours had read 0 kWh, in both arms.
  const zeroed = evFlex();
  zeroed.kwhByHour = Float64Array.from(ev.kwhByHour, (v) => (Number.isFinite(v) ? v : 0));
  const ref = Engine.simulate(ctx, P({ flex: [zeroed, poolFlex()] }), {});
  near(res.bill, ref.bill, 1e-9, "bill = the same load with 0 in the bad hours");
  near(res.baselineAsRecorded.bill, ref.baselineAsRecorded.bill, 1e-9, "...and the as-recorded arm too");
  assert.equal(ref.flexNanHours, 0, "a clean load reports none");
  // The optimizer's per-cell runs (runHours) carry the count too, so the app can warn.
  const q = P({ flex: [ev] });
  assert.ok(Engine.runHours(Engine.buildScenario(ctx, q), q, false).flexNanHours >= 3, "runHours reports it");
});

// ================================================================== 12. provider fallback
test("an unknown provider falls back to the utility's own default, never to SCE generation", () => {
  const known = Engine.runHours(Engine.buildScenario(ctx, P({ providerId: "sce" })), P({ providerId: "sce" }), false);
  const stale = P({ providerId: "mce" });                 // a PG&E CCA id on an SCE tariff
  const out = Engine.runHours(Engine.buildScenario(ctx, stale), stale, false);
  assert.equal(out.tariffTerms.providerId, "sce", "falls back to SCE bundled");
  assert.equal(out.tariffTerms.providerFallback, true, "...and says so");
  near(out.bill, known.bill, 1e-9, "priced exactly as SCE bundled");

  const pge = readTariff("pge");
  const cp = Engine.prepare({ load: loadSet(), tariffs: pge });
  const q = Engine.withDefaults(refParams(0, 0, { planId: "E-TOU-C", providerId: "cpa_green" }));
  const r = Engine.runHours(Engine.buildScenario(cp, q), q, false);
  const qp = Engine.withDefaults(refParams(0, 0, { planId: "E-TOU-C", providerId: "pge" }));
  const rp = Engine.runHours(Engine.buildScenario(cp, qp), qp, false);
  assert.equal(r.tariffTerms.providerId, "pge", "PG&E falls back to PG&E bundled");
  near(r.bill, rp.bill, 1e-9, "with generation charges intact (not delivery + sce_generation)");

  const orphan = JSON.parse(JSON.stringify(TARIFF));
  orphan.providers = {}; delete orphan.utility;
  const co = Engine.prepare({ load: loadSet(), tariffs: orphan });
  assert.throws(() => Engine.buildScenario(co, P({ providerId: "nobody" })), /provider/);
});

// ================================================================== 13. true-up month
// The billing year is the 12 months ending in the true-up month; the record runs as a
// cycle, so the months after its last true-up wrap round into its first period and the
// bank they hold is carried, never forfeited (settle() / docs/engine.md §6).
const sliceLoad = (from, to) => {
  const L = loadSet();
  const a = L.ts.findIndex((x) => x.startsWith(from));
  let b = to ? L.ts.findIndex((x) => x.startsWith(to)) : L.ts.length;
  if (b < 0) b = L.ts.length;
  return { ...L, ts: L.ts.slice(a, b), kwh: L.kwh.slice(a, b) };
};
const ctx24 = Engine.prepare({ load: sliceLoad("2024-09", "2026-09"), tariffs: TARIFF });
const runTU = (c, over) => {
  const q = P(over);
  return Engine.runHours(Engine.buildScenario(c, q), q, true);
};
const settledKeys = (o) => o.monthly.filter((m) => m.settled).map((m) => m.key);

test("true-up: a 24-month record settles two whole 12-month years for any true-up month", () => {
  assert.equal(ctx24.nMonths, 24);
  assert.equal(ctx24.monthKey[0], "2024-09");
  const want = {
    4:  { settled: ["2025-04", "2026-04"], firstStart: "2026-05",
          trailing: ["2026-05", "2026-06", "2026-07", "2026-08"] },
    9:  { settled: ["2024-09", "2025-09"], firstStart: "2025-10",
          trailing: ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
                     "2026-05", "2026-06", "2026-07", "2026-08"] },
    10: { settled: ["2024-10", "2025-10"], firstStart: "2025-11",
          trailing: ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
                     "2026-05", "2026-06", "2026-07", "2026-08"] },
  };
  for (const tum of [4, 9, 10]) {
    const o = runTU(ctx24, { panels: 60, batteries: 0, trueUpMonth: tum });
    const w = want[tum];
    assert.equal(o.tariffTerms.trueUpMonth, tum, "the override is used");
    assert.deepEqual(settledKeys(o), w.settled, `tum ${tum}: settled months`);
    assert.deepEqual(o.trueUp.settledMonths, w.settled, `tum ${tum}: result.trueUp agrees with the rows`);
    assert.deepEqual(o.trueUp.periods.map((x) => x.months), [12, 12], `tum ${tum}: two 12-month periods, no stub`);
    assert.equal(o.trueUp.periods[0].start, w.firstStart, `tum ${tum}: the first period wraps from the record's end`);
    assert.equal(o.trueUp.periods[0].end, w.settled[0]);
    const tr = o.trueUp.trailing;
    assert.deepEqual(tr.unsettledMonths, w.trailing, `tum ${tum}: months after the last true-up`);
    assert.equal(tr.carriedTo, "2024-09", "the trailing bank is carried into the record's first month");
    assert.equal(tr.settledAt, w.settled[0], "...and settles at the first true-up");
    near(tr.bankDollars, o.monthly[23].creditBalance, 1e-9, "trailing bank = the last month's balance");
    // 60 panels, no battery: no export cap, so the only forfeiture is the ARECR clawback,
    // and it happens only in a settled month - never at the record's end.
    for (const m of o.monthly) {
      if (!m.settled) near(m.forfeitedCredit, 0, 1e-9, `tum ${tum} ${m.key}: nothing forfeited outside a true-up`);
    }
  }
  // The bank is real: 60 panels end an April-settled record (May-Aug) holding summer credit.
  assert.ok(runTU(ctx24, { panels: 60, batteries: 0, trueUpMonth: 4 }).trueUp.trailing.bankDollars > 1,
            "an April true-up leaves a summer bank at the record's end, carried not forfeited");
});

test("true-up: the month moves an oversized array's savings, and October is the conservative default", () => {
  // ACC Plus off: the adder is a bill credit that only fills room above the credit floor
  // (fixed + NBCs), and a 60-panel array's banked adder never runs out, so with it every
  // month sits on the floor whatever the true-up month and only the NSC payout differs -
  // which favours October.  This test is about the ARECR wiping a scarce bank.
  const sav = (tum) => Engine.simulate(ctx24, P({ panels: 60, batteries: 0, trueUpMonth: tum, accPlusAdder: 0 }), {}).savingsVsSameFlex;
  const apr = sav(4), oct = sav(10);
  assert.ok(Math.abs(apr - oct) > 1, `the true-up month matters (${apr.toFixed(0)} vs ${oct.toFixed(0)})`);
  assert.ok(oct < apr, "October (bank largest after summer, paid at NSC) is below April");
  assert.equal(TARIFF.nbt.true_up_month, 10, "sce.json defaults to October");
  const def = runTU(ctx, {});
  assert.equal(def.tariffTerms.trueUpMonth, 10, "the default comes from the file");
  // A system that imports more kWh than it exports in every period (15 panels + 1
  // battery) never has net surplus, so the true-up month cannot move it.
  const small = (tum) => Engine.simulate(ctx24, P({ panels: 15, batteries: 1, trueUpMonth: tum }), {}).bill;
  near(small(4), small(10), 1e-6, "no surplus, no true-up effect");
});

test("true-up: 12- and 13-month records settle once, in the true-up month, with no stub", () => {
  const c12 = Engine.prepare({ load: sliceLoad("2025-09", "2026-09"), tariffs: TARIFF });
  const c13 = Engine.prepare({ load: sliceLoad("2025-08", "2026-09"), tariffs: TARIFF });
  assert.equal(c12.nMonths, 12); assert.equal(c13.nMonths, 13);
  for (let tum = 1; tum <= 12; tum++) {
    const o12 = runTU(c12, { panels: 60, batteries: 0, trueUpMonth: tum });
    assert.equal(o12.trueUp.settledMonths.length, 1, `12 months, tum ${tum}: one settlement`);
    assert.equal(+o12.trueUp.settledMonths[0].slice(5), tum, `12 months, tum ${tum}: in the true-up month`);
    assert.deepEqual(o12.trueUp.periods.map((x) => x.months), [12]);

    const o13 = runTU(c13, { panels: 60, batteries: 0, trueUpMonth: tum });
    assert.equal(o13.trueUp.settledMonths.length, 1, `13 months, tum ${tum}: one settlement, no 1-month stub`);
    assert.equal(+o13.trueUp.settledMonths[0].slice(5), tum, `13 months, tum ${tum}: in the true-up month`);
    assert.deepEqual(o13.trueUp.periods.map((x) => x.months), [13], `13 months, tum ${tum}: one 13-month period`);
  }
  // August occurs twice in the 13-month record (first and last month): the first would
  // close a 1-month stub, so it rolls into the next window and only the last settles.
  const aug = runTU(c13, { panels: 60, batteries: 0, trueUpMonth: 8 });
  assert.deepEqual(aug.trueUp.settledMonths, ["2026-08"]);
  assert.deepEqual(aug.trueUp.trailing.unsettledMonths, [], "nothing trails a record that ends in its true-up");
  assert.equal(aug.trueUp.trailing.bankDollars, 0);
  // A 12-month record's true-up month now matters (it used to settle only at the end).
  // (80 panels: this year's 60-panel bank is fully consumed by winter whatever the month.)
  // (ACC Plus off for the same reason as the 24-month test above.)
  const s12 = (tum) => Engine.simulate(c12, P({ panels: 80, batteries: 0, trueUpMonth: tum, accPlusAdder: 0 }), {}).bill;
  assert.ok(s12(10) - s12(4) > 50, "a 12-month record's bill depends on the true-up month");
});

test("true-up month: overrides must be integer numbers 1-12, as core/tariff.js reads the file", () => {
  for (const bad of ["4", 4.5, 0, 13, null, undefined, ""]) {
    assert.equal(Engine.resolveTrueUpMonth(TARIFF, bad), TARIFF.nbt.true_up_month, `override ${JSON.stringify(bad)} ignored`);
  }
  assert.equal(Engine.resolveTrueUpMonth(TARIFF, 4), 4);
  const str = JSON.parse(JSON.stringify(TARIFF)); str.nbt.true_up_month = "4";
  assert.equal(Engine.resolveTrueUpMonth(str), Tariff.trueUpMonth(str), "a string month in the file: same fallback as tariff.js");
  assert.equal(Engine.resolveTrueUpMonth(str), Engine.DEFAULT_TRUE_UP_MONTH);
});

// ================================================================== 14. parity with tariff.js
// The worker bundle cannot import core/tariff.js, so the engine carries copies of its
// helpers.  Each copy must agree with the original on every shipped file.
test("engine tariff-term helpers agree with core/tariff.js on all three utility files", () => {
  for (const id of ["sce", "pge", "sdge"]) {
    const t = readTariff(id);
    assert.equal(Engine.tariffAccPlus(t), Tariff.accPlusAdder(t), id + " ACC Plus");
    assert.equal(Engine.tariffArecr(t), Tariff.arecr(t), id + " ARECR");
    assert.equal(Engine.resolveTrueUpMonth(t), Tariff.trueUpMonth(t), id + " true-up month");
    assert.equal(Engine.resolveTrueUpMonth(t), 10, id + " defaults to October");
    assert.equal(Engine.resolveProvider(t, null).id, Tariff.defaultProvider(t), id + " default provider");
    assert.equal(Engine.resolvePlan(t, null).plan.id, Tariff.defaultPlan(t).id, id + " default plan");
    const dr = Tariff.defaultBaselineRegion(t), be = Engine.resolveBaseline(t, null);
    assert.equal(be.region, dr, id + " default baseline region");
    for (const reg of Object.keys(t.utility.baselineRegions.allocations)) {
      const a = Tariff.baselineAllocation(t, reg), b = Engine.resolveBaseline(t, reg);
      assert.deepEqual([b.summer, b.winter], [a.summer, a.winter], id + " baseline " + reg);
    }
    const c = Engine.prepare({ load: loadSet(), tariffs: t });
    for (const pl of t.plans) {
      const r = Engine.buildRates(c, pl.id, null, false, null, undefined, true, {});
      assert.equal(r.baselineCreditPct, Tariff.baselineCreditPct(t, pl), id + " " + pl.id + " baseline credit %");
      assert.equal(r.trueUpMonth, Tariff.trueUpMonth(t), id + " " + pl.id + " true-up month");
    }
  }
});

// ================================================================== 15. plan / provider fallback
test("tariffTerms reports the plan used and whether it was a fallback", () => {
  const ok = runTU(ctx, { planId: "TOU-D-5-8" });
  assert.equal(ok.tariffTerms.planId, "TOU-D-5-8");
  assert.equal(ok.tariffTerms.planRequested, "TOU-D-5-8");
  assert.equal(ok.tariffTerms.planFallback, false);
  const bad = runTU(ctx, { planId: "E-TOU-C" });            // a PG&E plan on an SCE tariff
  assert.equal(bad.tariffTerms.planId, Tariff.defaultPlan(TARIFF).id, "unknown plan -> the utility's default plan");
  assert.equal(bad.tariffTerms.planRequested, "E-TOU-C");
  assert.equal(bad.tariffTerms.planFallback, true, "...and the fallback is flagged");
  assert.equal(Engine.resolvePlan(TARIFF, "").fallback, false, "an empty plan id asks for the default");
  assert.equal(Engine.resolvePlan(TARIFF, undefined).plan.id, Tariff.defaultPlan(TARIFF).id);
  assert.equal(bad.tariffTerms.providerFallback, false, "the provider fields are still there");
  assert.equal(bad.tariffTerms.baselineRegionFallback, false);
});

test("an empty provider id asks for the default provider; it is not a fallback", () => {
  for (const v of ["", undefined, null]) {
    const r = Engine.resolveProvider(TARIFF, v);
    assert.equal(r.id, Tariff.defaultProvider(TARIFF), JSON.stringify(v) + " -> default provider");
    assert.equal(r.fallback, false, JSON.stringify(v) + " is not a fallback");
    assert.equal(r.requested, null);
  }
  assert.equal(Engine.resolveProvider(TARIFF, "mce").fallback, true, "an unknown id still is");
});

// ================================================================== 16. usable days
test("usable days count a partial day by its share of 24 hours", () => {
  const L = loadSet();
  const full = Engine.prepare({ load: L, tariffs: TARIFF });
  const n = full.dayStart[299] + 1;                          // 299 whole days and one hour
  const short = { ...L, ts: L.ts.slice(0, n), kwh: L.kwh.slice(0, n) };
  const c = Engine.prepare({ load: short, tariffs: TARIFF }, { minUsableDays: 0 });
  near(c.usableDays, 299 + 1 / 24, 1e-9, "the 1-hour day is 1/24 of a usable day");
  assert.throws(() => Engine.prepare({ load: short, tariffs: TARIFF }), /usable days/,
                "299 days and an hour is under the 300-day bar");
  assert.throws(() => Engine.prepare({ load: short, tariffs: TARIFF }, { minUsableDays: null }), /usable days/,
                "minUsableDays: null means the default bar, not 0");
  // A spring-forward day has 23 hours and is a whole day.
  near(full.usableDays, full.nDays, 1e-9, "a complete record (with its two 23-hour days) is all usable");
});

// ================================================================== 13. one TOU lookup
/**
 * A wall-clock hourly LoadSet from `from` to `to` inclusive with real DST days: the
 * spring-forward Sunday has no 02:00 slot, the fall-back Sunday keeps 24 (the repeated
 * hour is summed into one slot, as core/greenbutton.js does).
 */
function clockYear(from, to, kwh = 1) {
  const ts = [], k = [];
  const springFwd = (y) => { const f = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7; };
  for (let d = new Date(from + "T00:00Z"); d <= new Date(to + "T00:00Z"); d = new Date(d.getTime() + 864e5)) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    const day = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    for (let h = 0; h < 24; h++) {
      if (m === 3 && dd === springFwd(y) && h === 2) continue;
      ts.push(`${day}T${String(h).padStart(2, "0")}:00`); k.push(kwh);
    }
  }
  return { meta: {}, ts, kwh: Float64Array.from(k), exportKwh: null };
}

test("engine buildRates and tariff.periodAt agree on every hour of a year, every plan, all three utilities", () => {
  // Dec 2022 - Nov 2023: Christmas 2022 and New Year's 2023 fall on SUNDAYS (observed on
  // the Mondays after), Veterans Day 2023 on a SATURDAY (not moved), July 4 2023 on a
  // Tuesday; March/April carry SDG&E EV-TOU-2's schedule_overrides window.  The review
  // measured 356 differing hours on EV-TOU-2 before the two lookups were merged.
  const load = clockYear("2022-12-01", "2023-11-30");
  const PID = Engine._internal.PERIOD_IDS;
  let overrideHours = 0, sundayHolidayHours = 0;
  for (const id of ["sce", "pge", "sdge"]) {
    const t = readTariff(id);
    const c = Engine.prepare({ load, tariffs: t }, { minUsableDays: 0 });
    const prov = Tariff.defaultProvider(t);
    for (const plan of t.plans) {
      const r = Engine.buildRates(c, plan.id, prov, false, null, 0, false);
      const bad = [];
      for (let i = 0; i < c.N; i++) {
        const at = Tariff.periodAt(plan, load.ts[i]);
        if (PID[r.period[i]] !== at.period) { bad.push(load.ts[i] + " engine " + PID[r.period[i]] + " tariff " + at.period); continue; }
        if ((c.dayType[i] === 1) !== (at.dayType === "weekend")) bad.push(load.ts[i] + " day type");
        if ((r.summer[i] === 1) !== (at.season === "summer")) bad.push(load.ts[i] + " season");
        // Prices follow the period: the engine's hourly import price is the tariff's.
        if (Math.abs(r.imp[i] - Tariff.rateAt(t, plan, prov, load.ts[i])) > 1e-12) bad.push(load.ts[i] + " price");
        // ...and the export table follows the same day type.
        const wantExp = Tariff.exportRateAt(t, load.ts[i]) + (prov !== t.utility.id ? (t.nbt.cca_export_adder_per_kwh || 0) : 0);
        if (Math.abs(r.exp[i] - wantExp) > 1e-12) bad.push(load.ts[i] + " export price");
        if (at.overridden) overrideHours++;
        if (at.holiday && (load.ts[i].startsWith("2022-12-26") || load.ts[i].startsWith("2023-01-02"))) sundayHolidayHours++;
      }
      assert.equal(bad.length, 0, `${id} ${plan.id}: ${bad.length} hours differ, e.g. ${bad.slice(0, 3).join("; ")}`);
    }
    // Spot-check the calendar the comparison ran on.
    const at = (s) => c.dayType[load.ts.indexOf(s)];
    assert.equal(at("2023-01-02T17:00"), 1, "New Year's 2023 (Sunday) observed Monday bills as weekend");
    assert.equal(at("2022-12-26T17:00"), 1, "Christmas 2022 (Sunday) observed Monday bills as weekend");
    assert.equal(at("2023-11-10T17:00"), 0, "Friday before Saturday Veterans Day 2023 is a weekday");
    assert.equal(at("2023-07-04T17:00"), 1, "July 4 2023 (Tuesday) bills as weekend");
  }
  assert.ok(overrideHours > 0, "the comparison exercised schedule_overrides");
  assert.ok(sundayHolidayHours > 0, "the comparison exercised Sunday-observed holidays");
});

// ================================================================== 14. credit floor, ACC Plus
test("no export credit or ACC Plus ever offsets the fixed charge or the non-bypassable charges", () => {
  for (const id of ["sce", "pge", "sdge"]) {
    const t = readTariff(id);
    const c = Engine.prepare({ load: loadSet(), tariffs: t });
    const plan = Tariff.defaultPlan(t), prov = Tariff.defaultProvider(t);
    for (const [panels, batteries] of [[30, 1], [60, 0], [40, 2]]) {
      const q = Engine.withDefaults(refParams(panels, batteries, { planId: plan.id, providerId: prov }));
      const out = Engine.runHours(Engine.buildScenario(c, q), q, true);
      for (const m of out.monthly) {
        near(m.nonBypassable, t.nbt.nonbypassable_charges_per_kwh * m.importKwh, 1e-9, `${id} ${m.key} NBC line`);
        // The bill before the true-up payout and the climate credit (both of which may go
        // lower) never drops under fixed + NBCs.
        const beforeTrueUp = m.bill - m.trueUp - m.climateCredit;
        assert.ok(beforeTrueUp >= m.fixed + m.nonBypassable - 1e-9,
                  `${id} ${panels}p/${batteries}b ${m.key}: $${beforeTrueUp.toFixed(2)} < fixed + NBC $${(m.fixed + m.nonBypassable).toFixed(2)}`);
      }
    }
  }
});

test("accPlusRevenue is exactly the adder's marginal value, and a subset of exportRevenue", () => {
  for (const id of ["sce", "pge"]) {                    // SDG&E pays no adder
    const t = readTariff(id);
    const c = Engine.prepare({ load: loadSet(), tariffs: t });
    const plan = Tariff.defaultPlan(t), prov = Tariff.defaultProvider(t);
    for (const [panels, batteries] of [[20, 1], [30, 1], [40, 2], [60, 0]]) {
      const base = { planId: plan.id, providerId: prov };
      const w = Engine.simulate(c, Engine.withDefaults(refParams(panels, batteries, base)), {});
      const wo = Engine.simulate(c, Engine.withDefaults(refParams(panels, batteries, { ...base, accPlusAdder: 0 })), {});
      const tag = `${id} ${panels}p/${batteries}b`;
      assert.ok(w.accPlusRevenue >= 0 && w.accPlusRevenue <= w.exportRevenue + 1e-9, `${tag}: subset of exportRevenue`);
      // Once the adder expires (finance, year 10) the year looks exactly like no adder.
      near(wo.bill - w.bill, w.accPlusRevenue, 1e-6, `${tag}: bill without - with adder`);
      near(w.exportRevenue - w.accPlusRevenue, wo.exportRevenue, 1e-6, `${tag}: export revenue net of the adder`);
      // Never more than the adder earned on creditable export.
      assert.ok(w.accPlusRevenue <= w.exportKwh * t.nbt.acc_plus_adder_per_kwh + 1e-6, `${tag}: <= adder x export`);
    }
  }
  const plans = Engine.billOnAllPlans(ctx, P({ panels: 30, batteries: 1 }));
  assert.ok(plans.every((p) => typeof p.accPlusRevenue === "number" && p.accPlusRevenue <= p.exportRevenue + 1e-9),
            "billOnAllPlans carries accPlusRevenue alongside exportRevenue");
});

test("credit that survives a true-up carries round the cycle into the months before it", () => {
  // June 29-30 (no sun) + July 1-2 (sun, $1.50 exports), true-up in July.  The cycle
  // starts in June with an empty bank, so a single pass leaves June's bill uncovered;
  // in steady state the residual July carries over its true-up pays June.
  const m = miniData({ exportRate: 1.50 });
  const prof = Float64Array.from(m.profile);
  for (const doy of [180, 181]) for (let h = 0; h < 24; h++) prof[(doy - 1) * 24 + h] = 0;
  const c = Engine.prepare({ load: clockYear("2025-06-29", "2025-07-02"), tariffs: m.ctx.tariffs }, { minUsableDays: 0 });
  const q = miniParams({ profile: prof });
  const out = Engine.runHours(Engine.buildScenario(c, q), q, true);
  const [jun, jul] = out.monthly;
  near(jun.exportKwh, 0, 1e-12, "June exports nothing");
  // July: $24 earned, $13.00 - $1.80 = $11.20 used, $12.80 left.  The period exported
  // 16 kWh and imported 88, so there is no net surplus: no ARECR, no NSC, and the whole
  // $12.80 is carried round to June (room $15.40 - $1.96 = $13.44, so all of it fits).
  near(jul.exportCreditUsed, -11.2, 1e-9, "July's own credit fills July down to fixed + NBCs");
  near(jul.trueUp, 0, 1e-12, "no NSC for a net importer");
  near(jun.exportCreditUsed, -12.8, 1e-9, "June's bill is paid by the credit carried over July's true-up");
  assert.ok(jun.bill >= jun.fixed + jun.nonBypassable, "and never below fixed + NBCs");
});

test("the credit bank: NSC rides on kWh alone, ACC Plus escapes the ARECR, the draw order only splits", () => {
  // Swap the monthly draw order (adder pools before export pools) with the test-only
  // r.bankDrawOrder hook.  The net surplus kWh, and so the NSC payout, never depend on
  // which dollars were drawn.  The ARECR debit falls on export credit only (PG&E NBT
  // SC 5.d: "The ACC Plus paid ... on Net Surplus Electricity will not be debited"), so
  // drawing the adder first can only leave more export credit exposed to it: the
  // tariff's own order (export credit applied to the month's energy charges, the adder
  // to what remains) is never worse for the customer.  With no ARECR debit binding (no
  // adder, or no surplus) the total bill is identical in either order.
  let surplusSeen = 0;
  for (const id of ["sce", "pge"]) {
    const t = readTariff(id);
    const c = Engine.prepare({ load: loadSet(), tariffs: t });
    const plan = Tariff.defaultPlan(t), prov = Tariff.defaultProvider(t);
    for (const [panels, batteries] of [[15, 1], [27, 1], [40, 0], [60, 2]]) for (const tum of [4, 10]) {
      for (const adder of [undefined, 0]) {
        const q = Engine.withDefaults(refParams(panels, batteries, { planId: plan.id, providerId: prov, trueUpMonth: tum,
          ...(adder === 0 ? { accPlusAdder: 0 } : {}) }));
        const scn = Engine.buildScenario(c, q);
        const a = Engine.runHours(scn, q, true);
        scn.rates.bankDrawOrder = "adderFirst";
        const b = Engine.runHours(scn, q, true);
        const tag = `${id} ${panels}p/${batteries}b tum ${tum} adder ${adder === 0 ? "off" : "on"}`;
        for (let m = 0; m < a.monthly.length; m++) near(a.monthly[m].trueUp, b.monthly[m].trueUp, 1e-9, `${tag} ${a.monthly[m].key}: NSC is order-free`);
        assert.ok(b.bill >= a.bill - 1e-9, `${tag}: the tariff's order is never worse`);
        if (adder === 0) near(a.bill, b.bill, 1e-9, `${tag}: no adder, no order effect`);
        if (a.monthly.some((m) => m.trueUp < 0)) surplusSeen++;
      }
    }
  }
  assert.ok(surplusSeen > 4, "the sweep includes systems with net surplus");
});

// ================================================================== existing solar / NEM 2
/**
 * A summer of hand-checkable hours with a meter that already exports.  The flat tariff
 * prices every hour at $0.30 (NBCs $0.02 inside it), and the true-up falls in August,
 * the record's last month.  `loadByMonth` is the household's own draw per hour; a 1 kW
 * array making 3 kWh/kW in four midday hours stands for the existing panels, and the
 * meter channels are what that house would record: import = max(0, load - PV), export
 * = max(0, PV - load).  `spurious(i)` adds export the PV cannot explain.
 */
function nemData(opts = {}) {
  const loadByMonth = opts.loadByMonth || { 6: 0.1, 7: 0.3, 8: 0.3 };
  // `fullYear` runs September 2024 - August 2025 (enough for prepare()'s default bar);
  // the months before June draw 0.3 kWh/h.
  const months = opts.fullYear
    ? [[2024, 9], [2024, 10], [2024, 11], [2024, 12], [2025, 1], [2025, 2], [2025, 3], [2025, 4], [2025, 5], [2025, 6], [2025, 7], [2025, 8]]
    : [[2025, 6], [2025, 7], [2025, 8]];
  const profile = new Float64Array(8760);
  for (let doy = 152; doy <= 243; doy++) for (const h of [10, 11, 12, 13]) profile[(doy - 1) * 24 + h] = 3.0;
  const ts = [], imp = [], exp = [], gross = [];
  for (const [yr, mo] of months) {
    const nd = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
    for (let d = 1; d <= nd; d++) {
      // Summer-only fixture months are all PDT; the full year keeps it simple by giving
      // the existing array no output outside them (the meter channels follow the model).
      for (let h = 0; h < 24; h++) {
        ts.push(`${yr}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`);
        const L = loadByMonth[mo] ?? 0.3, pv = mo >= 6 && mo <= 8 && h >= 11 && h <= 14 ? 3.0 : 0;   // PDT: standard 10-13
        const extra = opts.spurious ? opts.spurious(ts.length - 1) : 0;
        gross.push(L);
        imp.push(Math.max(0, L - pv)); exp.push(Math.max(0, pv - L) + extra);
      }
    }
  }
  const rate = (v) => ({ sce: v, delivery: v * 0.6, sce_generation: v * 0.4 });
  const sched = (p) => new Array(24).fill(p);
  const flat = (v) => Array.from({ length: 12 }, () => new Array(24).fill(v));
  const tariffs = {
    utility: { id: "sce" },
    meta: { baseline_kwh_per_day: { summer: 0, winter: 0 } },
    providers: { sce: { name: "SCE" } },
    plans: [{
      id: "FLAT", name: "Flat", summer_months: [6, 7, 8, 9],
      fixed_charge_per_day: 0.50, minimum_charge_per_day: 0.40, baseline_credit_per_kwh: 0,
      period_ids: ["on", "mid", "off", "super_off"],
      schedule: { summer: { weekday: sched("off"), weekend: sched("off") },
                  winter: { weekday: sched("off"), weekend: sched("off") } },
      rates: { summer: { on: rate(0.30), mid: rate(0.30), off: rate(0.30) },
               winter: { on: rate(0.30), mid: rate(0.30), off: rate(0.30), super_off: rate(0.30) } },
    }],
    nbt: { export_rates: { weekday: flat(0.05), weekend: flat(0.05) },
           cca_export_adder_per_kwh: 0, net_surplus_compensation_per_kwh: 0.05,
           nonbypassable_charges_per_kwh: 0.02, true_up_month: 8,
           acc_plus_adder_per_kwh: 0.016, eec_adjustment_per_kwh: 0.05981 },
  };
  const ctxN = Engine.prepare({ load: { meta: {}, ts, kwh: Float64Array.from(imp), exportKwh: Float64Array.from(exp) },
                               tariffs }, opts.fullYear ? undefined : { minUsableDays: 0 });
  return { ctx: ctxN, profile, imp, exp, gross };
}
function nemParams(d, over = {}) {
  return Engine.withDefaults({
    planes: [{ id: "p1", profile: d.profile, panels: 0, shading: { annual: 0 } }],
    panelW: 1000, batteries: 0, battKWh: 10, battKW: 5, planId: "FLAT", providerId: "sce",
    flex: [], strategy: "self_consumption", climateCreditOff: true, ...over,
  });
}

test("NEM 2 credits an export at that hour's retail price less the NBCs; NEM 1 at the full retail price", () => {
  const d = nemData();
  const opts = (billing) => ({ billing });
  const r2 = Engine.buildRates(d.ctx, "FLAT", "sce", false, null, undefined, true, opts("nem2"));
  const r1 = Engine.buildRates(d.ctx, "FLAT", "sce", false, null, undefined, true, opts("nem1"));
  const rn = Engine.buildRates(d.ctx, "FLAT", "sce", false, null, undefined, true, opts(undefined));
  const i = d.ctx.load.ts.indexOf("2025-07-15T12:00");
  near(r2.imp[i], 0.30, 1e-12, "retail import price");
  near(r2.exp[i], 0.30 - 0.02, 1e-12, "NEM 2: retail minus nonbypassable_charges_per_kwh");
  near(r1.exp[i], 0.30, 1e-12, "NEM 1: no NBC deduction");
  near(rn.exp[i], 0.05, 1e-12, "the default is still Net Billing, priced off the ACC matrix");
  assert.equal(rn.billing, "nbt");
  // With applyNbc the NBCs ride on top of the table; NEM 2 still credits the table price.
  const ra = Engine.buildRates(d.ctx, "FLAT", "sce", true, null, undefined, true, opts("nem2"));
  near(ra.imp[i], 0.32, 1e-12, "applyNbc adds the NBC to the import price");
  near(ra.exp[i], 0.30, 1e-12, "...and NEM 2 credits it back out");
  // None of the Net Billing machinery applies.
  assert.equal(r2.accPlus, 0); assert.equal(r2.arecr, 0); assert.equal(r2.capExport, false);

  // One hand-checked month: July, 0.3 kWh/h, the 1 kW array exports 10.8 kWh a day.
  const X = { existing: { planeId: "p1", panels: 1 } };
  const p = nemParams(d, { billing: "nem2", ...X });
  const out = Engine.runHours(Engine.buildScenario(d.ctx, p), p, true);
  const jul = out.monthly[1];
  near(jul.exportKwh, 31 * 10.8, 1e-9, "July export");
  near(jul.importKwh, 31 * 20 * 0.3, 1e-9, "July import");
  near(jul.accPlus, 0, 0, "no ACC Plus under NEM");
  const p1 = nemParams(d, { billing: "nem1", ...X });
  const jul1 = Engine.runHours(Engine.buildScenario(d.ctx, p1), p1, true).monthly[1];
  assert.ok(jul1.exportKwh === jul.exportKwh, "same physics either way");
});

test("NEM 2 credits roll month to month, NSC pays the surplus kWh at true-up, and the rest is zeroed", () => {
  const d = nemData();
  const X = { existing: { planeId: "p1", panels: 1 } };
  const p = nemParams(d, { billing: "nem2", ...X });
  const out = Engine.runHours(Engine.buildScenario(d.ctx, p), p, true);
  const [jun, jul, aug] = out.monthly;
  const credit = 0.28;
  // June: 0.1 kWh/h.  Export 11.6 kWh/day, import 2 kWh/day.
  const junExp = 30 * 11.6, junImp = 30 * 2, julExp = 31 * 10.8, julImp = 31 * 6;
  const room = (days, imp) => (0.5 * days + 0.30 * imp) - (0.5 * days + 0.02 * imp);   // down to fixed + NBCs
  near(jun.exportCreditUsed, -room(30, junImp), 1e-9, "June credit fills the room down to fixed + NBCs");
  const bankJun = junExp * credit - room(30, junImp);
  near(jun.creditBalance, bankJun, 1e-9, "June's unused credit is banked");
  near(jul.exportCreditUsed, -room(31, julImp), 1e-9, "July is offset to the floor again");
  near(jul.creditBalance, bankJun + julExp * credit - room(31, julImp), 1e-9, "and the bank rolls forward");
  assert.equal(aug.settled, true, "August is the true-up month");
  const surplus = (junExp + 2 * julExp) - (junImp + 2 * julImp);
  near(aug.trueUp, -surplus * 0.05, 1e-9, "net surplus kWh are paid at NSC");
  const leftover = bankJun + 2 * (julExp * credit - room(31, julImp));
  near(aug.forfeitedCredit, leftover, 1e-9, "the dollar bank left at true-up is zeroed, not paid");
  near(aug.creditBalance, 0, 1e-12, "nothing carries into the next year");
  near(out.nscRevenue * d.ctx.years, surplus * 0.05, 1e-9, "nscRevenue is the true-up payout");
  // Fixed charge and NBCs are always paid: every month bills at least that, less only NSC.
  for (const m of out.monthly) {
    assert.ok(m.bill + 1e-9 >= m.fixed + m.nonBypassable + m.trueUp, `${m.key} keeps fixed + NBCs`);
  }
  // Under NEM the export dollars travel with the retail saving: exportRevenue is 0.
  assert.equal(out.exportRevenue, 0);
  assert.equal(out.accPlusRevenue, 0);
  near(out.nemExportValue * d.ctx.years,
       out.monthly.reduce((s, m) => s - m.exportCreditUsed - m.trueUp, 0), 1e-9, "nemExportValue = credits used + NSC");

  // NEM 1 is identical except the credit is worth the full $0.30.
  const p1 = nemParams(d, { billing: "nem1", ...X });
  const jun1 = Engine.runHours(Engine.buildScenario(d.ctx, p1), p1, true).monthly[0];
  near(jun1.creditBalance, junExp * 0.30 - room(30, junImp), 1e-9, "NEM 1 banks retail with no NBC deduction");
});

test("existing solar: gross load is import - export + existing PV, clipped at zero", () => {
  // Two spurious kWh of 'export' at 3 a.m. every day: the reconstruction would go
  // negative there, and must clip instead.
  const d = nemData({ spurious: (i) => (i % 24 === 3 ? 2 : 0) });
  const p = nemParams(d, { existing: { planeId: "p1", panels: 1 } });
  const scn = Engine.buildScenario(d.ctx, p);
  const pv = scn.existing.pv;
  let clipped = 0;
  for (let i = 0; i < d.ctx.N; i++) {
    const raw = d.imp[i] - d.exp[i] + pv[i];
    assert.ok(scn.baseLoad[i] >= 0, "never negative");
    if (raw >= 0) near(scn.baseLoad[i], raw, 1e-12, `hour ${i} is import - export + PV`);
    else { assert.equal(scn.baseLoad[i], 0); clipped++; }
    if (i % 24 !== 3) near(scn.baseLoad[i], d.gross[i], 1e-12, "and recovers the house's own draw");
  }
  assert.equal(clipped, d.ctx.nDays, "one clipped hour a day");
  assert.equal(scn.existing.grossClippedHours, clipped);
  // A plane id the scenario does not carry falls back to the first plane, and says so.
  const q = Engine.buildScenario(d.ctx, nemParams(d, { existing: { planeId: "gone", panels: 1 } }));
  assert.equal(q.existing.planeFallback, true);
  assert.equal(q.existing.planeId, "p1");
  // No existing panels: the recorded import, as before.
  const none = Engine.buildScenario(d.ctx, nemParams(d));
  assert.equal(none.existing, null);
  for (let i = 0; i < d.ctx.N; i++) assert.equal(none.baseLoad[i], d.imp[i]);
});

test("existing solar: both baselines carry the existing array; 0 batteries is the baseline bill exactly", () => {
  const d = nemData();
  for (const billing of ["nem2", "nem1", "nbt"]) {
    const p = nemParams(d, { billing, existing: { planeId: "p1", panels: 1 }, panelsByPlane: [0], batteries: 0 });
    const res = Engine.simulate(d.ctx, p);
    const arrayKwh = sum(Engine.buildScenario(d.ctx, p).existing.pv) / d.ctx.years;
    near(res.baselineSameFlex.pvKwh, arrayKwh, 1e-9, `${billing}: baseline PV is the existing array's output`);
    near(res.baselineAsRecorded.pvKwh, arrayKwh, 1e-9, `${billing}: so is the as-recorded baseline's`);
    near(res.baselineSameFlex.existingPvKwh, arrayKwh, 1e-9, "existingPvKwh reports it");
    assert.equal(res.panels, 1); assert.equal(res.newPanels, 0); assert.equal(res.existingPanels, 1);
    assert.equal(res.bill, res.baselineSameFlex.bill, `${billing}: adding nothing changes nothing`);
    assert.equal(res.savingsVsSameFlex, 0);
    // The model reproduces the metered house: same load, and the bill of the recorded channels.
    near(res.loadKwh * d.ctx.years, sum(d.gross), 1e-6, "household load is the reconstructed gross");
    // One battery on top keeps the array.  This fixture banks more credit than it can use
    // and forfeits it at true-up, so a stored kWh can only help.
    const withB = Engine.simulate(d.ctx, Object.assign({}, p, { batteries: 1 }));
    assert.equal(withB.panels, 1);
    near(withB.pvKwh, arrayKwh, 1e-9, "the battery adds no PV");
    assert.ok(withB.bill <= res.bill + 1e-9, `${billing}: a battery never raises the bill here`);
  }
  // No grid charging and no battery export under NEM, whatever the controls say.
  const p = nemParams(d, { billing: "nem2", existing: { planeId: "p1", panels: 1 }, panelsByPlane: [0],
                           batteries: 1, gridCharge: true, strategy: "export_arbitrage", exportThreshold: 0 });
  const h = Engine.runHours(Engine.buildScenario(d.ctx, p), p, true);
  assert.ok(h.chargeKwh > 0, "the battery does charge from the array");
  assert.equal(sum(h.hourly.gridToBatt), 0, "never charges from the grid");
  assert.equal(sum(h.hourly.battExport), 0, "never exports from the battery");
});

test("worker grid with an existing array sweeps batteries only, at the existing panel count", () => {
  const src = readFileSync(new URL("../app/worker-bundle.js", import.meta.url), "utf8");
  const out = [];
  const shim = { postMessage: (m) => out.push(m), onmessage: null };
  new Function("self", src)(shim);
  const d = nemData({ fullYear: true });
  shim.onmessage({ data: { type: "init", load: d.ctx.load, tariffs: d.ctx.tariffs, solar: null } });
  assert.equal(out[0].type, "ready", out[0].message);
  const params = { planes: [{ id: "a", profile: d.profile, panels: 30, maxPanels: 30, shading: { annual: 0 } },
                            { id: "p1", profile: d.profile, panels: 30, maxPanels: 30, shading: { annual: 0 } }],
                   panelW: 500, battKWh: 10, battKW: 5, planId: "FLAT", providerId: "sce",
                   strategy: "self_consumption", climateCreditOff: true,
                   billing: "nem2", existing: { planeId: "p1", panels: 2 } };
  shim.onmessage({ data: { type: "grid", id: 7, params, maxPanelsTotal: 40, maxBatteries: 3, step: 1 } });
  const g = out.find((m) => m.type === "grid");
  assert.ok(g, JSON.stringify(out.filter((m) => m.type === "error")));
  const grid = g.grid;
  assert.deepEqual(grid.panelList, [2], "the panel axis is the existing array");
  assert.deepEqual(grid.battList, [0, 1, 2, 3]);
  assert.equal(grid.cells.length, 4);
  for (const c of grid.cells) {
    assert.deepEqual(c.panelsByPlane, [0, 2], "every panel sits on the existing plane");
    assert.equal(c.kwdc, 1, "kwdc is the whole array");
    assert.equal(c.newPanels, 0);
    assert.equal(c.billing, "nem2");
  }
  assert.equal(grid.cells[0].bill, grid.baselineSameFlex.bill, "0 batteries is the baseline");
  assert.equal(grid.baselineSameFlex.panels, 2, "the baseline carries the existing array");
  // Without `existing` the same message runs the ordinary panel x battery sweep.
  out.length = 0;
  shim.onmessage({ data: { type: "grid", id: 8, params: Object.assign({}, params, { existing: null, billing: "nbt" }),
                           maxPanelsTotal: 3, maxBatteries: 1, step: 1 } });
  const g2 = out.find((m) => m.type === "grid").grid;
  assert.deepEqual(g2.panelList, [0, 1, 2, 3]);
});

test("a manual flex load with its own hourly series adds exactly that series and is never subtracted", () => {
  // A heat pump: a manual load whose kwhByHour was built from weather, never metered.
  const N = ctx.N;
  const series = new Float64Array(N);
  for (let i = 0; i < N; i++) series[i] = (i % 24) < 6 ? 0.75 : 0;
  const hp = { id: "hp", kind: "heatpump", source: "manual", name: "Heat pump",
               kwhByHour: series, schedule: { mode: "asRecorded" } };
  const p = Engine.withDefaults({ ...P({ panels: 0, batteries: 0 }), flex: [hp], baseLoadScale: 1 });
  const scn = Engine.buildScenario(ctx, p);
  const plain = Engine.buildScenario(ctx, Object.assign({}, p, { flex: [] }));
  for (let i = 0; i < N; i++) {
    if (!ctx.valid[i]) continue;
    assert.equal(scn.baseLoad[i], ctx.recorded[i], "base load is the recorded load");
    near(scn.load[i], plain.load[i] + series[i], 1e-12, "load gains exactly the series");
  }
  // ...in the as-recorded arm too.
  const rec = Engine.buildScenario(ctx, p, { flexMode: "asRecorded" });
  for (let i = 0; i < N; i += 97) if (ctx.valid[i]) near(rec.load[i], plain.load[i] + series[i], 1e-12, "as-recorded arm");
});
