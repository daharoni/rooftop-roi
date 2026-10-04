/* core/pv.js — run with: node --test tests/
 *
 * Everything here is offline except the last block, which compares the JS model against
 * tests/fixtures/solar-agoura-hills.json. Three of the eleven reference years ship as a
 * compressed weather fixture so that comparison runs with no network at all; the full
 * eleven-year comparison runs only when a weather cache or the network is available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BIAS_CORRECTIONS,
  DEFAULTS,
  acFromPoa,
  annualTotal,
  hourlyProfile,
  monthlyTotals,
  orientationFactor,
  poaHdkr,
  profilesForPlane,
  resolveBias,
  shadeFactor,
  solarPosition,
} from "../core/pv.js";
import {
  DAY_OF_HOUR,
  MONTH_OF_HOUR,
  standardHourStartsUtc,
  toWeatherYear,
  weatherYearFromArrays,
} from "../core/weather.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const SITE = { lat: 34.15, lon: -118.75, elevationM: 280 };
const PST = -8 * 3600;

// ---------------------------------------------------------------------------
// Solar position
// ---------------------------------------------------------------------------

/** Scan a UTC day at one-minute steps and return the highest solar position found. */
function noonScan(dayUtcMs, lat, lon) {
  let best = null;
  for (let m = 0; m < 1440; m++) {
    const p = solarPosition(dayUtcMs + m * 60000, lat, lon);
    if (!best || p.elevation > best.elevation) best = { ...p, minuteUtc: m };
  }
  return best;
}

test("solar position: the sun is overhead at the equator at noon on the equinox", () => {
  // March equinox 2021 fell at 09:37 UTC on the 20th; by local solar noon at lon 0 the
  // declination is still within ~0.1 deg of zero, so the sun reaches the zenith.
  const p = noonScan(Date.UTC(2021, 2, 20), 0, 0);
  assert.ok(p.elevation > 89.85, `peak elevation ${p.elevation.toFixed(3)} should be ~90`);
  assert.ok(Math.abs(p.declination) < 0.25, `declination ${p.declination.toFixed(3)} ~ 0`);
  // Solar noon at lon 0 is 12:00 UTC shifted by the equation of time (about -7.5 min in
  // late March), never by more than ~17 minutes anywhere in the year.
  assert.ok(Math.abs(p.minuteUtc - 720) < 17, `solar noon at UTC minute ${p.minuteUtc}`);
  assert.ok(Math.abs(p.hourAngle) < 0.2, `hour angle ${p.hourAngle.toFixed(3)} ~ 0 at noon`);
});

test("solar position: equinox sunrise/sunset are due east and due west", () => {
  // At the equator on the equinox the sun rises due east (az 90) and sets due west (270).
  const day = Date.UTC(2021, 2, 20);
  let rise = null;
  let set = null;
  for (let m = 0; m < 1440; m++) {
    const p = solarPosition(day + m * 60000, 0, 0);
    if (!rise && p.elevation > 0) rise = p;
    if (rise && !set && p.elevation < 0) set = solarPosition(day + (m - 1) * 60000, 0, 0);
  }
  assert.ok(Math.abs(rise.azimuth - 90) < 1.5, `sunrise azimuth ${rise.azimuth.toFixed(2)}`);
  assert.ok(Math.abs(set.azimuth - 270) < 1.5, `sunset azimuth ${set.azimuth.toFixed(2)}`);
  // Refraction lifts the apparent sunrise ~0.5 deg above the geometric one.
  assert.ok(rise.elevation >= 0 && rise.elevation < 0.6, `apparent elevation ${rise.elevation}`);
});

test("solar position: solar noon at the reference site is a few minutes before 12:00 PST", () => {
  // lon -118.75 sits 1.25 deg east of the 120 deg W standard meridian, i.e. about 5
  // minutes of clock time early, plus the equation of time.
  const junePeak = noonScan(Date.UTC(2021, 5, 21, 8), SITE.lat, SITE.lon); // PST day start
  const minuteOfPstDay = junePeak.minuteUtc; // the scan starts at 00:00 PST
  assert.ok(
    Math.abs(minuteOfPstDay - 720) < 25,
    `solar noon at PST minute ${minuteOfPstDay} (expected within 25 min of 12:00)`,
  );
});

test("solar position: solstice noon elevations at the reference site", () => {
  // Solar noon at lon -118.75 is about 12:04 UTC-8 -> 20:04 UTC (equation of time aside).
  const summer = solarPosition(Date.UTC(2021, 5, 21, 19, 55), SITE.lat, SITE.lon);
  const winter = solarPosition(Date.UTC(2021, 11, 21, 20, 5), SITE.lat, SITE.lon);
  // 90 - lat +- obliquity = 79.3 / 32.4 degrees
  assert.ok(Math.abs(summer.elevation - 79.3) < 1.0, `June ${summer.elevation.toFixed(2)}`);
  assert.ok(Math.abs(winter.elevation - 32.4) < 1.0, `December ${winter.elevation.toFixed(2)}`);
  assert.ok(Math.abs(summer.azimuth - 180) < 3, `June noon azimuth ${summer.azimuth.toFixed(1)}`);
});

