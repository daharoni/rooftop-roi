# PG&E tariff notes — sources, derivations and confidence

**Prepared:** 2026-09-16 · **Utility:** Pacific Gas and Electric (CPUC U 39-E, EIA 14328) ·
**Rate vintage in the file:** effective **2026-06-01** (Advice Letter 7921-E, D.26-04-036);
Schedule EV (EV-B) is effective 2026-03-01 (AL 7846-E) and was not repriced in June.

Data file: `data/tariffs/pge.json`. Export matrices also in `data/export/pge-nbt26.json`.
Schema: `docs/tariff-schema.md`. Every number below is in the JSON; nothing is only here.

---

## 0. The three things that matter most

**1. Going CCA in PG&E territory usually costs money, and the reason is not the generation
rate.** A bundled PG&E customer receives a PCIA *credit* of −$0.01011/kWh. A CCA customer
gives that up and instead pays a vintaged PCIA *charge* of about +$0.037/kWh plus a $0.00059
franchise fee surcharge. That is a **$0.047/kWh headwind** before the CCA's generation
discount does anything. Only WestLight (5% off generation) clears a meaningful part of it.

| E-TOU-C summer peak | $/kWh | vs PG&E |
|---|---|---|
| WestLight ECOplus (`pce`) | **0.51251** | −0.0099 |
| SJCE GreenSource | 0.51647 | −0.0059 |
| SVCE GreenStart | 0.52042 | −0.0020 |
| Ava Bright Choice (`ebce`) | 0.52141 | −0.0010 |
| **PG&E bundled** | **0.52240** | — |
| CleanPowerSF Green | 0.52479 | +0.0024 |
| MCE Light Green | **0.56351** | **+0.0411** |

**2. PG&E's ACC Plus export adder is $0.0088/kWh — about half SCE's $0.016.** Same CPUC
decision (D.22-12-056), different per-utility schedule. It steps to $0.0044 for a 2027
interconnection vintage and to zero from 2028, so the *application* date is worth real money.
It is the only export credit that may offset non-bypassable charges.

**3. PG&E has no residential super-off-peak period.** On E-ELEC and EV2-A the midnight–3 p.m.
block **is** off-peak. Modelling it as a fourth, cheaper tier is a common and expensive error.
`period_ids` still declares `super_off` so lookups never miss; it is documented filler.

---

## 1. Rate plans — TOU windows — confidence **HIGH**

Read from each schedule's Special Conditions in the tariff book, not from marketing pages.

| Plan | Summer | Weekday | Weekend / holiday |
|---|---|---|---|
| **E-TOU-C** (default) | Jun–Sep | Peak 4–9 p.m.; off-peak otherwise | **identical to weekday** |
| **E-TOU-D** | Jun–Sep | Peak 5–8 p.m.; off-peak otherwise | **all off-peak** |
| **E-ELEC** | Jun–Sep | Peak 4–9 p.m.; part-peak 3–4 p.m. and 9 p.m.–midnight; off-peak midnight–3 p.m. | identical to weekday |
| **EV2-A** | Jun–Sep | same shape as E-ELEC | identical to weekday |
| **EV-B** | **May–Oct** | Peak 2–9 p.m.; part-peak 7 a.m.–2 p.m. and 9–11 p.m.; off-peak 11 p.m.–7 a.m. | Peak **3–7 p.m.**, no part-peak |

Three of the five make **no weekday/weekend distinction at all**. That is tariff, not an
oversight in the file — the weekend arrays are deliberately identical. Holidays bill the
weekend schedule, which on those three changes nothing.

**EV-B's summer is May 1 – October 31**, six months, unlike every other plan. EV-B also carries
a DST clause shifting its periods one hour later for roughly six weeks around each transition;
**this file does not model that shift** — see §8.

## 2. Bundled totals ($/kWh, eff. 2026-06-01) — confidence **HIGH**

