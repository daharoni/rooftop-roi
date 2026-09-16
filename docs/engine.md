# The simulation core

`core/engine.js`, `core/finance.js` and `core/optimizer.js`: what they compute, in what
order, and every approximation they make. Nothing here touches the DOM or the network.
The contracts (`LoadSet`, `Plane`, `FlexLoad`, `Tariff`) are in
[ARCHITECTURE.md](ARCHITECTURE.md); this file is the arithmetic.

```
LoadSet + Tariff ──prepare()──▶ ctx            calendar, day/month indices, cal for flexload
ctx + params ──buildScenario()─▶ scn           load with flexible loads re-timed, per-PANEL PV
                                               per plane, hourly import/export prices
scn + params ──runHours()──────▶ result        hourly dispatch, then the NBT bill
result + FinanceInputs ──evaluate()──▶ money   25 years of cash flow, three ways to pay
```

Hourly resolution throughout. Energy in kWh per hour, power in kW, money in dollars.
Every hourly series is a `Float64Array`.

---

## 1. `prepare({ load, tariffs })` — the calendar

One pass over `load.ts` builds the index arrays every later step reads:

| field | meaning |
|---|---|
| `month`, `hour`, `dayType` | 1-12, 0-23 **clock** time, 0 = weekday / 1 = weekend or holiday |
| `dayIdx`, `monthIdx`, `dayStart`, `dayLen`, `dayDow` | day and month boundaries; days are **not** assumed to be 24 hours long |
| `solarIdx` | index into an 8760 profile, in local **standard** time |
| `recorded` | `load.kwh` as a `Float64Array`; non-finite values become 0 and are counted in `quality.unfilledHours` |
| `cal` | `{ N, ts, dayIdx, dayDow, hourA, nDays }` — exactly the slice `core/flexload.js` is given |

**Clock time vs standard time.** Meter data and tariff periods are local *clock* time, so
5 p.m. PDT is on-peak in July and 5 p.m. PST is on-peak in January. Solar profiles are
local *standard* time. `solarIdx` does the conversion: during DST it reads the profile one
hour earlier, rolling back to hour 23 of the previous day at midnight. Feb 29 folds onto
Feb 28, so the profile is always 365 × 24.

**DST days.** A spring-forward day has 23 slots and a fall-back day 24 (the duplicated
wall-clock hour is summed into one slot by `core/greenbutton.js`). On a fall-back day the
*second* occurrence of the repeated stamp is standard time, which is how `solarIdx` reads
it. Annualisation is always `nDays / 365`, never `N / 8760`.

**Holidays** use the weekend schedule: New Year's, Presidents', Memorial, Independence,
Labor, Veterans, Thanksgiving, Christmas — on the actual date, not the observed one,
because that is what SCE bills.

---

## 2. Prices — `buildRates(ctx, planId, providerId, ...)`

For every hour: a period code (`on` / `mid` / `off` / `super_off`), an import price and an
export price. The 2 (season) × 2 (day type) × 24 (hour) lookup is memoised, so this is one
array write per hour.

```
import $/kWh = rates[season][period][providerId]          full bundled retail price
             + nonbypassable charges                       only if params.applyNbc
             + generation × generation municipal surcharge factor
             + CCA energy surcharge                         CCA providers only
export $/kWh = nbt.export_rates[dayType][month][hour]       the ACC vintage matrix
             + nbt.cpa_export_adder_per_kwh                 CCA providers only
```

Two subtleties the tariff file documents and the engine implements:

- **The municipal surcharge is levied on generation only.** For a CCA customer the gap
  between the bundled price and delivery also contains the CCA surcharge stack (PCIA +
  wildfire fund + CTC + fixed recovery). It is backed out with the identity the file
  publishes, `cpa_clean = delivery + (sce_generation − $0.02433) + stack`, so the surcharge
  applies to true generation and nothing else.
- **Non-bypassable charges are assumed to be already inside the published retail rates**
  (that is how SCE publishes them). A tariff that lists NBC-exclusive rates needs
  `params.applyNbc = true`.

If a provider key is missing from a rate row, the engine falls back to
`delivery + sce_generation`.