test("solar position: southern hemisphere noon sun is in the north", () => {
  const p = solarPosition(Date.UTC(2021, 5, 21, 2, 0), -33.87, 151.21); // Sydney, ~noon AEST
  assert.ok(p.elevation > 0 && p.elevation < 40, `elevation ${p.elevation.toFixed(1)}`);
  assert.ok(Math.abs(p.azimuth - 0) < 8 || Math.abs(p.azimuth - 360) < 8, `azimuth ${p.azimuth}`);
});

test("solar position: extraterrestrial normal irradiance peaks at perihelion", () => {
  const jan = solarPosition(Date.UTC(2021, 0, 3, 12, 0), 0, 0).e0n;
  const jul = solarPosition(Date.UTC(2021, 6, 4, 12, 0), 0, 0).e0n;
  assert.ok(jan > jul, "January (perihelion) beats July (aphelion)");
  assert.ok(jan > 1400 && jan < 1420, `${jan.toFixed(1)} W/m2`);
});

// ---------------------------------------------------------------------------
// Calendar: 8760, Feb 29 dropped, local standard time
// ---------------------------------------------------------------------------

test("calendar: 8760 slots and Feb 29 is dropped even in a leap year", () => {
  assert.equal(MONTH_OF_HOUR.length, 8760);
  const marchFirst = 59 * 24; // 31 (Jan) + 28 (Feb) days
  assert.equal(MONTH_OF_HOUR[marchFirst], 3);
  assert.equal(DAY_OF_HOUR[marchFirst], 1);
  assert.equal(MONTH_OF_HOUR[marchFirst - 1], 2);
  assert.equal(DAY_OF_HOUR[marchFirst - 1], 28);

  const starts = standardHourStartsUtc(2020, PST); // 2020 IS a leap year
  const feb28 = new Date(starts[58 * 24] - PST * 1000);
  const mar01 = new Date(starts[59 * 24] - PST * 1000);
  assert.equal(feb28.toISOString().slice(0, 10), "2020-02-28");
  assert.equal(mar01.toISOString().slice(0, 10), "2020-03-01"); // Feb 29 skipped
  assert.equal(starts.length, 8760);
});

test("calendar: hour slots are local STANDARD time, with no DST shift", () => {
  const starts = standardHourStartsUtc(2021, PST);
  // Slot (dayOfYear-1)*24 + 12 must be 12:00 PST = 20:00 UTC in both January and July.
  for (const doy of [10, 190]) {
    const d = new Date(starts[(doy - 1) * 24 + 12]);
    assert.equal(d.getUTCHours(), 20, `day ${doy}: 12:00 PST is 20:00 UTC year round`);
  }
});

// ---------------------------------------------------------------------------
// Transposition and module physics
// ---------------------------------------------------------------------------

test("poaHdkr: night and dark hours give zero", () => {
  assert.equal(poaHdkr(0, 0, 0, -10, 90, 1367, 20, 180).poa, 0);
  assert.equal(poaHdkr(100, 500, 50, -0.5, 90, 1367, 20, 180).poa, 0);
});

test("poaHdkr: a tilted south plane beats horizontal in winter at 34N", () => {
  // Winter noon: elevation ~32 deg, sun due south.
  const args = [700, 900, 90, 32.4, 180, 1410];
  const flat = poaHdkr(...args, 0, 180).poa;
  const tilted = poaHdkr(...args, 30, 180).poa;
  assert.ok(tilted > flat * 1.2, `tilted ${tilted.toFixed(0)} vs flat ${flat.toFixed(0)}`);
});

test("poaHdkr: the incidence-angle modifier only ever reduces the beam", () => {
  const p = poaHdkr(700, 900, 90, 20, 120, 1410, 20, 180, { b0: 0.05 });
  const noIam = poaHdkr(700, 900, 90, 20, 120, 1410, 20, 180, { b0: 0, iamDiffuse: 1 });
  assert.ok(p.poa < noIam.poa && p.poa > noIam.poa * 0.85);
  assert.ok(p.aoi > 0 && p.aoi < 90);
});

test("acFromPoa: inverter clipping caps output at 1/dcAcRatio", () => {
  const hot = acFromPoa(1400, 20, 5, { dcAcRatio: 1.2 });
  assert.ok(hot <= 1 / 1.2 + 1e-12, `${hot} must not exceed 0.8333`);
  assert.ok(hot > 0.83, "a 1400 W/m2 hour should actually clip");
  assert.equal(acFromPoa(0, 25, 3), 0);
});