| Plan | S-peak | S-part | S-off | W-peak | W-part | W-off |
|---|---|---|---|---|---|---|
| E-TOU-C | 0.52240 | — | 0.39940 | 0.39757 | — | 0.36757 |
| E-TOU-D | 0.47708 | — | 0.34212 | 0.38747 | — | 0.34886 |
| E-ELEC | 0.55214 | 0.39026 | 0.33358 | 0.32063 | 0.29854 | 0.28468 |
| EV2-A | 0.53809 | 0.42760 | 0.22558 | 0.41099 | 0.39428 | 0.22558 |
| EV-B | 0.62131 | 0.37720 | 0.26465 | 0.43878 | 0.30677 | 0.23504 |

**Independently verified, not just transcribed.** PG&E unbundles each schedule into generation,
distribution and a flat adder stack; generation + distribution + $0.05716 re-sums to the
published total in **all 26 season/period cells** (E-TOU-C additionally carries the
+$0.05354/kWh over-baseline Conservation Incentive Adjustment). The build script asserts this.

The flat stack: transmission 0.04638, transmission rate adjustment 0.00453, reliability 0.00013,
PPP 0.00614, nuclear decommissioning −0.00002, CTC 0.00027, ECRA 0.00002, wildfire fund 0.00591,
wildfire hardening 0.00391, recovery bond charge +0.00857 and credit −0.00857 (cancel), bundled
PCIA −0.01011. Excluding PCIA it sums to 0.06727; **including** it, 0.05716 — the latter is the
one that balances.

### E-TOU-C rates are PRE-CREDIT

E-TOU-C is the only PG&E residential TOU plan that is still tiered. The values above are the
**over-baseline** rates; usage up to the daily baseline allocation gets **−$0.08140/kWh**,
stored separately as `baseline_credit_per_kwh`. (A commonly quoted "−$0.10" is stale.)

## 3. CCA providers — confidence **HIGH**

Six CCAs, default tier each. The identity used:

```
cca_total = pge_total − pge_generation + 0.01011 + cca_generation + pcia_and_franchise_fee
```

Applying it reproduces the CCAs' own published all-in comparison tables **to five decimals**,
so these are transcriptions rather than estimates. The build script asserts three spot cells
across three different schedules.

| id | CCA | Default tier | Rule vs PG&E net generation | Rates eff. | PCIA+FF |
|---|---|---|---|---|---|
| `mce` | MCE | Light Green (60% RE) | **parity**, less a flat −$0.0062 Cost Relief Credit | 2026-04-01 | 0.03720 |
| `svce` | Silicon Valley Clean Energy | GreenStart | −1.00% exactly | 2026-01-01 | 0.03720 |
| `cleanpowersf` | CleanPowerSF | Green (54% RE) | **no rule** — own schedule | 2026-03-01 | 0.03738 |
| `pce` | **WestLight Energy** (was Peninsula Clean Energy) | ECOplus | −5.00% exactly | 2026-07-01 | 0.03746 |
| `ebce` | **Ava Community Energy** (was EBCE) | Bright Choice | −0.50% exactly | 2026-01-01 | 0.03738 |
| `sjce` | San José Clean Energy | GreenSource | 3% on E-TOU-C/D, **0–5%** on E-ELEC/EV2-A | 2026-03-01 | 0.03738 |

Two rebrands the UI should surface: **Peninsula Clean Energy → WestLight Energy** on
2026-07-01, and **East Bay Community Energy → Ava Community Energy**. The provider ids stay
`pce` and `ebce` for state-hash continuity.

Three provider-specific traps:

- **CleanPowerSF's TOU shape is much flatter than PG&E's.** On E-TOU-C summer it is only
  +$0.002/kWh at peak but **+$0.057/kWh off-peak**. That materially weakens both battery
  arbitrage and solar self-consumption value in San Francisco.
- **SJCE is not a flat percentage.** 5% on E-ELEC summer peak, **0%** on E-ELEC winter
  part/off-peak and on EV2-A off-peak and winter part-peak.
- **MCE has a pending change.** A rise in the Cost Relief Credit to as much as $0.03725/kWh for
  2026-11-01 → 2027-03-31 goes to its board **2026-10-15**. If it passes, MCE's premium drops
  from +$0.041 to about +$0.010/kWh. The file carries the currently approved $0.0062.
