# `data/tariffs/*.json` — the tariff schema, field by field

One file per utility: `sce.json`, `pge.json`, `sdge.json`. Loaded by `core/tariff.js`
(`loadLibrary()`), consumed by `core/engine.js`, gated in CI by `tests/validate-tariffs.mjs`.

The schema **is** `data/tariffs/sce.json`. That file was calibrated line by line against a
real customer bill (`meta.bill_validation` replays $749.41 to four cents), so when the two
disagree, the SCE file wins and this document is wrong. `pge.json` and `sdge.json` replicate
its structure exactly, with two additions that the SCE file predates: the top-level
`utility` block and `plans[].default`.

---

## Two invariants the whole app leans on

**1. `rates[season][period][providerId]` is the FULL retail $/kWh.** Delivery + generation +
every volumetric surcharge, for that provider's customer, in that hour. It is not a component
to be summed with anything. This is why a CCA customer's number can legitimately be *higher*
than the bundled utility's — the CCA customer pays the PCIA and franchise-fee stack that a
bundled customer never sees as a separate line because it is already inside the bundled rate.

**2. Every `[season][period]` cell resolves, including the ones the schedules never emit.**
Most plans have no super-off-peak in summer and no on-peak in winter. Those cells are still
present, filled with the nearest real period (summer `super_off` = summer `off`; winter `on` =
winter `mid`), and the filler is documented in `meta.notes`. A lookup therefore can never
miss, and a correct simulation never reads the filler because the 24-hour schedule arrays
never name it. `tests/validate-tariffs.mjs` sweeps every (plan × provider × month × daytype ×
hour) combination to prove it.

---

## Top level

```
{ utility, meta, providers, plans[], nbt, incentives }
```

---

## `utility` — identity and geography

| field | type | notes |
|---|---|---|
| `id` | string | `"sce"` / `"pge"` / `"sdge"`. Must equal the filename stem and `state.site.utilityId`. |
| `name` | string | Display name, e.g. `"Pacific Gas and Electric"`. |
| `states` | string[] | `["CA"]` for all three. |
| `zipPrefixes` | string[] | 3-digit (or 5-digit) ZIP prefixes in the electric service territory. **Overlapping between IOUs is normal** — PG&E and SCE share several 93x prefixes. `utilityForZip()` returns `ambiguous: true` with all candidates, and the UI must ask. 5-digit entries win over 3-digit ones. |
| `website` | string | Rate-plan landing page. |
| `baselineRegions` | object | Optional; see below. |

### `utility.baselineRegions`

```jsonc
{
  "note": "what these are and how confident we are",
  "summer_months": [6,7,8,9],
  "allocations": {
    "9": { "summer": 16.9, "winter": 12.0, "summer_all_electric": 12.5, "winter_all_electric": 13.9,
           "label": "Region 9 - moderate inland" }
  },
  "zipHints": { "913": ["6","9"], "917": ["8"] }
}
```

- `allocations[region]` — kWh **per day**. `summer` and `winter` are the *basic* (non-all-electric)
  allocations and are required and positive. `*_all_electric` are optional.
- `zipHints[prefix]` — a 3- or 5-digit ZIP prefix mapped to one region id or an array of them.
  Every region named must exist in `allocations`. **These are hints, not tariff facts**: the
  IOUs assign baseline by premises, not by ZIP, and several cities straddle a boundary. The
  UI must let the user override. `baselineRegionForZip()` returns `ambiguous: true` when a
  prefix maps to more than one region.
- Baseline only has a price effect on plans with a non-zero `baseline_credit_per_kwh`
  (SCE TOU-D-4-9PM / 5-8PM, PG&E E-TOU-C). On every other plan the region is economically
  irrelevant and the UI should say so rather than demanding an answer.

---

## `meta` — provenance

| field | type | required | notes |
|---|---|---|---|
| `as_of` | `YYYY-MM-DD` | yes | When the file was researched. |
| `rates_effective` | `YYYY-MM-DD` | **yes (error)** | The effective date printed on the rate source. Not the research date. |
| `sources[]` | array | **yes (error)** | `{ title, url, used_for }`. `url` is required; `used_for` must say which numbers came from it. `local:` URLs are allowed for a customer bill. |
| `confidence` | object | yes (warning) | Per-section `high` / `medium` / `low`, either as a bare string or `{ level, note }`. Section keys are free-form but should at minimum cover `rates`, `schedules`, `baseline`, `fixed_charge`, `export_rates`, `providers`. |
| `climate_credit` | object | yes (warning) | `{ amount, months: [1-12] }`. `amount` is **per appearance**, not per year — the utilities now split the credit across two bills. `climateCredit()` returns `annual = amount × months.length`. |
| `baseline_region` | string | no | The region the file's `baseline_kwh_per_day` describes. |
| `baseline_kwh_per_day` | `{summer, winter}` | no | Fallback allocation when no region is chosen. |
| `escalation` | object | no | `{ historical_cagr, period, recommended_default, note }`, feeds `finance.js`. |
| `bill_validation` | object | no | Present only where a real bill anchored the file (SCE). See below. |
| `notes` | string | yes in practice | The long-form prose that explains every derivation, every filler cell, and every known weakness. Read it before trusting a number. |
| `custom` | bool | no | Set by `fromBill()`. Never in a shipped file. |

