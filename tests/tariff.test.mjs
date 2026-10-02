/* =============================================================================
 * tariff.test.mjs - core/tariff.js and the shipped tariff library.
 *
 *   node --test tests/
 *
 * The load-bearing assertion in this file is the SCE bill replay: data/tariffs/sce.json
 * was calibrated against a real customer bill, and a pure-tariff calculation
 * (kWh by period x rates + fixed + surcharges - climate credit) must still land on
 * $749.41 against the actual $749.37.  If a rate edit breaks that, the edit is wrong.
 * ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import T from "../core/tariff.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "data", "tariffs");

const lib = await T.loadLibrary(DIR);
const { utilities } = lib;
const ids = Object.keys(utilities).sort();

const close = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, (msg || "") + " expected " + b + " +/-" + eps + ", got " + a);

/* ========================================================================== */
test("library loads every shipped utility with no load errors", () => {
  assert.deepEqual(lib.errors, [], "load errors: " + JSON.stringify(lib.errors));
  assert.ok(ids.length >= 3, "expected at least sce, pge, sdge; got " + ids.join(","));
  for (const id of ["sce", "pge", "sdge"]) assert.ok(utilities[id], id + ".json missing");
});

test("every file validates with zero errors", () => {
  for (const id of ids) {
    const r = T.validate(utilities[id]);
    assert.equal(r.ok, true, id + " errors:\n  " + r.errors.join("\n  "));
  }
});

test("validate() actually catches a broken file", () => {
  const bad = JSON.parse(JSON.stringify(utilities.sce));
  bad.plans[0].schedule.summer.weekday = bad.plans[0].schedule.summer.weekday.slice(0, 23);
  let r = T.validate(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /23 entries, need 24/.test(e)), r.errors.join("; "));

  const bad2 = JSON.parse(JSON.stringify(utilities.sce));
  delete bad2.plans[0].rates.summer.on[Object.keys(bad2.providers)[1]];
  r = T.validate(bad2);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /is not a number/.test(e)), r.errors.join("; "));

  const bad3 = JSON.parse(JSON.stringify(utilities.sce));
  bad3.meta.rates_effective = "June 2026";
  r = T.validate(bad3);
  assert.ok(r.errors.some((e) => /rates_effective must be YYYY-MM-DD/.test(e)));

  const bad4 = JSON.parse(JSON.stringify(utilities.sce));
  bad4.plans.forEach((p) => { p.default = true; });
  r = T.validate(bad4);
  assert.ok(r.errors.some((e) => /more than one plan marked default/.test(e)));
});

test("exactly one default plan per utility, and it is the expected one", () => {
  const expected = { sce: "TOU-D-4-9", pge: "E-TOU-C", sdge: "TOU-DR1" };
  for (const id of ids) {
    const d = T.defaultPlan(utilities[id]);
    assert.ok(d, id + " has no default plan");
    if (expected[id]) assert.equal(d.id, expected[id], id + " default plan");
  }
});

/* ------------------------------------------------------------------ calendar */

test("holidays use the weekend schedule, including observed-on-Monday", () => {
  // 2027-01-01 is a Friday -> New Year's Day is itself a weekday holiday.
  const h2027 = T.holidaysForYear(2027);
  assert.ok(h2027.has("2027-1-1"));

  // 2028-01-01 is a Saturday -> observed Friday 2027-12-31 (a weekday).
  assert.ok(T.holidaysForYear(2028).has("2028-1-1"));

  // 2023-01-01 was a Sunday -> observed MONDAY 2023-01-02.  This is the case the
  // schema note is about: a Monday that must bill as a weekend.
  const h2023 = T.holidaysForYear(2023);
  assert.ok(h2023.has("2023-1-2"), "New Year's observed Monday 2023-01-02");
  assert.equal(T.isWeekendOrHoliday("2023-01-02"), true);

  // 2026-07-04 is a Saturday -> observed Friday 2026-07-03.
  const h2026 = T.holidaysForYear(2026);
  assert.ok(h2026.has("2026-7-3"), "Independence Day observed Friday 2026-07-03");
  assert.equal(T.isWeekendOrHoliday("2026-07-03"), true);

  // Floating holidays land on Mondays/Thursdays by construction.
  assert.ok(h2026.has("2026-5-25"), "Memorial Day 2026-05-25");
  assert.ok(h2026.has("2026-9-7"), "Labor Day 2026-09-07");
  assert.ok(h2026.has("2026-11-26"), "Thanksgiving 2026-11-26");
  assert.ok(h2026.has("2026-2-16"), "Presidents' Day 2026-02-16");

  // An ordinary Monday is not a holiday.
  assert.equal(T.isWeekendOrHoliday("2026-07-13"), false);
});