- **Ava is vintage-neutral** (verified) and **SJCE normalises 2019/2020 to 2018**, so their
  single columns are correct for any customer. MCE, SVCE, CleanPowerSF and WestLight publish
  one representative vintage; a customer who departed in 2021–2024 pays a materially higher
  PCIA (up to $0.0543) and this file will understate their bill.

## 4. Fixed charge — confidence **HIGH**

**$0.79343/day** standard (≈ $24.14/month), **$0.39688/day** FERA or deed-restricted affordable
housing, **$0.19713/day** CARE. Introduced by AL 7846-E on **2026-03-01**; the CPUC
income-graduated fixed charge under AB 205 / D.24-05-028.

It **replaced the Delivery Minimum Bill** on E-1, E-TOU-C, E-TOU-D, E-ELEC and EV2 — the words
"minimum bill" do not appear in any of those tariffs, and PG&E's own comparison workbook shows
"—" with the footnote "Only Applicable to EM and EMTOU". So `minimum_charge_per_day` is a real
**0.00**. The old ~$0.398/day survives only on Schedules EM/EM-TOU (master-metered mobilehome
parks), which this file does not carry.

**EV-B is the exception**: no Base Services Charge at all, only a **$0.04928/day** Total Meter
Charge, which is what its `fixed_charge_per_day` holds.

## 5. Baseline territories — allocations **HIGH**, ZIP hints **LOW**

Schedule E-1 Special Condition 2. Values unchanged since 2022-06-01. kWh **per day**.

| Terr | Code B summer | Code B winter | Code H summer | Code H winter |
|---|---|---|---|---|
| P | 13.5 | 11.0 | 15.2 | 26.0 |
| Q | 9.8 | 11.0 | **8.5** | 26.0 |
| R | 17.7 | 10.4 | 19.9 | 26.7 |
| S | 15.0 | 10.2 | 17.8 | 23.7 |
| T | **6.5** | 7.5 | 7.1 | 12.9 |
| V | 7.1 | 8.1 | 10.4 | 19.1 |
| W | **19.2** | 9.8 | 22.4 | **19.0** |
| X | 9.8 | 9.7 | **8.5** | 14.6 |
| Y | 10.5 | 11.1 | 12.0 | 24.0 |
| Z | **5.9** | 7.8 | 6.7 | 15.7 |

Two apparent typos are **real** and appear identically in the 2023, 2025 and 2026 sheets:
Q and X have an all-electric *summer* allowance below their basic summer allowance; W has an
all-electric winter allowance below its all-electric summer one.

Baseline summer is **June 1 – September 30**, the same as TOU summer on every plan except EV-B;
a straddling cycle is prorated by days. Territory character in one line each is in
`utility.baselineRegions.allocations[*].label`.

### The ZIP hints are inference

**PG&E publishes no ZIP-to-baseline-territory table anywhere** — not in the tariff book, not on
pge.com, not in any advice letter. The only ZIPs it names normatively are six Territory Q
exceptions in Santa Cruz County (95005, 95006, 95007, 95018, 95033, 95041), which are in the
file as 5-digit entries and take precedence over the 3-digit default.

Everything else is a join of PG&E's official county-and-elevation table (Electric Preliminary
Statement Part A §A.1.b) with its 2014 service-area ZIP map. Boundaries are **elevation
contours** and metes-and-bounds descriptions, so several prefixes genuinely straddle two or
three territories:

| ZIP3 | Splits |
|---|---|
| 940 | bayside San Mateo + Mountain View/Sunnyvale = **X**; the coastside strip (Daly City, Pacifica, Half Moon Bay, Pescadero, Portola Valley) = **T** |
| 949 | Petaluma/San Rafael/Novato = X; Sausalito, Mill Valley, Tiburon, Point Reyes, Bodega Bay = T |
| 950 | Santa Clara County = X; Santa Cruz below 1,500 ft = T; the six named mountain ZIPs = Q |
| 953 | Modesto/Turlock/Manteca = S; Merced/Atwater/Livingston = R; Sonora/Twain Harte = P or Y |
| 957 | valley floor = S; Colfax/Meadow Vista = P; Pollock Pines = Y; Norden/Soda Springs = Z |

