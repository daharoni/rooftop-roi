# rooftop-roi — architecture and module contracts

Static site (GitHub Pages, no build step, no backend). Everything runs in the visitor's
browser. **User data never leaves the browser**: the only network calls are weather
(Open-Meteo), optional geocoding (address → coordinates, disclosed and avoidable by
clicking the map), and map tiles. No analytics, no uploads.

Plain ES modules (`export` / `import`), no bundler, no framework. Node 24 for tests
(`node --test tests/`). Chart.js 4 (UMD from cdnjs) and Leaflet 1.9 (from cdnjs) are the
only libraries.

```
index.html              landing + app shell (tabs)
app/                    UI: main.js, state.js, tabs/*.js, roof/*.js, charts/*.js, styles.css
core/                   pure logic, no DOM: engine.js finance.js optimizer.js tariff.js
                        greenbutton.js flexload.js pv.js weather.js geocode.js
data/tariffs/*.json     tariff library, one file per utility (schema below)
data/export/*.json      NBT export-rate matrices per utility and vintage (may be inside the tariff file)
data/demo/*.csv         scrubbed demo Green Button files (a real SCE household, 2 years)
tests/*.test.mjs        node --test; tests/fixtures/ has the reference site's load + solar
docs/                   this file, tariff notes, reference implementations from the prototype
```

Reference implementations from the single-house prototype live in `docs/reference-*.{js,py,html,css}`
and `core/*.js`. They are correct and tested (168 assertions in `tests/engine.test.mjs`);
generalize them, do not rewrite from scratch.

## Conventions

- Hourly resolution everywhere. Energy in kWh per hour, power in kW, money in dollars.
- Load timestamps are **local clock time** (DST shifts). Solar profiles are **local standard
  time**, 8760 entries, index `(dayOfYear-1)*24 + hour`, Feb 29 dropped. The engine maps
  clock → standard when looking up solar (see `engine.js`).
- Typed arrays (`Float64Array`) for hourly series. Plain objects for everything else.
- Every module exports named functions plus a `default` object of the same functions.
- Every function that consumes user data must work offline (except weather/geocode fetches,
  which must fail with a clear message and never block the rest of the UI).

## Shared state (app/state.js) — the single source of truth

```js
state = {
  site:   { lat, lon, elevationM, tz, utilityId /* "sce"|"pge"|"sdge" */, addressLabel /* display only, never persisted */ },
  roof:   { planes: [ Plane ] },
  load:   LoadSet | null,
  flex:   [ FlexLoad ],              // flexible loads detected or user-defined
  solar:  { byPlane: { [planeId]: SolarProfiles } , weatherYears: [..], status },
  tariff: { utilityId, planId, providerId, custom: Tariff | null },
  system: { panelW: 460, battKWh: 10, battKW: 5, rte: 0.9, minReserve: 0.2,
            strategy: "tou_arbitrage", gridCharge: false, exportThreshold: 0.5, ngom: false,
            maxBatteries: 6, override: { panelsByPlane: null, batteries: null } },
  fin:    FinanceInputs,             // see finance.js DEFAULTS + financing block below
  ui:     { tab, basis, season, weatherKey, objective }
}
```

State is serialized to `location.hash` (only non-default values) and to `localStorage`
(`rooftop-roi:v1`) so a reload keeps the session. The load data itself is kept in
IndexedDB (`rooftop-roi`, store `loads`) because it is ~1 MB; the user can clear it with one
button ("Forget my data").

### Plane
```js
{ id: "p1", name: "South face", tilt: 20, azimuth: 180, maxPanels: 30,
  shading: { annual: 0.0 } | { monthly: [12 fractions lost] },
  costAdder: 0,                       // $ one-time for building on this face
  polygon: [[lat,lon],...] | null,    // from the map tracer, optional
  gutterEdge: [i, j] | null }         // indices into polygon of the low edge
```

### LoadSet (core/greenbutton.js output)
```js
{ meta: { source: "sce-csv"|"pge-csv"|"sdge-csv"|"espi-xml"|"generic-csv", tz, start, end,
          nHours, totalKwh, intervalMinutes /* original */, gapsFilled: [...], notes: [] },
  ts:  string[],          // "YYYY-MM-DDTHH:00" local clock time, hour start, one per hour
  kwh: Float64Array,      // delivered (import) kWh per hour
  exportKwh: Float64Array | null }   // received kWh if the meter already has solar
```
DST: a fall-back duplicated hour is summed into one slot; spring-forward days have 23 slots.
15-minute data is summed to hours. Gaps ≤ 3 h are interpolated from the same hour on adjacent
days and listed in `meta.gapsFilled`; longer gaps are left as NaN and reported.