test("periodAt bills the weekend schedule on an observed-Monday holiday", () => {
  const sce = utilities.sce;
  const p = T.plan(sce, "TOU-D-4-9");
  // Monday 2023-01-02, 5 p.m. -> weekend schedule because New Year's is observed.
  const mon = T.periodAt(p, "2023-01-02", 17);
  assert.equal(mon.dayType, "weekend");
  assert.equal(mon.holiday, true);
  // The very next Monday is an ordinary weekday.
  const nextMon = T.periodAt(p, "2023-01-09", 17);
  assert.equal(nextMon.dayType, "weekday");
  assert.equal(nextMon.holiday, false);
});

test("partsOf reads date strings as local wall clock, never through Date parsing", () => {
  const a = T.partsOf("2026-07-04", 17);
  assert.deepEqual([a.y, a.m, a.d, a.hour], [2026, 7, 4, 17]);
  const b = T.partsOf("2026-07-04T09:00");
  assert.equal(b.hour, 9);
  const c = T.partsOf({ y: 2026, m: 12, d: 25, h: 20 });
  assert.equal(c.hour, 20);
  assert.equal(T.partsOf("2026-07-04", 0).dow, 6);      // Saturday
  assert.throws(() => T.partsOf("not a date"));
});

/* -------------------------------------------------------------- season edges */

test("season boundaries: the first and last hour of each utility's summer", () => {
  const cases = [
    ["sce", null, [6, 7, 8, 9]],
    ["pge", null, [6, 7, 8, 9]],
    ["sdge", null, [6, 7, 8, 9, 10]],
  ];
  for (const [id, planId, months] of cases) {
    const t = utilities[id];
    if (!t) continue;
    const p = T.plan(t, planId);
    assert.deepEqual(p.summer_months.slice().sort((a, b) => a - b), months, id + " summer months");
    const first = months[0], last = months[months.length - 1];

    // Last hour of the month before summer is winter; first hour of summer is summer.
    assert.equal(T.periodAt(p, { y: 2026, m: first - 1, d: 28 }, 23).season, "winter",
      id + ": " + (first - 1) + "/28 23:00 should be winter");
    assert.equal(T.periodAt(p, { y: 2026, m: first, d: 1 }, 0).season, "summer",
      id + ": " + first + "/1 00:00 should be summer");

    // Last hour of summer is summer; first hour of the next month is winter.
    assert.equal(T.periodAt(p, { y: 2026, m: last, d: 30 }, 23).season, "summer",
      id + ": " + last + "/30 23:00 should be summer");
    assert.equal(T.periodAt(p, { y: 2026, m: last + 1, d: 1 }, 0).season, "winter",
      id + ": " + (last + 1) + "/1 00:00 should be winter");
  }
});

test("SCE TOU-D-4-9PM peak window is 4-9 p.m. and nothing else", () => {
  const p = T.plan(utilities.sce, "TOU-D-4-9");
  const wed = { y: 2026, m: 7, d: 15 };                 // a summer Wednesday
  for (let h = 0; h < 24; h++) {
    const at = T.periodAt(p, wed, h);
    if (h >= 16 && h < 21) assert.equal(at.period, "on", "hour " + h);
    else assert.equal(at.period, "off", "hour " + h);
  }
  const sun = { y: 2026, m: 7, d: 12 };                 // a summer Sunday
  assert.equal(T.periodAt(p, sun, 17).period, "mid");
  assert.equal(T.periodAt(p, sun, 10).period, "off");
});

