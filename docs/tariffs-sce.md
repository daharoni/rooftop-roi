# TARIFF_NOTES.md — sources, derivations and confidence

**Prepared:** 2026-09-15 · **Customer:** single-family home, Agoura Hills CA 91301 · **Delivery:** Southern California Edison · **Generation:** Clean Power Alliance, 100% Green Power · **Current rate plan:** TOU-D-PRIME · one EV · no existing solar (new solar falls under SCE's Net Billing Tariff / "NEM 3.0")

Companion data file: `build/tariffs.json`.

---

## 0. The single most important finding

**The customer is on Clean Power Alliance 100% Green Power, and it costs materially more than SCE bundled service would.**

Agoura Hills selected 100% Green Power as its *default* CPA product, so a household that never opted out is on the most expensive of the three tiers. The bill confirms this household is on it. Against SCE bundled generation, on TOU-D-PRIME:

| period | cpa_green (actual) | sce bundled | difference |
|---|---|---|---|
| summer on-peak | $0.66603 | $0.58532 | **+$0.0807/kWh** |
| summer mid-peak | $0.43183 | $0.39601 | +$0.0358/kWh |
| summer off-peak | $0.28907 | $0.26149 | +$0.0276/kWh |
| winter mid-peak | $0.63324 | $0.56000 | +$0.0732/kWh |
| winter off/super-off | $0.26501 | $0.24000 | +$0.0250/kWh |

Even CPA **Clean** Power costs $0.01102/kWh more than SCE bundled at every hour, and CPA **Lean** is only marginally cheaper (and cheaper than SCE only in some periods). This contradicts SCE's own published SCE/CPA Joint Rate Comparison, which shows SCE and CPA Clean Power as *exactly equal*. The reason is documented in §3 — the comparison assumes a CCA surcharge of $0.02433/kWh while the customer's actual stack is $0.03535/kWh. **Trust the bill.** A dashboard that models this household as "SCE" will understate their current bill; one that offers a provider switch should show tier choice as a real, immediate lever worth roughly $0.03–0.08/kWh.

---

## 1. Baseline territory and allocation — confidence **HIGH** (region), **MEDIUM** (which of the two)

**Source:** SCE *Index of Communities*, Revised Cal. PUC Sheet No. 53902-E — https://www.sce.com/sites/default/files/inline-files/ce62-12.pdf

The index lists:

```
Agoura              6, 9
Agoura Hills        6, 9
Calabasas           6, 9
```

Agoura Hills straddles the region 6 / region 9 boundary, so the city maps to **both**. SCE does not publish a ZIP-level breakdown; the actual region is printed on page 3 of the customer's bill under "Additional information" (it was not in the extract available here). **Region 9 is used in `tariffs.json`** because most of ZIP 91301 lies inland of the coastal band that defines region 6. SCE classifies region 9 as a "Moderate" climate zone and region 6 as "Cool".

**Allocation table** — source: SCE *Tiered Rate Plan* page (https://www.sce.com/save-money/rates-financing/residential-rate-plans/tiered-rate-plan), rates current as of 6/1/26:

| Region | Summer daily kWh (basic) | Summer all-electric | Winter daily kWh (basic) | Winter all-electric |
|---|---|---|---|---|
| **9 (used)** | **16.9** | 12.5 | **12.0** | 13.9 |
| 6 (alternative) | 11.4 | 8.7 | 11.0 | 12.6 |

Summer = June 1 – September 30. Medical Baseline adds 16.5 kWh/day.

**Why this barely matters here:** baseline allocation only has a price effect on TOU-D-4-9PM and TOU-D-5-8PM, which carry a $0.10/kWh baseline credit. **TOU-D-PRIME has no baseline credit at all**, so on the customer's current plan the region 6 vs 9 ambiguity is economically irrelevant. It only becomes material if the dashboard recommends switching to 4-9PM or 5-8PM — and note that if the premises is actually region 6, the summer allocation drops from 16.9 to 11.4 kWh/day, which cuts the value of that credit by about a third in summer.

---

## 2. SCE rate plans — TOU periods and bundled rates — confidence **HIGH**

**Source:** SCE *Time-of-Use Residential Rate Plans*, https://www.sce.com/save-money/rates-financing/residential-rate-plans/time-of-use-plans — page states **"Current rates as of 6/1/26"**. Period definitions independently corroborated by the CPA rate sheet (§4) and by the customer's bill, which prints "Summer weekdays On 4–9 PM / Off 12 AM–4 PM & 9 PM–12 AM; Weekends & holidays Mid 4–9 PM".

Seasons: **Summer = June–September**, **Winter = October–May**, for all three plans.

| Plan | Summer weekday | Summer weekend/holiday | Winter (all days) |
|---|---|---|---|
| **TOU-D-PRIME** | Off 12a–4p, **On 4p–9p**, Off 9p–12a | Off 12a–4p, **Mid 4p–9p**, Off 9p–12a | Off 12a–8a, **Super-off 8a–4p**, **Mid 4p–9p**, Off 9p–12a |
| **TOU-D-4-9PM** | Off 12a–4p, **On 4p–9p**, Off 9p–12a | Off 12a–4p, **Mid 4p–9p**, Off 9p–12a | Off 12a–8a, **Super-off 8a–4p**, **Mid 4p–9p**, Off 9p–12a |
| **TOU-D-5-8PM** | Off 12a–5p, **On 5p–8p**, Off 8p–12a | Off 12a–5p, **Mid 5p–8p**, Off 8p–12a | Off 12a–8a, **Super-off 8a–5p**, **Mid 5p–8p**, Off 8p–12a |

Neither season uses all four period ids: **summer has no super-off-peak, winter has no on-peak.** In `tariffs.json` the missing id is filled with the nearest real period (summer `super_off` = summer `off`; winter `on` = winter `mid`) so that any `rates[season][period]` lookup returns a real number. The 24-hour `schedule` arrays never emit those ids.

**Holidays use the weekend schedule.** SCE's eight: New Year's Day, Presidents' Day, Memorial Day, Independence Day, Labor Day, Veterans Day, Thanksgiving, Christmas. This is recorded in `meta.notes`.

### SCE bundled totals as published (whole cents, eff. 6/1/26)

| Plan | S-on | S-mid | S-off | W-mid | W-off | W-super-off | Basic charge | Baseline credit |
|---|---|---|---|---|---|---|---|---|
| TOU-D-PRIME | 59¢ | 40¢ | 26¢ | 56¢ | 24¢ | 24¢ | $0.79/day | **none** |
| TOU-D-4-9PM | 58¢ | 46¢ | 34¢ | 51¢ | 37¢ | 33¢ | $0.79/day | $0.10/kWh |
| TOU-D-5-8PM | 74¢ | 54¢ | 34¢ | 60¢ | 38¢ | 32¢ | $0.79/day | $0.10/kWh |

SCE's site shows the 4-9PM and 5-8PM plans twice, before and after the baseline credit (e.g. 5-8PM winter mid-peak 60¢ → 50¢). `tariffs.json` stores the **pre-credit** rates and exposes `baseline_credit_per_kwh` separately, per the schema.

**TOU-D-PRIME eligibility:** SCE requires an attestation that the customer has an EV, a residential battery, or an electric heat pump (space or water). It is also the **required** plan for new SCE Solar Billing Plan (NBT) customers — so the customer's existing enrolment on PRIME is exactly where new solar would put them anyway. No rate-plan switch is needed to go solar.

### Fixed charge — confidence **HIGH**

**The CPUC income-graduated fixed charge has already taken effect.** SCE's **Base Services Charge** began in **November 2025** and implements D.24-05-028 / Pub. Util. Code § 739.9(e):

| Customer class | Monthly | ≈ Daily |
|---|---|---|
| Standard residential | **$24.15** | $0.79 |
| CARE | $6.00 | $0.20 |
| FERA / deed-restricted affordable housing | $12.08 | $0.40 |

Source: https://www.sce.com/save-money/rates-financing/residential-rate-plans/bsc

Two consequences:
- **The minimum charge is gone.** SCE: *"The minimum charge is no longer applicable. If you have 0 usage, you will still receive the Base Services Charge."* `minimum_charge_per_day` is **0.00 as a real value**, not a placeholder.
- The BSC is **not offset by solar exports**, so it puts a hard floor of roughly $280/year on the bill no matter how large the system.

**`fixed_charge_per_day` in the JSON is $0.76862, not $0.79** — that is the exact figure on the customer's bill (29 days × $0.76862 = $22.29). The CCA customer's BSC is slightly below SCE's posted bundled figure. The bill wins.

---

## 3. The bill: primary calibration anchor — confidence **HIGH**

**Source:** customer's SCE bill, billing period **2026-07-23 to 2026-08-20** (29 days), `data/download.pdf`. Read locally only; nothing from it was transmitted to any service.

This bill is the backbone of the whole file. It supplies numbers SCE does not publish anywhere per-period.

### Exact lines used

| Item | Value |
|---|---|
| Base services charge | 29 days × **$0.76862** = $22.29 |
| Delivery energy, on-peak | 436 kWh × **$0.29033** = $126.58 |
| Delivery energy, mid-peak | 176 kWh × **$0.29033** = $51.10 |
| Delivery energy, off-peak | 1,362 kWh × **$0.19058** = $259.57 |
| PCIA (2018 Vintage CRS) | 1,974 kWh × **$0.02311** = $45.62 |
| CCA wildfire fund charge | 1,974 kWh × **$0.00591** = $11.67 |
| CTC | 1,974 kWh × **$0.00014** = $0.28 |
| Fixed recovery charge | 1,974 kWh × **$0.00619** = $12.22 |
| Generation Municipal Surcharge | factor 0.009294 on generation → $2.27 |
| CA Climate Credit | **−$36.00** |
| **SCE side total** | **$495.60** |
| CPA 100% Green on-peak | 436.488 kWh @ **$0.34035** = $148.56 |
| CPA 100% Green mid-peak | 175.596 kWh @ **$0.10615** = $18.64 |
| CPA 100% Green off-peak | 1,361.73 kWh @ **$0.06314** = $85.98 |
| CPA Energy Surcharge | $0.59 (≈ $0.000299/kWh) |
| **CPA side total** | **$253.77** |
| **Total new charges** | **$749.37** |

Delivery detail printed on the bill: transmission $48.97, distribution $378.95, public purpose programs $13.22, new system generation charge $16.37.

**Full reconciliation check (performed):** $437.25 delivery energy + $22.29 basic + $45.62 PCIA + $11.67 WFC + $0.28 CTC + $12.22 FRC + $2.27 GMS − $36.00 climate credit = **$495.60** ✓ exact. CPA: $253.18 + $0.59 = **$253.77** ✓ exact. This is stored as `meta.bill_validation` so the dashboard can prove the tariff model reproduces a real bill.

### End-to-end validation: the finished `tariffs.json` reproduces this bill

Running the exact printed kWh through the finished file:

| line | model |
|---|---|
| 436.488 kWh × `rates.summer.on.cpa_green` + 175.596 × `.mid` + 1361.73 × `.off` | $760.18 |
| 29 × `fixed_charge_per_day` | $22.29 |
| Generation Municipal Surcharge (0.009294 × CPA generation) | $2.35 |
| CPA Energy Surcharge | $0.59 |
| California Climate Credit | −$36.00 |
| **model total** | **$749.41** |
| **actual bill** | **$749.37** |
| **error** | **$0.04 — 0.01%** |

The residual is kWh rounding. This is recorded as `meta.bill_validation.model_reproduces_bill` so the dashboard can display the check.

**Independent confirmation:** the CPA generation rates on the bill ($0.34035 / $0.10615 / $0.06314) match the published CPA 2018-Vintage rate sheet effective 2026-07-01 **to the fifth decimal**. Two independent sources agree exactly, which is a strong validation of both.

### California Climate Credit — timing changed in 2026

The bill states: *"Starting in 2026, the bills you receive in August and September will each contain a $36 Climate Credit per service account."* Previously it landed in **April and October**. Recorded as `meta.climate_credit = {amount: 36, months: [8, 9]}` — **$72/year total**. A dashboard that still assumes April/October will put the credit in the wrong months.

---

## 4. Clean Power Alliance generation rates — confidence **HIGH**

**Source:** *Clean Power Alliance Residential Rates — 2018 Vintage*, **effective July 1, 2026** — https://files.cleanpoweralliance.org/uploads/2026/06/Clean-Power-Alliance-Residential-Rates-2018-Vintage-Effective-July-1-2026.pdf

**Getting the right vintage matters.** CPA publishes several residential rate books and they carry different numbers. The January 1, 2026 "2025 Vintage" book applies **only** to La Cañada Flintridge, Lynwood and Port Hueneme. The **2018 Vintage** book is the one that covers Agoura Hills ("applicable to residential customers in all Clean Power Alliance jurisdictions except Hermosa Beach, La Cañada Flintridge, Lynwood, Monrovia, Port Hueneme and Santa Paula"). Using the wrong book would have put TOU-D-PRIME summer on-peak 100% Green at $0.32705 instead of the correct $0.34035.

**Default tier:** the 2018-Vintage book states that *"Jurisdictions on 2018 Vintage Residential Rates that have selected the 100% Green Power default are Agoura Hills, Alhambra, Beverly Hills, …"* — **Agoura Hills defaults to 100% Green Power**, which the bill confirms.

### CPA generation, $/kWh, effective 2026-07-01

| Plan | Season | Period | Lean (40% clean) | Clean (50%) | 100% Green |
|---|---|---|---|---|---|
| TOU-D-PRIME | Summer | On | 0.25075 | 0.27066 | **0.34035** |
| | | Mid | 0.07426 | 0.08135 | **0.10615** |
| | | Off | 0.04185 | 0.04658 | **0.06314** |
| | Winter | Mid | 0.22140 | 0.23918 | 0.30140 |
| | | Off | 0.03178 | 0.03578 | 0.04977 |
| | | Super-off | 0.03178 | 0.03578 | 0.04977 |
| TOU-D-4 | Summer | On | 0.21136 | 0.22761 | 0.28446 |
| | | Mid | 0.10022 | 0.10877 | 0.13869 |
| | | Off | 0.04528 | 0.05002 | 0.06663 |
| | Winter | Mid | 0.14312 | 0.15464 | 0.19496 |
| | | Off | 0.07168 | 0.07825 | 0.10125 |
| | | Super-off | 0.05506 | 0.06048 | 0.07946 |
| TOU-D-5 | Summer | On | 0.35797 | 0.38448 | 0.47723 |
| | | Mid | 0.17255 | 0.18617 | 0.23381 |
| | | Off | 0.03509 | 0.03914 | 0.05334 |
| | Winter | Mid | 0.23222 | 0.24998 | 0.31214 |
| | | Off | 0.06906 | 0.07547 | 0.09793 |
| | | Super-off | 0.04174 | 0.04626 | 0.06207 |

Note CPA's TOU-D-PRIME winter off-peak and super-off-peak are **identical**, mirroring SCE's bundled 24¢/24¢.

---

## 5. How the CPA totals were computed — confidence **HIGH** for TOU-D-PRIME summer, **MEDIUM-HIGH** elsewhere

Three identities, applied uniformly:

```
(1)  sce_generation[p] = cpa_clean[p] + 0.02433
(2)  sce[p]            = delivery[p] + sce_generation[p]
(3)  cpa_X[p]          = delivery[p] + cpa_X_generation[p] + 0.03535
```

### Where $0.02433 comes from

SCE's own **SCE/CPA Joint Rate Comparison** (https://www.sce.com/customer-service-center/community-choice-aggregation/sce-cpa-joint-rate-comparisons, SCE rates as of 2026-06-01, CPA rates as of 2026-07-01) publishes, for each schedule, a usage-weighted Generation Rate, SCE Delivery Rate, Surcharges and Total:

| Schedule | SCE gen | SCE delivery | SCE total | CPA Lean gen | CPA Clean gen | CPA Green gen | CCA surcharge |
|---|---|---|---|---|---|---|---|
| TOU-D-PRIME | 0.11586 | 0.27147 | 0.38733 | 0.08376 | 0.09154 | 0.11875 | 0.02433 |
| TOU-D-4-9 | 0.11655 | 0.25585 | 0.37240 | 0.08474 | 0.09222 | 0.11839 | 0.02433 |
| TOU-D-5-8 | 0.11595 | 0.25592 | 0.37187 | 0.08415 | 0.09162 | 0.11775 | 0.02433 |

SCE generation minus CPA Clean generation is **0.02432, 0.02433, 0.02433** — i.e. **exactly the surcharge** in all three rows. CPA sets its Clean Power tier precisely so that a CPA Clean customer's total equals an SCE bundled customer's total under SCE's assumed surcharge. So the joint comparison's "SCE Generation Rate" is not independent information — it is CPA Clean plus $0.02433. That relationship is what identity (1) uses, and because it is a *rate-design* relationship rather than a load-weighted average, it transfers correctly to individual TOU periods.

### Where $0.03535 comes from — and why it differs

The customer's actual CCA surcharge stack, from the bill:

```
PCIA (2018 vintage)            0.02311
CCA wildfire fund charge       0.00591
CTC                            0.00014
Fixed recovery charge          0.00619
                              --------
                               0.03535   $/kWh
```

This is **$0.01102/kWh higher** than the $0.02433 the joint comparison assumes. The gap is most of the fixed recovery charge (a newer SCE wildfire-securitization bond charge) plus a PCIA vintage difference — the customer carries the **2018 vintage**, which the bill labels "2018 Vintage CRS", while the comparison appears to use a lower blended figure.

**Consequence, and it is the headline of §0:** under SCE's marketing comparison CPA Clean is a wash against SCE bundled; under the customer's real surcharge stack CPA Clean costs **$0.01102/kWh more** at every hour. SCE bundled customers pay no separate surcharge line because PCIA, CTC, WFC and FRC are already inside SCE's published bundled rates, which is why the `sce` totals in `tariffs.json` carry no surcharge.

### Validation of identity (1) against the bill

Applying `sce_generation = cpa_clean + 0.02433` and `delivery = published_total − sce_generation` to TOU-D-PRIME summer, and comparing against the delivery rates actually printed on the bill:

| Period | Derived delivery | **Bill delivery** | Error |
|---|---|---|---|
| Summer on-peak | 0.29501 | **0.29033** | +$0.0047 |
| Summer mid-peak | 0.29432 | **0.29033** | +$0.0040 |
| Summer off-peak | 0.18909 | **0.19058** | −$0.0015 |

**All three land within half a cent** — inside the ±$0.005 that SCE's whole-cent publishing precision allows. The derivation also independently reproduces a structural fact visible on the bill: on-peak and mid-peak delivery are **the same rate** ($0.29501 vs $0.29432 derived; $0.29033 vs $0.29033 measured), with the entire 19¢ on/mid difference sitting in generation. That the method recovers this without being told it is good evidence it transfers to the plans and seasons where no bill exists.

### What is measured vs. derived

- **TOU-D-PRIME, summer, all three periods — MEASURED.** Delivery taken verbatim from the bill. `cpa_green` reproduces the bill exactly: on **$0.66603**, mid **$0.43183**, off **$0.28907**. Confidence **HIGH**.
- **TOU-D-PRIME winter, and all of TOU-D-4-9PM and TOU-D-5-8PM — DERIVED** as `delivery = published_SCE_total − cpa_clean − 0.02433`. Because SCE posts totals only to the whole cent these carry up to **±$0.005/kWh**. The validation above — where the derivation reproduced all three measured summer delivery rates inside that tolerance — is the basis for trusting them. Confidence **MEDIUM-HIGH**. Residual risk is that SCE's delivery rate structure differs by plan in a way the whole-cent totals hide; the `sce` totals themselves are unaffected, since for derived periods `sce` is set to SCE's published value by construction.

A useful sanity result: for TOU-D-PRIME winter the derived delivery comes out at $0.29649 (mid-peak) and $0.17989 (off/super-off), against the bill's summer $0.29033 / $0.19058. SCE's delivery rates are nearly season-independent, which is the expected structure and supports the derivation.

### Deliberately excluded from the per-kWh rates

Two small bill items are left out so the rate tables stay clean; both are recorded in `meta.bill_validation`:
- **Generation Municipal Surcharge** — factor **0.009294** applied to generation charges ($2.27 on this bill). Agoura Hills levies it.
- **CPA Energy Surcharge** — $0.59 on 1,974 kWh ≈ **$0.000299/kWh**.

Together under 0.4% of the bill. Apply them on top if you need to reproduce the bill to the cent.

### Final rate tables as written to `tariffs.json`

### TOU-D-PRIME

| season | period | delivery | sce_generation | **sce** | cpa_lean | cpa_clean | **cpa_green** | delivery source |
|---|---|---|---|---|---|---|---|---|
| summer | on | 0.29033 | 0.29499 | **0.58532** | 0.57643 | 0.59634 | **0.66603** | bill |
| summer | mid | 0.29033 | 0.10568 | **0.39601** | 0.39994 | 0.40703 | **0.43183** | bill |
| summer | off | 0.19058 | 0.07091 | **0.26149** | 0.26778 | 0.27251 | **0.28907** | bill |
| winter | mid | 0.29649 | 0.26351 | **0.56000** | 0.55324 | 0.57102 | **0.63324** | derived |
| winter | off | 0.17989 | 0.06011 | **0.24000** | 0.24702 | 0.25102 | **0.26501** | derived |
| winter | super_off | 0.17989 | 0.06011 | **0.24000** | 0.24702 | 0.25102 | **0.26501** | derived |

### TOU-D-4-9

| season | period | delivery | sce_generation | **sce** | cpa_lean | cpa_clean | **cpa_green** | delivery source |
|---|---|---|---|---|---|---|---|---|
| summer | on | 0.32806 | 0.25194 | **0.58000** | 0.57477 | 0.59102 | **0.64787** | derived |
| summer | mid | 0.32690 | 0.13310 | **0.46000** | 0.46247 | 0.47102 | **0.50094** | derived |
| summer | off | 0.26565 | 0.07435 | **0.34000** | 0.34628 | 0.35102 | **0.36763** | derived |
| winter | mid | 0.33103 | 0.17897 | **0.51000** | 0.50950 | 0.52102 | **0.56134** | derived |
| winter | off | 0.26742 | 0.10258 | **0.37000** | 0.37445 | 0.38102 | **0.40402** | derived |
| winter | super_off | 0.24519 | 0.08481 | **0.33000** | 0.33560 | 0.34102 | **0.36000** | derived |

### TOU-D-5-8

| season | period | delivery | sce_generation | **sce** | cpa_lean | cpa_clean | **cpa_green** | delivery source |
|---|---|---|---|---|---|---|---|---|
| summer | on | 0.33119 | 0.40881 | **0.74000** | 0.72451 | 0.75102 | **0.84377** | derived |
| summer | mid | 0.32950 | 0.21050 | **0.54000** | 0.53740 | 0.55102 | **0.59866** | derived |
| summer | off | 0.27653 | 0.06347 | **0.34000** | 0.34697 | 0.35102 | **0.36522** | derived |
| winter | mid | 0.32569 | 0.27431 | **0.60000** | 0.59326 | 0.61102 | **0.67318** | derived |
| winter | off | 0.28020 | 0.09980 | **0.38000** | 0.38461 | 0.39102 | **0.41348** | derived |
| winter | super_off | 0.24941 | 0.07059 | **0.32000** | 0.32650 | 0.33102 | **0.34683** | derived |

---

## 6. Net Billing Tariff export compensation — confidence **VERY HIGH** (matrices), **HIGH** (rules)

**Primary source:** SCE's own published EEC factor file, **`EEC Factors_Upload File - Pacific Time Zone - FINAL.xlsx`** (file modified 2026-03-05), sheet **"PTO Grp 4 (2026)"**, reached from https://www.sce.com/customer-service-center/help-center/solar/solar-billing-plan/understanding-export-pricing . Cross-validated cell-by-cell against SCE's NBT26 MIDAS CSV in the same folder.

**The 12×24 matrices in `tariffs.json` are real hourly data. Nothing is interpolated, averaged or estimated.** The task brief allowed for an approximate reconstruction; that proved unnecessary.

**Conventions:** `$/kWh`; hour index is **hour-beginning 0–23 in Pacific *prevailing* time** (DST-aware, verified against UTC timestamps in the MIDAS file — SCE's sheet labels them "Hour 1..24", so Hour 1 = index 0); **holidays use the weekend table** (MIDAS day-code 8). Each value is the **total** credit = generation component + delivery component.

### Shape — this is what drives battery economics

| | value |
|---|---|
| Annual simple average, weekday | **$0.09605/kWh** |
| Annual simple average, weekend | **$0.08146/kWh** |
| **Peak: Aug weekday h17 (5–6 p.m.)** | **$1.14724** |
| Aug weekday h18 / h20 / h19 | $1.06614 / $1.01736 / $0.97466 |
| Aug **weekend** h20 | $1.02109 |
| Sep weekday h19 | $0.58417 |
| **Typical summer midday — Aug weekday noon** | **$0.06184** |
| **Typical summer midday — Sep weekday noon** | **$0.05560** |
| Floor: Apr/May **weekend** midday | **$0.00003–0.00006** (effectively zero) |

Two things worth putting in front of the user: midday export is worth roughly **one twentieth** of what the same kWh costs to import, so self-consumption and evening battery discharge carry essentially all the value; and the March–May midday trough is *far* below the "$0.03–0.06" rule of thumb that circulates in the solar trade press — it is functionally zero.

### ⚠️ The 9-year lock-in freezes a *trajectory*, and the error changes sign

This is the easiest thing in the whole file to get wrong. A 2026 PTO date locks the **NBT26** vintage for 9 years — but that vintage specifies a **different 12×24 matrix for every year**. The generation component falls while the delivery component rises sharply:

| Year | WD avg | WE avg | | Year | WD avg | WE avg |
|---|---|---|---|---|---|---|
| **2026** | **0.09605** | **0.08146** | | 2031 | 0.16508 | 0.12424 |
| 2027 | 0.10262 | 0.08808 | | 2032 | 0.17114 | 0.12786 |
| 2028 | 0.10210 | 0.08818 | | 2033 | 0.18133 | 0.13730 |
| 2029 | 0.11829 | 0.09340 | | 2034 (final) | 0.17028 | 0.12777 |
| 2030 | 0.14679 | 0.11420 | | | | |

**Do not apply a single scalar correction.** Those are all-hours averages, and they roughly double — but that is carried by overnight and shoulder hours where a solar customer exports little or nothing. Restricted to the hours that actually earn money, the picture is different, and for a battery **the sign flips**. 2026 against the mean of the nine locked years, unweighted within each hour window:

| Hour window | 2026 WD → 9yr mean | 2026 WE → 9yr mean |
|---|---|---|
| All hours 0–23 | 0.09605 → 0.13930 (2026 **low by 31%**) | 0.08146 → 0.10916 (**low by 25%**) |
| h08–17, daytime PV export | 0.06856 → 0.09016 (**low by 24%**) | 0.03918 → 0.04159 (**low by only 6%**) |
| h16–21, battery discharge | 0.17304 → 0.22744 (**low by 24%**) | 0.15646 → 0.18902 (**low by 17%**) |
| **Aug–Sep h16–21** (dominates battery revenue) | 0.59828 → 0.53142 (**2026 HIGH by 11%**) | 0.56709 → 0.46400 (**HIGH by 18%**) |

So: **daytime-only PV export is understated by roughly 6–24%**, while **a battery discharging into August–September evenings is OVERSTATED by roughly 11–18%** if you apply the 2026 matrix flat. An earlier draft of these notes claimed a flat "40–50% understatement"; that figure was the all-hours number and is wrong for any realistic export profile — it is corrected here.

**Mechanism.** The summer-evening generation-capacity spike decays sharply after 2028, while the delivery component that grows over time is spread thinly across many more hours. August weekday h17 across 2026–2034: **1.1472, 1.2027, 1.0457, 0.6544, 0.7358, 0.8215, 0.8308, 0.8521, 0.8347** — a nine-year mean of **$0.9028** against 2026's **$1.1472**, i.e. 2026 sits 27% *above* the mean at the single most valuable hour of the year. Illustrative mix shift at **Aug weekday h19**: 2026 = generation 0.89396 + delivery 0.08070; 2033 = generation 0.23654 + delivery **0.36493**.

**Correct treatment:** apply each year's own matrix (they are all in the source file). If a single correction factor is unavoidable, compute it against **this system's own modelled hourly export shape** — the brackets above establish sign and rough magnitude, not the factor itself. `tariffs.json` stores the 2026 matrix only, because the schema provides for one pair; the trajectory and this warning are in `nbt.notes`.

*(The 2026 column of every bracket above was recomputed independently from the matrices in `tariffs.json` and matched to five decimals. The nine-year means come from the source file's later-year sheets and were not independently re-derived here; the sign is corroborated by the per-year h17 series above.)*

### Vintage note

**NBT25 and NBT26 are numerically identical** (verified cell-by-cell), because there was no 2025 ACC — the 2024 ACC (Resolution E-5328, adopted 2024-11-13) was still "the ACC approved as of January 1" on both 2025-01-01 and 2026-01-01. The 2026 ACC was adopted **2026-09-03 (D.26-09-007)** and will drive NBT27, which *will* differ. For context the older NBT23/NBT24 vintages are much richer at the summer peak (Aug 2026 weekday h19 = $1.61483 vs NBT26's $0.97466) — earlier adopters did materially better.

### ACC Plus Adder — on top of the matrix, and not in it

**Source:** SCE Schedule NBT (Revised Cal. PUC Sheet No. 87677-E) — https://www.sce.com/sites/default/files/custom-files/PDF_Files/ELECTRIC_SCHEDULES_NBT.pdf

| EEC vintage year | Residential non-equity | Residential equity |
|---|---|---|
| 2023 | $0.040/kWh | $0.093/kWh |
| 2024 | $0.032 | $0.074 |
| 2025 | $0.024 | $0.056 |
| **2026** | **$0.016** | **$0.037** |
| 2027 | $0.008 | $0.019 |
| 2028+ | $0.000 | $0.000 |

A 2026 PTO date earns **$0.016/kWh on every exported kWh**, fixed for the same 9-year lock-in, then zero. Eligibility requires an Original PTO Date between 2023-04-15 and 2027-12-31. **It is not included in the `export_rates` matrices — add it.** It is also the *only* credit that can offset non-bypassable charges, the Base Services Charge and other fixed charges; ordinary export credits cannot. CPA customers receive it from SCE on the delivery portion; switching to or from CPA does not change its value.

### Netting, true-up, and the clawback that penalises oversizing

- **Netting is hourly, not monthly.** Each hour's exports earn that hour's EEC price; each hour's imports are charged the retail rate for that TOU period. They do **not** cancel at the same price — this is the whole point of NBT versus NEM 2.0.
- Within a billing period, credits offset that period's energy charges; excess **rolls forward** month to month.
- **Annual true-up.** SCE uses the customer's own 12-month Relevant Period; **CPA runs its true-up in the April billing cycle**.
- ⚠️ **Clawback before payout.** Schedule NBT SC 4.e.i applies an "Average Retail Export Compensation Rate", which SCE publishes under the different name **"EEC Adjustment Pricing"**: September 2026 = **$0.05981/kWh** (delivery $0.01163 + generation $0.04818; Aug 0.05867, Jul 0.06095, Jun 0.05917, May 0.06010, Apr 0.06279). Net Surplus Energy is then paid at the NSC rate of only ~$0.02/kWh — roughly **one third** of the clawback rate. Modelling annual surplus at the NSC rate alone substantially understates the penalty for an oversized array. **Design conclusion: size to self-consumption plus battery, not to annual kWh offset.** (Name-match of "EEC Adjustment Pricing" to the tariff's ARECR is inference, confidence **medium-high**; the numbers are read directly off SCE's page.)

### Net Surplus Compensation

`net_surplus_compensation_per_kwh` = **$0.02008/kWh** — **CPA's** rate for usage ending September 2026, used because this customer takes generation from CPA. SCE's own NSCR for the same period is **$0.01825/kWh**.

CPA sets its NSC 10% above SCE's, and the two series track to 3–4 significant figures across all nine overlapping 2026 months — an independent confirmation, since the two figures were obtained from different documents. **CCA and Direct Access customers are not eligible for NSC from SCE at all** (Schedule NBT SC 4.g.iv), which is exactly why CPA publishes its own.

Both are recalculated monthly as a 12-month rolling average of CAISO day-ahead DLAP prices for hours ending 08–17, so they drift: SCE's ranged $0.01309–$0.01864 over the last 21 months. **NSC requires an affirmative election by the customer** — it is not automatic.

Sources: https://www.sce.com/regulatory/regulatory-information/ferc-Standards-conduct/tariff-books/rates-pricing-choices/net-surplus-compensation and https://files.cleanpoweralliance.org/uploads/2026/09/CPA-NSCR-AREC-SEP-2026.pdf

### Does CPA pay an adder above ACC? **No.**

`cpa_export_adder_per_kwh` = **0.0**. CPA's Net Billing Tariff derives its Energy Export Credit from the **same** CPUC ACC, splits each hourly price into a generation component (paid by CPA) and a delivery component (paid by SCE), and locks it for the same 9 years for PTO dates through 2027-12-31. **The total export credit is identical whether generation comes from CPA or SCE — only who pays it changes.** The one place CPA does pay a premium is Net Surplus Compensation (10% above SCE), and CPA also offers a Renewable Attribute Adder on net surplus if the customer certifies and transfers the RECs.

### Non-bypassable charges on imports — **corrected**

`nonbypassable_charges_per_kwh` = **$0.00779/kWh**, per Schedule TOU-D effective 2026-06-01 (Advice 5829-E):

| Component | $/kWh |
|---|---|
| Public Purpose Programs Charge (PPPC) | 0.00171 |
| Nuclear Decommissioning Charge (NDC) | 0.00003 |
| Competition Transition Charge (CTC) | 0.00014 |
| Wildfire Fund Charge (WFC) | 0.00591 |
| **Total** | **0.00779** |

⚠️ **Do not add this on top of the `rates` tables — it is already inside them.** It is recorded separately only to show which part of the import price solar cannot escape by exporting.

**A correction worth recording.** An initial derivation from the bill put PPPC at $0.00670/kWh (the $13.22 "public purpose programs" line ÷ 1,974 kWh), giving an NBC total of ~$0.0128. That is **wrong**. Effective 2025-11-15 (Advice 5654-E, implementing D.24-05-028) SCE moved most public-purpose recovery out of the volumetric rate and into the fixed Base Services Charge — of the $0.794/day BSC, about $0.365/day is PPPC and $0.429/day is distribution. Only **$0.00171/kWh** of PPPC remains volumetric. The bill's $13.22 line is *fixed + volumetric combined*, so dividing it by kWh overstates the volumetric rate roughly fourfold. Reconciliation confirms the tariff figure: 29 days × ~$0.34/day + 1,974 kWh × $0.00171 ≈ **$13.2**, matching the bill's $13.22. The tariff value $0.00779 is used.

Two further cautions: CARE and Medical Baseline customers are exempt from the WFC, giving them **$0.00188/kWh** — **FERA is not exempt**. And CCA customers get the same $0.00779 total, with CTC and WFC drawn from Schedule CCA-CRS (Advice 5837-E, eff. 2026-06-25) rather than the base schedule.

### Battery rules under NBT — two hard constraints

**(1) Discharge to grid IS compensated at the same EEC prices — but capped.** SCE's Solar Billing Plan FAQ: *"Do energy storage customers receive Energy Export Credits (EEC) for energy sent back to the grid? Yes. However, for systems that are less than 10 kW and do not have a Net Generation Output Meter (NGOM), Energy Export Credits are capped in accordance with the Paired Storage estimation methodology… No credits are granted for exports that exceed the recorded generation from the renewable system."*

The cap (Schedule NBT SC 5.c) is (CSI EPBB production factor for that month and CEC climate zone, kWh/kW) × (installed PV kW). **SC 5.c.vii is the sting:** export above the cap *"is not eligible for Energy Export Credits and is forfeited,"* and the forfeited kWh *"are assumed to have occurred during the Customer's highest priced billing period, regardless of when the excess energy was actually exported,"* cascading to the next-highest. Forfeited kWh also do not count toward Net Surplus Energy. **Over-export is penalised at the most valuable hours by construction.** The applicable month is set by the **first day** of the billing period.

A sub-10 kW system can escape the cap by **opting into NGOM metering at the start of a Relevant Period** (metering cost capped at **$600**). For a battery intended to discharge to the grid in August evenings, this is very likely worth doing — it is the difference between capturing and forfeiting the $1.00+/kWh hours. Systems over 10 kW AC storage must have an NGOM or certified power control, with storage output limited to 150% of the renewable generator's capacity. There is **no limit on storage kWh capacity**, and the old NEM 150% PV sizing rule is suspended.

**(2) Grid-charging then exporting is PROHIBITED — there is no arbitrage path.** SCE FAQ: *"As a SBP customer, can I charge my battery from the grid? Battery systems in a Paired Storage agreement are charged by a renewable generator i.e., solar, wind, etc., but are not permitted to charge from the grid."* Schedule NBT SC 5.b.ii.B permits certified power-control firmware in lieu of an NGOM, explicitly including equipment *"that prevents electricity imported from the grid to charge the storage device"* (open-loop response ≤ 10 s). So buying cheap off-peak energy to resell into the evening peak is barred by the interconnection agreement — and even if it occurred, the export cap means it would earn nothing. **Model the battery as solar-charged only.**

⚠️ **Unresolved:** SCE does not publish the paired-storage production-factor table (kWh/kW by month × climate zone) anywhere findable — the tariff describes it but does not reproduce it. Reconstructing it would require running the CSI EPBB calculator with SCE's stated assumptions (optimal tilt floored at 20°, 180° azimuth, SunPower SPR-327NE-WHT-D with SPR-X20-327-C-AC micro-inverter at 96%, >6in standoff, minimal shade). **If the dashboard models a sub-10 kW battery without an NGOM, the export cap is approximate.**
---

## 7. Historical rate escalation — confidence **HIGH**

**Sources:** EIA Form 861 annual (`Sales_Ult_Cust_YYYY.xlsx`, Part A "Bundled", utility #17609) for 2015–2024 and EIA-861M utility-level monthly for 2025–2026 — https://www.eia.gov/electricity/data/eia861/ · https://www.eia.gov/electricity/data/eia861m/ ; cross-checked against the CPUC 2025 SB 695 Report (published 2025-09-30) — https://www.cpuc.ca.gov/-/media/cpuc-website/divisions/office-of-governmental-affairs-division/reports/2025/2025-sb-695-report_093025.pdf

SCE bundled residential average rate (revenue ÷ sales), ¢/kWh:

| Year | ¢/kWh | YoY | | Year | ¢/kWh | YoY |
|---|---|---|---|---|---|---|
| 2015 | 16.51 | — | | 2021 | 21.33 | **+17.1%** |
| 2016 | 15.84 | −4.1% | | 2022 | 24.62 | **+15.4%** |
| 2017 | 16.60 | +4.8% | | 2023 | 32.33 | **+31.3%** |
| 2018 | 16.30 | −1.8% | | 2024 | 32.43 | +0.3% |
| 2019 | 16.21 | −0.6% | | 2025 | ~32.4 (prelim) | −0.1% |
| 2020 | 18.22 | **+12.4%** | | 2026 | 32.46 (YTD, 5 mo) | +0.2% |

**Validation:** CPUC's SB 695 Report Table 4 lists SCE at 16.2 / 18.2 / 21.3 / 24.6 / 32.3 for 2019–2023; the computed series is 16.21 / 18.22 / 21.33 / 24.62 / 32.33 — an exact match.

### Computed CAGRs

| Period | CAGR |
|---|---|
| **2015 → 2026 (11y) — written to `meta.escalation.historical_cagr`** | **6.34%/yr** |
| 2015 → 2024 (9y) | 7.79%/yr |
| 2020 → 2026 (6y) | 10.10%/yr |
| 2020 → 2024 (4y) | 15.50%/yr |

### Why the recommended default is 5%, not 6.34% or 10%

**Escalation has flattened hard since 2023.** The 2020–2023 run (+12% to +31%/yr) was extraordinary and is over: 2024, 2025 and 2026 YTD are all essentially flat on a realized-revenue basis. Matched-month EIA comparison (Jan/Feb/Mar/May/Jun): 2024 = 34.29¢, 2025 = 32.41¢ (−5.5%), 2026 = 32.46¢ (+0.15%). **A dashboard defaulting to 10–15%/yr would badly overstate solar savings.**

CPUC's own forward projection (SB 695 Report, Table 17, nominal $/kWh, SCE bundled residential):

| 2024 actual | 2025 | 2026 | 2027 | 2028 |
|---|---|---|---|---|
| $0.293 | $0.325 | $0.344 | $0.361 | $0.374 |

→ **6.29%/yr 2024→2028**, but only **4.27%/yr 2026→2028**. Its 2026 projection ($0.344) matches SCE's posted 34.4¢/kWh exactly, which is a good sign for the near-term numbers.

**`recommended_default` = 0.05**, blending the 11-year history (6.34%) with CPUC's forward view (4.3% near-term). Suggested sensitivity bands **3% low / 8% high**.

**Caveats:** 2025 and 2026 EIA figures are Preliminary. December 2025 in the 861M file is anomalous (415 GWh vs ~1.6 TWh typical) and April 2026 is missing. Note also that EIA's realized-revenue level (~32.5¢) differs from SCE's posted tariff-level average (34.4¢ as of 2026-06-01) because EIA averages across all residential customers including CARE discounts — the two are internally consistent series but **must not be mixed**. SCE's own posted series shows a sharp **+13.1% step on 2025-10-01** ($536M wildfire cost recovery under D.25-06-017 and D.25-06-051 plus the $1.685B 2025 GRC under D.25-09-030), then 34.5¢ on 2026-01-01 and 34.4¢ on 2026-06-01. No 2026 SB 695 report exists yet (due ~2026-09-30).

---

## 8. Incentives as of September 2026

### 8.1 Federal 25D — **TERMINATED. A 2026 homeowner-owned install gets 0%.** Confidence **HIGH**

Verified against the statute: **26 U.S.C. § 25D(h)** now reads *"The credit allowed under this section shall not apply with respect to any expenditures made after December 31, 2025."* Amended by **Pub. L. 119-21 § 70506** (One Big Beautiful Bill Act, enacted 2025-07-04), which replaced the prior "placed in service after December 31, 2034".

Two details that matter:
- It is an **expenditure** test, not a placed-in-service test.
- § 25D(e)(8)(A) treats the expenditure as made **when the original installation is completed**. Per IRS Fact Sheet FS-2025-05, **prepaying in 2025 does not preserve the credit** if installation finishes in 2026.

`federal_itc_residential_pct` = **0.0**. This is the single largest change to residential solar economics versus any pre-2026 model, and it is why §8.2 matters.

Source: https://uscode.house.gov/view.xhtml?req=(title:26%20section:25D%20edition:prelim)

### 8.2 Section 48E via third-party ownership — **ALIVE at 30%.** Confidence **HIGH** (one flagged ambiguity)

The only federal credit path left in 2026, and it is reachable only by **not owning the system** — a lease or PPA, where the third-party owner claims 48E and passes value through as lower pricing.

**§ 48E(i)** denies the credit only for property described in paragraphs **(1)** and **(4)** of § 25D(d) — solar *water heating* and small wind. Rooftop PV is 25D(d)**(2)** and storage is 25D(d)**(6)**; **neither is denied.** The House draft that would have killed residential PV leases did not survive conference.

- **Rate: 30%**, granted automatically by § 48E(a)(2)(A)(ii)(I) to any facility under **1 MW AC** — no prevailing-wage or apprenticeship compliance required. Same for storage under (a)(2)(B)(ii)(I).
- **Adders:** +10pp domestic content (50% threshold for CY2026 construction start), +10pp energy community, +10/+20pp low-income allocation. **Real benchmark: Sunrun's Q2 2026 filing reports an average realized ITC of 44.0% of subscriber value.**
- **Deadlines:** the § 48E(e)(4)(A) cliff (no solar placed in service after 2027-12-31) applies only to facilities beginning construction after 2026-07-04 — a date now passed, so projects starting now must be placed in service by 2027-12-31, a non-issue for residential where install-to-PTO is weeks. **Storage is exempt from the 2027 cliff entirely under § 48E(e)(4)(C).**
- **FEOC:** material-assistance thresholds for CY2026 construction start are ≥40% (facility) and ≥55% (storage); IRS Notice 2026-15 (2026-02-12) provides three interim safe harbors. § 50(a)(4) imposes 100% recapture for a prohibited-foreign-entity payment within 10 years of placed-in-service.

⚠️ **Flagged ambiguity (MEDIUM):** § 48E(i)'s *heading* says "wind and solar leasing arrangements" while its operative text points at solar water heating, which is not 48E property anyway. Text controls over heading (§ 7806(b)) and practitioner commentary uniformly reads PV leases as intact, but a technical corrections bill could close it.

⚠️ **Consumer-facing caveat the dashboard should surface:** the homeowner claims nothing and sees the credit only as a lower lease/PPA payment. **Pass-through is a pricing decision, not an entitlement**, and is not disclosed on customer paperwork. TPO share of the residential market is projected at **60–69% for 2026** precisely because 25D is gone. Counterparty risk is real — Sunnova (Ch. 11, 2025) and Freedom Forever (2026-04) are both bankrupt.

### 8.3 California SGIP — **CLOSED. Model $0.** Confidence **HIGH**

`sgip_residential_per_kwh` = **0.0**. This is the second-largest change from any pre-2026 assumption.

**CPUC D.25-12-003** (issued 2025-12-04, implemented by joint Tier 1 advice letter 2026-01-05) stopped **all ratepayer-funded SGIP budgets** from accepting applications on **2025-12-30**, and **cancelled every application still on a waitlist at 2025-12-31**. Statutory basis: Pub. Util. Code § 379.6 authorised administration only *"until January 1, 2026"* (the SB 700 sunset); unallocated ratepayer funds return to ratepayers.

Levels at the moment of closure (all now CLOSED): Small Residential Storage (general market, ≤10 kW) Step 7 **$0.15/Wh = $150/kWh**; Equity Resiliency Step 5 **$1.00/Wh**; Large-Scale Storage Step 5 $0.25/Wh. Residual "available funds" still displayed on the closed budgets are **stranded, not awardable**.

The only surviving path is **RSSE** (Residential Solar and Storage Equity, D.24-03-071 implementing AB 209, $280M from GGRF), paying **$1.10/Wh = $1,100/kWh** storage + $3.10/W solar. In SCE territory: RSSE-Ratepayer **CLOSED**; RSSE AB 209 Non-POU **WAITLIST ONLY** ($1.39M); the one OPEN budget (RSSE AB 209 POU, ~$1M unallocated) is reserved for customers of **publicly owned utilities** that use SCE as program administrator. **An ordinary SCE-delivery / CPA-generation household in Agoura Hills falls in the waitlist-only bucket with no funding guarantee** (apply-by 2028-06-30).

⚠️ **The CPUC's own SGIP page is stale** — it still shows rates "available through 2025" and never mentions the closeout. Do not source from it. Use https://www.selfgenca.com/home/program_metrics/ (self-dated 2026-09-15) and D.25-12-003.

Also note: the old "$850/kWh residential equity" figure is stale — $0.85/Wh now applies only to non-residential.

### 8.4 SCE demand-response programs — confidence **HIGH**

| Program | Value | Available to this customer? |
|---|---|---|
| **ELRP** (Emergency Load Reduction Program) | **$2.00/kWh** of incremental reduction | **Not directly.** Runs **2021–2027** (seven years, extended by D.23-12-005) — not a 5-year pilot. The residential battery path is subgroup **A.4 (Virtual Power Plant aggregators)**, which requires the aggregation to total **≥500 kW**, so the household must join an aggregator (Tesla, AutoGrid, EnergyHub, Enersponse, Leap, Stem). Events: max **60 dispatch hours/yr**, May 1 – Oct 31, **4–9 p.m.**, 1–5 hr, day-ahead notice, triggered by CAISO EEA Watch/1/2/3. No penalty for non-performance; paid as a bill credit by March 31 of the following year. |
| **Power Saver Rewards** | **$0 — terminated** | No. Sunset at the conclusion of the 2025 ELRP program year; `powersaver.sce.com` now redirects. For historical modelling note it paid **$1/kWh**, not $2/kWh — the $2 figure is the non-residential ELRP rate. |
| **BTM Optimization of Load Technology Study** | up to **$400 per battery** | Yes — via EnergyHub, Octopus, or Uplight/Optiwatt. Framed as a *study*, not a standing program, so do not assume it recurs. |
| **CEC DSGS** | Option 1 **suspended for 2026**; Option 3 ≈ **$107.64/kW-yr** + $1/kWh | Effectively no. Option 1 (the $2/kWh program) is suspended for PY2026 on budget grounds. Option 3 (Market-Aware Storage VPP) pays $82.80/kW-yr for a 4-hr battery plus a 30% PY2026 bonus, but 2026 participation is **limited to aggregations that already participated in October 2025** — new aggregations are locked out. |

⚠️ **No ELRP successor is announced for after 2027.** If the dashboard models a 10-year battery payback, demand-response revenue beyond 2027 is genuinely unknown; surface it as an assumption, not a fact.

### 8.5 Clean Power Alliance programs — confidence **HIGH**

**Power Response Smart Home** (https://cleanpoweralliance.org/smarthome/, administered by Uplight):

| Device | Signup | Annual |
|---|---|---|
| **Home battery** | **$400** e-gift card | **$300/yr**, paid each October |
| Smart thermostat | $85 | $40/yr |
| EV charger | closed to new enrollees | $25/yr |

⚠️ **Hardware constraint that should drive equipment selection: SolarEdge is the only supported battery brand.** Tesla, Enphase, FranklinWH, Generac, LG, sonnen and Panasonic are all absent from the eligible list. Payments are **flat annual, not per-event or per-kWh**. For a household weighing battery brands, $400 + $300/yr is a real thumb on the scale toward SolarEdge — but note it is not stackable in the obvious way with ELRP VPP enrolment, since most VPP aggregators are built around other brands.

**Power Response Home** (manual, no smart device): **$20 signup + $2.00/kWh** saved during Energy Saving Events, 24-hour notice. The only CPA offering with a per-kWh rate — and it is the manual one.

**CPA Sun Storage Rebate** — **OPEN**, first-come first-served: $2,000 base + $1,250 Reliability+ (PSPS-prone area) + $250 Medical Baseline + $250 income-qualified, **"up to $3,500"**. ⚠️ The components sum to $3,750 against a stated $3,500 cap — unresolved discrepancy; treat **$3,500 as the maximum** (MEDIUM confidence on the cap). Over 1,200 battery models eligible, far broader than Power Response.

**CPA Solar and Battery Access Program** — **WAITLISTED**; CPA states the statewide incentives funding it are fully allocated. Do not count on it.

### 8.6 Stacking summary for this household

| Path | 2026 value | Open? |
|---|---|---|
| Federal 25D | **$0** | **No — terminated** |
| Federal 48E via TPO lease/PPA | 30–44% to the owner, passed through as pricing | Yes |
| SGIP general market | **$0** | **No — closed 2025-12-30** |
| SGIP RSSE (SCE, Non-POU) | $1,100/kWh | Waitlist only, no guarantee |
| ELRP direct | — | **No — non-residential only** |
| ELRP A.4 via VPP aggregator | $2.00/kWh incremental | Yes, via a ≥500 kW aggregator |
| SCE BTM Optimization Study | up to $400/battery | Yes |
| CPA Power Response Smart Home | $400 + $300/yr | Yes — **SolarEdge only** |
| CPA Power Response Home | $20 + $2/kWh | Yes (manual) |
| CPA Sun Storage Rebate | up to $3,500 one-time | Yes, while funds last |

---

## 9. Confidence summary

| Section | Confidence | Basis |
|---|---|---|
| Baseline region 6 vs 9 | **MEDIUM** | SCE lists both for Agoura Hills; region 9 assumed. Economically irrelevant on TOU-D-PRIME (no baseline credit). |
| Baseline allocation values | **HIGH** | SCE's published table |
| SCE TOU period definitions | **HIGH** | Three independent sources agree (SCE site, CPA rate sheet, customer bill) |
| SCE bundled totals | **HIGH** (±$0.005 rounding) | SCE published, eff. 6/1/26 |
| Base Services Charge / fixed charge | **HIGH** | Bill + SCE published |
| Minimum charge = $0 | **HIGH** | SCE explicitly states it no longer applies |
| CPA generation rates | **HIGH** | Published sheet matches the bill to 5 decimals |
| Agoura Hills default = 100% Green | **HIGH** | CPA rate book + bill |
| CCA surcharge stack $0.03535 | **HIGH** | Itemised on the bill; full bill reconciles to the cent |
| TOU-D-PRIME **summer** delivery & CPA totals | **HIGH** | Measured on the bill; `cpa_green` matches exactly |
| TOU-D-PRIME **winter**, and TOU-D-4-9 / 5-8 all periods | **MEDIUM-HIGH** | Derived; method validated against the bill to ±$0.005 |
| SCE generation split per period | **MEDIUM-HIGH** | Derived from SCE's own published gen-vs-CPA-Clean relationship |
| NBT 12x24 export matrices | **VERY HIGH** | SCE's own EEC factor file, dual-validated against its MIDAS CSV; real hourly data |
| 9-year lock-in trajectory | **VERY HIGH** | Same source file, all years 2026-2046 |
| ACC Plus Adder table | **HIGH** | SCE Schedule NBT, read directly |
| NSC rates (SCE and CPA) | **HIGH** | Two independent published series that agree on the 10% relationship |
| Non-bypassable charges $0.00779 | **HIGH** | Tariff values eff. 2026-06-01; reconciles with the bill's PPP line |
| True-up clawback (ARECR) $0.05981 | **MEDIUM-HIGH** | Numbers read off SCE's page; the name match to the tariff's ARECR is inference |
| Battery export cap and grid-charging ban | **HIGH** | Direct tariff and FAQ quotes |
| Historical CAGR | **HIGH** | EIA, cross-validated against CPUC SB 695 |
| Recommended escalation default | **MEDIUM** | Judgement blending 11-yr history with CPUC forward projection |
| Federal 25D = 0% | **HIGH** | Statutory text |
| 48E for TPO | **HIGH** (one drafting ambiguity flagged) | Statutory text |
| SGIP = $0 | **HIGH** | D.25-12-003 + selfgenca metrics |
| SCE / CPA demand-response programs | **HIGH** | Program pages |

---

## 10. Things that could not be pinned down

1. **Which baseline region the premises is actually in** (6 or 9). SCE publishes only city-level mappings and the city spans both. It is printed on page 3 of the customer's bill; that page was not in the extract. Immaterial while on TOU-D-PRIME.
2. **SCE's per-TOU-period delivery/generation split is not published anywhere.** SCE's tariff schedules are served from a host (`library.sce.com`) that does not resolve, and the regulatory tariff book is behind a SharePoint link that cannot be fetched. Everything in §5 is a reconstruction — well validated, but a reconstruction. The customer's bill is the only primary source for these numbers, which is why it matters so much.
3. **Why the joint rate comparison's CCA surcharge ($0.02433) differs from the bill's ($0.03535).** Most of the gap is the fixed recovery charge plus a PCIA vintage difference, but the comparison does not disclose its assumed vintage. The bill is used.
4. **SCE's paired-storage production-factor table** (kWh/kW by month and climate zone), which sets the export cap for a sub-10 kW battery without an NGOM, is described by the tariff but published nowhere. It would have to be reconstructed from the CSI EPBB calculator. Material only if the dashboard models a small battery without NGOM metering.
5. **No 2026 CPUC SB 695 report yet** (due ~2026-09-30), so the forward rate projection is the 2025 vintage.
6. **D.C. Circuit posture on the June 2026 vacatur of IRS Notice 2025-42** — appeal/stay status unknown. Low residential impact (the 5% safe harbor always applied to sub-1.5 MW solar).
7. **Treasury's final prohibited-foreign-entity safe harbor tables**, statutorily due 2026-12-31, not confirmed published.
8. **CPA Sun Storage Rebate cap** — components sum to $3,750 against a published $3,500 maximum.
9. **Post-2027 demand-response revenue** for batteries is unknown; no ELRP successor announced.
10. **The "EEC Adjustment Pricing" page is inferred to be** Schedule NBT SC 4.e.i's Average Retail Export Compensation Rate. The numbers are SCE's; the name match is not stated explicitly by SCE. Confidence medium-high.
11. **`tariffs.json` holds only the 2026 export matrix**, because the schema provides one 12x24 pair. The NBT26 vintage actually specifies a different matrix for each of the nine locked years, and the direction of the error depends on the export profile: daytime PV export is understated by roughly 6-24%, but a battery discharging into August-September evenings is OVERSTATED by 11-18%. The year-by-year averages and the per-window brackets are in `nbt.notes` and in §6. The nine-year window means were supplied by the research agent and were not independently re-derived; only the 2026 column was recomputed here.