---

## 3. Roof planes

```js
params.planes = [{ id, profile: Float64Array(8760), panels, shading }]
```

- **kW DC per plane** = `panels × panelW / 1000`. PV for the hour is the sum over planes.
- **The profile already carries its orientation.** `core/pv.js` models tilt and azimuth and
  hands the engine a finished per-kW profile; the engine applies no orientation factors of
  its own. It also does not pick weather years — the caller passes the chosen year's
  profile per plane. `profileFor(solarProfiles, weatherKey)` is the only helper left: it
  resolves `"tmy"`, a year like `"2019"`, or the exceedance aliases `p10` / `p50` / `p90`.
- **Shading** is a fraction *lost*: `{ annual: 0.1 }` keeps 90% of every hour;
  `{ monthly: [12 fractions] }` keeps `1 − monthly[m]` in calendar month `m`, keyed on the
  clock month of the metered hour. No shading block means no derate.
- **PV is exactly linear in panel count.** `buildScenario` computes a per-*panel* hourly
  series per plane once; `pvFor(scn, alloc)` scales and sums it. That is what lets the
  optimizer sweep 61 panel counts without re-reading a solar profile, and it is asserted in
  the tests (`PV(n) = n × PV(1)`).
- `result.pvKwhByPlane` reports annual production per plane and always sums to
  `result.pvKwh` — PV is counted before any export clipping.

---

## 4. Flexible loads

An EV, a pool pump, a heat-pump water heater: energy the household can move on the clock
without noticing. The engine's rule is one line:

```
load = (recorded − Σ detected flex.kwhByHour) × baseLoadScale
     + Σ FlexLoad.reshape(flex, cal, solarShape)
```

Subtracting every *detected* series gives the base load; each flexible load is then added
back at its scheduled hours. A manual load (`kwhByHour: null`) is only ever added. The
reshaping itself belongs to `core/flexload.js`; `core/engine.js` supplies:

- `cal` — the calendar slice above.
- `solarShape` — `Float64Array(N)`, kWh AC per kW DC per hour, aligned to the **load**
  series (clock time), averaged over the planes weighted by their panel counts. This is
  what `schedule.followSolar` weights against. Monthly shading is constant within a day, so
  it cancels out of the weights inside a window; only genuinely different plane shapes move
  them.