test("acFromPoa: the temperature coefficient costs output on hot days", () => {
  const cool = acFromPoa(800, 10, 10);
  const warm = acFromPoa(800, 35, 10);
  assert.ok(warm < cool, "35 C produces less than 10 C");
  // 25 K of ambient at -0.35 %/K is roughly a 9% loss.
  const drop = 1 - warm / cool;
  assert.ok(drop > 0.05 && drop < 0.13, `drop ${(drop * 100).toFixed(1)}%`);
});

test("acFromPoa: 1000 W/m2 at 25 C lands near the nameplate derate", () => {
  // Hand check: Tmod = 1000*exp(-2.98 - 0.0471*10) + 25 = 56.7 C, Tcell 57.7 C;
  // DC = 1 * (1 - 0.0035*32.7) = 0.886 kW/kW; x 0.86 losses = 0.762; the part-load
  // inverter curve at zeta = 0.88 gives eta = 0.926 -> 0.706 kWh/kW.
  const v = acFromPoa(1000, 25, 10, DEFAULTS);
  assert.ok(Math.abs(v - 0.706) < 0.01, `${v.toFixed(3)} kWh/kW, expected ~0.706`);
});

// ---------------------------------------------------------------------------
// Synthetic clear-sky sky: three days, fully offline
// ---------------------------------------------------------------------------

const JUNE_DAY0 = 172; // June 21 in a 365-day calendar
const DEC_DAY0 = 355; // December 21

/**
 * ASHRAE clear-sky irradiance for a few named windows of a year. Everything outside the
 * windows stays dark, which makes the arithmetic in the assertions checkable by hand.
 */
function clearSkyYear({
  windows = [{ doy0: JUNE_DAY0, days: 3 }],
  lat = SITE.lat,
  lon = SITE.lon,
  tamb = 20,
  wind = 5,
} = {}) {
  const wy = weatherYearFromArrays({
    year: 2021,
    tz: "Etc/GMT+8",
    utcOffsetSeconds: PST,
    lat,
    lon,
    elevation: 280,
  });
  const starts = standardHourStartsUtc(2021, PST);
  const A = 1160, B = 0.18, C = 0.1; // ASHRAE clear-sky coefficients
  for (const { doy0, days } of windows) {
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const i = (doy0 - 1 + d) * 24 + h;
        const p = solarPosition(starts[i] + 1800000, lat, lon);
        if (p.elevation <= 0) continue;
        const cosz = Math.cos(((90 - p.elevation) * Math.PI) / 180);
        const am = 1 / Math.max(cosz, 0.05);
        const dni = A * Math.exp(-B * am);
        const dhi = C * dni;
        wy.dni[i] = dni;
        wy.dhi[i] = dhi;
        wy.ghi[i] = dni * cosz + dhi;
        wy.temp[i] = tamb;
        wy.wind[i] = wind;
      }
    }
  }
  return { wy, starts };
}

/** Both solstice windows — used wherever a seasonal contrast matters. */
const solsticeSky = (opts = {}) =>
  clearSkyYear({
    windows: [{ doy0: JUNE_DAY0, days: 3 }, { doy0: DEC_DAY0, days: 3 }],
    ...opts,
  });

test("synthetic clear sky: three June days give plausible daily yields", () => {
  const { wy } = clearSkyYear();
  const p = hourlyProfile(wy, { ...SITE, tilt: 20, azimuth: 180, biasCorrection: "none" });
  const daily = [];
  for (let d = 0; d < 3; d++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += p[(171 + d) * 24 + h];
    daily.push(s);
  }
  for (const v of daily)
    assert.ok(v > 4.5 && v < 8.0, `clear June day = ${v.toFixed(2)} kWh/kW (expect 4.5-8)`);
  // The three days are the same synthetic sky, so they must agree closely.
  assert.ok(Math.abs(daily[0] - daily[2]) < 0.1, "consecutive identical skies agree");
  // Nothing outside the three days.
  assert.ok(Math.abs(annualTotal(p) - (daily[0] + daily[1] + daily[2])) < 1e-9);
});

test("synthetic clear sky: production is zero at night and peaks near solar noon", () => {
  const { wy } = solsticeSky();
  const p = hourlyProfile(wy, { ...SITE, biasCorrection: "none" });
  // Local STANDARD time, so the peak sits at hour 11-12 in June as well as in December:
  // there is no daylight-saving shift in these profiles.
  for (const day0 of [JUNE_DAY0 - 1, DEC_DAY0 - 1]) {
    const day = day0 * 24;
    let best = -1, bestH = -1;
    for (let h = 0; h < 24; h++) if (p[day + h] > best) { best = p[day + h]; bestH = h; }
    assert.ok(bestH >= 11 && bestH <= 12, `peak at standard hour ${bestH}, expected 11-12`);
    for (const h of [0, 1, 2, 3, 22, 23]) assert.equal(p[day + h], 0, `hour ${h} is dark`);
  }
});