### FlexLoad (core/flexload.js)
```js
{ id: "ev1", kind: "ev"|"pool"|"custom", name: "Tesla Model Y",
  source: "detected"|"manual",
  kwhByHour: Float64Array | null,     // detected portion of the recorded load (same length as load.kwh)
  annualKwh: 3582,                    // for manual loads, or the detected total per year
  detection: { method, chargerKW, sessions: [{date,startHour,kwh,hours}], confidence } | null,
  schedule: {
    mode: "asRecorded" | "spread",
    daysPerWeek: 5,                    // spread: charging days in fixed priority Mon..Sun
    window: [8, 15],                   // daytime window, clock hours
    daylightFraction: 0.9,             // share of each day's kWh inside the window
    overnightWindow: [1, 5],
    maxKW: 8,                          // charger / appliance cap per hour
    followSolar: true                  // weight window hours by the solar shape
  },
  scale: 1.0 }                         // multiplies annualKwh (e.g. "drive 20% more")
```
The engine subtracts every detected `kwhByHour` from the recorded load to get the base
load, then adds each flex load back at its scheduled hours. A second EV is just another
FlexLoad with `source: "manual"` and the same schedule. Pool pump = `kind: "pool"` with a
flat draw inside its window. Energy is conserved exactly per week.

### SolarProfiles (core/pv.js output, per plane)
```js
{ tilt, azimuth, profiles: { tmy?: Float64Array(8760), "2015": Float64Array(8760), ... },
  annualPerKw: { "2015": 1677.8, ... }, percentiles: { p10Year, p50Year, p90Year },
  model: { losses: 0.14, dcAcRatio: 1.2, invEff: 0.96, tempCoeff: -0.0035, notes } }
```
kWh AC per kW DC. P90 = low-sun conservative year, P10 = high-sun year (industry exceedance
convention). Shading is applied by the engine from `plane.shading`, not baked in here.

### Tariff (data/tariffs/<utility>.json)
Schema is exactly `data/tariffs/sce.json` (documented in `docs/tariffs-sce.md`):
`meta`, `providers`, `plans[]` with `schedule[season][weekday|weekend][24]` period ids and
`rates[season][period][providerId]` total $/kWh, `nbt.export_rates.{weekday,weekend}[12][24]`,
`incentives`. Additions for the library:
- top-level `utility: { id, name, states: ["CA"], zipPrefixes: ["913","917",...], website }`
- `plans[].eligibility` and `plans[].default: true` for the utility's default residential plan
- `meta.rates_effective`, `meta.sources[]`, and `meta.confidence` per section are mandatory.
`core/tariff.js` exposes `loadLibrary()`, `forZip(zip)`, `plan(t, id)`, `rateAt(t, plan, provider, date, hour)`,
`exportRateAt(t, date, hour)`, `validate(t)` (also used by `tests/validate-tariffs.mjs`), and
`fromBill({...})` to build a custom tariff from a form.

## core/engine.js API (generalize the prototype)

