# Demo household — Agoura Hills, CA 91301

The two CSVs in this folder are the dataset behind the **"Try the demo household"**
button on the landing page. They are a **real** Southern California Edison
household's hourly interval export, scrubbed of everything that identifies it.

| | |
|---|---|
| Location | Agoura Hills, CA — ZIP **91301** (Los Angeles County) |
| Utility | **Southern California Edison** (SCE), bundled service |
| Rate plan | **TOU-D-PRIME** (the EV / electrification time-of-use plan) |
| Dwelling | Single-family home, no existing solar, no battery |
| Flexible load | **One electric vehicle** on a ~8 kW Level 2 charger |
| Coverage | **2024-09-01 00:00 → 2026-09-09 23:00** local clock time, two years |
| Hours | 17,734 (739 days; two of them 23 hours long — see DST below) |
| Total import | **26,878.49 kWh** (≈ 13,285 kWh/yr) |
| Export | none — `Received` is 0.000 kWh in every row |

## Files

| File | Covers | Rows |
|---|---|---|
| `demo-sce-usage-2024-09.csv` | 2024-09-01 → 2025-08-31 (365 days) | 8,760 readings → 8,759 hourly slots |
| `demo-sce-usage-2025-09.csv` | 2025-09-01 → 2026-09-10 (374 days) | 8,976 readings → 8,975 hourly slots |

The two files do not overlap; `mergeLoadSets()` concatenates them into the
17,734-hour LoadSet that `tests/fixtures/load-agoura-hills.json` records.

## What was scrubbed

These are the utility's own export files with the identifying header fields
replaced, and nothing else changed:

- the customer name and street address were replaced with `DEMO HOUSEHOLD` — the
  city, state and ZIP were kept, because the ZIP is what picks the tariff and the
  coordinates are what drive the solar model;
- the service-account and meter numbers were removed from the preamble and from
  the filenames (the originals were named `SCE_Usage_<account>_<from>_to_<to>.csv`);
- the interval readings themselves are untouched, so the bill replay in
  `data/tariffs/sce.json` (`meta.bill_validation`) still reconciles.

`core/greenbutton.js` discards the remaining header fields at parse time anyway:
a LoadSet's `meta` carries only `zip` and `utilityHint`, never a name, address,
account or meter number. `tests/greenbutton.test.mjs` asserts that.

## Format quirks these files exercise

They are kept as-is precisely because a real SCE export is messier than the
documentation suggests, and the parser has to survive all of it:

- 12 lines of preamble, one of which (`"For location: …`) opens a double quote it
  never closes;
- every field padded with **U+00A0** (non-breaking space), not a normal space;
- 12-hour times with and without a leading zero in the same file
  (`01:00AM` in the morning, `1:00PM` in the afternoon);
- `12:00AM` = midnight, `12:00PM` = noon;
- a UTF-8 BOM may be present depending on how the file was downloaded;
- **DST fall-back**: the day has 25 readings and one clock-hour label appears
  twice. The two readings are **summed** into one hourly slot
  (2024-11-03 04:00 and 2025-11-02 10:00 in these files — the duplicated label is
  wherever the meter's own read cycle put it, not necessarily 01:00);
- **DST spring-forward**: the day has 23 readings and one clock hour simply does
  not exist (2025-03-09 and 2026-03-08 here). That missing hour is *not* a gap and
  is not interpolated.

There are **no data gaps** in either file: `meta.gapsFilled` is empty and
`meta.quality.missing` is 0.

## What the detector finds in it

`core/flexload.js` `detectEV()` on the merged LoadSet:

| | |
|---|---|
| EV energy | 7,247.3 kWh total, **3,582 kWh/yr** (27% of the house) |
| Charger | **8.02 kW** (consistent with a 32 A / 240 V Level 2 wall connector) |
| Sessions | **254** — 2.41 per week, median 26.6 kWh |
| Daytime charging today | 341 kWh, 4.7% of the EV's energy |

That is the whole point of the demo: a household that charges an EV roughly two
and a half nights a week, in one ~27 kWh lump at 4-6 AM, is the household solar
plus a battery changes the most — and the **Loads** tab lets you move that energy
into the middle of the day and watch the bill move with it.

No pool pump is detected (`detectPool()` returns `null`); this house does not
have one.

## Reusing it

```js
import GB from "../core/greenbutton.js";
import FL from "../core/flexload.js";

const load = GB.mergeLoadSets([
  GB.parse(await (await fetch("data/demo/demo-sce-usage-2024-09.csv")).text()),
  GB.parse(await (await fetch("data/demo/demo-sce-usage-2025-09.csv")).text()),
]);
const ev = FL.detectEV(load);
```

Nothing in this folder leaves the browser, and neither does a file a visitor
drops on the page: the demo files are fetched from the same static origin as the
app and parsed in the tab.