Allocations range **5.9 → 19.2 kWh/day** in summer, more than threefold, so a wrong guess is
expensive. **The territory letter is printed on page 3 of the bill under "Service Information"**
— seed a dropdown from these hints and ask the customer to confirm. Note that baseline only has
a price effect on **E-TOU-C**, the only plan here with a baseline credit.

## 6. Climate credit — confidence **HIGH**

**$36.18 per credit, twice** — on the **August and September 2026** bills, $72.36/year. Moved
from the historical April/October by a CPUC vote on **2026-04-30** (R.25-07-013, under AB 1207).
Printed in every current residential tariff sheet and confirmed by PG&E's July 2026 press
release.

⚠️ PG&E's own residential comparison workbook still carries a stale column header reading
"March & Oct Bill". Ignore it. **EV-B receives no climate credit.** The $46.26 residential *gas*
credit (April 2026, moving to February from 2027) is a different credit and is not in this file.

## 7. NBT export economics — confidence **HIGH**

Source: PG&E's **CPUC Resolution E-5301 machine-readable MIDAS compliance file**
(`PG&E NBT EEC Values 2026 Vintage.csv`, from the ZIP at `pge.com/eecvalues`). It already
carries the CPUC-mandated month / day-type / hour aggregation in its `ValueName` field
(`"Aug Weekday HS19"`), so nothing was interpolated or re-averaged — 576 distinct cells per
component, zero conflicting values. Cross-checked cell by cell against PG&E's published PDF
price sheet: **1,149 of 1,152 identical**, the three exceptions differing by ≤$0.0005 in the
November DST fall-back hours. Underlying model: the 2024 ACC (Resolution E-5328).

| | weekday | weekend |
|---|---|---|
| Unweighted mean, 288 cells | $0.10187 | $0.08396 |
| **Midday mean (h9–h15)** | **$0.04664** | **$0.02407** |
| Peak cell | **$1.15441** (Aug, h19) | **$1.19289** (Aug, h19) |
| Minimum | $0.00018 | $0.00001 |

**Read the midday row, not the mean row.** The all-hours mean is carried by a handful of extreme
August-evening cells a PV array alone never reaches. Exporting a midday kWh earns roughly a
tenth of what importing one costs, so self-consumption and evening battery discharge carry
essentially all of the value, and sizing to annual kWh offset is the wrong objective.

**ACC Plus adder, residential non-equity, by interconnection-application vintage** (declines by
20% of the 2023 base each year, locked for the same nine years):
2023 $0.0220 · 2024 $0.0176 · 2025 $0.0132 · **2026 $0.0088** · 2027 $0.0044 · 2028+ $0.0000.
Low-income/equity: 0.090 / 0.072 / 0.054 / 0.036 / 0.018 / 0.000. **Not** inside the matrices.

**Net Surplus Compensation: $0.02751/kWh** (September 2026). PG&E's AB 920 table is indexed by
**true-up month**, not month of export. 2026 range: $0.02684 (Aug) – $0.03116 (Jan).

**Non-bypassable charges: $0.01230/kWh of import** — Schedule NBT SC 2.f names exactly four:
PPP $0.00614, nuclear decommissioning −$0.00002, CTC $0.00027, wildfire fund $0.00591.
**Already inside the rate tables — do not add.** Wildfire hardening ($0.00391) and the recovery
bond charge/credit are *not* non-bypassable and are commonly miscounted. CARE and Medical
Baseline customers are exempt from the wildfire fund charge → $0.00639.

## 8. What could not be found, and what is estimated