test("SDG&E March/April weekday 10 a.m.-2 p.m. super-off-peak", () => {
  const t = utilities.sdge;
  if (!t) return;
  const plans = t.plans.filter((p) => (p.schedule_overrides || []).length);
  assert.ok(plans.length, "expected at least one sdge plan with a March/April override");
  for (const p of plans) {
    const marWed = { y: 2026, m: 3, d: 11 };            // Wednesday in March
    for (let h = 10; h < 14; h++) {
      assert.equal(T.periodAt(p, marWed, h).period, "super_off",
        p.id + " March weekday hour " + h);
    }
    // 9 a.m. and 2 p.m. are outside the window.
    assert.notEqual(T.periodAt(p, marWed, 9).period, "super_off", p.id + " March 9 a.m.");
    assert.notEqual(T.periodAt(p, marWed, 14).period, "super_off", p.id + " March 2 p.m.");

    // April weekday: same.  April WEEKEND: not overridden.
    assert.equal(T.periodAt(p, { y: 2026, m: 4, d: 15 }, 12).period, "super_off",
      p.id + " April weekday noon");
    const aprSat = T.periodAt(p, { y: 2026, m: 4, d: 18 }, 12);
    assert.equal(aprSat.dayType, "weekend");
    assert.equal(aprSat.overridden, false, p.id + " April weekend must not be overridden");

    // May weekday noon: the window is March/April only.
    assert.equal(T.periodAt(p, { y: 2026, m: 5, d: 13 }, 12).overridden, false,
      p.id + " May weekday must not be overridden");

    // And the overridden period has a real, positive rate for every provider.
    for (const prov of Object.keys(t.providers)) {
      const r = T.rateAt(t, p, prov, marWed, 12);
      assert.ok(r > 0, p.id + "/" + prov + " March noon rate");
    }
  }
});

/* ----------------------------------------------------------------- rate lookups */

