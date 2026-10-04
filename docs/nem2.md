# Existing solar: adding a battery on NEM 1 or NEM 2

A meter that already exports belongs to a home that already has solar, almost always on a
legacy net-metering agreement (NEM 1 or NEM 2) rather than the Net Billing Tariff the rest of
this tool models. For that household the useful question is not "how many panels?" but "is a
battery worth adding to the array I have?". This page says what the engine does to answer it
and, just as important, what it does not do.

## How the app gets there

When the meter's export is more than 1% of its import (`existingSolarShare` in
`app/main.js`), the landing notice offers two choices:

- **Model adding a battery to my existing solar.** A short form (`app/ui/existing.js`) asks
  for the array size in kW DC (0.5 to 50) and the agreement (NEM 2 by default, or NEM 1).
  The app stores `existing = { kwDc, planeId, nem }` and runs in battery-only mode.
- **Ignore the existing panels.** The old behaviour: import is treated as the whole usage,
  under Net Billing, with a red banner saying the results are not the real bill.

## What the engine does

`params.billing` is `"nbt"` (default), `"nem2"` or `"nem1"`. `params.existing` is
`{ planeId, panels }` or `null`; the app sends `panels = round(kwDc × 1000 / panelW)`.

**Usage is rebuilt.** The meter only sees what crosses it, so the household's own draw is

    gross load(hour) = import − export + existing PV(hour),   clipped at 0

with existing PV taken from the named plane's profile (the first plane if the id is unknown)
times the existing panel count, on the same clock-to-standard-time mapping the engine uses for
all solar. Our modelled output stands in for what the panels really made that hour; where the
model undershoots a sunny hour the sum can go negative, and it is clipped and counted
(`scenario.existing.grossClippedKwh` / `grossClippedHours`). Flexible loads are then handled as
usual on top of this gross load.

**The array is in every scenario.** Both baselines, `baselineSameFlex` and
`baselineAsRecorded`, are "existing solar, no battery": the existing plane never holds fewer
than the existing panels, in any run. So `savings*` is exactly what the battery adds. Results
carry `existingPanels`, `existingPvKwh` (annual kWh from the existing array) and `newPanels`
(always 0 in this mode); `panels` and `kwdc` are the whole array.

**The panel axis is fixed.** With `existing` set, the worker's `grid` message does not run the
panel sweep: `panelList = [existing.panels]`, every panel on the existing plane, and only the
battery count varies (0 to `maxBatteries`, at most 20). The result has the same shape as
`optimizer.searchGrid`.

**NEM billing (`settle()`).**

- Each exported kWh is credited at that hour's retail import price for the chosen plan and
  provider, less `nbt.nonbypassable_charges_per_kwh` on NEM 2. NEM 1 credits the full retail
  price. The import price used is the engine's own (`rates.imp`), so it includes any NBCs
  added with `applyNbc`, and the NEM 2 deduction takes them back out either way.
- Credits offset the month's energy charges down to, never below, the fixed charge plus the
  NBCs on that month's imported kWh (or the minimum charge, if higher). What does not fit
  rolls forward to the next month.
- At the annual true-up the net surplus kWh (exported minus imported over the relevant
  period, if positive) are paid at `nbt.net_surplus_compensation_per_kwh`, and whatever dollar
  credit is left is zeroed. It does not roll into the next year. The zeroed credit is reported
  in `forfeitedCredit`.
- No ACC export matrix, no ACC Plus adder, no ARECR debit, no paired-storage export cap, no
  CCA export adder.
- The battery never charges from the grid and never exports, whatever the dispatch controls
  say: a battery added to a NEM system is normally installed that way to keep the array's
  agreement.

**Money.** Under NEM the export credit is the retail price, so it rises with retail rates.
`exportRevenue` and `accPlusRevenue` are therefore 0 in NEM mode and the whole saving
escalates with retail in `core/finance.js`. The export dollars are still reported, for display:
`nemExportValue` (credits used plus the true-up payout) and `nscRevenue` (the payout alone).

## What is not modelled

- **The 10% / 1 kW rule.** Adding more than about 10% of the original array's capacity, or
  more than 1 kW, moves the whole system to Net Billing. This mode adds no panels at all, so
  the rule is never crossed; a household weighing more panels plus a battery should run the
  ordinary mode, which models the whole system under Net Billing.
- **The end of the legacy term** is modelled; see "When the term ends" below. What is not:
  the tariff of the day after the term is assumed to be today's Net Billing Tariff, priced on
  today's export matrix, with no ACC Plus adder.
- **CCA variants.** A Community Choice Aggregator runs its own NEM programme for the
  generation share of the bill: some credit generation at a premium, some cash out annually
  at a different rate, some on a different settlement month. The engine credits the bundled
  retail price of the chosen provider column and settles on the utility's true-up month.
- **Plan switching requirements.** NEM 2 customers had to move to a time-of-use plan, and a
  utility can restrict which plans a NEM 2 customer may choose. The engine prices whatever
  plan is selected, and "best plan" comparisons do not check eligibility.
- **Baseline credit on net usage.** Where a plan has a baseline credit, it is applied to
  imported kWh, as for Net Billing. Some NEM bills apply it to net usage instead.
