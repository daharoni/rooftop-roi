# The solar production model

`core/pv.js` turns an hourly weather year into **kWh AC per kW DC installed**, hour by hour.
`core/weather.js` gets the weather years. `core/geocode.js` turns an address into the
coordinates those two need. Nothing here touches the user's load or bill data, and none of
it needs a server.

The model is a JS port of `docs/reference-pv-model.py`, the prototype's build script. That
script was validated against **PVGIS v5.2 PVcalc driven by PVGIS-NSRDB** — the same NSRDB
satellite radiation family NREL PVWatts uses — for the reference site (Agoura Hills, CA;
34.145 N, 118.76 W, 280 m). NREL's own PVWatts API was unreachable from the prototype's
network, so PVGIS-NSRDB stood in. The port reproduces the prototype exactly on identical
inputs (see [Validation](#validation)).

---

## 1. Inputs

### Weather (`core/weather.js`)

| field | source | unit | note |
|---|---|---|---|
| `ghi` | Open-Meteo `shortwave_radiation` | W/m² | global horizontal |
| `dni` | Open-Meteo `direct_normal_irradiance` | W/m² | |
| `dhi` | Open-Meteo `diffuse_radiation` | W/m² | |
| `bhi` | Open-Meteo `direct_radiation` | W/m² | direct on the horizontal; fetched, not used by the model |
| `temp` | Open-Meteo `temperature_2m` | °C | |
| `wind` | Open-Meteo `wind_speed_10m` | **km/h** | see the [wind caveat](#wind-speed-units) |

Everything comes from the free, keyless **Open-Meteo historical archive** (ERA5 reanalysis,
~30 km native grid, downscaled). One request per year:

```
https://archive-api.open-meteo.com/v1/archive
  ?latitude=..&longitude=..&start_date=YYYY-12-31&end_date=YYYY+1-01-01
  &hourly=shortwave_radiation,direct_radiation,diffuse_radiation,
          direct_normal_irradiance,temperature_2m,wind_speed_10m
  &timezone=auto[&elevation=<site metres>]
```

The request spans one day either side of the calendar year so every local-standard hour
has a sample. `elevation` is passed when known: it changes Open-Meteo's temperature
downscaling (and therefore the cell-temperature derate), not the irradiance.

**Default year range** — the 11 most recent *complete* years, computed from today's date
with a 5-day archive lag (`defaultYears()`, `ARCHIVE_LAG_DAYS`). On 16 September 2026 that
is 2015–2025; on 2 January 2026 it is 2014–2024, because 2025 has not finished arriving.

### Site and plane

```js
hourlyProfile(weatherYear, {
  lat, lon, elevationM,          // site
  tilt = 20, azimuth = 180,      // plane; azimuth is degrees clockwise from TRUE north
  losses = 0.14,                 // flat DC derate
  dcAcRatio = 1.2, invEff = 0.96,
  tempCoeff = -0.0035,           // per °C
  albedo = 0.2, b0 = 0.05, iamDiffuse = 0.96,
  sapm = { a: -2.98, b: -0.0471, dT: 1.0 },
  biasCorrection = "auto",
}) -> Float64Array(8760)
```

---

## 2. Time convention

Profiles are **local standard time, no daylight saving**: 8760 hours, index
`(dayOfYear - 1) * 24 + hour`, **Feb 29 dropped**. Loads are local *clock* time; the engine
maps clock → standard when it looks a solar hour up. This is the convention in
`docs/ARCHITECTURE.md` and it is what makes a TOU schedule line up with production in both
halves of the year.

The standard UTC offset is derived from the IANA zone Open-Meteo reports, via `Intl`:
daylight saving always shifts a clock *east*, so the standard offset is
`min(January offset, July offset)` — correct in both hemispheres. Open-Meteo applies one
fixed offset to a whole request (there is no DST break inside a year-long series), so the
series is re-anchored to UTC from its first label and re-sliced into standard hours.

**Preceding-hour convention.** Open-Meteo labels an hourly radiation value with the *end*
of its averaging interval: the sample at UTC label `T` is the mean over `(T-1h, T]`. Local
standard hour `H` therefore reads the sample labelled `H + 1h`, and the solar position is
evaluated at the interval **midpoint**, `H + 30min`. Getting this wrong costs about 1% of
annual yield and skews the morning/evening shape, which matters under a TOU tariff.

Dropping Feb 29 drops the *slot*, not the weather that straddles its boundary: the last
standard hour of 28 February still reads the sample labelled 00:00 on 29 February.

---

## 3. Model chain

For each of the 8760 hours:

### 3.1 Solar position — NOAA algorithm

Julian day from the UTC midpoint, then the NOAA spreadsheet equations: geometric mean
longitude and anomaly, equation of centre, apparent longitude, obliquity, declination, and
the equation of time

```
eqtime = 4·(y·sin2L₀ − 2e·sinM + 4ey·sinM·cos2L₀ − ½y²·sin4L₀ − 1.25e²·sin2M)   [minutes]
y      = tan²(ε/2)
```

True solar time `tst = (hour_UTC·60 + eqtime + 4·lon) mod 1440`, hour angle
`ha = tst/4 − 180`, then

```
cos z = sin φ · sin δ + cos φ · cos δ · cos ha
```

Apparent elevation adds the standard NOAA refraction polynomials; azimuth is measured
clockwise from true north. Extraterrestrial normal irradiance
`E₀ₙ = 1367 · (1 + 0.033 · cos(2π·doy/365))` W/m² feeds the anisotropy index below.

Accuracy is ~0.01° over the modern era — far finer than the weather's grid error.

### 3.2 Transposition — HDKR

Hay–Davies–Klucher–Reindl, with the incidence angle from the plane normal:

```
cos θ = cos z · cos β + sin z · sin β · cos(γₛ − γ)
Rb    = max(0, cos θ) / max(cos z, 0.03)          # the 0.03 floor tames sunrise/sunset
Ai    = min(1, DNI / E₀ₙ)                          # anisotropy index
f     = sqrt(max(0, DNI·cos z) / GHI)              # Klucher horizon-brightening factor

beam        = DNI · cos θ
circumsolar = DHI · Ai · Rb
isotropic   = DHI · (1 − Ai) · (1 + cos β)/2 · (1 + f · sin³(β/2))
ground      = GHI · ρ · (1 − cos β)/2,     ρ = 0.2
```

### 3.3 Incidence-angle modifier — ASHRAE

```
IAM(θ) = max(0, 1 − b₀ · (1/cos θ − 1)),   b₀ = 0.05,  θ capped at 89°
```
applied to `beam + circumsolar`; a constant **0.96** is applied to `isotropic + ground`
(they arrive from all directions, so a single effective IAM is the usual simplification).
Above θ = 90° the beam and circumsolar terms are zero.

```
POA = IAM(θ)·(beam + circumsolar) + 0.96·(isotropic + ground)
```

### 3.4 Cell temperature — Sandia, roof mount

PVWatts `array_type = 1` coefficients:

```
T_module = POA · exp(a + b · wind) + T_ambient,     a = −2.98, b = −0.0471
T_cell   = T_module + (POA/1000) · ΔT,              ΔT = 1 °C
```

### 3.5 DC power and losses

```
P_dc = (POA/1000) · (1 + γ · (T_cell − 25)) · (1 − losses)      [kW per kW DC]
γ = −0.0035 /°C   (−0.35 %/°C)
losses = 0.14     (soiling, mismatch, wiring, connections, LID, nameplate, availability)
```

The 14% figure is the PVWatts default residential loss stack **without** shading — shading
is a separate, per-plane input the engine applies (see [`shadeFactor`](#shadefactor)).

### 3.6 Inverter — PVWatts part-load curve with clipping

```
P_ac0 = 1 / dcAcRatio                       # inverter AC rating, kW per kW DC = 0.8333
P_dc0 = P_ac0 / invEff                      # rated DC input
ζ     = P_dc / P_dc0
η     = invEff · (−0.0162·ζ − 0.0059/ζ + 0.9858),  clamped to [0, 1]
P_ac  = min(P_dc · η, P_ac0)                # hard clipping at the DC/AC ratio
```

A 1.2 DC/AC ratio clips the top of clear summer days. That is deliberate and normal — it
is also why an oversized array's marginal panel is worth less than its first one, which the
optimizer relies on.

### 3.7 Monthly bias correction (optional)

`P_ac ← P_ac · bias[month]`. See [§5](#5-the-bias-correction).

---

## 4. Derived outputs

### `profilesForPlane(weatherYears, plane, site) -> SolarProfiles`

Runs every weather year, then adds:

**Synthetic TMY.** For each calendar month, pick the *actual modelled year* whose production
in that month is closest to the multi-year **median** for that month, then stitch the twelve
chosen months together. This is the classic TMY construction collapsed to a single index
(production instead of Sandia's weighted Finkelstein–Schafer statistic over nine variables).
It is a synthetic year: no real year looks like it, and its month boundaries have small
discontinuities. The chosen source year per month is reported in `tmySources`. Because a
month's bias factor scales every year identically, the selection is unaffected by the bias
correction.

**Exceedance percentiles.** The solar-industry convention, which is the opposite of the
statistical one: **P90 is the annual yield exceeded in 90% of years, i.e. the LOW,
conservative year**; P50 is the median; P10 is the optimistic high year. They are empirical
order statistics of the modelled years, and `percentiles` reports both the value and which
year it came from. The financing tab should quote P90, not P50 — lenders do.

### `orientationFactor(site, tilt, azimuth, refTilt, refAz, weatherYear) -> number[12]`

Twelve monthly yield multipliers relative to a reference orientation, for live UI previews
of the pitch/direction dials. Two 8760 passes (the solar geometry is cached per weather
year and site), so it is a few milliseconds. Bias corrections cancel in the ratio, so the
result is independent of `biasCorrection`.

A property worth knowing before you trust a preview: **in midsummer at 34° N a tilted array
is nearly orientation-blind.** The sun rises north of east and sets north of west, so a
30°-tilted north face collects within a few percent of a 30°-tilted south face in June, and
an east face at 20° can beat a south face. The orientation penalty is a *winter* penalty.
The model reproduces this, and `tests/pv.test.mjs` asserts it against an independent
closed-form clear-sky integral.

### `shadeFactor(plane)`

Returns the fraction **retained** — `{ annual, monthly: number[12], kind }` — from
`plane.shading`, which is `{ annual: fractionLost }` or `{ monthly: [12 fractionsLost] }`.
Shading is deliberately *not* baked into the profiles: the engine applies it, so the user
can drag a shading slider without re-running the PV model.

---

## 5. The bias correction

`BIAS_CORRECTIONS["pvgis-nsrdb-socal"]` is twelve multiplicative factors that map this
model's 11-year monthly means onto PVGIS-NSRDB's monthly means at the reference site:

```
Jan 1.0220  Feb 0.9670  Mar 1.0378  Apr 1.0002  May 1.0379  Jun 1.0311
Jul 1.0140  Aug 1.0531  Sep 1.0134  Oct 0.9926  Nov 1.0034  Dec 0.9840
```

**It is region specific.** It is dominated by ERA5's known negative irradiance bias against
satellite retrievals in coastal southern California — ERA5 over-predicts the May/June marine
layer and misses some thin-cirrus days, and the residual shows up worst in August (+5.3%).
Those factors have no physical meaning in a different climate, so:

`biasCorrection: "auto"` (the default) applies the table **only** inside the box it was
fitted in — latitude 32.5 to 35.6 N, longitude 120.6 to 116.0 W — and applies nothing
anywhere else. `"none"` turns it off; `"pvgis-nsrdb-socal"` forces it on; a 12-number array
supplies your own.

**Is it needed?** No — not to meet the accuracy bar. Without it the model is 1.45–2.21%
below the reference annual and at worst 6.1% off on a month, both inside the 3% / 10%
budget. With it the model is within 0.7% and 1.2%. It is kept on inside SoCal because it is
a real, measured correction toward a better radiation database, and it is kept off elsewhere
because extrapolating it would be guesswork. Adding a new region means fitting a new table
against PVGIS (or PVWatts) for that region and adding an entry with its own box.

---

## 6. Validation

Driven by the **same** Open-Meteo/ERA5 inputs, against
`tests/fixtures/solar-agoura-hills.json` (tilt 20°, azimuth 180°, kWh/kW).
Budget: **annual within 3%, every month within 10%.**

### With the bias correction (the default at this site)

| year | model | fixture | annual Δ | worst month Δ |
|---|---|---|---|---|
| 2015 | 1667.5 | 1677.8 | −0.61% | Jun −1.08% |
| 2016 | 1669.0 | 1680.6 | −0.69% | Jun −1.14% |
| 2017 | 1626.8 | 1626.9 | −0.00% | Feb +0.00% |
| 2018 | 1625.5 | 1625.5 | −0.00% | Feb +0.00% |
| 2019 | 1581.5 | 1581.5 | +0.00% | Jul −0.00% |
| 2020 | 1653.0 | 1653.0 | +0.00% | Feb +0.00% |
| 2021 | 1653.8 | 1653.8 | −0.00% | Feb +0.01% |
| 2022 | 1659.7 | 1659.8 | −0.00% | Feb +0.00% |
| 2023 | 1536.1 | 1536.1 | −0.00% | Jul −0.00% |
| 2024 | 1603.9 | 1603.9 | +0.00% | Feb +0.00% |
| 2025 | 1607.6 | 1607.6 | +0.00% | Feb +0.01% |
| **worst** | | | **−0.69%** | **−1.14%** |

Nine of the eleven years reproduce the prototype to **four significant figures**, which is
what a faithful port should do. 2015 and 2016 differ by 0.6–0.7% because Open-Meteo has
since revised those ERA5 years upstream — the fixture was built from the older
vintage. That is drift in the *data*, not in the model, and it is well inside budget.

Other checks:

* **TMY**: 1638.4 vs the fixture's 1640.5 kWh/kW (−0.13%). Two of the twelve TMY month
  sources differ (June, October) because the 2015/2016 revision moved them across a
  near-tie for the median.
* **Percentiles**: identical year assignment — P10 2015, P50 2017, P90 2019.
* **Orientation grid** (42 tilt × azimuth combinations × 12 months): worst deviation
  **1.56%** when driven by the same TMY splice the fixture used, **3.66%** when driven by a
  single median year. The prototype's own orientation check against PVGIS was within 0.54%.

### Without the bias correction

| year | annual Δ | worst month Δ |
|---|---|---|
| 2015 | −2.12% | Aug −5.99% |
| 2016 | −2.21% | Aug −6.07% |
| 2017 | −1.60% | Aug −5.04% |
| 2018 | −1.45% | Aug −5.04% |
| 2019 | −1.58% | Aug −5.04% |
| 2020 | −1.49% | Aug −5.04% |
| 2021 | −1.54% | Aug −5.04% |
| 2022 | −1.55% | Aug −5.04% |
| 2023 | −1.47% | Aug −5.04% |
| 2024 | −1.61% | Aug −5.04% |
| 2025 | −1.57% | Aug −5.04% |
| **worst** | **−2.21%** | **−6.07%** |

Still inside budget — this is the accuracy to expect **outside** southern California, where
`"auto"` applies nothing.

### Underlying reference accuracy (from the prototype, for context)

| quantity | model | PVGIS-NSRDB |
|---|---|---|
| annual kWh/kW (11-yr mean, uncorrected) | 1602.8 | 1627.9 (−1.54%) |
| POA irradiation kWh/m²·yr | 2187.6 | 2213.6 |
| POA per Open-Meteo's own `global_tilted_irradiance` | 2207.2 | — |

So the transposition itself is within 1.2% of both an independent implementation and PVGIS.

### Tests

`tests/pv.test.mjs`, `tests/weather.test.mjs` and `tests/geocode.test.mjs` — 66 tests, all
offline except four clearly-marked live ones that **skip with an explanation** rather than
fail when the network is down.

```bash
node --test tests/pv.test.mjs tests/weather.test.mjs tests/geocode.test.mjs

# online, caches 11 years (~3.7 MB) outside the repo
ROOFTOP_ROI_WEATHER_CACHE=/tmp/rooftop-roi-weather node --test tests/pv.test.mjs
```

> Note for CI: on Node 24.18 `node --test tests/` treats the directory as a file to execute
> and fails before running anything. `node --test` with no arguments (it recurses from the
> working directory) or an explicit list of files both work.

The per-year rows are printed as test diagnostics. Three of the eleven years
(2015 / 2017 / 2023 — the P10, P50 and P90 years) ship as
`tests/fixtures/weather-agoura-hills.json.gz` (151 KB gzipped, irradiance rounded to
1 W/m², temperature and wind to 0.1) so the comparison runs **fully offline**; rounding
costs at most 0.01% on an annual total. The eleven-year test skips with an explicit message
when neither a cache nor the network is available. If you keep a repo-local cache, add
`.cache/` to `.gitignore` first.

---

## 7. Caveats

**Grid resolution.** ERA5 is a ~30 km reanalysis. It knows the regional climate, not your
street. A coastal marine layer that burns off two miles inland, an urban heat island, a
canyon's own fog — none of that is resolved. Expect a few percent of site-to-site error
that no amount of model care removes.

**No terrain horizon.** The model assumes a clear horizon. A ridge to the south-west, a
neighbour's oak, a chimney: all of it has to arrive as `plane.shading`, a flat derate the
engine applies. There is no ray tracing and no horizon profile. For a shaded roof this is
by far the largest error in the whole tool, and the UI should say so.

**Shading is a derate, not a simulation.** A 15% annual shading loss applied uniformly is
not the same as losing all of 08:00–10:00 in December; per-month shading
(`shading.monthly`) is closer, and per-hour would be closer still, but the model does not
do it. Under a TOU tariff the *timing* of a shading loss can matter more than its size.

<a id="wind-speed-units"></a>
**Wind speed units.** Open-Meteo returns `wind_speed_10m` in **km/h** and the model feeds
it to the Sandia `exp(a + b·wind)` term, whose coefficients are defined for **m/s**. The
reference model did the same, so a faithful port must too. The practical effect is modules
modelled ~10 °C cooler than Sandia intends (roughly +4% output), which is partly offset by
the model's other conservative choices — the uncorrected result still lands 1.5% *below*
PVGIS-NSRDB. Changing it would need the whole loss stack recalibrated and would break the
fixture. Recorded here as a known, deliberate deviation, not an accident.

**No spectral, no soiling season, no degradation.** The flat 14% covers all of it. Panel
degradation over the analysis horizon belongs in `core/finance.js`, not here.

**No snow, no albedo season.** Ground albedo is a constant 0.2. Fine for California, wrong
for a snowy climate.

**A weather year is not a forecast.** Eleven modelled years give an honest spread — use the
P90 for anything that has to be financed. Climate trend is not extrapolated.

**Feb 29.** Dropped, so a leap year is modelled as 8760 hours. The lost day is ~0.27% of
annual production, which is inside the noise and keeps every index arithmetic trivial.

---

## 8. Offline behaviour, caching and failure

`fetchYears` is the only function in these three modules that can fail from the outside,
and it **only ever rejects with `WeatherUnavailableError`**, which carries:

* `code` — `"offline" | "http" | "api" | "timeout" | "aborted" | "data"`
* `userMessage` — a complete, non-technical sentence the UI can render verbatim
* `year`, and the original failure as `cause`

`tryFetchYears(opts)` wraps it and never rejects at all: `{ ok: true, years }` or
`{ ok: false, error, message }`. Everything else in the tool must keep working when solar
is unavailable — that is the rule in `docs/ARCHITECTURE.md`.

**Cache.** `cache.get(key)` / `cache.set(key, value)` holds raw API responses.

| runtime | implementation |
|---|---|
| browser | IndexedDB, database `rooftop-roi`, store `weather` |
| Node | one JSON file per key under `$ROOFTOP_ROI_WEATHER_CACHE` or `./.cache/weather` |
| neither | in-memory |

The key is `"lat,lon,year"` with coordinates rounded to **0.05°** (~5.5 km) — which is also
the precision actually sent to Open-Meteo, so two houses on the same block share one
download and neither one's exact position leaves the browser. A cache that throws (private
browsing, quota exceeded, IndexedDB disabled) degrades to no cache, never to an error.
`cacheOnly: true` forbids the network entirely.

---

## 9. Geocoding (`core/geocode.js`)

`geocode(query)` → `{ lat, lon, label, zip, source }`.

**Nominatim** (OpenStreetMap) is tried first:
`https://nominatim.openstreetmap.org/search?format=jsonv2&q=..&countrycodes=us&limit=1&addressdetails=1`.
Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires:

* **at most 1 request per second** — enforced by a serialised queue inside the module;
* **a descriptive User-Agent or Referer.** A browser cannot set `User-Agent` (doing so
  makes the request fail CORS), so in the browser the `Referer` the browser sends — the
  GitHub Pages origin — is what identifies the application. From Node the module sends an
  explicit `User-Agent` (`USER_AGENT`). If this tool ever gets real traffic, the polite
  thing is to run or pay for a dedicated geocoder rather than lean on Nominatim;
* **attribution** — `ATTRIBUTION` ("Address search © OpenStreetMap contributors
  (Nominatim)") must be visible next to the address field;
* no bulk querying. One lookup per session is exactly the intended use.

**Fallback.** A bare ZIP, or a Nominatim miss or failure when the query contained a ZIP,
goes to `zipCentroid(zip)` via Open-Meteo's geocoding index
(`https://geocoding-api.open-meteo.com/v1/search?name=<zip>&count=1&countryCode=US`).

`elevationFor(lat, lon)` uses Open-Meteo's elevation API (~90 m DEM) and returns `null`
rather than throwing — elevation only tunes the temperature downscaling.

`PRIVACY_NOTE` is an exported string stating literally what is sent: **the text typed in
the address box, to Nominatim, and nothing else.** The UI must show it near the address
field. The privacy-maximal paths — clicking the roof on the map, or typing only a ZIP — are
named in the note itself.

### `utilityForZip(zip)` → `"sce" | "pge" | "sdge" | null`

Three-digit ZIP prefix tables for the three California investor-owned utilities, assembled
from the CPUC electric service-territory map, each utility's own service-area pages, and
the USPS 3-digit (SCF) prefix areas.

| utility | 3-digit prefixes |
|---|---|
| SDG&E | 919–921 |
| SCE | 900–908, 910–918, 922–928, 930, 931, 934, 935 |
| PG&E | 932, 933, 936–961 |

This is a **prefill guess, not a service-territory determination**, and the UI must let the
user override it:

* **Three digits is too coarse in places.** 922 covers both SCE's Coachella Valley and the
  Imperial Irrigation District; 926 covers SCE's Orange County and SDG&E's San Clemente;
  931/934 straddle the SCE/PG&E line in Santa Barbara and Ventura; 939 straddles it in
  south Monterey County. `AMBIGUOUS_ZIP_PREFIXES` names these, and
  `utilityForZipDetailed(zip)` returns `confident: false` plus the caveat text for the
  Assumptions tab.
* **Municipal utilities are not IOUs.** LADWP, Glendale, Burbank, Pasadena, Anaheim,
  Riverside, Azusa, Vernon, Silicon Valley Power, Alameda, Palo Alto, Roseville, SMUD,
  Redding, Lodi, Modesto ID, Turlock ID and Imperial ID all sit inside these prefixes and
  have their own tariffs. They will be mapped to the surrounding IOU and the user has to
  correct it.
* **CCAs are not a different utility.** Clean Power Alliance, MCE, Ava, SVCE, 3CE, CleanPowerSF
  and the rest share the IOU's delivery territory and appear as `providers` inside the IOU's
  tariff file. The utility id stays the IOU; `core/tariff.js` handles the generation
  provider. See `docs/tariffs-sce.md`.

---

## 10. API summary

```js
// core/weather.js
fetchYears({ lat, lon, years, elevationM, signal, cache, cacheOnly, onProgress }) -> Promise<weatherYear[]>
tryFetchYears(opts)            -> Promise<{ ok, years } | { ok, error, message }>
defaultYears(today?, count?)   -> number[]      // 11 most recent complete years
latestCompleteYear(today?)     -> number
toWeatherYear(rawResponse, { year, lat, lon }) -> weatherYear
weatherYearFromArrays({ ... }) -> weatherYear   // synthetic skies, imported TMY files
cacheKey(lat, lon, year)       -> string
memoryCache() | fileCache({ dir }) | indexedDbCache() | defaultCache()
standardOffsetSeconds(tz) | zoneOffsetSeconds(tz, atMs) | offsetFromLongitude(lon)
standardHourStartsUtc(year, utcOffsetSeconds) -> Float64Array(8760)
MONTH_OF_HOUR, DAY_OF_HOUR : Uint8Array(8760)
WeatherUnavailableError

// core/pv.js
hourlyProfile(weatherYear, opts)                 -> Float64Array(8760)   // kWh AC per kW DC
profilesForPlane(weatherYears, plane, site)      -> SolarProfiles
orientationFactor(site, tilt, az, refTilt, refAz, weatherYear) -> number[12]
shadeFactor(plane)                               -> { annual, monthly, kind }
solarPosition(utcMs, lat, lon)                   -> { elevation, azimuth, e0n, ... }
poaHdkr(ghi, dni, dhi, elev, solarAz, e0n, tilt, az, opts) -> { beam, diffuse, poa, aoi }
acFromPoa(poa, tamb, wind, opts)                 -> number
monthlyTotals(profile) | annualTotal(profile) | resolveBias(spec, site)
DEFAULTS, BIAS_CORRECTIONS

// core/geocode.js
geocode(query, opts)           -> Promise<{ lat, lon, label, zip, source }>
zipCentroid(zip, opts)         -> Promise<{ lat, lon, label, zip, elevationM, source }>
elevationFor(lat, lon, opts)   -> Promise<number|null>
utilityForZip(zip)             -> "sce" | "pge" | "sdge" | null
utilityForZipDetailed(zip)     -> { utilityId, zip, confident, note }
extractZip(text)               -> string | null
PRIVACY_NOTE, ATTRIBUTION, USER_AGENT, IOU_ZIP_PREFIXES, AMBIGUOUS_ZIP_PREFIXES, GeocodeError
```

`SolarProfiles` adds `monthlyPerKw`, `years` and `tmySources` to the shape in
`docs/ARCHITECTURE.md`; the documented fields are all present and unchanged.

---

## 11. Sources

* Open-Meteo historical weather API (ERA5) — <https://open-meteo.com/en/docs/historical-weather-api>
* PVGIS v5.2 PVcalc, `radiation_db=PVGIS-NSRDB` — <https://re.jrc.ec.europa.eu/api/v5_2/PVcalc>
* NREL PVWatts v8 technical reference (loss stack, inverter part-load curve, Sandia
  array-type coefficients) — <https://www.nrel.gov/docs/fy14osti/62641.pdf>
* NOAA Solar Calculator equations — <https://gml.noaa.gov/grad/solcalc/calcdetails.html>
* Duffie & Beckman, *Solar Engineering of Thermal Processes*, 4th ed. (HDKR transposition)
* OSM Nominatim usage policy — <https://operations.osmfoundation.org/policies/nominatim/>
* CPUC electric utility service-territory maps; SCE / PG&E / SDG&E service-area pages