test("rateAt returns a positive number for every utility x plan x provider x season x period", () => {
  let checked = 0;
  for (const id of ids) {
    const t = utilities[id];
    for (const p of t.plans) {
      for (const prov of Object.keys(t.providers)) {
        // Sample a weekday and a weekend in each month, every hour.
        for (let m = 1; m <= 12; m++) {
          for (const d of [14, 18]) {                   // 2026-xx-14 / -18 span both day types
            for (let h = 0; h < 24; h++) {
              const v = T.rateAt(t, p, prov, { y: 2026, m, d }, h);
              assert.ok(typeof v === "number" && isFinite(v) && v > 0,
                id + "/" + p.id + "/" + prov + " " + m + "/" + d + " h" + h + " -> " + v);
              checked++;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, "only checked " + checked + " rate lookups");
});

test("rateAt throws rather than returning zero on a bad lookup", () => {
  const t = utilities.sce;
  const p = T.plan(t, "TOU-D-4-9");
  assert.throws(() => T.rateAt(t, p, "no_such_provider", "2026-07-15", 17),
    /no rate for provider/);
  assert.throws(() => T.rateAt(t, "NO-SUCH-PLAN", "sce", "2026-07-15", 17), /no such plan/);
});

test("filler period cells resolve but are never emitted by a schedule", () => {
  for (const id of ids) {
    const t = utilities[id];
    for (const p of t.plans) {
      for (const season of ["summer", "winter"]) {
        const sched = p.schedule[season];
        const emitted = new Set([].concat(sched.weekday, sched.weekend));
        for (const ov of (p.schedule_overrides || [])) {
          if (!ov.months || ov.months.some((m) => T.seasonOf(p, m) === season)) emitted.add(ov.period);
        }
        for (const pid of p.period_ids) {
          const cell = p.rates[season][pid];
          assert.ok(cell, id + "/" + p.id + " rates." + season + "." + pid + " missing");
          for (const prov of Object.keys(t.providers)) {
            assert.ok(cell[prov] > 0, id + "/" + p.id + " " + season + "." + pid + "." + prov);
          }
        }
        assert.ok(emitted.size >= 2, id + "/" + p.id + " " + season + " emits only " + emitted.size + " period(s)");
      }
    }
  }
});

test("on-peak costs more than off-peak in summer, for every plan and provider", () => {
  for (const id of ids) {
    const t = utilities[id];
    for (const p of t.plans) {
      const s = p.rates.summer;
      const peak = s.on || s.mid;
      if (!peak || !s.off) continue;
      for (const prov of Object.keys(t.providers)) {
        assert.ok(peak[prov] > s.off[prov],
          id + "/" + p.id + "/" + prov + " summer peak " + peak[prov] + " <= off " + s.off[prov]);
      }
    }
  }
});

test("providers, defaults and ZIP routing", () => {
  for (const id of ids) {
    const t = utilities[id];
    assert.equal(t.utility.id, id, "utility.id must match the filename");
    assert.ok(t.providers[id], id + " must price its own bundled service");
    assert.ok(T.providersOf(t).includes(id));
    assert.ok(!T.providersOf(t).includes("delivery"), "diagnostic columns must not be providers");

    const zip = String(t.utility.zipPrefixes[0]).slice(0, 3) + "01";
    const hit = T.utilityForZip(zip, lib);
    assert.ok(hit, id + ": no utility for ZIP " + zip);
    assert.ok(hit.candidates.includes(id), id + ": ZIP " + zip + " routed to " + hit.candidates);
  }
  assert.equal(T.utilityForZip("10001", lib), null, "a New York ZIP must not match");
  assert.equal(T.utilityForZip("9", lib), null);
});

test("baseline regions resolve and carry positive allocations", () => {
  for (const id of ids) {
    const t = utilities[id];
    const br = t.utility.baselineRegions;
    if (!br) continue;
    for (const r of Object.keys(br.allocations)) {
      const a = br.allocations[r];
      assert.ok(a.summer > 0 && a.winter > 0, id + " region " + r);
      assert.ok(a.summer < 60 && a.winter < 60, id + " region " + r + " allocation looks wrong");
    }
    for (const k of Object.keys(br.zipHints || {})) {
      const hit = T.baselineRegionForZip(t, k + "01");
      assert.ok(hit && hit.allocation, id + " zipHint " + k + " does not resolve");
    }
  }
});

/* ------------------------------------------------------------- export matrices */

test("export matrices are 12x24, non-negative, and weekend differs from weekday", () => {
  for (const id of ids) {
    const t = utilities[id];
    for (const dt of ["weekday", "weekend"]) {
      const m = T.exportMatrix(t, dt);
      assert.equal(m.length, 12, id + "." + dt + " months");
      m.forEach((row, mi) => {
        assert.equal(row.length, 24, id + "." + dt + " month " + (mi + 1) + " hours");
        row.forEach((v, h) => {
          assert.ok(typeof v === "number" && isFinite(v) && v >= 0,
            id + "." + dt + "[" + mi + "][" + h + "] = " + v);
        });
      });
    }
    const wd = JSON.stringify(T.exportMatrix(t, "weekday"));
    const we = JSON.stringify(T.exportMatrix(t, "weekend"));
    assert.notEqual(wd, we, id + ": weekday and weekend export matrices are identical");
  }
});

test("exportRateAt picks the right cell, and holidays read the weekend table", () => {
  for (const id of ids) {
    const t = utilities[id];
    const wd = T.exportMatrix(t, "weekday"), we = T.exportMatrix(t, "weekend");
    // 2026-08-12 is a Wednesday; 2026-08-15 a Saturday.
    close(T.exportRateAt(t, "2026-08-12", 17), wd[7][17], 1e-12, id + " weekday cell");
    close(T.exportRateAt(t, "2026-08-15", 17), we[7][17], 1e-12, id + " weekend cell");
    // 2026-07-03, the observed Independence Day, must read the WEEKEND table.
    close(T.exportRateAt(t, "2026-07-03", 17), we[6][17], 1e-12, id + " observed-holiday cell");
    // The adder is excluded from the matrix and added on request.
    const adder = T.accPlusAdder(t);
    close(T.exportRateAt(t, "2026-08-12", 17, { includeAdder: true }), wd[7][17] + adder, 1e-12,
      id + " adder");
  }
});

test("export credit at midday is far below the retail import price", () => {
  for (const id of ids) {
    const t = utilities[id];
    const p = T.defaultPlan(t);
    const prov = T.defaultProvider(t);
    const noon = T.exportRateAt(t, "2026-08-12", 12);
    const retail = T.rateAt(t, p, prov, "2026-08-12", 12);
    assert.ok(noon < retail * 0.6,
      id + ": midday export $" + noon + " is not clearly below retail $" + retail);
  }
});

/* ------------------------------------------------------------------- fromBill */

test("fromBill round-trips the user's own numbers", () => {
  const spec = {
    utilityId: "sce", planId: "TOU-D-4-9", providerId: "sce",
    periods: { summer: { on: 0.61, mid: 0.49, off: 0.37 }, winter: { mid: 0.54, off: 0.40 } },
    fixedPerDay: 0.81, minimumPerDay: 0, baselineCreditPerKwh: 0.10,
    climateCredit: { amount: 41, months: [4, 10] },
    label: "My July bill",
  };
  const custom = T.fromBill(spec, lib);

  assert.equal(custom.meta.custom, true);
  assert.equal(custom.plans.length, 1);
  const p = custom.plans[0];
  assert.equal(p.id, "TOU-D-4-9");
  assert.equal(p.default, true);

  // Every substituted price comes back exactly.
  close(T.rateAt(custom, p, "sce", "2026-07-15", 17), 0.61, 1e-12, "summer on");
  close(T.rateAt(custom, p, "sce", "2026-07-18", 17), 0.49, 1e-12, "summer weekend mid");
  close(T.rateAt(custom, p, "sce", "2026-07-15", 2), 0.37, 1e-12, "summer off");
  close(T.rateAt(custom, p, "sce", "2026-12-15", 17), 0.54, 1e-12, "winter mid");
  close(T.rateAt(custom, p, "sce", "2026-12-15", 2), 0.40, 1e-12, "winter off");

  close(T.fixedChargePerDay(custom, p), 0.81, 1e-12);
  assert.equal(p.baseline_credit_per_kwh, 0.10);
  assert.deepEqual(T.climateCredit(custom), { amount: 41, months: [4, 10], annual: 82 });

  // The schedule, seasons and export matrix are inherited untouched.
  assert.deepEqual(p.schedule, T.plan(utilities.sce, "TOU-D-4-9").schedule);
  assert.deepEqual(custom.nbt.export_rates.weekday, utilities.sce.nbt.export_rates.weekday);

  // Unsupplied periods are inherited, not zeroed, and are reported as such.
  assert.ok(custom.meta.custom_fields.substituted.includes("summer.on"));
  assert.ok(custom.meta.custom_fields.inherited.includes("winter.super_off"));
  assert.ok(T.rateAt(custom, p, "sce", "2026-12-15", 10) > 0, "inherited winter super-off");

  // Other providers keep their spread, so a provider switch still works.
  const src = T.plan(utilities.sce, "TOU-D-4-9");
  const delta = 0.61 - src.rates.summer.on.sce;
  close(p.rates.summer.on.cpa_green, src.rates.summer.on.cpa_green + delta, 1e-5, "cpa_green shifted");
  assert.equal(T.validate(custom).ok, true, T.validate(custom).errors.join("; "));

  assert.throws(() => T.fromBill({ utilityId: "nope", planId: "x" }, lib), /unknown utility/);
  assert.throws(() => T.fromBill({ utilityId: "sce", planId: "nope" }, lib), /unknown plan/);
});

/* --------------------------------------------------------------- SCE bill replay */

test("SCE bill replay: pure-tariff calculation reproduces $749.41", () => {
  const t = utilities.sce;
  const bv = t.meta.bill_validation;
  assert.ok(bv, "sce.json lost meta.bill_validation");

  const p = T.plan(t, bv.plan);
  const prov = bv.provider;
  const days = bv.billing_period.days;

  // The exact metered kWh by period, from meta.bill_validation.model_reproduces_bill.method.
  const kwh = { on: 436.488, mid: 175.596, off: 1361.73 };
  const totalKwh = bv.kwh.total;

  let energy = 0;
  for (const period of Object.keys(kwh)) {
    energy += kwh[period] * p.rates.summer[period][prov];
  }
  const fixed = days * T.fixedChargePerDay(t, p);
  const gms = bv.generation_municipal_surcharge_factor * bv.cpa_side.generation.total;
  const ccaSurcharge = bv.cpa_energy_surcharge_per_kwh * totalKwh;
  const credit = T.climateCredit(t).amount;

  const total = energy + fixed + gms + ccaSurcharge - credit;

  close(total, bv.model_reproduces_bill.model_total, 0.01, "model total");
  close(total, bv.total_new_charges, 0.05, "actual bill");
  close(total, 749.41, 0.01, "the headline number");

  // The individual rates the bill printed must still be in the file verbatim.
  close(p.rates.summer.on[prov], 0.66603, 1e-9, "summer on");
  close(p.rates.summer.mid[prov], 0.43183, 1e-9, "summer mid");
  close(p.rates.summer.off[prov], 0.28907, 1e-9, "summer off");
  close(T.fixedChargePerDay(t, p), 0.76862, 1e-9, "base services charge");

  // And the period lookup agrees with how the bill was read: a summer weekday
  // at 5 p.m. is on-peak, at noon off-peak, a summer Sunday at 5 p.m. mid-peak.
  assert.equal(T.periodAt(p, "2026-07-29", 17).period, "on");     // Wednesday
  assert.equal(T.periodAt(p, "2026-07-29", 12).period, "off");
  assert.equal(T.periodAt(p, "2026-08-02", 17).period, "mid");    // Sunday
});

/* -------------------------------------------------------------------- describe */

test("describe produces usable plain language for every plan", () => {
  for (const id of ids) {
    const t = utilities[id];
    for (const p of t.plans) {
      const d = T.describe(t, p);
      assert.ok(d.title.includes(t.utility.name), id + "/" + p.id + " title");
      assert.ok(d.text.length > 200, id + "/" + p.id + " description too short");
      assert.ok(d.table.length >= 2, id + "/" + p.id + " needs at least two priced periods");
      assert.ok(/holiday/i.test(d.text), id + "/" + p.id + " must mention holidays");
      assert.ok(/Net Billing Tariff/i.test(d.text), id + "/" + p.id + " must mention NBT");
      for (const row of d.table) {
        assert.ok(typeof row.rate === "number" && row.rate > 0,
          id + "/" + p.id + " " + row.season + "." + row.period + " has no rate");
        assert.ok(row.weekday || row.weekend, id + "/" + p.id + " " + row.period + " has no window");
      }
    }
  }
});

/* ------------------------------------------------------------- misc accessors */

test("fixed charge, climate credit, NSC and NBC are real values everywhere", () => {
  for (const id of ids) {
    const t = utilities[id];
    const p = T.defaultPlan(t);
    const fixed = T.fixedChargePerDay(t, p);
    assert.ok(fixed >= 0 && fixed < 3, id + " fixed charge $" + fixed + "/day");
    const cc = T.climateCredit(t);
    assert.ok(cc.annual > 0 && cc.annual < 500, id + " climate credit " + cc.annual);
    assert.ok(T.netSurplusRate(t) > 0 && T.netSurplusRate(t) < 0.2, id + " NSC");
    assert.ok(T.nonBypassablePerKwh(t) >= 0 && T.nonBypassablePerKwh(t) < 0.1, id + " NBC");
    assert.ok(T.accPlusAdder(t) >= 0 && T.accPlusAdder(t) < 0.2, id + " ACC Plus");
  }
});

test("every file records provenance", () => {
  for (const id of ids) {
    const t = utilities[id];
    assert.match(t.meta.rates_effective, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.ok(t.meta.sources.length >= 3, id + " has only " + t.meta.sources.length + " sources");
    for (const s of t.meta.sources) assert.ok(s.url && s.used_for, id + " source " + s.title);
    assert.ok(t.meta.confidence, id + " has no meta.confidence");
    assert.ok(t.meta.notes && t.meta.notes.length > 400, id + " meta.notes is too thin");
  }
});
