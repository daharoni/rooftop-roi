// core/pv.js — hourly PV production model (kWh AC per kW DC installed).
//
// A faithful JS port of docs/reference-pv-model.py, which was validated against PVGIS v5.2
// PVcalc driven by PVGIS-NSRDB (the satellite radiation family PVWatts uses) for the
// reference site: annual within 1.55%, every month within ~5% after the bias correction.
//
// Model chain (PVWatts-like, no dependencies):
//   NOAA solar position at the interval midpoint
//   -> HDKR transposition to the array plane (0.2 ground albedo)
//   -> ASHRAE b0 = 0.05 incidence-angle modifier on beam + circumsolar, 0.96 on the rest
//   -> Sandia roof-mount module temperature from ambient temperature and 10 m wind
//   -> linear temperature coefficient (default -0.35 %/degC)
//   -> flat system losses (default 14%)
//   -> PVWatts part-load inverter curve at 96% nominal, hard clipping at the DC/AC ratio
//   -> optional per-month bias correction onto PVGIS-NSRDB.
//
// Output indexing: Float64Array(8760), LOCAL STANDARD TIME (no DST),
// index = (dayOfYear-1)*24 + hour, Feb 29 dropped. See docs/solar-model.md.

import {
  HOURS,
  MONTH_OF_HOUR,
  offsetFromLongitude,
  standardHourStartsUtc,
} from "./weather.js";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const HALF_HOUR_MS = 1800000;

/** Model defaults — the validated reference configuration. */
export const DEFAULTS = {
  tilt: 20,
  azimuth: 180, // degrees clockwise from true north; 180 = due south
  losses: 0.14, // flat DC derate (soiling, wiring, mismatch, availability, ...)
  dcAcRatio: 1.2,
  invEff: 0.96,
  tempCoeff: -0.0035, // per degC
  albedo: 0.2,
  b0: 0.05, // ASHRAE incidence-angle modifier coefficient
  iamDiffuse: 0.96, // constant IAM on isotropic sky + ground-reflected diffuse
  sapm: { a: -2.98, b: -0.0471, dT: 1.0 }, // PVWatts array_type=1 (roof mount)
  biasCorrection: "auto",
};

/**
 * Per-month multiplicative bias corrections, model -> reference irradiance database.
 *
 * These are REGION SPECIFIC: they were fitted at the reference site (Agoura Hills, CA) by
 * dividing PVGIS-NSRDB monthly yields by this model's 11-year monthly means. They mostly
 * correct ERA5's known reanalysis bias against satellite irradiance in coastal southern
 * California (ERA5 misses the May/June marine layer burn-off and thin cirrus). Applying
 * them outside that climate would be guesswork, so `"auto"` restricts them to the box
 * they were fitted in. See docs/solar-model.md.
 */
export const BIAS_CORRECTIONS = {
  "pvgis-nsrdb-socal": {
    id: "pvgis-nsrdb-socal",
    factors: [1.022, 0.967, 1.0378, 1.0002, 1.0379, 1.0311, 1.014, 1.0531, 1.0134, 0.9926, 1.0034, 0.984],
    box: { latMin: 32.5, latMax: 35.6, lonMin: -120.6, lonMax: -116.0 },
    reference: "PVGIS v5.2 PVcalc, radiation_db=PVGIS-NSRDB, lat 34.145 lon -118.76, tilt 20 az 180",
  },
};

const NO_BIAS = new Float64Array(12).fill(1);

/**
 * Resolve the `biasCorrection` option to a 12-element factor array (all 1 = off).
 * Accepts "auto" | "none" | false | a key of BIAS_CORRECTIONS | a 12-number array.
 */