test("synthetic clear sky: hotter ambient costs output", () => {
  const o = { ...SITE, tilt: 20, azimuth: 180, biasCorrection: "none" };
  const base = annualTotal(hourlyProfile(clearSkyYear().wy, o));
  const hot = annualTotal(hourlyProfile(clearSkyYear({ tamb: 40 }).wy, o));
  assert.ok(hot < base, `${hot.toFixed(2)} (40 C) < ${base.toFixed(2)} (20 C)`);
});

test("synthetic clear sky: south beats north over both solstices, but barely in June", () => {
  const wy = solsticeSky().wy;
  const o = { ...SITE, tilt: 30, biasCorrection: "none" };
  const m = (az) => monthlyTotals(hourlyProfile(wy, { ...o, azimuth: az }));
  const north = m(0);
  const south = m(180);
  assert.ok(south[11] > north[11] * 2.5, `December south ${south[11].toFixed(2)} vs north ${north[11].toFixed(2)}`);
  assert.ok(
    south[5] + south[11] > north[5] + north[11],
    "south wins on the two solstices combined",
  );
  // A tilted array in midsummer at 34N is nearly orientation-blind: the sun rises north
  // of east and sets north of west, so the June ratio is close to 1. This is a real
  // property of the geometry, not a modelling artefact.
  assert.ok(Math.abs(north[5] / south[5] - 1) < 0.1, `June north/south = ${(north[5] / south[5]).toFixed(3)}`);
});

test("hourlyProfile: no hour can exceed the inverter AC rating", () => {
  const { wy } = clearSkyYear({ tamb: 0 });
  const p = hourlyProfile(wy, { ...SITE, dcAcRatio: 1.4, biasCorrection: "none" });
  for (let i = 0; i < p.length; i++)
    assert.ok(p[i] <= 1 / 1.4 + 1e-12, `hour ${i} = ${p[i]} exceeds the 1.4 clip`);
});

test("hourlyProfile: returns a Float64Array of 8760 and needs coordinates", () => {
  const { wy } = clearSkyYear();
  const p = hourlyProfile(wy, { ...SITE });
  assert.ok(p instanceof Float64Array);
  assert.equal(p.length, 8760);
  const bare = weatherYearFromArrays({ year: 2021 });
  assert.throws(() => hourlyProfile(bare, {}), TypeError);
});

// ---------------------------------------------------------------------------
// Bias correction
// ---------------------------------------------------------------------------

test("bias correction: no regional table ships, so 'auto' is uncorrected everywhere", () => {
  // The SoCal table was removed 2026-10-03 (like for like, ERA5 is within ~1% of NSRDB at
  // the reference site; see BIAS_CORRECTIONS in core/pv.js).
  assert.deepEqual(Object.keys(BIAS_CORRECTIONS), []);
  assert.ok(Object.isFrozen(BIAS_CORRECTIONS));
  const id = (lat, lon) => resolveBias("auto", { lat, lon }).id;
  assert.equal(id(34.15, -118.75), "none"); // the reference site, formerly inside the box
  assert.equal(id(34.05, -118.25), "none"); // downtown LA
  assert.equal(id(34.2, -119.18), "none"); // Oxnard
  assert.equal(id(32.72, -117.16), "none"); // San Diego
  assert.equal(id(37.34, -121.89), "none"); // San Jose
  assert.equal(id(42.36, -71.06), "none"); // Boston
  assert.ok(resolveBias("auto", { lat: 34.15, lon: -118.75 }).factors.every((f) => f === 1));
  assert.equal(resolveBias("none", { lat: 34.15, lon: -118.75 }).id, "none");
  assert.throws(() => resolveBias("pvgis-nsrdb-socal", {}), RangeError); // gone, not silent
  assert.throws(() => resolveBias("no-such-table", {}), RangeError);
  assert.throws(() => resolveBias([1, 2, 3], {}), RangeError);
});

test("bias correction: the default model output equals the explicitly uncorrected one", () => {
  const { wy } = clearSkyYear();
  const auto = hourlyProfile(wy, { ...SITE });
  const none = hourlyProfile(wy, { ...SITE, biasCorrection: "none" });
  assert.deepEqual(Array.from(auto), Array.from(none));
});

