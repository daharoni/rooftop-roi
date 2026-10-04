# Incentives in 2026: what the Assumptions card says and where it comes from

The "Incentives in 2026" card (`app/tabs/assumptions.js`) is part fixed copy and part rendered from
`incentives` in each tariff file (`data/tariffs/<utility>.json`). Facts below were last checked
2026-10 against the notes in those files. Confidence is the file's own wording; where the tariff file
is silent we say "medium" and mark it unverified.

## Fixed items

| Item | State in 2026 | Confidence | Source |
|---|---|---|---|
| Section 25D homeowner credit | 0%. Expenditure test: treated as made when installation is complete, so paying in 2025 for a 2026 install does not qualify | high | P.L. 119-21 sec. 70506 (2025-07-04); 26 U.S.C. 25D(h), 25D(e)(8)(A); IRS FS-2025-05. Tariff key `federal_itc_note` |
| Section 48E, third-party owner | 30% base, 40-44% realised with adders. Claimed by the lease/PPA owner, reaches the homeowner only as a lower payment. Not an entitlement | high | 48E(a)(2)(A)(ii)(I); tariff `federal_itc_note`. Drives the "vendor pass-through" incentive mode |
| SGIP | Closed. Ratepayer budgets stopped taking applications 2025-12-30, waitlists cancelled 2025-12-31. Remaining path is RSSE (equity), small and mostly waitlisted | high | CPUC D.25-12-003; Pub. Util. Code 379.6; D.24-03-071 (RSSE). Tariff `sgip_note` |
| Property tax, new active solar | Excluded from reassessment. Last known sunset: systems completed through 2026-12-31 | medium, UNVERIFIED | Cal. Rev. & Tax. Code section 73. Not recorded in the tariff files |
| HOA limits | Solar Rights Act limits HOA bans and cost- or output-raising rules. A protection, not money, so not priced | medium | Cal. Civ. Code 714 and Gov. Code 65850.5 (not in the tariff files) |

## Rendered from the tariff file

Every entry in `incentives.other` is shown, except Section 48E and base-service-charge rows (covered above or costs).
Each is cut to its first two sentences with a "more" toggle. An entry may carry a `confidence` string;
without one the card shows "medium". Entries today include CPA Sun Storage Rebate, Power Response,
SCE ELRP (runs to 2027 only), DSGS, the California Climate Credit, MCE and CEA credits.

## What to re-check each January

1. Section 73 sunset: has the Legislature extended it past 2026-12-31? Update the card text and this file.
2. 48E: any technical-corrections bill on the 48E(i) leasing language; the 2027 placed-in-service cliff for solar (storage is exempt).
3. SGIP/RSSE: budget status on the CPUC SGIP page (which lags), RSSE waitlist rules.
4. Each tariff file's `incentives.other`: dated programmes (ELRP ends 2027, CCA credits expire 2026-12-31, DSGS program year, Climate Credit months).
5. Rebate and credit amounts that appear in the Incentives rail defaults (`fin.sgipPerKwh`, `fin.taxCreditPct` stay 0 unless a programme is genuinely open to a typical customer).
6. Re-read `federal_itc_note` and `sgip_note` in all three files so the card and the files agree.