```js
prepare({ load: LoadSet, tariffs: Tariff }) → ctx            // calendar, periods, rates
buildScenario(ctx, params) → scn                              // load reshaping, PV per hour
runHours(scn, params, detail) → result                        // hourly dispatch + NBT bill
simulate(ctx, params, { detail }) → result + baselines
billPeriod(ctx, params, start, end) → bill replay for validation
```
`params` (all optional, defaults in `DEFAULTS`):
```js
{ planes: [{ id, profile: Float64Array(8760), panels, shading }], // panels per plane
  panelW, batteries, battKWh, battKW, rte, minReserve,
  flex: [FlexLoad], baseLoadScale: 1,
  planId, providerId, weatherKey, strategy, gridCharge, exportThreshold, ngom, accPlusAdder,
  climateCredit }
```
`result` keeps every field the prototype returns (bill, monthly, importKwh, exportKwh, pvKwh,
selfSufficiency, cycles, exportRevenue, importSavings*, typicalDay, periodCost, forfeitedCredit)
plus `pvKwhByPlane`. Baselines: `baselineSameFlex` (no system, same flex schedule) and
`baselineAsRecorded` (today's actual bill).

Dispatch strategies (unchanged): `self_consumption`, `tou_arbitrage`, `export_arbitrage`,
`backup_only`; grid charging flagged as not permitted under NBT paired storage.

## core/optimizer.js

`searchGrid(ctx, params, { maxPanelsTotal, maxBatteries, planeCaps })` sweeps total panels ×
batteries; panels are allocated across planes **greedily by marginal annual value** (simulate
one panel on each plane, fill the best plane until its cap, then the next). Returns cells with
`panelsByPlane`. `priceGrid(grid, fin, basis)` re-prices with finance only (must stay ~15 ms).
Objectives: max NPV, min lifetime cost, max IRR, fastest payback.

## core/finance.js — financing

Add to `DEFAULTS`:
```js
financing: {
  mode: "cash" | "loan" | "lease",
  loan:  { sharePct: 1.0, apr: 0.0699, termYears: 15, dealerFeePct: 0.0 },   // dealer fee inflates principal
  lease: { monthly: 180, escalatorPct: 0.029, termYears: 25, buyout: 0 }       // lease/PPA: no upfront, payments instead
}
```
Cash flows: cash = year-0 outlay; loan = down payment at year 0 plus level annual payments
(monthly amortization summed) for the term, principal = netCost × share × (1 + dealerFee);
lease = annual payments escalating, buyout at end, no ownership incentives, system savings
still accrue. All three report NPV vs investing, IRR (where defined), payback, wealth at
horizon, and monthly cash-flow-vs-current-bill for the first year ("is my monthly outlay
lower than today's bill?"). Existing incentive modes (none / discount / vendor pass-through)
remain and apply to the price before financing.

## UI (app/)

Landing (before data): what the tool does in three sentences, a privacy statement that is
literally true (list the exact network calls), a drop zone for Green Button XML/CSV, a
"Try the demo household" button, and a location field (address → geocode, ZIP, or click the map).

App (after data): one screen, tabs, no page scroll at desktop height (each tab scrolls
internally if it must). Tabs: **Home** (headline result tiles + optimum), **Roof** (roof builder),
**Loads** (detected flexible loads, schedules, add EV/pool/custom), **System** (heatmap, slices,
overrides, strategy), **Bills** (before/after by month, plan and provider tables, bill replay
check), **Money** (cash flow vs investing, financing knobs, tornado, break-evens), **Assumptions**
(method, sources, data quality, rate effective dates). Controls live in a left rail that
changes per tab; results re-render live (finance-only changes instant; simulation changes
debounced, run in a Blob worker with a main-thread fallback).

Roof builder paths (all produce `roof.planes`): **Simple** (one face: pitch picker with gable
icons 2°/4:12/6:12/9:12/12:12 or degrees, direction dial, max panels), **Trace on map**
(Leaflet + Esri World Imagery; click corners, click the gutter edge → azimuth; pitch picker;
panels auto-laid at real module size with setbacks, count editable; shading 4-step), **From
installer proposal** (panels per face + installer annual kWh → calibration factor shown).

Design: reuse `docs/reference-styles.css` tokens (IBM Plex Sans/Mono, light + dark via
tokens), dataviz conventions from the prototype. Mobile: tabs stack, charts shrink; the map
tracer may require desktop and say so.

## Tests

`node --test tests/` must pass in CI. Each core module ships its own `*.test.mjs`. Fixtures:
`tests/fixtures/load-agoura-hills.json` (prototype LoadSet + detected EV), `tests/fixtures/solar-agoura-hills.json`
(prototype profiles at tilt 20 / az 169-180 grid) — the JS PV model must reproduce the fixture's
annual kWh/kW within 3% and monthly shape within 10%, and the engine must still replay the
reference bill ($749.41 vs $749.37, see `data/tariffs/sce.json` meta.bill_validation).

## Not now (recorded so nobody builds it by accident)

- Google Solar API roof import (needs a user key) — a fourth roof path later.
- Opt-in sharing of chosen configurations to a Supabase table — a later, clearly opt-in
  feature; the architecture keeps a single `state` object so a "share my scenario" call is one
  function if it ever happens.