test("wind: km/h weather is converted to m/s before the Sandia term", () => {
  // Same sky, wind given as 18 km/h and as 5 m/s: identical output.
  const { wy: kmh } = clearSkyYear({ wind: 18 });
  const { wy: ms } = clearSkyYear({ wind: 5 });
  ms.units = { ...ms.units, wind: "m/s" };
  const o = { ...SITE, biasCorrection: "none" };
  const a = annualTotal(hourlyProfile(kmh, o));
  const b = annualTotal(hourlyProfile(ms, o));
  assert.ok(Math.abs(a / b - 1) < 1e-12, `${a} vs ${b}`);
  // The prototype's bug (18 read as m/s) cooled the modules and over-produced by a few %.
  const bug = annualTotal(hourlyProfile({ ...kmh, units: { ...kmh.units, wind: "m/s" } }, o));
  const over = 100 * (bug / a - 1);
  assert.ok(over > 2 && over < 6, `unconverted wind over-produces by ${over.toFixed(2)}%`);
});

test("bias correction: a custom 12-factor array scales each month by exactly its factor", () => {
  const { wy } = clearSkyYear(); // June only
  const factors = [1, 1, 1, 1, 1, 1.0289, 1, 1, 1, 1, 1, 1];
  const off = monthlyTotals(hourlyProfile(wy, { ...SITE, biasCorrection: "none" }));
  const on = monthlyTotals(hourlyProfile(wy, { ...SITE, biasCorrection: factors }));
  assert.equal(resolveBias(factors).id, "custom");
  assert.ok(Math.abs(on[5] / off[5] - factors[5]) < 1e-9, `${on[5] / off[5]} vs ${factors[5]}`);
});

// ---------------------------------------------------------------------------
// profilesForPlane / orientationFactor / shadeFactor
// ---------------------------------------------------------------------------

test("profilesForPlane: percentiles follow the exceedance convention", () => {
  const years = [2019, 2020, 2021].map((year, k) => {
    const { wy } = clearSkyYear({ tamb: 10 + k * 15 }); // hotter year = less output
    wy.year = year;
    return wy;
  });
  const sp = profilesForPlane(years, { tilt: 20, azimuth: 180, id: "p1" }, SITE);
  assert.deepEqual(sp.years, ["2019", "2020", "2021"]);
  assert.ok(sp.profiles.tmy instanceof Float64Array);
  assert.equal(Object.keys(sp.profiles).length, 4);
  assert.ok(sp.percentiles.p90 <= sp.percentiles.p50, "P90 is the LOW year");
  assert.ok(sp.percentiles.p50 <= sp.percentiles.p10, "P10 is the HIGH year");
  assert.equal(sp.percentiles.p10Year, "2019"); // coolest -> highest yield
  assert.equal(sp.percentiles.p90Year, "2021");
  assert.equal(sp.planeId, "p1");
  assert.equal(sp.model.tempCoeff, -0.0035);
  assert.equal(sp.model.losses, 0.14);
});

test("profilesForPlane: the TMY is a per-month median-year splice", () => {
  const years = [2019, 2020, 2021].map((year, k) => {
    const { wy } = clearSkyYear({ tamb: 10 + k * 15 });
    wy.year = year;
    return wy;
  });
  const sp = profilesForPlane(years, { tilt: 20, azimuth: 180 }, SITE);
  // Only June has production here, so every TMY month must name one of the three years
  // and June must name the median (2020).
  assert.equal(sp.tmySources[6], "2020");
  for (let m = 1; m <= 12; m++) assert.ok(sp.years.includes(sp.tmySources[m]));
  // Spliced hours come verbatim from the chosen year.
  const i = 172 * 24 + 12;
  assert.equal(sp.profiles.tmy[i], sp.profiles["2020"][i]);
  assert.ok(sp.annualPerKw.tmy > 0);
});

test("orientationFactor: identity is 1.0, and winter punishes an east-facing roof", () => {
  const { wy } = solsticeSky();
  const same = orientationFactor(SITE, 20, 180, 20, 180, wy);
  assert.equal(same[5], 1);
  assert.equal(same[11], 1);
  assert.equal(same.length, 12);
  const east = orientationFactor(SITE, 20, 90, 20, 180, wy);
  assert.ok(east[11] < 0.8 && east[11] > 0.4, `December east/south = ${east[11].toFixed(3)}`);
  const flat = orientationFactor(SITE, 0, 180, 20, 180, wy);
  assert.ok(flat[11] < 0.85, `December flat/tilted = ${flat[11].toFixed(3)}`);
  // Months with no sun in this synthetic year return 0, not NaN.
  assert.equal(east[0], 0);
  // Bias corrections cancel in the ratio.
  const biased = orientationFactor({ ...SITE, biasCorrection: [0.9, 1.1, 1, 1, 1, 1.05, 1, 1, 1, 1, 1, 0.97] }, 20, 90, 20, 180, wy);
  assert.ok(Math.abs(biased[11] - east[11]) < 1e-12);
});