`reshapeFlex()` falls back to an engine-local implementation (a straight generalisation of
the prototype's `spreadEV`) if `flexload.js` ever returns something that is not an N-long
series. The fallback reproduces the prototype's numbers to the cent and the tests pin it
there; `setFlexReshape(fn)` forces either one.

### The two baselines

| baseline | load |
|---|---|
| `baselineSameFlex` | the same re-timed load as the system arm, with no panels and no battery |
| `baselineAsRecorded` | every **detected** load back at its metered hours; **manual** loads keep their schedule |

`savingsVsSameFlex` credits the hardware only. `savingsVsAsRecorded` is the change against
today's bill, and the difference between the two baselines
(`flexShiftOnlySavings`) is what re-timing alone is worth — free, no hardware.

A manual load stays in *both* arms on purpose: a pool pump or a second EV is being added
either way, and solar only decides what it costs. That is the prototype's convention,
generalised; the consequence is that `baselineAsRecorded` is "today's bill plus whatever
you are adding regardless", not literally the metered bill. `billPeriod()` — the bill
replay — ignores flexible loads entirely and prices the recorded series.

---

## 5. Dispatch — `runHours(scn, params, detail)`

One pass over the hours. There is no LP and no perfect foresight; the rules use a one-day
lookahead on the *actual* profile, which is optimistic by exactly the amount a real
forecast is wrong. Per-day precomputation: `surplusDay` (PV above load) and `peakNeed` /
`peakStart` (net load in on/mid hours).

Order within an hour, for `P` = PV, `L` = load, `soc` = state of charge, `eff` = √RTE:

1. **PV serves the house.** `pvToLoad = min(P, L)`.
2. **Charge from surplus PV** — `min(surplus, batteries × battKW, (cap − soc)/eff)`.
3. **Discharge to the deficit**, down to a floor that depends on the strategy:
   - `self_consumption` — floor is the reserve, `cap × minReserve`.
   - `tou_arbitrage` / `export_arbitrage` — in off/super-off hours, hold back the part of
     the coming peak the sun will not cover:
     `level = floor + max(0, peakNeed(refDay)/eff − min(surplusDay(refDay)×eff, cap − floor))`,
     where `refDay` is today if the peak has not started yet, otherwise tomorrow. A sunny
     forecast frees the pack to serve the house tonight at off-peak prices, which beats
     exporting at ACC rates.
   - `backup_only` — never charges, never discharges; the pack sits full.
4. **Grid pre-charge** (`gridCharge`, TOU strategies only, and flagged in the UI as *not
   permitted* under an NBT paired-storage agreement): in super-off hours, or off-peak
   before 06:00, buy what tomorrow's sun will not deliver, sharing the inverter with
   whatever already flowed this hour.
5. **Export arbitrage** (`export_arbitrage`): after the house is served, sell stored energy
   whenever the export price is above `exportThreshold`. **Never while `gridCharge` is on** —
   grid energy in the pack must not earn an export credit, and the tariff forbids the
   combination outright.
6. **Export limit.** Anything above `exportLimitKW` is clipped and reported as
   `clippedKwh`.

Invariants the tests check for every hour of the record, under every strategy:
`load = PV→load + battery→load + grid→load`;
`PV = PV→load + PV→battery + export + clipped`;
`soc` never below `cap × minReserve` nor above `cap`;
hourly throughput never above `batteries × battKW`;
`soc(t) = soc(t−1) + charge × eff − discharge / eff`.

---

## 6. NBT billing — `settle()`

Monthly, in this order:

1. **Export cap (paired storage, no NGOM).** Creditable export in a month is capped at the
   modelled PV production for that month. The excess kWh are forfeited, and Schedule NBT
   SC 5.c.vii deems them to have happened in the customer's *highest-priced* hours — so
   every exported kWh is filed into one of ten price bands during the hourly loop and the
   settlement strips credit from the top band down. `params.ngom = true` removes the cap.
2. `subtotal = fixed × days + energy − baseline credit`, floored at
   `max(minimum_charge_per_day, fixed_charge_per_day) × days` so the fixed charge always
   survives an export offset.
3. **Export credits** roll in a bank and offset the subtotal down to — never below — that
   floor. The bank tracks both dollars and the kWh that produced them.
4. **ACC Plus adder** (`accPlusAdder × creditable kWh`) is settled *outside* the bank: it is
   the one export credit that may offset fixed and non-bypassable charges, so it can take a
   monthly bill below the floor.
5. **CA Climate Credit** — a flat credit in the months the tariff file names, applied after
   the export offset, and it too can push the bill below the floor. Taken from
   `tariff.meta.climate_credit`; a tariff that does not publish one gets none.
6. **True-up**, in the true-up month (or the last month of the record): SC 4.e.i first
   reduces the bank by the Average Retail Export Compensation Rate × surplus kWh
   (~$0.0598), *then* pays Net Surplus Compensation on those kWh (~$0.02). The ARECR is
   about three times NSC, so a bank built from cheap midday exports is wiped out and the
   customer keeps only the NSC payment. That is the penalty for sizing an array to annual
   kWh offset instead of to self-consumption, and `forfeitedCredit` reports it.

`exportRevenue` is every dollar sourced from an exported kWh: credits actually applied to a
bill, the ACC Plus adder, and the true-up payout. It is kept separate from avoided import
cost because export prices are locked to the ACC vintage and do not follow retail
escalation (see §8).

---

## 7. Choosing a system — `optimizer.searchGrid`

```js
searchGrid(ctx, params, { maxPanelsTotal, maxBatteries, planeCaps, step, greedyBatteries })
```

**Panels are allocated across planes greedily by marginal annual bill saving.** At each
step one extra panel is simulated on every plane that still has room and the cheapest
resulting bill wins. Value per added panel declines once the array outgrows
self-consumption, so the greedy path is *monotone* — the allocation for *n* panels is the
allocation for *n−1* plus one panel — which means the order is computed **once per grid
run** (at `greedyBatteries`, default 0) and replayed for every battery count. The winning
simulation of each greedy step is also the grid cell at that battery count, so it is never
simulated twice.

Caps come from `opts.planeCaps` (an array by index or an object by plane id), else
`plane.maxPanels`, else unbounded; the sweep stops at `min(maxPanelsTotal, Σ caps)`.

Cost: `maxPanelsTotal × nPlanes` greedy simulations plus one per remaining cell. Measured
on the reference household (17,734 hours, 3 planes, 61 panel counts × 7 battery counts):
**~125 ms** for the sweep. `priceGrid` re-prices all 427 cells in **~13 ms**, which is why
moving a cost or finance slider never re-runs a simulation.

`priceGrid(grid, finance, objective, basis)` attaches the money to every cell and picks the
winner for one of four objectives — max NPV, lowest lifetime cost, max IRR, fastest
payback. `basis` is `"sameFlex"` (default) or `"asRecorded"`. The 0-panel/0-battery cell is
never a candidate, but if the best real cell still has NPV ≤ 0 it is flagged
`beatenByDoingNothing`.

---

## 8. Money — `finance.evaluate(sim, f)`

### Savings

```
savings_y = importSavings₁ × (1 + escalation)^(y−1)       × degradation(y)
          + exportRevenue₁ × (1 + exportEscalation)^(y−1) × degradation(y)
degradation(y) = wₛ (1 − panelDeg)^(y−1) + w_b (1 − battDeg)^(bAge−1)
```

The two halves escalate differently on purpose: avoided import cost rides retail rates,
while export credits are locked to the ACC vintage for nine years and are not tied to
retail rates at all (`exportEscalation` defaults to 0). Escalating them together inflates
the value of every exported kWh and pushes the optimum toward an oversized array.

`wₛ` / `w_b` are the solar and storage shares of the installed cost — a crude but stable
proxy for how much of the saving each contributes. `bAge` resets when the pack is replaced.

### Price

```
gross     = kW DC × 1000 × costPerW + kWh × costPerKwh + adder
discount  = none | discountPct | passThroughPct            (incentiveMode)
netCost   = max(0, gross × (1 − discount) − ITC − SGIP − rebates)
```

### The three ways to pay (`financing.mode`)

| | year-0 outlay | annual payment | O&M, inverter, battery replacement | incentives |
|---|---|---|---|---|
| `cash` | `netCost` | — | customer | apply |
| `loan` | `(1 − sharePct) × netCost` | monthly amortization summed to annual rows | customer | apply |
| `lease` | 0 | `monthly × 12 × (1 + escalator)^(y−1)`, plus `buyout` in the final lease year | lessor | **none** |

**Loan.** `principal = netCost × sharePct × (1 + dealerFeePct)` — the dealer fee inflates
what is borrowed, not what the system costs. The level monthly payment is the textbook
annuity `P·i / (1 − (1+i)^−n)` with `i = apr/12`; the last month absorbs rounding so the
balance lands exactly on zero. `financingSchedule[]` reports `{ year, payment, interest,
principal, balance }`. A term longer than the analysis horizon is **paid off at the
horizon** (the outstanding balance is added to the final year) so the three modes stay
comparable.

**Lease.** The customer buys nothing, so no homeowner tax credit, SGIP, rebate or vendor
pass-through applies, and the lessor carries O&M, the inverter swap, the battery
replacement and the resale value. `netCost` is still reported — as the sticker price, for
reference. Only the `payment` column of `financingSchedule[]` is meaningful.

### Outputs

```
cashflows[0] = −upfront
cashflows[y] = savings_y − O&M_y − extras_y − payment_y + (y = H ? resaleValue : 0)
NPV          = Σ cashflows_y / (1 + investReturn)^y
IRR          = bisection on the same array; null when it never crosses zero
payback      = first year the running total turns positive, linearly interpolated
wealthInvest = netCost × (1 + investReturn)^H          the cash price, left in the market
wealthSystem = (netCost − upfront) × (1 + investReturn)^H + Σ cashflows_y × (1 + investReturn)^(H−y)
             = wealthInvest + NPV × (1 + investReturn)^H   (in every financing mode)
lifetimeCost = upfront + Σ (bill_y + O&M_y + extras_y + payment_y) / (1 + discountRate)^y
LCOE         = (upfront + PV of O&M + extras + payments) / PV of kWh generated
```

Both wealth arms start from the same cash — what buying the system outright would cost
(the sticker price under a lease). The market arm leaves all of it invested; the system arm
spends `upfront` of it (everything for cash, the down payment for a loan, nothing for a
lease), keeps the rest invested at the same return, and reinvests each year's net cash flow,
loan or lease payments included. Counting only the cash flows would forget the borrower's
still-invested principal and make a cheap loan look worse than paying cash.

With no year-0 outlay (a lease, or a loan with nothing down) `IRR` is usually `null` — with
no sign change there is no rate of return to solve for, and reporting a number there would
be a fake. If the first year is already cash positive, `payback` is 0.

`firstYearMonthlyOutlay` = `payment₁/12 + bill/12`, against `currentMonthlyBill` =
`baselineBill/12`: the "is my monthly outlay lower than today's bill?" comparison, which is
the only number a loan or lease customer actually feels.

---

## 9. Approximations, stated plainly

Everything below is a deliberate simplification. They are listed in the UI's method panel
because a number that is wrong in a known way is worth more than a number that is wrong in
an unknown one.

1. **Year-1 dispatch, scaled.** The hourly simulation is run once at year-1 condition and
   25 years of savings are scaled from it, rather than re-simulating a slightly smaller
   array and pack every year. The error is second-order (the bill mix shifts a little as
   production falls) and it buys a ~2,000× speedup — which is what makes the optimizer
   possible at all.
2. **Degradation is blended by cost share**, not by attributing savings to panels and pack
   separately.
3. **The export cap uses our own modelled PV**, not SCE's estimate of it, and strips credit
   at the month's highest export prices — the conservative reading of SC 5.c.vii.
4. **The ACC vintage is flat.** Export prices come from one published matrix and are held
   constant for the whole horizon (`exportEscalation` default 0). The real vintage is
   locked for nine years and then unknown; we do not guess at year 10.
5. **One-day lookahead**, using the actual next day. A real forecast is worse.
6. **No demand charges, no tier-based rates, no net metering legacy tariffs.** NBT only.
7. **Baseline credits** are applied on the lesser of monthly import and the baseline
   allowance; the allowance is a flat kWh/day from the tariff file, not a climate-zone
   calculation.
8. **Unfilled gaps price as zero** (they are reported in `quality.unfilledHours`), so a
   record with long gaps understates both the bill and the savings.
9. **Round-trip efficiency is split symmetrically** (√RTE in, √RTE out) and inverter
   clipping is modelled only through `exportLimitKW`; the DC/AC ratio lives in `core/pv.js`.

---

## 10. The worker bundle

`core/worker.js` is a classic script, not a module: it expects `SolarEngine`,
`SolarFinance`, `SolarOptimizer` and `FlexLoad` to already exist in its scope, and speaks
the `init` / `grid` / `detail` / `validate` / `progress` protocol documented at the top of
the file.

`node core/bundle-for-worker.mjs` concatenates `core/flexload.js`, `core/engine.js`,
`core/finance.js`, `core/optimizer.js` and `core/worker.js` into **`app/worker-bundle.js`,
the one generated file in the repo — and it is committed**, so the site stays a no-build
static deploy. Each module becomes an IIFE assigned to its namespace; three mechanical
rewrites are applied and nothing else:

```
import X from "./mod.js";   →  const X = <namespace of mod.js>;
export default <expr>;      →  var __default = <expr>;   (+ return __default)
export <declaration>        →  <declaration>
export { a, b };            →  (dropped)
```

Re-run it after editing any core module the worker uses, and commit the result with the
change. The UI fetches the bundle as text and starts it as a Blob Worker, falling back to
`new Function("self", src)(shim)` on the main thread where a CSP forbids Blob workers — so
nothing in the worker may touch `window` or `document`.
