#!/usr/bin/env python3
"""
Build hourly solar production profiles (kWh AC per kW DC installed) for the site
-> build/solar.json + build/solar_summary.json

Data sources
  * Open-Meteo historical archive (ERA5, free, no key): GHI / DNI / DHI /
    temperature / wind, 2015-2025, hourly, downloaded to a local cache.
  * PVGIS v5.2 PVcalc (JRC, free, no key) using the PVGIS-NSRDB satellite
    radiation database - the same NSRDB family PVWatts uses - as the
    calibration/validation reference and for the monthly bias correction.
    (NREL PVWatts itself was unreachable: developer.nrel.gov has no DNS
    record from this network, so PVGIS-NSRDB stands in for it.)

Model chain (PVWatts-like, pure stdlib):
  NOAA solar position -> HDKR transposition to the array plane -> ASHRAE
  incidence-angle modifier -> Sandia roof-mount cell temperature -> linear
  temperature coefficient -> system losses -> PVWatts part-load inverter
  curve with clipping at the DC/AC ratio -> monthly bias correction to PVGIS.

Usage:  python3 scripts/build_solar.py
"""
import json
import math
import os
import statistics
import subprocess
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, "build")
# Downloaded weather / reference responses are cached here so the build is
# reproducible offline; delete the directory to force a fresh download.
CACHE_DIR = os.environ.get("SOLAR_CACHE", os.path.join(ROOT, "data", "cache"))

LAT, LON, ELEV = 34.145, -118.76, 280.0
UTC_OFFSET = -8              # local STANDARD time (PST), no DST
YEARS = list(range(2015, 2026))
DEFAULT_TILT, DEFAULT_AZ = 20.0, 180.0
LOSSES_PCT = 14.0
DC_AC_RATIO = 1.2
INV_EFF = 96.0
GAMMA = -0.0035              # -0.35 %/degC
ALBEDO = 0.2
# Sandia module-temperature coefficients, PVWatts array_type=1 (roof mount)
SAPM_A, SAPM_B, SAPM_DT = -2.98, -0.0471, 1.0
B0_ASHRAE = 0.05             # incidence-angle modifier coefficient
IAM_DIFFUSE = 0.96           # constant IAM applied to sky/ground diffuse
TILTS = [10, 15, 20, 25, 30, 35]
AZIMUTHS = [135, 150, 165, 180, 195, 210, 225]

D2R = math.pi / 180.0
R2D = 180.0 / math.pi


# --------------------------------------------------------------------------
# Weather cache
# --------------------------------------------------------------------------
def fetch_year(year, path):
    start = f"{year}-01-01"
    end = f"{year}-12-31" if year in YEARS else f"{year}-01-02"
    q = urllib.parse.urlencode({
        "latitude": LAT, "longitude": LON, "start_date": start, "end_date": end,
        "hourly": ("shortwave_radiation,direct_radiation,diffuse_radiation,"
                   "direct_normal_irradiance,temperature_2m,wind_speed_10m,"
                   "global_tilted_irradiance"),
        "tilt": 20, "azimuth": 0, "timezone": "GMT", "elevation": 280})
    url = "https://archive-api.open-meteo.com/v1/archive?" + q
    subprocess.run(["curl", "-sS", "-m", "180", url, "-o", path], check=True)