test("shadeFactor: annual and monthly forms both return retained fractions", () => {
  assert.deepEqual(shadeFactor({}), { annual: 1, monthly: new Array(12).fill(1), kind: "none" });
  const a = shadeFactor({ shading: { annual: 0.12 } });
  assert.equal(a.kind, "annual");
  assert.ok(Math.abs(a.annual - 0.88) < 1e-12);
  assert.ok(a.monthly.every((v) => Math.abs(v - 0.88) < 1e-12));
  const m = shadeFactor({ shading: { monthly: [0.3, 0.3, 0.2, 0.1, 0, 0, 0, 0, 0.1, 0.2, 0.3, 0.35] } });
  assert.equal(m.kind, "monthly");
  assert.ok(Math.abs(m.monthly[0] - 0.7) < 1e-12);
  assert.ok(m.annual > 0.85 && m.annual < 0.93, `annual equivalent ${m.annual}`);
});

// ---------------------------------------------------------------------------
// Validation against tests/fixtures/solar-agoura-hills.json
// ---------------------------------------------------------------------------

const ANNUAL_TOL_PCT = 3;
const MONTHLY_TOL_PCT = 10;

// The fixture is the PROTOTYPE's output, which fed km/h wind into the m/s Sandia term and
// used the yield-fitted bias table below. Replaying exactly that (a weather year flagged
// as m/s skips the conversion) must still reproduce it — that pins every other link of
// the chain. The fixed model is then checked against the fixture at the expected offset.
const PROTOTYPE_BIAS = [1.022, 0.967, 1.0378, 1.0002, 1.0379, 1.0311, 1.014, 1.0531, 1.0134, 0.9926, 1.0034, 0.984];
const asPrototype = (wy) => ({ ...wy, units: { ...wy.units, wind: "m/s" } });
// Fixed wind (-3.1..-3.6%/yr) and no bias table (the prototype's table added ~+1.5%/yr):
// the fixed model sits 4.5-5.0% below the prototype each year (2015/16 -5.2/-5.4%, a
// further 0.6-0.7% from the upstream ERA5 revision of those years). Measured 2026-10-03:
// -4.46% (2023) .. -5.38% (2016).
const FIXED_VS_PROTOTYPE_PCT = [-6.0, -4.0];

function loadFixtureWeather() {
  const file = path.join(FIXTURES, "weather-agoura-hills.json.gz");
  if (!fs.existsSync(file)) return null;
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  return Object.entries(fx.years).map(([year, y]) => {
    const time = new Array(y.n);
    const t0 = Date.parse(y.t0 + ":00Z");
    for (let i = 0; i < y.n; i++)
      time[i] = new Date(t0 + i * 3600000).toISOString().slice(0, 16);
    return toWeatherYear(
      {
        ...y.meta,
        hourly: {
          time,
          shortwave_radiation: y.ghi,
          direct_normal_irradiance: y.dni,
          diffuse_radiation: y.dhi,
          direct_radiation: y.bhi,
          temperature_2m: y.tempX10.map((v) => v / 10),
          wind_speed_10m: y.windX10.map((v) => v / 10),
        },
      },
      { year: Number(year), lat: SITE.lat, lon: SITE.lon },
    );
  });
}

function fixtureMonthly(profile) {
  const m = new Array(12).fill(0);
  for (let i = 0; i < 8760; i++) m[MONTH_OF_HOUR[i] - 1] += profile[i];
  return m;
}

function compareToFixture(t, weatherYears, label) {
  const ref = JSON.parse(fs.readFileSync(path.join(FIXTURES, "solar-agoura-hills.json"), "utf8"));
  const rows = [];
  let worstAnnual = 0;
  let worstMonthly = 0;
  for (const wy of weatherYears) {
    const key = String(wy.year);
    const refAnnual = ref.meta.annual_kwh_per_kw[key];
    // The fixed model (the default chain at this site) against the prototype.
    const fixed = annualTotal(hourlyProfile(wy, { ...SITE, tilt: 20, azimuth: 180 }));
    const dF = 100 * (fixed / refAnnual - 1);
    assert.ok(
      dF >= FIXED_VS_PROTOTYPE_PCT[0] && dF <= FIXED_VS_PROTOTYPE_PCT[1],
      `${key}: fixed model ${fixed.toFixed(1)} is ${dF.toFixed(2)}% from the prototype, expected ${FIXED_VS_PROTOTYPE_PCT.join("..")}%`,
    );

    const mine = hourlyProfile(asPrototype(wy), { ...SITE, tilt: 20, azimuth: 180, biasCorrection: PROTOTYPE_BIAS });
    const annual = annualTotal(mine);
    const dA = 100 * (annual / refAnnual - 1);

    const mm = monthlyTotals(mine);
    const refM = fixtureMonthly(ref.profiles[key]);
    let wm = 0;
    let wmMonth = 0;
    for (let k = 0; k < 12; k++) {
      const d = 100 * (mm[k] / refM[k] - 1);
      if (Math.abs(d) > Math.abs(wm)) { wm = d; wmMonth = k + 1; }
    }
    rows.push(`  ${key}  prototype replay ${annual.toFixed(1)} vs ${refAnnual}  ${dA.toFixed(2)}%   worst month ${wmMonth}: ${wm.toFixed(2)}%   fixed model ${fixed.toFixed(1)} (${dF.toFixed(2)}%)`);
    if (Math.abs(dA) > Math.abs(worstAnnual)) worstAnnual = dA;
    if (Math.abs(wm) > Math.abs(worstMonthly)) worstMonthly = wm;

    assert.ok(
      Math.abs(dA) <= ANNUAL_TOL_PCT,
      `${key} annual off by ${dA.toFixed(2)}% (limit ${ANNUAL_TOL_PCT}%)`,
    );
    assert.ok(
      Math.abs(wm) <= MONTHLY_TOL_PCT,
      `${key} month ${wmMonth} off by ${wm.toFixed(2)}% (limit ${MONTHLY_TOL_PCT}%)`,
    );
  }
  t.diagnostic(`${label}\n${rows.join("\n")}\n  worst annual ${worstAnnual.toFixed(2)}%, worst monthly ${worstMonthly.toFixed(2)}%`);
}