### `meta.bill_validation`

The replay contract. `tests/tariff.test.mjs` recomputes the bill from the rate tables alone and
asserts it reproduces `model_reproduces_bill.model_total`:

```
Σ_period kwh[period] × rates[season][period][provider]
  + days × fixed_charge_per_day
  + generation_municipal_surcharge_factor × (CCA generation charges)
  + cpa_energy_surcharge_per_kwh × total kWh
  − climate_credit.amount
```

For SCE this lands on **$749.41** against an actual **$749.37** (0.01%, residual is kWh
rounding). If a future rate edit breaks that, the edit is wrong.

---

## `providers` — who sells the generation

```jsonc
"providers": {
  "pge":  { "name": "PG&E bundled", "default": true },
  "mce":  { "name": "MCE Light Green (default tier)", "tier": "Light Green",
            "service_area": "Marin, Napa, unincorporated Contra Costa, ...",
            "zipPrefixes": ["949","945"] }
}
```

`name` is required. The bundled utility's key equals `utility.id`. Everything else is optional
metadata for the provider picker. `default: true` marks the provider a customer is on unless
they opted out; with none marked, `defaultProvider()` falls back to `utility.id`.

**Every provider key must be priced in every rate cell of every plan.** `validate()` treats a
missing provider column as an error, because a provider switch in the UI would otherwise throw
mid-simulation. Where a CCA does not publish a rate for a plan, the file must still carry a
derived number and say so in `meta.notes`.

---

## `plans[]` — the rate schedules

| field | type | notes |
|---|---|---|
| `id` | string | Stable key, e.g. `"E-TOU-C"`, `"TOU-D-4-9"`. Unique within the file. |
| `name` | string | What the utility calls it on a bill, e.g. `"TOU-D-4-9PM"`. |
| `default` | bool | Exactly one plan per file must be `true` — the utility's default residential plan. |
| `eligibility_note` | string | Who may take it (EV required, all-electric required, closed to new enrollment, …). |
| `summer_months` | int[] | 1-12. SCE and PG&E: `[6,7,8,9]`. SDG&E: `[6,7,8,9,10]`. |
| `fixed_charge_per_day` | number ≥ 0 | The CPUC income-graduated fixed charge (D.24-05-028) as that utility implemented it, converted to $/day. Unavoidable, **not** offset by exports — it floors the bill. |
| `minimum_charge_per_day` | number ≥ 0 | 0 where the fixed charge replaced the old minimum bill. A real 0, not a placeholder. |
| `baseline_credit_per_kwh` | number ≥ 0 | Credit applied to usage up to the daily baseline allocation. Stored **positive**; the engine subtracts it. Rates in this file are **pre-credit**. |
| `period_ids` | string[] | The ids this plan may use, from `["on","mid","off","super_off"]`. |
| `schedule` | object | `schedule[season][daytype][hour]` → period id. |
| `rates` | object | `rates[season][periodId][providerId]` → total $/kWh. |

### `plans[].schedule`

```
schedule.summer.weekday  = [24 period ids]   // index = hour-BEGINNING, 0..23, local clock
schedule.summer.weekend  = [24 period ids]
schedule.winter.weekday  = [24 period ids]
schedule.winter.weekend  = [24 period ids]
```

All four arrays are required, each exactly 24 entries, each entry a member of `period_ids`.
**Holidays bill the weekend schedule** — `core/tariff.js` handles that, the file carries no
holiday table. The eight: New Year's Day, Presidents' Day, Memorial Day, Independence Day,
Labor Day, Veterans Day, Thanksgiving, Christmas. Fixed-date holidays are matched on both the
actual and the *observed* date (Sat → the Friday before, Sun → the Monday after), so a
Monday can be a weekend day.

Hour index is **hour-beginning in local prevailing (clock) time**, DST included. Index 16 is
4–5 p.m.

#### Seasonal sub-periods (SDG&E)

SDG&E prices a weekday super-off-peak window in **March and April only** (10 a.m.–2 p.m.).
The `summer`/`winter` split cannot express a two-month window, so `sdge.json` carries an
optional per-plan override:

```jsonc
"schedule_overrides": [
  { "months": [3,4], "daytype": "weekday", "hours": [10,11,12,13], "period": "super_off",
    "note": "SDG&E's March/April weekday 10am-2pm super-off-peak" }
]
```

`periodAt()` applies any matching override after the base lookup. An override may only emit a
period id that is in `period_ids` and priced in `rates`.

### `plans[].rates`

```jsonc
"rates": {
  "summer": {
    "on":   { "pge": 0.62, "mce": 0.61, "svce": 0.60, "delivery": 0.35, "pge_generation": 0.27 },
    "mid":  { ... }, "off": { ... }, "super_off": { ... }
  },
  "winter": { ... }
}
```

Every provider id in `providers` must appear in every cell, as a finite number `> 0`.
`validate()` warns outside $0.03–$2.00/kWh.

`delivery` and `<utility>_generation` are **optional diagnostic columns**, not providers —
they let the Bills tab explain the split and let a CCA's total be re-derived. They are not in
`providers`, so `providersOf()` filters them out and `validate()` does not require them.

---

## `nbt` — Net Billing Tariff ("NEM 3.0") export economics

| field | type | notes |
|---|---|---|
| `vintage` | string | e.g. `"2026"` / `"NBT26"`. The tariff year a PTO date locks into. |
| `lock_in_years` | int | 9 for all three IOUs. |
| `export_rates.weekday` | `[12][24]` | $/kWh export credit, month index 0=Jan, hour index 0..23 hour-beginning, local prevailing time. |
| `export_rates.weekend` | `[12][24]` | Same, for Saturdays, Sundays **and holidays**. |
| `export_rates.note` | string | What the numbers are and where they came from. |
| `acc_plus_adder_per_kwh` | number | The ACC Plus adder for this vintage, paid **on top of** the matrix. Not baked in. |
| `acc_plus_schedule` | object | Optional `{ "2023": 0.04, ... }` by vintage year, non-equity residential. |
| `net_surplus_compensation_per_kwh` | number ≥ 0 | Paid for energy left over at the annual true-up. Roughly a third of the clawback rate, which is why oversizing is penalised. |
| `nonbypassable_charges_per_kwh` | number ≥ 0 | $/kWh of **import** that solar cannot escape. **Already inside the rate tables** — do not add it on top. Recorded only so the UI can show which part of the price is unavoidable. |
| `true_up` | string | `"annual"`. |
| `notes` | string | The long-form explanation: matrix shape, the lock-in trajectory, battery export caps, grid-charging prohibition. |

Matrix values are the **total** export credit (generation component + delivery component).
For a CCA customer the total is unchanged; it simply arrives split across two bills.

`exportRateAt(t, date, hour)` returns the raw matrix value. Pass `{ includeAdder: true }` to
add the ACC Plus adder.

> `sce.json` has no `acc_plus_adder_per_kwh` field — its value ($0.016 for the 2026 vintage)
> is stated in `nbt.notes` prose. That file is frozen, so `core/tariff.js` carries the value
> in `ACC_PLUS_FALLBACK` and `validate()` warns. New files must carry the field.

---

## `incentives`

| field | notes |
|---|---|
| `federal_itc_residential_pct` | 0.0 for 2026 — §25D terminated for expenditures after 2025-12-31. |
| `federal_itc_note` | Why, including the §48E third-party-ownership path that still pays 30%. |
| `sgip_residential_per_kwh` | 0.0 — all ratepayer-funded SGIP budgets closed 2025-12-30. |
| `sgip_note` | Including the RSSE remnant. |
| `other[]` | `{ name, value, note }` for utility/CCA rebates and demand-response programs. |

---

## `core/tariff.js` API