| Item | Status |
|---|---|
| **EV-B CCA columns** | **The one estimated block in the file.** No CCA publishes an EV-B generation rate. Each CCA's EV-B column is PG&E's EV-B total plus that CCA's per-period all-in delta on EV2-A, its structural twin. Confidence **LOW**. PG&E's own EV-B column is exact. |
| **ZIP → baseline territory** | Not published by PG&E at all. Derived; confidence **LOW**. |
| **PG&E's true-up clawback rate** | Schedule NBT SC 5.d debits net surplus kWh at "the utility's average real-world retail export compensation rates … over the past 12 months" before crediting at the NSC rate. SCE publishes its equivalent (~$0.060/kWh in Sep 2026). **PG&E publishes only the input — the hourly EEC sheets — and no standalone average.** Not estimated here. Modelling surplus at the NSC rate alone therefore *understates* the oversizing penalty. |
| **EV-B DST shift** | Schedule EV shifts its periods one hour later between the 2nd Sunday in March and the 1st Sunday in April, and between the last Sunday in October and the 1st Sunday in November. **Not modelled.** Affects ≤6 weeks of a schedule that should not drive a whole-home model. |
| **NBT26 years 2027–2034** | The nine-year lock-in freezes a *trajectory*, not a flat table. Only the 2026 matrix is carried. PG&E publishes each vintage year in the ZIP at `pge.com/energyexportcredit`; a future revision should carry all nine. Direction of the error is documented in `sce.json` `nbt.notes` and is the same here. |
| **Baseline territory GIS** | The official map (`PGECZ_90Rev.pdf`, D.85-12-080) is a raster scan with no text layer; no shapefile is published. Sub-county T/X splits are metes-and-bounds and cannot be converted to ZIPs without georeferencing. |
| **CPUC decision number for the climate-credit move** | Only the proceeding (R.25-07-013) and Agenda ID #24119 are published. |
| **Medical Baseline quantities** | Live in Electric Rule 19, not E-1. Not pulled. |
| **Escalation** | `meta.escalation` rests on a CPUC **projection** (SB 695 Report Table 17), not a realised EIA revenue series as SCE's does. Confidence **MEDIUM**. |

## 9. Escalation — confidence **MEDIUM**

CPUC SB 695 Report Table 17, bundled residential average rate:

| 2024 actual | 2025 | 2026 | 2027 | 2028 |
|---|---|---|---|---|
| $0.361 | $0.350 | $0.380 | $0.414 | **$0.445** |

5.37%/yr over 2024–2028, but strongly back-loaded: 2024→2025 was *negative*, 2026→2028 alone
implies **8.21%/yr**. PG&E has both the highest projected rate and the steepest projected
increase of the three IOUs. `recommended_default` is deliberately **5%**, below the back-loaded
projection — a forecast is not a measurement, and compounding 8% for 25 years would badly
overstate solar savings. Band: 3% low, 8% high.

## 10. ZIP territory and overlaps

`utility.zipPrefixes` carries 931–961 excluding 938 and 942 (PO-box ranges with no service).
**931, 932, 933, 935 and 936 also appear in `sce.json`** because both utilities serve parts of
them — 933 (Bakersfield) is PG&E, 931 (Santa Barbara city) is SCE. `utilityForZip()` returns
every candidate with `ambiguous: true` and the UI must ask.

Municipal utilities carve holes inside the footprint that ZIP cannot see: SMUD (Sacramento),
Palo Alto, Silicon Valley Power (Santa Clara), Alameda, Modesto and Turlock Irrigation
Districts, Lodi, Roseville, Redding, Truckee Donner, Liberty Utilities (Lake Tahoe).

---

## Source list

Every URL is also in `data/tariffs/pge.json` `meta.sources[]` with a `used_for` string saying
which numbers came from it. Primary sources, in rough order of load-bearing-ness:

1. PG&E tariff book, `ELEC_SCHEDS_{E-TOU-C,E-TOU-D,E-ELEC,EV2 (Sch),EV (Sch),E-1}.pdf`
2. PG&E Electric Preliminary Statement Part A §A.1.b — baseline territory definitions
3. PG&E Electric Service Area Map, Cal. P.U.C. Sheet 34575-E
4. PG&E Base Services Charge page (AL 7846-E)
5. PG&E California Climate Credit page (note: the old `/financial-assistance/…` URL 404s)
6. `PGE-Solar-Billing-Plan-Export-Rates.zip` via `pge.com/eecvalues` — the MIDAS compliance file
7. PG&E Schedule NBT (`ELEC_SCHEDS_NBT.pdf`) — ACC Plus, NBCs, true-up
8. PG&E AB 920 Net Surplus Compensation rate table
9. Six CCA adopted rate sheets (MCE, SVCE, CleanPowerSF, WestLight, Ava, SJCE)
10. PCIA / franchise-fee vintage table effective 2026-01-01
11. CPUC 2025 SB 695 Report, Table 17