test("fixture: the JS model reproduces the reference profiles (3 stored years, offline)", (t) => {
  const wys = loadFixtureWeather();
  if (!wys) {
    t.skip("tests/fixtures/weather-agoura-hills.json.gz is missing");
    return;
  }
  compareToFixture(t, wys, "offline 3-year fixture comparison (kWh/kW):");
});

test("fixture: eleven-year comparison (needs the weather cache or the network)", { skip: process.env.SKIP_LIVE ? "SKIP_LIVE set" : false }, async (t) => {
  const { fetchYears, fileCache, WeatherUnavailableError } = await import("../core/weather.js");
  // Kept out of the repo on purpose: eleven years is ~3.7 MB of JSON.
  const dir =
    process.env.ROOFTOP_ROI_WEATHER_CACHE || path.join(os.tmpdir(), "rooftop-roi-weather");
  const years = Array.from({ length: 11 }, (_, i) => 2015 + i);
  let wys;
  try {
    wys = await fetchYears({
      lat: SITE.lat,
      lon: SITE.lon,
      years,
      elevationM: SITE.elevationM,
      cache: fileCache({ dir }),
    });
  } catch (err) {
    assert.ok(err instanceof WeatherUnavailableError, "weather failures must be typed");
    t.skip(
      `no weather cache in ${dir} and no network (${err.code}). Populate it with ` +
        `ROOFTOP_ROI_WEATHER_CACHE=${dir} node --test tests/ while online.`,
    );
    return;
  }
  compareToFixture(t, wys, "full 11-year comparison (kWh/kW):");

  const refPct = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "solar-agoura-hills.json"), "utf8"),
  ).meta.percentiles;
  // Percentile years: the prototype replay must pick exactly the prototype's years.
  const proto = profilesForPlane(wys.map(asPrototype), { tilt: 20, azimuth: 180 }, { ...SITE, biasCorrection: PROTOTYPE_BIAS });
  assert.equal(proto.percentiles.p10Year, refPct.p10_year);
  assert.equal(proto.percentiles.p50Year, refPct.p50_year);
  assert.equal(proto.percentiles.p90Year, refPct.p90_year);
  // The fixed model (uncorrected): same low year; 2015/2016 are a 0.1% near-tie for P10 and
  // 2017/2018 a 0.1% near-tie for P50, so those may flip. 11-year mean 1548.8 kWh/kW
  // (2026-10-03), inside the reviewers' PVWatts-style band of 1,514-1,668.
  const sp = profilesForPlane(wys, { tilt: 20, azimuth: 180 }, SITE);
  assert.equal(sp.model.biasCorrection, "none");
  assert.ok(["2017", "2018"].includes(sp.percentiles.p50Year), `P50 ${sp.percentiles.p50Year}`);
  assert.equal(sp.percentiles.p90Year, refPct.p90_year);
  assert.ok(["2015", "2016"].includes(sp.percentiles.p10Year));
  assert.ok(sp.percentiles.mean > 1514 && sp.percentiles.mean < 1668, `mean ${sp.percentiles.mean}`);
  assert.ok(Math.abs(sp.percentiles.mean / 1548.8 - 1) < 0.02, `mean ${sp.percentiles.mean} drifted from 1548.8`);
  const tmyDelta = 100 * (sp.annualPerKw.tmy / refPct.p50_kwh_per_kw - 1);
  t.diagnostic(
    `fixed model: mean ${sp.percentiles.mean}, TMY ${sp.annualPerKw.tmy} kWh/kW ` +
      `(prototype P50 ${refPct.p50_kwh_per_kw}, ${tmyDelta.toFixed(2)}%); P10/P50/P90 ` +
      `${sp.percentiles.p10Year}/${sp.percentiles.p50Year}/${sp.percentiles.p90Year}`,
  );
});