- **Battery metering.** Some NEM 2 storage installations may export under an approved
  metering arrangement. That is not modelled; the battery here only serves the house.
- **The record's own weather.** The rebuilt load uses the modelled output for the selected
  weather year, not the sunshine that actually fell on the recorded days. On a day that was
  cloudier than the model, the rebuilt load is too high by the difference, and the other way
  round on a sunnier day.

## Dispatch and baseline under NEM (review fixes, 2026-10-04)

- The battery charges only on a day whose dearest import hour, after the round-trip loss, is worth
  more than the export credit a stored kWh gives up, and it holds its charge through hours that are
  not. Without this rule a flat-ish plan had the pack discharging into off-peak hours and losing
  the round trip, so two batteries saved less than one.
- The baseline allowance is set against net kWh (import minus export) under NEM, as the energy
  charge is computed on net usage; under Net Billing every imported kWh is billed.
- NEM 1 credit includes the non-bypassable charges, so it can offset them; NEM 2 cannot.

## When the term ends

NEM 1 and NEM 2 last 20 years from the array's permission to operate. After that the same
panels are billed under the Net Billing Tariff, where a battery is usually worth more: exports
earn the low ACC export price, so every kWh kept in the house instead is worth the import price.

**In the app.** The existing-solar form asks a third question, the year the array was switched
on (prefilled 2019 for NEM 2, 2013 for NEM 1; stored as `existing.since`, link key `xyr`). The
rail group "Your existing solar" (Dashboard, shown only when an existing array is set) lets the
person change size, plan and year afterwards. The app banner names the agreement, the year it
ends and the plan year the switch lands in; the dashboard's why-line says whether the battery
earns more, less or about the same under Net Billing, with the two first-year figures. If the
year is blank, the model assumes the agreement never ends and both lines say how to model it.
On the demo household, a 5 kW existing array on NEM 2 since 2016 (ten years left in 2026) moves
one battery's NPV by about +$2.5k against never switching, and two batteries' by about +$2.9k.

**Inputs.** `finance.legacyYears = max(0, since + 20 − current year)`, where `since` is the year
the array was switched on (`state.existing.since`, link key `xyr`). Years `1..legacyYears` of the
horizon are billed on the legacy agreement, later years on Net Billing. `null` (year unknown)
means it never switches, the old behaviour; `0` means the term has already ended and the whole
horizon is Net Billing.

**Worker.** With `params.existing` set and billing `"nem2"` / `"nem1"`, `grid` runs each battery
cell twice: once as before and once with `{ billing: "nbt", accPlusAdder: 0 }` (a legacy array
rolling over does not get the ACC Plus adder, which is for new 2023 to 2027 interconnections),
against Net Billing baselines built once. The pack keeps its NEM-era setup in that run: no grid
charging and no export arbitrage (it was installed non-exporting and solar-charged, and the
rollover does not change the hardware). Each cell carries

    cell.after = { savingsVsSameFlex, savingsVsAsRecorded, importSavingsVsSameFlex,
                   importSavingsVsAsRecorded, exportRevenueVsSameFlex, exportRevenueVsAsRecorded,
                   exportRevenue (= VsSameFlex), accPlusRevenue, bill, pvKwh, importKwh, exportKwh }

Under Net Billing the array already exports in the no-battery baseline, so the battery's export
revenue is the *increment* over that baseline (usually negative, the pack keeps midday surplus
at home) and the import saving is the rest of the bill saving. The engine's usual split
(saving minus total export revenue) is only right for a baseline with no panels, and would
understate the escalating import share here. The grid carries `afterBaselineSameFlex: { bill }` and `afterBaselineAsRecorded: { bill }`.
Progress counts both runs. `detail` adds `after = { savings, savingsAsRecorded, importSavings,
importSavingsAsRecorded, exportRevenue, accPlusRevenue, bill, baselineBill,
baselineBillAsRecorded }` to the result and to every `weather[i]` row. A new-system (Net
Billing) run carries no `after`.

**Optimizer.** `priceGrid` turns `cell.after` into the finance stream for the chosen basis,
`{ savings, importSavings, exportRevenue, accPlusRevenue, bill, baselineBill }`, and the
priced cell carries `after` and `regimeChangeYear`. `tornado` re-prices with the same `after`.

**Finance.** `evaluate(sim, f)` reads `sim.after`. For every year `y > legacyYears` the import
saving, export revenue and ACC Plus share come from `after`, escalated and degraded exactly as
the legacy stream would have been in that year (`escalation^(y−1)`, export escalation, the
panel/pack blend). The lifetime-cost bill series uses `after.baselineBill` from the switch on,
for both the with-system and the no-system arm: the household without a battery rolls over
too. `firstYearSavings` and the monthly-outlay figures use whichever regime year 1 is on.
Results add `regimeChangeYear` (`legacyYears + 1` when the switch falls inside the horizon,
else `null`) and `legacyYears` (as used, or `null` when nothing switches). With no `after`, or
`legacyYears` null, every number is unchanged (tested).

**Simplification.** The Net Billing stream is simulated once on today's load and today's
export matrix and scaled like the legacy one. The real export matrix in the switch year is
not known, and the household's load in year 10 will not be today's.
