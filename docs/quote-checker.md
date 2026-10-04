# Quote checker

The Quote tab (`app/tabs/quote.js`, maths in `core/quote.js`) holds an installer's proposal up against the model.

## What is compared

The household enters the system size (kW DC), battery count, total contract price and, optionally, the installer's first-year kWh and quoted monthly payment. Nothing is re-simulated. The quote is placed on the nearest cell of the grid the optimiser already simulated (panels = round(kW x 1000 / panel watts); batteries exactly, or the nearest count simulated), and that cell is priced three ways with `core/finance.evaluate`:

1. **Quote as priced.** The contract price is the whole gross cost. The model's own $/W and $/kWh stay in the inputs, because they set the solar/storage weights in the degradation blend and the battery-swap price; the fixed adder is solved so that gross equals the quoted price exactly. Roof extras are zero (the price is assumed to include them), the incentive mode is "none" (the price is after any discount), and any tax credit, rebate or SGIP in the settings still applies as the household's own claim.
2. **Same size at market price.** The same cell at the household's own price knobs, including roof extras.
3. **Optimiser's pick.** The best cell for the chosen objective.

Each tile is NPV over the analysis horizon. A quote bigger than the grid (more panels or batteries than were simulated) is reported as outside the grid, naming the knob to raise: "Most panels to consider" or "Most batteries to consider".

## Market band

`MARKET_PER_W` in `core/quote.js`: $2.40 to $3.25 per watt DC, installed, as of 2026-08, from EnergySage California marketplace averages. It is a solar-only figure, so with batteries in the quote the storage is removed first at the model's storage prices ($/kWh x usable kWh + $ per battery) before dividing by watts. It is a guide: roof work, a panel upgrade and premium equipment all move a fair price outside it. Update the constant and its date together when prices move.

## Dealer fee

Only in loan mode. If a monthly payment is entered, the fee is implied: the level payment at the loan's APR and term is turned back into a principal, and the fee is that principal minus the financed share of the price. Assumptions:

- the price entered is the cash price, and the fee is added to the loan on top of it;
- the monthly payment is the loan payment alone (no insurance, escalator or fees folded in);
- the loan APR and term are the ones set in the left rail, and any down payment is the unfinanced share (1 minus "Share financed");
- a negative result (the payment is lower than the price implies) is shown as no fee.

With no monthly payment, the fee is the "Dealer fee" setting applied to the financed price. The quoted pricing uses the same fee, so a fee found in the payment lowers the quote's NPV. "Price with the fee counted" is the price plus the fee.

## Production check

The model's first-year kWh for the matched cell, scaled by quoted kW over the cell's kW, against the installer's. Verdicts on installer over model: within 5% is "in line"; 5% to 15% above is "optimistic"; more than 15% above is "very optimistic"; more than 5% below is "conservative". The payback sentence rescales every saving by the ratio, a rough stand-in (a battery's savings do not scale with sun).

## Not done

The battery size in the quote is used for the price-per-watt split only; the simulation uses the Hardware setting. A battery-size note is shown when they differ.