export function resolveBias(biasCorrection, site = {}) {
  if (biasCorrection == null || biasCorrection === false || biasCorrection === "none")
    return { factors: NO_BIAS, id: "none" };
  if (Array.isArray(biasCorrection) || ArrayBuffer.isView(biasCorrection)) {
    if (biasCorrection.length !== 12) throw new RangeError("biasCorrection array must have 12 entries");
    return { factors: Float64Array.from(biasCorrection), id: "custom" };
  }
  if (biasCorrection === "auto") {
    const { lat, lon } = site;
    for (const entry of Object.values(BIAS_CORRECTIONS)) {
      const b = entry.box;
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= b.latMin &&
        lat <= b.latMax &&
        lon >= b.lonMin &&
        lon <= b.lonMax
      )
        return { factors: Float64Array.from(entry.factors), id: entry.id };
    }
    return { factors: NO_BIAS, id: "none" };
  }
  const entry = BIAS_CORRECTIONS[biasCorrection];
  if (!entry) throw new RangeError(`Unknown biasCorrection "${biasCorrection}"`);
  return { factors: Float64Array.from(entry.factors), id: entry.id };
}

// ---------------------------------------------------------------------------
// Solar position (NOAA algorithm, as in the reference script)
// ---------------------------------------------------------------------------

/** Julian day for a UTC instant given as epoch milliseconds. */
export function julianDay(utcMs) {
  return utcMs / 86400000 + 2440587.5;
}

/**
 * Apparent solar position for a UTC instant.
 * @returns {{elevation:number, azimuth:number, e0n:number, declination:number,
 *            zenith:number, hourAngle:number}}
 *   elevation deg above the horizon (refraction-corrected), azimuth deg clockwise from
 *   true north, e0n = extraterrestrial normal irradiance W/m^2.
 */