def load_weather():
    """Return {utc_hour_label_iso: (ghi, dni, dhi, tamb, wind, gti_ref)}."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    out = {}
    for year in YEARS + [2026]:
        name = f"{year}.json" if year in YEARS else "2026head.json"
        path = os.path.join(CACHE_DIR, name)
        if not os.path.exists(path) or os.path.getsize(path) < 1000:
            fetch_year(year, path)
        h = json.load(open(path))["hourly"]
        for i, t in enumerate(h["time"]):
            out[t] = (h["shortwave_radiation"][i] or 0.0,
                      h["direct_normal_irradiance"][i] or 0.0,
                      h["diffuse_radiation"][i] or 0.0,
                      h["temperature_2m"][i],
                      h["wind_speed_10m"][i] or 0.0,
                      h["global_tilted_irradiance"][i] or 0.0)
    return out


# --------------------------------------------------------------------------
# Solar geometry (NOAA algorithm)
# --------------------------------------------------------------------------
def julian_day(y, mo, d, hour_frac):
    if mo <= 2:
        y -= 1
        mo += 12
    a = y // 100
    b = 2 - a + a // 4
    return (math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (mo + 1))
            + d + b - 1524.5 + hour_frac / 24.0)


def solar_position(y, mo, d, hour_frac_utc):
    """Return (apparent elevation deg, azimuth deg from N, extraterrestrial
    normal irradiance W/m2) for a UTC instant."""
    jd = julian_day(y, mo, d, hour_frac_utc)
    jc = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    e = 0.016708634 - jc * (0.000042037 + 0.[id removed] * jc)
    c = (math.sin(m * D2R) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
         + math.sin(2 * m * D2R) * (0.019993 - 0.000101 * jc)
         + math.sin(3 * m * D2R) * 0.000289)
    true_long = l0 + c
    app_long = true_long - 0.00569 - 0.00478 * math.sin((125.04 - 1934.136 * jc) * D2R)
    mean_obliq = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0
    obliq = mean_obliq + 0.00256 * math.cos((125.04 - 1934.136 * jc) * D2R)
    decl = math.asin(math.sin(obliq * D2R) * math.sin(app_long * D2R)) * R2D
    vary = math.tan(obliq / 2 * D2R) ** 2
    eqtime = 4 * R2D * (vary * math.sin(2 * l0 * D2R)
                        - 2 * e * math.sin(m * D2R)
                        + 4 * e * vary * math.sin(m * D2R) * math.cos(2 * l0 * D2R)
                        - 0.5 * vary * vary * math.sin(4 * l0 * D2R)
                        - 1.25 * e * e * math.sin(2 * m * D2R))
    tst = (hour_frac_utc * 60.0 + eqtime + 4.0 * LON) % 1440.0
    ha = tst / 4.0 - 180.0
    lat_r, decl_r, ha_r = LAT * D2R, decl * D2R, ha * D2R
    cosz = (math.sin(lat_r) * math.sin(decl_r)
            + math.cos(lat_r) * math.cos(decl_r) * math.cos(ha_r))
    cosz = max(-1.0, min(1.0, cosz))
    zen = math.acos(cosz) * R2D
    elev = 90.0 - zen
    # atmospheric refraction
    if elev > 85:
        ref = 0.0
    elif elev > 5:
        te = math.tan(elev * D2R)
        ref = (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600.0
    elif elev > -0.575:
        ref = (1735.0 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))) / 3600.0
    else:
        ref = (-20.772 / math.tan(elev * D2R)) / 3600.0
    elev_app = elev + ref
    # azimuth from north, clockwise
    denom = math.cos(zen * D2R) * math.sin(lat_r) - math.sin(decl_r)
    if abs(math.cos(lat_r) * math.sin(zen * D2R)) < 1e-9:
        az = 180.0
    else:
        arg = denom / (math.cos(lat_r) * math.sin(zen * D2R))
        az = math.acos(max(-1.0, min(1.0, arg))) * R2D
        az = (az + 180.0) if ha > 0 else (180.0 - az)
    az %= 360.0
    doy = jd - julian_day(y, 1, 1, 0.0) + 1
    e0n = 1367.0 * (1 + 0.033 * math.cos(2 * math.pi * doy / 365.0))
    return elev_app, az, e0n


def poa_hdkr(ghi, dni, dhi, elev, saz, e0n, tilt, az):
    """Hay-Davies-Klucher-Reindl plane-of-array irradiance (W/m2).
    Returns (poa_beam_after_iam, poa_diffuse_after_iam, aoi_deg)."""
    if elev <= 0.0 or ghi <= 0.0:
        return 0.0, 0.0, 90.0
    zen_r = (90.0 - elev) * D2R
    t_r, a_r = tilt * D2R, az * D2R
    cos_aoi = (math.cos(zen_r) * math.cos(t_r)
               + math.sin(zen_r) * math.sin(t_r) * math.cos(saz * D2R - a_r))
    cos_aoi = max(-1.0, min(1.0, cos_aoi))
    aoi = math.acos(cos_aoi) * R2D
    cosz = max(math.cos(zen_r), 0.03)   # limit Rb blow-up near sunrise/sunset
    rb = max(0.0, cos_aoi) / cosz

    beam = max(0.0, dni * cos_aoi)
    ai = min(1.0, dni / e0n) if e0n > 0 else 0.0
    bh = dni * math.cos(zen_r)
    f = math.sqrt(max(0.0, bh) / ghi) if ghi > 0 else 0.0
    iso = dhi * (1.0 - ai) * (1.0 + math.cos(t_r)) / 2.0 * (
        1.0 + f * math.sin(t_r / 2.0) ** 3)
    circ = dhi * ai * rb
    grnd = ghi * ALBEDO * (1.0 - math.cos(t_r)) / 2.0

    # ASHRAE incidence angle modifier on the beam + circumsolar component
    if aoi < 90.0:
        iam = max(0.0, 1.0 - B0_ASHRAE * (1.0 / math.cos(min(aoi, 89.0) * D2R) - 1.0))
    else:
        iam = 0.0
        beam = 0.0
        circ = 0.0
    return (beam + circ) * iam, (iso + grnd) * IAM_DIFFUSE, aoi


def ac_from_poa(poa, tamb, wind):
    """kWh AC per kW DC for one hour at the given POA (W/m2)."""
    if poa <= 0.0:
        return 0.0
    tmod = poa * math.exp(SAPM_A + SAPM_B * wind) + tamb
    tcell = tmod + poa / 1000.0 * SAPM_DT
    pdc = poa / 1000.0 * (1.0 + GAMMA * (tcell - 25.0))   # kW per kW DC
    pdc *= (1.0 - LOSSES_PCT / 100.0)
    if pdc <= 0.0:
        return 0.0
    pac0 = 1.0 / DC_AC_RATIO                 # inverter AC rating, kW per kW DC
    pdc0 = pac0 / (INV_EFF / 100.0)          # inverter rated DC input
    zeta = pdc / pdc0
    if zeta <= 0.0:
        return 0.0
    eta = (INV_EFF / 100.0) * (-0.0162 * zeta - 0.0059 / max(zeta, 0.01) + 0.9858)
    eta = max(0.0, min(eta, 1.0))
    return min(pdc * eta, pac0)


# --------------------------------------------------------------------------
def lst_hours(year):
    """Yield (hour_index_0_8759, utc_label, month, day) for a year's 8760 local
    standard-time hours, Feb 29 dropped."""
    import datetime as dt
    d = dt.datetime(year, 1, 1, 0, 0)
    idx = 0
    while d.year == year:
        if not (d.month == 2 and d.day == 29):
            utc = d - dt.timedelta(hours=UTC_OFFSET) + dt.timedelta(hours=1)
            yield idx, utc.strftime("%Y-%m-%dT%H:%M"), d.month, d.day, utc
            idx += 1
        d += dt.timedelta(hours=1)


def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    wx = load_weather()

    # ---- pre-compute geometry + weather per (year, hour index) -------------
    print("computing solar geometry ...")
    grid = {}          # year -> list of (ghi, dni, dhi, tamb, wind, elev, saz, e0n, gti_ref)
    month_of = None
    for year in YEARS:
        rows = []
        months = []
        for idx, label, mo, day, utc in lst_hours(year):
            ghi, dni, dhi, tamb, wind, gti_ref = wx.get(label, (0, 0, 0, 15.0, 1.0, 0))
            if tamb is None:
                tamb = 15.0
            # radiation values are the mean over the PRECEDING hour -> use the
            # interval midpoint for the solar position
            hf = utc.hour + utc.minute / 60.0 - 0.5
            yy, mm, dd = utc.year, utc.month, utc.day
            if hf < 0:
                import datetime as dt
                prev = utc - dt.timedelta(days=1)
                yy, mm, dd = prev.year, prev.month, prev.day
                hf += 24.0
            elev, saz, e0n = solar_position(yy, mm, dd, hf)
            rows.append((ghi, dni, dhi, tamb, wind, elev, saz, e0n, gti_ref))
            months.append(mo)
        grid[year] = rows
        month_of = months
    assert all(len(v) == 8760 for v in grid.values())

    def run(tilt, az, rows):
        out = []
        for ghi, dni, dhi, tamb, wind, elev, saz, e0n, _ in rows:
            pb, pd, _ = poa_hdkr(ghi, dni, dhi, elev, saz, e0n, tilt, az)
            out.append(ac_from_poa(pb + pd, tamb, wind))
        return out

    # ---- default orientation, every year ---------------------------------
    print("running PV model, default orientation ...")
    raw = {str(y): run(DEFAULT_TILT, DEFAULT_AZ, grid[y]) for y in YEARS}

    def monthly(profile):
        m = [0.0] * 12
        for i, v in enumerate(profile):
            m[month_of[i] - 1] += v
        return m

    raw_monthly = {y: monthly(p) for y, p in raw.items()}
    model_mean_monthly = [statistics.mean(raw_monthly[str(y)][k] for y in YEARS)
                          for k in range(12)]

    # ---- transposition cross-check against Open-Meteo's own GTI ----------
    gti_ref_sum = sum(r[8] for y in YEARS for r in grid[y]) / len(YEARS) / 1000.0
    gti_mine = 0.0
    for y in YEARS:
        for ghi, dni, dhi, tamb, wind, elev, saz, e0n, _ in grid[y]:
            pb, pd, _ = poa_hdkr(ghi, dni, dhi, elev, saz, e0n, 20.0, 180.0)
            gti_mine += pb + pd
    gti_mine = gti_mine / len(YEARS) / 1000.0

    # ---- reference: PVGIS (PVGIS-NSRDB) ----------------------------------
    ref_path = os.path.join(CACHE_DIR, "pvgis_t20a0_bld.json")
    if not os.path.exists(ref_path):
        url = ("https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=%s&lon=%s"
               "&peakpower=1&loss=%s&angle=%s&aspect=0&mountingplace=building"
               "&outputformat=json" % (LAT, LON, LOSSES_PCT, int(DEFAULT_TILT)))
        subprocess.run(["curl", "-sS", "-m", "120", url, "-o", ref_path], check=True)
    pv = json.load(open(ref_path))["outputs"]
    ref_monthly = [m["E_m"] for m in pv["monthly"]["fixed"]]
    ref_annual = pv["totals"]["fixed"]["E_y"]

    bias = [ref_monthly[k] / model_mean_monthly[k] for k in range(12)]
    print("raw model annual (11-yr mean): %.1f  PVGIS-NSRDB: %.1f  ratio %.4f"
          % (sum(model_mean_monthly), ref_annual, ref_annual / sum(model_mean_monthly)))
    print("monthly bias factors:", [round(b, 4) for b in bias])

    def correct(profile):
        return [profile[i] * bias[month_of[i] - 1] for i in range(8760)]

    profiles = {y: correct(p) for y, p in raw.items()}

    # ---- TMY: pick, for each month, the year closest to the 11-year median
    tmy_months = {}
    for k in range(12):
        vals = {str(y): sum(v for i, v in enumerate(profiles[str(y)])
                            if month_of[i] == k + 1) for y in YEARS}
        med = statistics.median(vals.values())
        tmy_months[k] = min(vals, key=lambda y: abs(vals[y] - med))
    tmy = [profiles[tmy_months[month_of[i] - 1]][i] for i in range(8760)]
    profiles["tmy"] = tmy

    annual = {k: round(sum(v), 1) for k, v in profiles.items()}
    yearly_sorted = sorted((annual[str(y)], str(y)) for y in YEARS)

    def pick(exceedance):
        """Solar-industry exceedance convention: PXX is the annual yield that is
        exceeded in XX% of years, so P90 is a LOW (conservative) year and P10 a
        high one."""
        p = 1.0 - exceedance
        i = min(len(yearly_sorted) - 1, max(0, int(round(p * (len(yearly_sorted) - 1)))))
        return yearly_sorted[i]

    p10_v, p10_y = pick(0.10)
    p50_v, p50_y = pick(0.50)
    p90_v, p90_y = pick(0.90)

    # ---- orientation factors (monthly multipliers vs tilt 20 / az 180) ----
    print("running orientation grid (%d combinations) ..." % (len(TILTS) * len(AZIMUTHS)))
    tmy_rows = [grid[int(tmy_months[month_of[i] - 1])][i] for i in range(8760)]
    base_prof = run(DEFAULT_TILT, DEFAULT_AZ, tmy_rows)
    base_m = monthly(base_prof)
    orientation = {"note": ("monthly yield multipliers relative to tilt 20 / az 180, "
                            "computed with the same PV model on the TMY weather "
                            "(index 0 = January)")}
    for t in TILTS:
        for a in AZIMUTHS:
            pm = monthly(run(float(t), float(a), tmy_rows))
            orientation["tilt_%d_az_%d" % (t, a)] = [
                round(pm[k] / base_m[k], 4) if base_m[k] else 0.0 for k in range(12)]

    # ---- orientation validation against PVGIS ----------------------------
    orient_check = []
    tmy_m = monthly(tmy)
    tmy_a = sum(tmy_m)
    for tilt, aspect in [(10, 0), (30, 0), (35, 0), (20, -45), (20, 45)]:
        f = os.path.join(CACHE_DIR, "pvgis_t%d_asp%d.json" % (tilt, aspect))
        if not os.path.exists(f):
            url = ("https://re.jrc.ec.europa.eu/api/v5_2/PVcalc?lat=%s&lon=%s"
                   "&peakpower=1&loss=%s&angle=%d&aspect=%d&mountingplace=building"
                   "&outputformat=json" % (LAT, LON, LOSSES_PCT, tilt, aspect))
            subprocess.run(["curl", "-sS", "-m", "120", url, "-o", f], check=True)
        ey = json.load(open(f))["outputs"]["totals"]["fixed"]["E_y"]
        az = 180 + aspect
        key = "tilt_%d_az_%d" % (tilt, az)
        mine = sum(orientation[key][k] * tmy_m[k] for k in range(12)) / tmy_a
        orient_check.append({"orientation": key,
                             "model_annual_ratio": round(mine, 4),
                             "pvgis_annual_ratio": round(ey / ref_annual, 4),
                             "delta_pct": round(100 * (mine / (ey / ref_annual) - 1), 2)})

    # ---- write solar.json -------------------------------------------------
    meta = {
        "lat": LAT, "lon": LON, "elevation_m": ELEV,
        "default_tilt": DEFAULT_TILT, "default_azimuth": DEFAULT_AZ,
        "losses_pct": LOSSES_PCT, "dc_ac_ratio": DC_AC_RATIO, "inv_eff": INV_EFF,
        "tz": "America/Los_Angeles (local STANDARD time, no DST)",
        "model_notes": (
            "Pure-python PVWatts-like chain on Open-Meteo/ERA5 hourly GHI-DNI-DHI: "
            "NOAA solar position at the interval midpoint (Open-Meteo radiation is a "
            "preceding-hour mean); HDKR transposition to the array plane with 0.2 "
            "ground albedo; ASHRAE b0=0.05 incidence-angle modifier on the beam plus "
            "circumsolar diffuse and a constant 0.96 IAM on isotropic and ground "
            "diffuse; Sandia roof-mount module temperature (a=-2.98, b=-0.0471, "
            "dT=1) from ambient temperature and 10 m wind; DC power with a "
            "-0.35 %/degC temperature coefficient; 14% system losses; PVWatts "
            "part-load inverter curve at 96% nominal with hard clipping at the "
            "1.2 DC/AC ratio. NREL PVWatts v8 could not be reached from this "
            "network (developer.nrel.gov does not resolve), so the model is "
            "calibrated against PVGIS v5.2 PVcalc driven by PVGIS-NSRDB "
            "(the same NSRDB satellite radiation family PVWatts uses), roof "
            "('building') mounting, 14% loss, tilt 20 / azimuth 180. A per-month "
            "multiplicative bias correction maps the 11-year model mean onto the "
            "PVGIS-NSRDB monthly means; the correction is listed in "
            "meta.monthly_bias_correction and is applied to every profile, TMY "
            "included. TMY is built the classic way: for each calendar month the "
            "actual year whose monthly production is closest to the 11-year median "
            "is selected and the 12 months are stitched together "
            "(meta.tmy_month_sources)."),
        "sources": [
            "Open-Meteo historical archive API (ERA5), hourly GHI/DNI/DHI/"
            "temperature_2m/wind_speed_10m, 2015-2025, timezone=GMT, "
            "https://archive-api.open-meteo.com/v1/archive",
            "PVGIS v5.2 PVcalc (radiation_db=PVGIS-NSRDB, meteo_db=ERA5, "
            "2005-2015), https://re.jrc.ec.europa.eu/api/v5_2/PVcalc - used for "
            "the monthly bias correction and for orientation validation",
            "NREL PVWatts v8: UNAVAILABLE (developer.nrel.gov has no DNS record "
            "from this network); PVGIS-NSRDB substituted",
        ],
        "annual_kwh_per_kw": annual,
        "percentiles": {"p10_year": p10_y, "p50_year": p50_y, "p90_year": p90_y,
                        "p10_kwh_per_kw": p10_v, "p50_kwh_per_kw": p50_v,
                        "p90_kwh_per_kw": p90_v,
                        "convention": ("solar-industry exceedance: P90 is the annual "
                                       "yield exceeded in 90% of years (conservative, "
                                       "LOW), P50 the median, P10 the optimistic high "
                                       "year; picked as empirical order statistics of "
                                       "the 11 modelled weather years")},
        "monthly_bias_correction": [round(b, 4) for b in bias],
        "tmy_month_sources": {str(k + 1): tmy_months[k] for k in range(12)},
        "validation": {
            "pvgis_nsrdb_annual_kwh_per_kw": round(ref_annual, 1),
            "pvgis_nsrdb_monthly_kwh_per_kw": [round(v, 1) for v in ref_monthly],
            "model_raw_annual_kwh_per_kw_11yr_mean": round(sum(model_mean_monthly), 1),
            "model_raw_monthly_kwh_per_kw_11yr_mean": [round(v, 1) for v in model_mean_monthly],
            "raw_vs_pvgis_pct": round(100 * (sum(model_mean_monthly) / ref_annual - 1), 2),
            "poa_kwh_per_m2_my_hdkr_11yr_mean": round(gti_mine, 1),
            "poa_kwh_per_m2_open_meteo_gti_11yr_mean": round(gti_ref_sum, 1),
            "poa_kwh_per_m2_pvgis": round(pv["totals"]["fixed"]["H(i)_y"], 1),
            "orientation_factor_check_vs_pvgis": orient_check,
        },
    }
    out = {
        "meta": meta,
        "hour_index_note": ("index = (dayOfYear-1)*24 + hour, local standard time "
                            "(PST, UTC-8, no DST), 8760 entries, Feb 29 dropped"),
        "profiles": {k: [round(v, 4) for v in p] for k, p in profiles.items()},
        "orientation_factors": orientation,
    }
    path = os.path.join(BUILD_DIR, "solar.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    # ---- summary ----------------------------------------------------------
    summary = {
        "meta": {"annual_kwh_per_kw": annual,
                 "percentiles": meta["percentiles"],
                 "validation": meta["validation"],
                 "tmy_month_sources": meta["tmy_month_sources"],
                 "monthly_bias_correction": meta["monthly_bias_correction"]},
        "monthly_kwh_per_kw": {k: [round(v, 1) for v in monthly(p)]
                               for k, p in profiles.items()},
        "year_ranking_best_to_worst": [y for _, y in reversed(yearly_sorted)],
        "annual_stats": {
            "mean": round(statistics.mean(annual[str(y)] for y in YEARS), 1),
            "stdev": round(statistics.stdev(annual[str(y)] for y in YEARS), 1),
            "min": yearly_sorted[0][0], "min_year": yearly_sorted[0][1],
            "max": yearly_sorted[-1][0], "max_year": yearly_sorted[-1][1],
        },
    }
    with open(os.path.join(BUILD_DIR, "solar_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)

    print("annual kWh/kW:", annual)
    print("P10 %s=%.0f  P50 %s=%.0f  P90 %s=%.0f"
          % (p10_y, p10_v, p50_y, p50_v, p90_y, p90_v))
    print("solar.json: %.2f MB" % (os.path.getsize(path) / 1e6))


if __name__ == "__main__":
    main()
