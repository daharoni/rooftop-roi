# Rooftop ROI

**Does rooftop solar plus a battery beat leaving the same cash in the market?**

Rooftop ROI answers that for your house, using your own utility interval data. It simulates
every hour of your last one to two years with a candidate solar array and battery, bills
each hour under California's Net Billing Tariff (NEM 3.0) rules, searches for the array and
battery size that maximizes net present value, and compares the result with investing the
same money at a return you choose. Cash, loan, and lease financing are all modeled.

Live site: https://daharoni.github.io/rooftop-roi/

## Your data never leaves this browser

The whole tool is a static page. There is no server and no account. Your meter data is parsed
and simulated in your browser and never sent anywhere. The page does make these network
requests, and this list is kept in step with the code by `tests/privacy-hosts.test.mjs`
(the single source is `app/privacy.js`):

- **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`): the IBM Plex typefaces on
  first load. Like any request it carries your IP address and the referring page.
- **cdnjs** (`cdnjs.cloudflare.com`): Chart.js on first load, and Leaflet when you open the map.
- **OpenStreetMap Nominatim** (`nominatim.openstreetmap.org`): the address you type, only if you
  use the address box.
- **Open-Meteo place search** (`geocoding-api.open-meteo.com`): the ZIP code you type, only if
  you use the ZIP box (or an address lookup falls back to its ZIP).
- **Open-Meteo elevation** (`api.open-meteo.com`): your coordinates rounded to 0.05° (~5 km).
- **Open-Meteo weather archive** (`archive-api.open-meteo.com`): the same rounded coordinates,
  eleven requests per location, then cached in this browser.
- **Esri satellite tiles** (`server.arcgisonline.com`): only while a map is on screen. Tile
  requests at tracing zoom reveal roughly which block you are looking at (about 75 m), along
  with your IP address.

No analytics, no uploads, no cookies.

**What is stored on this device.** Your meter readings and the downloaded weather are kept in
IndexedDB; your settings are kept in localStorage and in the URL. localStorage also holds the
roof outline you traced and your location at full precision (share links round it to two
decimals, ~1 km). A street address you type is never stored. "Forget my data" erases all of it.

**Sharing a scenario.** Every setting you change — prices, financing, roof faces, load schedules —
is packed into the URL after `#`, so the address bar is always a link that reproduces every setting
except traced roof outlines, custom tariffs and the existing-solar acknowledgement, which stay on this
device. "Share link" copies it. The link never contains your meter data; someone opening it adds
their own file, or, if you built the scenario on the demo household, the demo loads automatically.

## What you need

1. **Green Button data** from your utility: a year or more of hourly (or 15-minute) usage.
   - SCE: My Account → Usage → Download my data → Green Button "Download my data" (CSV).
   - PG&E: My Account → Energy Usage Details → Green Button → Export usage for a range (CSV or XML).
   - SDG&E: My Energy → Usage → Green Button Download (CSV or XML).
   Multiple files are merged. You can also try the built-in demo household (a real
   Agoura Hills home on SCE with one EV, address and account removed).
2. **Your location**: address, ZIP, or a click on the map. This picks the weather and the
   utility's tariff library.
3. **Your roof**: describe one face (direction and pitch), trace faces on the satellite map, or
   type the panel counts from an installer's proposal.

## What it models

- Hourly dispatch of solar and battery with four strategies (self-consumption, time-of-use
  arbitrage, export arbitrage into high-priced evening hours, backup only).
- Net Billing Tariff billing: hourly import at retail, export at the utility's Avoided Cost
  Calculator prices, monthly netting, annual true-up, export caps for paired storage, and the
  fixed charge floor. Tariff files for SCE, PG&E and SDG&E including the major community
  choice aggregators, each with its effective date and a confidence rating.
- **Flexible loads.** The tool detects EV charging in your history, subtracts it, and lets you
  put it back on a schedule that follows the sun (for example, spread over five days a week
  inside a daytime window). Pool pumps, water heaters, laundry, or a second EV can be added
  the same way. Moving flexible usage into solar hours is often worth more than an extra
  battery.
- Money: upfront cost, incentives and vendor pass-through discounts, cash / loan / lease,
  rate escalation, degradation, replacements, NPV against an investment return, IRR, payback,
  wealth at the horizon, break-even prices, weather sensitivity (P90 / P50 / P10 years), SCE's 150%
  interconnection sizing line drawn on the panel × battery grid, and a
  bill-replay check that shows how closely the tariff model reproduces a real bill.

## Running locally

No build step. Serve the folder over HTTP (ES modules do not load from `file://`):

```
python3 -m http.server 8000
# open http://localhost:8000/
```

Tests (Node 24):

```
node --test
node tests/validate-tariffs.mjs
```

If you edit anything in `core/`, regenerate the worker bundle:

```
node core/bundle-for-worker.mjs
```

## Adding or updating a tariff

Tariff files live in `data/tariffs/<utility>.json` and follow the schema in
`docs/tariff-schema.md` (`data/tariffs/sce.json` is the reference, calibrated against a real
bill). Every plan needs 24-hour period schedules for summer and winter weekdays and weekends,
total $/kWh per period per provider, the fixed charge, and the export-rate matrices. Record
`meta.rates_effective`, sources, and a confidence level. `node tests/validate-tariffs.mjs`
checks the file. Utilities change rates two or three times a year, so check the effective
date on the Assumptions tab and, if it is stale, use "Custom tariff from my bill".

## Layout

```
index.html         landing page and app shell
app/               UI (tabs, charts, roof builder, state persistence)
core/              pure logic: parsers, load detection, PV model, weather, tariffs,
                   hourly engine, optimizer, finance
data/tariffs/      tariff library     data/export/  NBT export matrices     data/demo/  demo household
tests/             node --test suites and fixtures
docs/              architecture contract, model notes, tariff notes
```

## Disclaimer

This is a planning tool, not financial or engineering advice. Utility rates, export prices,
incentives, and equipment costs change; the model makes documented simplifications (see the
Assumptions tab and `docs/engine.md`). Verify against installer proposals and your own bills
before deciding.

## License

MIT. Map tiles © Esri and contributors; geocoding © OpenStreetMap contributors; weather data
from Open-Meteo (CC BY 4.0).