export function solarPosition(utcMs, lat, lon) {
  const jd = julianDay(utcMs);
  const jc = (jd - 2451545.0) / 36525.0;
  const l0 = mod360(280.46646 + jc * (36000.76983 + jc * 0.0003032));
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c =
    Math.sin(m * D2R) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * m * D2R) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * m * D2R) * 0.000289;
  const trueLong = l0 + c;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * D2R);
  const meanObliq =
    23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
  const obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * D2R);
  const decl = Math.asin(Math.sin(obliq * D2R) * Math.sin(appLong * D2R)) * R2D;

  const vary = Math.tan((obliq / 2) * D2R) ** 2;
  const eqtime =
    4 *
    R2D *
    (vary * Math.sin(2 * l0 * D2R) -
      2 * e * Math.sin(m * D2R) +
      4 * e * vary * Math.sin(m * D2R) * Math.cos(2 * l0 * D2R) -
      0.5 * vary * vary * Math.sin(4 * l0 * D2R) -
      1.25 * e * e * Math.sin(2 * m * D2R));

  // Hour of the UTC day, as a fraction — the reference script's `hour_frac_utc`.
  const hourFracUtc = ((utcMs / 3600000) % 24 + 24) % 24;
  const tst = (((hourFracUtc * 60 + eqtime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 - 180;

  const latR = lat * D2R;
  const declR = decl * D2R;
  const cosz = clamp(
    Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(ha * D2R),
    -1,
    1,
  );
  const zen = Math.acos(cosz) * R2D;
  const elev = 90 - zen;

  let ref;
  if (elev > 85) ref = 0;
  else if (elev > 5) {
    const te = Math.tan(elev * D2R);
    ref = (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600;
  } else if (elev > -0.575) {
    ref = (1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))) / 3600;
  } else {
    ref = -20.772 / Math.tan(elev * D2R) / 3600;
  }
  const elevApp = elev + ref;

  let az;
  const denom = Math.cos(zen * D2R) * Math.sin(latR) - Math.sin(declR);
  if (Math.abs(Math.cos(latR) * Math.sin(zen * D2R)) < 1e-9) {
    az = 180;
  } else {
    const arg = denom / (Math.cos(latR) * Math.sin(zen * D2R));
    const a = Math.acos(clamp(arg, -1, 1)) * R2D;
    az = ha > 0 ? a + 180 : 180 - a;
  }
  az = mod360(az);

  const d = new Date(utcMs);
  const doy = (utcMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1;
  const e0n = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));

  return { elevation: elevApp, azimuth: az, e0n, declination: decl, zenith: zen, hourAngle: ha };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod360 = (v) => ((v % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Transposition + module
// ---------------------------------------------------------------------------

/**
 * Hay-Davies-Klucher-Reindl plane-of-array irradiance, incidence-angle modifier applied.
 * @returns {{beam:number, diffuse:number, poa:number, aoi:number}} W/m^2, aoi in degrees
 */
export function poaHdkr(ghi, dni, dhi, elevation, solarAz, e0n, tilt, azimuth, opts = {}) {
  const albedo = opts.albedo ?? DEFAULTS.albedo;
  const b0 = opts.b0 ?? DEFAULTS.b0;
  const iamDiffuse = opts.iamDiffuse ?? DEFAULTS.iamDiffuse;
  if (elevation <= 0 || ghi <= 0) return { beam: 0, diffuse: 0, poa: 0, aoi: 90 };

  const zenR = (90 - elevation) * D2R;
  const tR = tilt * D2R;
  const aR = azimuth * D2R;
  const cosAoi = clamp(
    Math.cos(zenR) * Math.cos(tR) + Math.sin(zenR) * Math.sin(tR) * Math.cos(solarAz * D2R - aR),
    -1,
    1,
  );
  const aoi = Math.acos(cosAoi) * R2D;
  const cosz = Math.max(Math.cos(zenR), 0.03); // limit Rb blow-up near sunrise/sunset
  const rb = Math.max(0, cosAoi) / cosz;

  let beam = Math.max(0, dni * cosAoi);
  const ai = e0n > 0 ? Math.min(1, dni / e0n) : 0;
  const bh = dni * Math.cos(zenR);
  const f = ghi > 0 ? Math.sqrt(Math.max(0, bh) / ghi) : 0;
  const iso = dhi * (1 - ai) * ((1 + Math.cos(tR)) / 2) * (1 + f * Math.sin(tR / 2) ** 3);
  let circ = dhi * ai * rb;
  const grnd = ghi * albedo * ((1 - Math.cos(tR)) / 2);

  let iam;
  if (aoi < 90) {
    iam = Math.max(0, 1 - b0 * (1 / Math.cos(Math.min(aoi, 89) * D2R) - 1));
  } else {
    iam = 0;
    beam = 0;
    circ = 0;
  }
  const beamOut = (beam + circ) * iam;
  const diffOut = (iso + grnd) * iamDiffuse;
  return { beam: beamOut, diffuse: diffOut, poa: beamOut + diffOut, aoi };
}

/**
 * kWh AC per kW DC for one hour at the given plane-of-array irradiance.
 * `wind` is 10 m wind speed in the units core/weather.js supplies (km/h — see docs).
 */
export function acFromPoa(poa, tamb, wind, opts = {}) {
  if (poa <= 0) return 0;
  const losses = opts.losses ?? DEFAULTS.losses;
  const dcAcRatio = opts.dcAcRatio ?? DEFAULTS.dcAcRatio;
  const invEff = opts.invEff ?? DEFAULTS.invEff;
  const gamma = opts.tempCoeff ?? DEFAULTS.tempCoeff;
  const sapm = opts.sapm ?? DEFAULTS.sapm;

  const tmod = poa * Math.exp(sapm.a + sapm.b * wind) + tamb;
  const tcell = tmod + (poa / 1000) * sapm.dT;
  let pdc = (poa / 1000) * (1 + gamma * (tcell - 25));
  pdc *= 1 - losses;
  if (pdc <= 0) return 0;

  const pac0 = 1 / dcAcRatio; // inverter AC rating, kW per kW DC
  const pdc0 = pac0 / invEff; // inverter rated DC input
  const zeta = pdc / pdc0;
  if (zeta <= 0) return 0;
  let eta = invEff * (-0.0162 * zeta - 0.0059 / Math.max(zeta, 0.01) + 0.9858);
  eta = clamp(eta, 0, 1);
  return Math.min(pdc * eta, pac0);
}

// ---------------------------------------------------------------------------
// Geometry cache (solar position does not depend on tilt/azimuth, so reuse it)
// ---------------------------------------------------------------------------

const geomCache = new WeakMap();

function geometryFor(weatherYear, lat, lon) {
  let byKey = geomCache.get(weatherYear);
  if (!byKey) geomCache.set(weatherYear, (byKey = new Map()));
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  let g = byKey.get(key);
  if (g) return g;

  const offset = Number.isFinite(weatherYear.utcOffsetSeconds)
    ? weatherYear.utcOffsetSeconds
    : offsetFromLongitude(lon);
  const starts = standardHourStartsUtc(weatherYear.year, offset);
  const elev = new Float64Array(HOURS);
  const az = new Float64Array(HOURS);
  const e0n = new Float64Array(HOURS);
  for (let i = 0; i < HOURS; i++) {
    // Irradiance is the mean over the hour, so evaluate the sun at the midpoint.
    const p = solarPosition(starts[i] + HALF_HOUR_MS, lat, lon);
    elev[i] = p.elevation;
    az[i] = p.azimuth;
    e0n[i] = p.e0n;
  }
  g = { elev, az, e0n, starts, offset };
  byKey.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/**
 * Hourly AC production for one weather year and one plane.
 *
 * @param {object} weatherYear  from core/weather.js — { year, ghi, dni, dhi, temp, wind, ... }
 * @param {object} opts { lat, lon, elevationM, tilt, azimuth, losses, dcAcRatio, invEff,
 *                        tempCoeff, albedo, b0, iamDiffuse, sapm, biasCorrection }
 * @returns {Float64Array} 8760 values, kWh AC per kW DC, local standard time
 */
export function hourlyProfile(weatherYear, opts = {}) {
  const lat = opts.lat ?? weatherYear.lat;
  const lon = opts.lon ?? weatherYear.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new TypeError("hourlyProfile needs { lat, lon } (on the options or the weather year)");
  const tilt = opts.tilt ?? DEFAULTS.tilt;
  const azimuth = opts.azimuth ?? DEFAULTS.azimuth;
  const bias = resolveBias(
    opts.biasCorrection === undefined ? DEFAULTS.biasCorrection : opts.biasCorrection,
    { lat, lon },
  ).factors;

  const g = geometryFor(weatherYear, lat, lon);
  const { ghi, dni, dhi, temp, wind } = weatherYear;
  const out = new Float64Array(HOURS);
  for (let i = 0; i < HOURS; i++) {
    const p = poaHdkr(ghi[i], dni[i], dhi[i], g.elev[i], g.az[i], g.e0n[i], tilt, azimuth, opts);
    if (p.poa <= 0) continue;
    const ac = acFromPoa(p.poa, temp[i], wind[i], opts);
    out[i] = ac * bias[MONTH_OF_HOUR[i] - 1];
  }
  return out;
}

/** Sum a profile into 12 calendar-month totals. */
export function monthlyTotals(profile) {
  const m = new Float64Array(12);
  for (let i = 0; i < HOURS; i++) m[MONTH_OF_HOUR[i] - 1] += profile[i];
  return m;
}

/** Sum of a profile (annual kWh per kW DC). */
export const annualTotal = (profile) => {
  let s = 0;
  for (let i = 0; i < profile.length; i++) s += profile[i];
  return s;
};

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * Solar-industry exceedance percentile over the modelled weather years: PXX is the annual
 * yield exceeded in XX% of years, so P90 is a LOW (conservative) year and P10 a high one.
 * `sorted` is ascending [value, yearKey] pairs.
 */
function pickExceedance(sorted, exceedance) {
  const p = 1 - exceedance;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Per-year profiles plus a synthetic TMY for one roof plane.
 *
 * TMY splice: for each calendar month, pick the actual modelled year whose production in
 * that month is closest to the 11-year median for that month, then stitch the 12 chosen
 * months together. This is the classic TMY selection reduced to a single (production)
 * index; it is a *synthetic* year and no single real year looks like it.
 *
 * Shading is NOT applied here — the engine applies `plane.shading` (see shadeFactor).
 *
 * @param {object[]} weatherYears
 * @param {object} plane  { tilt, azimuth, id? }
 * @param {object} site   { lat, lon, elevationM? } plus any model overrides
 * @returns {object} SolarProfiles per docs/ARCHITECTURE.md
 */
export function profilesForPlane(weatherYears, plane = {}, site = {}) {
  if (!Array.isArray(weatherYears) || !weatherYears.length)
    throw new TypeError("profilesForPlane needs at least one weather year");
  const tilt = plane.tilt ?? DEFAULTS.tilt;
  const azimuth = plane.azimuth ?? DEFAULTS.azimuth;
  const lat = site.lat ?? weatherYears[0].lat;
  const lon = site.lon ?? weatherYears[0].lon;
  const opts = { ...site, lat, lon, tilt, azimuth };
  const biasInfo = resolveBias(
    site.biasCorrection === undefined ? DEFAULTS.biasCorrection : site.biasCorrection,
    { lat, lon },
  );

  const profiles = {};
  const monthly = {};
  const annualPerKw = {};
  const keys = [];
  for (const wy of weatherYears) {
    const key = String(wy.year);
    const prof = hourlyProfile(wy, opts);
    profiles[key] = prof;
    monthly[key] = monthlyTotals(prof);
    annualPerKw[key] = round1(annualTotal(prof));
    keys.push(key);
  }

  // --- TMY: per-month median-year splice -----------------------------------
  const tmySources = {};
  for (let k = 0; k < 12; k++) {
    const med = median(keys.map((y) => monthly[y][k]));
    let best = keys[0];
    let bestD = Infinity;
    for (const y of keys) {
      const d = Math.abs(monthly[y][k] - med);
      if (d < bestD) {
        bestD = d;
        best = y;
      }
    }
    tmySources[k + 1] = best;
  }
  const tmy = new Float64Array(HOURS);
  for (let i = 0; i < HOURS; i++) tmy[i] = profiles[tmySources[MONTH_OF_HOUR[i]]][i];
  profiles.tmy = tmy;
  monthly.tmy = monthlyTotals(tmy);
  annualPerKw.tmy = round1(annualTotal(tmy));

  // --- exceedance percentiles over the real years only ---------------------
  const sorted = keys.map((y) => [annualPerKw[y], y]).sort((a, b) => a[0] - b[0]);
  const [p10v, p10y] = pickExceedance(sorted, 0.1);
  const [p50v, p50y] = pickExceedance(sorted, 0.5);
  const [p90v, p90y] = pickExceedance(sorted, 0.9);

  const values = keys.map((y) => annualPerKw[y]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    planeId: plane.id ?? null,
    tilt,
    azimuth,
    profiles,
    monthlyPerKw: Object.fromEntries(Object.entries(monthly).map(([k, v]) => [k, Array.from(v, round1)])),
    annualPerKw,
    years: keys,
    percentiles: {
      p10Year: p10y,
      p50Year: p50y,
      p90Year: p90y,
      p10: p10v,
      p50: p50v,
      p90: p90v,
      mean: round1(mean),
      convention:
        "solar-industry exceedance: P90 is the annual yield exceeded in 90% of years " +
        "(conservative, LOW), P50 the median, P10 the optimistic high year; empirical " +
        "order statistics of the modelled weather years",
    },
    tmySources,
    model: {
      losses: site.losses ?? DEFAULTS.losses,
      dcAcRatio: site.dcAcRatio ?? DEFAULTS.dcAcRatio,
      invEff: site.invEff ?? DEFAULTS.invEff,
      tempCoeff: site.tempCoeff ?? DEFAULTS.tempCoeff,
      albedo: site.albedo ?? DEFAULTS.albedo,
      biasCorrection: biasInfo.id,
      weatherSource: weatherYears[0].source ?? "open-meteo-archive-era5",
      notes:
        "NOAA solar position at the hour midpoint; HDKR transposition; ASHRAE b0=0.05 IAM; " +
        "Sandia roof-mount cell temperature; PVWatts part-load inverter curve with clipping. " +
        "kWh AC per kW DC, local standard time, 8760 hours, Feb 29 dropped. Shading is not " +
        "included — the engine applies plane.shading.",
    },
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Monthly yield multipliers for a different orientation, relative to a reference one.
 * Cheap enough for live UI previews (two 8760 passes, shared solar geometry).
 *
 * Bias corrections cancel in the ratio, so the result is independent of `biasCorrection`.
 *
 * @param {object} site        { lat, lon, ... model overrides }
 * @param {number} tilt
 * @param {number} azimuth
 * @param {number} [refTilt]
 * @param {number} [refAz]
 * @param {object} weatherYear a single weather year (the TMY-ish year is a good choice)
 * @returns {number[]} 12 multipliers, index 0 = January
 */
export function orientationFactor(
  site,
  tilt,
  azimuth,
  refTilt = DEFAULTS.tilt,
  refAz = DEFAULTS.azimuth,
  weatherYear,
) {
  if (!weatherYear) throw new TypeError("orientationFactor needs a weather year");
  const base = { ...site, biasCorrection: "none" };
  const a = monthlyTotals(hourlyProfile(weatherYear, { ...base, tilt, azimuth }));
  const b = monthlyTotals(hourlyProfile(weatherYear, { ...base, tilt: refTilt, azimuth: refAz }));
  const out = new Array(12);
  for (let k = 0; k < 12; k++) out[k] = b[k] ? a[k] / b[k] : 0;
  return out;
}

/**
 * Fraction of production RETAINED after shading, from `plane.shading`.
 * `{ annual: 0.12 }` -> 12% lost; `{ monthly: [...12 fractions lost] }` -> per month.
 *
 * @param {object} plane
 * @returns {{annual:number, monthly:number[], kind:"none"|"annual"|"monthly"}}
 */
export function shadeFactor(plane = {}) {
  const sh = plane.shading;
  if (!sh) return { annual: 1, monthly: new Array(12).fill(1), kind: "none" };
  if (Array.isArray(sh.monthly) && sh.monthly.length === 12) {
    const monthly = sh.monthly.map((lost) => clamp(1 - (Number(lost) || 0), 0, 1));
    // Weight the annual equivalent by a generic clear-sky-ish monthly shape so a single
    // number is still meaningful for headline copy; the engine should use `monthly`.
    const w = [0.062, 0.069, 0.087, 0.096, 0.100, 0.101, 0.104, 0.101, 0.090, 0.079, 0.063, 0.058];
    const annual = monthly.reduce((s, v, k) => s + v * w[k], 0) / w.reduce((s, v) => s + v, 0);
    return { annual, monthly, kind: "monthly" };
  }
  const lost = clamp(Number(sh.annual) || 0, 0, 1);
  return { annual: 1 - lost, monthly: new Array(12).fill(1 - lost), kind: "annual" };
}

export const HOURS_PER_YEAR = HOURS;
export { MONTH_OF_HOUR };

export default {
  BIAS_CORRECTIONS,
  DEFAULTS,
  HOURS_PER_YEAR,
  MONTH_OF_HOUR,
  acFromPoa,
  annualTotal,
  hourlyProfile,
  julianDay,
  monthlyTotals,
  orientationFactor,
  poaHdkr,
  profilesForPlane,
  resolveBias,
  shadeFactor,
  solarPosition,
};
