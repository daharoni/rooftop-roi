# Synthetic load (the "I only have my bills" path)

`core/synthload.js` turns twelve monthly kWh totals into an hourly LoadSet. The engine
cannot tell it from a parsed Green Button file: same `ts` strings ("YYYY-MM-DDTHH:00",
local clock time), a `Float64Array` of kWh, `exportKwh: null`. It is marked by
`meta.source: "synthetic"`, and `meta.notes` carries the plain-English caveats.

```js
synthesize({ monthlyKwh: number[12] /* Jan..Dec */, tz, endMonth /* "YYYY-MM" */, utilityId })
seasonalSplit(annualKwh) // -> number[12], for someone with one yearly figure
```

The twelve months end at `endMonth` (default: last complete month). Entry 0 is always
January, whichever months the span covers. Each month's hours add up to its input to
within floating-point error (tests check 0.01 kWh).

## What the shapes are

For every calendar month there is a weekday and a weekend 24-hour profile, each summing
to 1, plus the ratio of a weekend day's energy to a weekday's. A month's kWh is split
over its days by that ratio, then each day over its hours by the profile. Weekdays and
weekends follow the calendar; holidays count as weekdays (we do not guess).

The numbers come from the demo household (`data/demo/*.csv`, a real SCE home in Agoura
Hills) with the detected EV subtracted. `tests/tools/derive-synth-shapes.mjs` makes
them; re-run it and paste the output into `core/synthload.js` if the demo data changes.
Only shapes are kept. The home's own kWh are not. `seasonalSplit` uses the same
household's month-to-month pattern.

Daylight-saving days match the parser: the spring-forward day has 23 slots, the
fall-back day has 24 slots with the 01:00 slot carrying two real hours (so it gets
double weight). US rules only; Arizona and Hawaii zones get no DST.

## Limits

- **One home's pattern.** The shape is one household's. Homes with different routines
  (someone home all day, night-shift work, a home office) will differ.
- **No inland air-conditioning homes.** The source is coastal-valley Southern California.
  A Palm Springs or Central Valley house with a summer afternoon peak three times its
  winter load is not represented. Its monthly totals are honoured, but the hours inside
  a hot month will be too flat.
- **No EV unless added as a flex load.** The EV was removed from the shape on purpose.
  The bill form's EV and pool answers become flex loads (Loads tab), which add their own
  hourly pattern on top. If the bills already include charging, the base load is
  over-counted by that amount and the user should say so.
- **No heat pump, pool or electric heat by default.** Same reason.
- **Weekday/weekend and month shapes are noisy.** Two years of one home. Differences
  between neighbouring months are partly real and partly luck.

## Why results from bills are less certain

A battery and solar system earn money in specific hours: panels produce at midday, a
battery shifts evening use, time-of-use rates differ by hour. Bills only say how much was
used in a month, not when. Two homes with the same bill can have very different hourly
shapes, so the self-consumption, export and rate-plan figures here are estimates around
a typical pattern. Monthly totals, and so the size of the bill, are exact. Expect the
savings number to be less reliable than from interval data, and the dashboard should say
so whenever `meta.source === "synthetic"`. A Green Button file replaces all of this with
the home's own hours.