| function | returns |
|---|---|
| `loadLibrary(baseUrl?, ids?)` | `{ utilities: { sce, pge, sdge }, errors[], ids[] }`. fetch in the browser, `fs` in Node. A failed file lands in `errors`, it does not reject. |
| `utilityForZip(zip, lib)` | `{ utilityId, utility, ambiguous, candidates[] }` or `null`. |
| `baselineRegionForZip(t, zip)` | `{ region, regions[], ambiguous, allocation, zipPrefix }` or `null`. |
| `baselineAllocation(t, region)` | `{ summer, winter, … }`, falling back to `meta.baseline_kwh_per_day`. |
| `plan(t, id)` | Plan object, case-insensitive on `id` then `name`; `null` if absent. `plan(t)` = default. |
| `defaultPlan(t)` | The `default: true` plan, else `plans[0]`. |
| `providersOf(t, plan)` | Provider ids this plan actually prices (filters the diagnostic columns). |
| `defaultProvider(t)` | The `default: true` provider, else `utility.id`. |
| `seasonOf(plan, month)` | `"summer"` / `"winter"`. |
| `periodAt(plan, date, hour)` | `{ season, dayType, period, holiday, month, hour, dow }`. |
| `rateAt(t, plan, providerId, date, hour)` | Total $/kWh. Throws on a missing cell — a miss is a bug, not a zero. |
| `rateDetailAt(...)` | The same plus period context and the baseline credit. |
| `exportRateAt(t, date, hour, opts?)` | $/kWh export credit; `{ includeAdder: true }` adds ACC Plus. |
| `exportMatrix(t, dayType)` | The raw `[12][24]`. |
| `accPlusAdder(t)` | $/kWh. |
| `fixedChargePerDay(t, plan)` | $/day. |
| `minimumChargePerDay(t, plan)` | $/day. |
| `climateCredit(t)` | `{ amount, months[], annual }`. |
| `netSurplusRate(t)`, `nonBypassablePerKwh(t)` | $/kWh. |
| `validate(t)` | `{ ok, errors[], warnings[] }`. |
| `fromBill(spec, lib)` | A complete custom Tariff, `meta.custom: true`. |
| `describe(t, plan, providerId?)` | `{ title, lines[], table[], text }` — plain language for the UI. |
| `holidaysForYear(y)`, `isWeekendOrHoliday(date)`, `partsOf(date, hour)` | Calendar helpers. |

Dates accept a `Date`, `"YYYY-MM-DD"`, `"YYYY-MM-DDTHH:MM"`, or `{ y, m, d, h }`. Strings are
read as local wall-clock and never passed through `Date` parsing, so a date string cannot
slide a day on a machine east of Greenwich.

### `fromBill(spec, lib)`

```js
fromBill({
  utilityId: "pge", planId: "E-TOU-C", providerId: "pge",
  periods: { summer: { on: 0.61, off: 0.48 }, winter: { on: 0.49, off: 0.44 } },
  fixedPerDay: 0.0,           // optional
  minimumPerDay: 0.39,        // optional
  baselineCreditPerKwh: 0.10, // optional
  climateCredit: { amount: 55.17, months: [4, 10] },  // optional
  label: "My April bill",
}, lib);
```

Everything the user does not supply is inherited from the library plan, so the schedule, the
seasons, the export matrix and the NBT mechanics stay real — only the prices they typed are
substituted. Other providers' columns are shifted by the same delta so a later provider
switch still works. The result is a complete Tariff object; `engine.js` cannot tell it from a
shipped one except by `meta.custom`. `meta.custom_fields.substituted` / `.inherited` list
which cells the user actually set, so the UI can say so.

---

## `validate()` — what is an error and what is a warning

**Errors** (CI fails): missing `utility` block or any of its required fields; malformed ZIP
prefixes; missing/malformed `meta.rates_effective`; empty `meta.sources[]` or a source with no
`url`; a `meta.confidence` level that is not high/medium/low; a malformed `climate_credit`;
an empty `providers` or a provider with no name; empty `plans[]`; zero or more than one
`default: true` plan; duplicate plan ids; a bad `summer_months`; a negative fixed/minimum/
baseline-credit; a schedule array that is not exactly 24 entries or that emits an id not in
`period_ids`; a rate cell that is missing, non-numeric or ≤ 0 for any declared provider;
an export matrix that is not 12×24 or contains a negative or non-numeric value; a negative
NSC or NBC; a `zipHints` entry naming a region with no allocation.

**Warnings** (reported, do not fail unless `--strict`): no `meta.confidence`; no
`utility.website`; a source with no `used_for`; no `baselineRegions`; a rate outside
$0.03–$2.00/kWh; an export value above $3/kWh; a missing `acc_plus_adder_per_kwh`.

`tests/validate-tariffs.mjs` additionally sweeps every (plan × provider × month × sampled day
× hour) and every export-matrix cell through the real lookup functions, so a hole that the
structural check misses still fails CI.

---

## Adding a utility

1. Copy the structure of `sce.json`. Keep the key order — it is the reading order.
2. Fill `meta.sources[]` **as you go**; a number with no source does not belong in the file.
3. Fill every unused `[season][period]` cell with the nearest real period and say so in
   `meta.notes`.
4. Mark exactly one `plans[].default`.
5. Run `node tests/validate-tariffs.mjs --strict` and `node --test tests/`.
6. Write `docs/tariffs-<id>.md`: sources, effective dates, the tables you pulled, a confidence
   level per section, and — most important — **what you could not find**.