test("fixture: orientation factors match the reference grid (needs weather)", async (t) => {
  const wys = loadFixtureWeather();
  if (!wys) {
    t.skip("weather fixture missing");
    return;
  }
  const ref = JSON.parse(fs.readFileSync(path.join(FIXTURES, "solar-agoura-hills.json"), "utf8"));
  // The reference grid was computed on the TMY splice; a single median year is close
  // enough to check the orientation response to a few percent.
  const wy = wys.find((w) => w.year === 2017) || wys[0];
  let worst = 0;
  let worstKey = "";
  for (const [key, factors] of Object.entries(ref.orientation_factors)) {
    if (key === "note") continue;
    const m = /^tilt_(\d+)_az_(\d+)$/.exec(key);
    if (!m) continue;
    const mine = orientationFactor(SITE, Number(m[1]), Number(m[2]), 20, 180, wy);
    for (let k = 0; k < 12; k++) {
      const d = 100 * (mine[k] / factors[k] - 1);
      if (Math.abs(d) > Math.abs(worst)) { worst = d; worstKey = `${key} month ${k + 1}`; }
    }
  }
  t.diagnostic(`orientation grid worst deviation ${worst.toFixed(2)}% at ${worstKey}`);
  assert.ok(Math.abs(worst) <= MONTHLY_TOL_PCT, `orientation factor off by ${worst.toFixed(2)}%`);
});

// ---------------------------------------------------------------------------
// Other California sites (live; skipped offline)
// ---------------------------------------------------------------------------

// Recorded 2026-10-03 from Open-Meteo 2015-2025, tilt 20 az 180, 14% losses, no bias table
// (these sites were always outside the removed SoCal box, so removing it moves nothing).
// "before" is the prototype's km/h-wind chain; PVGIS is v5.2 PVcalc on PVGIS-NSRDB with
// mountingplace=building, 14% loss — whose 14% INCLUDES the inverter, so a PVWatts-style
// chain (14% + 96% inverter + clipping) should land ~3-4% under it on identical sun.
// The band is +-2% around the recorded value: wide enough for upstream ERA5 revisions,
// tight enough to catch a units regression (which moves these by 3-4%).
const OUTSIDE_BOX = [
  { name: "San Jose", lat: 37.34, lon: -121.89, before: 1582.8, after: 1525.3, pvgis: 1555.4 },
  { name: "Sacramento", lat: 38.58, lon: -121.49, before: 1487.5, after: 1443.4, pvgis: 1541.0 },
];

test("live: San Jose and Sacramento sit below PVGIS-NSRDB with the fixed, uncorrected model", { skip: process.env.SKIP_LIVE ? "SKIP_LIVE set" : false }, async (t) => {
  const { fetchYears, fileCache, WeatherUnavailableError } = await import("../core/weather.js");
  const dir =
    process.env.ROOFTOP_ROI_WEATHER_CACHE || path.join(os.tmpdir(), "rooftop-roi-weather");
  const years = Array.from({ length: 11 }, (_, i) => 2015 + i);
  const rows = [];
  for (const s of OUTSIDE_BOX) {
    let wys;
    try {
      wys = await fetchYears({ lat: s.lat, lon: s.lon, years, cache: fileCache({ dir }) });
    } catch (err) {
      assert.ok(err instanceof WeatherUnavailableError, "weather failures must be typed");
      t.skip(`Open-Meteo unreachable (${err.code}) and ${s.name} is not cached in ${dir}`);
      return;
    }
    const sp = profilesForPlane(wys, { tilt: 20, azimuth: 180 }, { lat: s.lat, lon: s.lon });
    assert.equal(sp.model.biasCorrection, "none");
    const mean = sp.percentiles.mean;
    rows.push(`  ${s.name}: ${mean} kWh/kW (was ${s.before}; PVGIS-NSRDB ${s.pvgis}, ${(100 * (mean / s.pvgis - 1)).toFixed(2)}%)`);
    assert.ok(Math.abs(mean / s.after - 1) < 0.02, `${s.name} ${mean} drifted from ${s.after}`);
    assert.ok(mean < s.pvgis, `${s.name} ${mean} should sit below PVGIS-NSRDB ${s.pvgis}`);
    assert.ok(mean < s.before * 0.98, `${s.name} ${mean}: the wind fix should cost 3-4%`);
  }
  t.diagnostic(`other sites, 11-year mean:\n${rows.join("\n")}`);
});
