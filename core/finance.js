/* =============================================================================
 * core/finance.js - turns one year of simulated bill savings into 25 years of money.
 *
 * Deliberately separate from engine.js: the hourly physics does not depend on any
 * price, so every cost/finance control can be re-priced against cached simulation
 * results without touching the 17,700-hour loop.  That is what makes the cost and
 * finance sliders feel instant while the system sliders take a worker round-trip.
 *
 * The central approximation (shown to the user in the method panel):
 *     savings_y = importSavings_1 x escalation^(y-1)      x degradationBlend(y)
 *               + exportRevenue_1 x exportEscalation^(y-1) x degradationBlend(y)
 * The two halves escalate differently on purpose.  Avoided import cost rides retail
 * rates; export credits are locked to the ACC vintage for nine years and are not
 * tied to retail rates at all, so escalating them alongside the bill would inflate the
 * value of every exported kWh and push the optimiser toward an oversized array.
 * The dispatch is simulated once at year-1 condition and the result is scaled,
 * rather than re-simulating a slightly smaller array and pack every year.  The error
 * is second-order (the bill mix shifts a little as production falls) and it buys a
 * ~2,000x speedup, which is what lets the optimizer sweep 400+ configurations.
 *
 * Three ways to pay for it (financing.mode):
 *   cash   the whole net cost at year 0.
 *   loan   a down payment at year 0 plus level monthly payments (summed to annual
 *          rows) on a principal of netCost x share x (1 + dealer fee).
 *   lease  no upfront at all, escalating annual payments and an optional buyout;
 *          a third party owns the system, so no homeowner incentive applies and
 *          O&M / inverter / battery replacement are not the customer's problem.
 * Savings accrue in all three - under a lease only while the household has the
 * system.  When a lease term ends before the horizon:
 *   buyout > 0   the buyout is paid in the last term year and the household owns
 *                the system from the next year on: savings continue, and O&M,
 *                replacements and the resale credit become the owner's, as for cash.
 *   buyout = 0   the system goes back to the lessor (the conservative reading of a
 *                California lease/PPA with renew-or-remove at end of term), so the
 *                savings stop with the payments.  Renewing is a new contract this
 *                model does not price.
 *
 * Replacements (inverter every inverterYear, battery every battReplYear) recur at
 * every multiple of their interval, but only while at least REPLACE_MIN_REMAINING
 * years of the horizon remain after the replacement year: nobody budgets a new
 * inverter in year 24 of a 25-year analysis whose terminal value is zero.  On the
 * default 25-year horizon that books the inverter at 12 (not 24) and the battery at
 * 20 - exactly what the single-replacement rule used to give.  The battery's
 * capacity-fade clock restarts at every replacement that is booked, and only then.
 *
 * Battery hardware has two prices: costPerKwh on the usable kWh and a fixed
 * costPerBattery per unit (inverter/gateway/install labour that does not scale with
 * capacity).  `sim.batteries` is the unit count; absent means 0 units, so no fixed
 * cost.  The fixed part sits inside storageCost, so discounts, the degradation cost
 * share and the pack replacement (battReplFraction of the whole storage price) see it.
 *
 * Existing solar: `existingKwDc` is array already on the roof.  `sim.kwdc` stays the
 * TOTAL (production, LCOE denominators and the simulation are about the whole array)
 * but only newKw = max(0, kwdc - existingKwDc) is bought, so the solar price and the
 * inverter swap are charged on new watts alone.  The resale credit is a flat input
 * and is not scaled.  `microinverters: true` means the inverters are in the panel
 * price and fail with the panels, so the inverter swap outlay is 0
 * (inverterYear/inverterPerW stay in the inputs untouched).
 *
 * extraRevenue: batteries bring non-bill value - a resilience value (what an outage
 * is worth to the household, $/yr) and VPP/demand-response income ($/yr per unit).
 * Each year the household has the system and batteries > 0 it adds
 * resilienceValue + vppPerBattery x batteries, flat (not escalated, not degraded), to
 * the household's earnings in every metric.  It is not a bill saving, so `savings`
 * and savingsByYear exclude it; firstYearSavings includes it.  Under a lease that
 * ends with no buyout it stops with the system.
 *
 * Defaults mirror the app's State.DEFAULTS.fin (app/state.js ~line 101-111), which
 * is the source of truth for anything a person sees; these only fill keys a caller
 * leaves out (tests, the optimizer called without a full finance block).  Keep the
 * overlapping keys equal; tests/finance.test.mjs pins the two that once drifted.
 * ========================================================================== */

/** Years of horizon that must remain after a replacement for it to be booked. */
export const REPLACE_MIN_REMAINING = 3;

export const DEFAULTS = {
  costPerW: 2.75,            // $/W DC, installed, before incentives (= app/state.js)
  costPerKwh: 1000,          // $/kWh usable storage, installed
  costPerBattery: 0,         // fixed $ per battery unit, on top of $/kWh (needs sim.batteries)
  resilienceValue: 0,        // $/yr outage-protection value while batteries > 0 (not a bill saving)
  vppPerBattery: 0,          // $/yr per battery unit of VPP / demand-response income
  microinverters: false,     // true: no string-inverter swap is booked
  existingKwDc: 0,           // kW DC already installed; priced only above this
  adder: 0,                  // fixed install adder (panel upgrade, trenching, ...)
  // Per-roof-face extra install cost (long conduit runs, tile roof, steep pitch...).
  // Charged whenever there are panels; hardware-agnostic, so it never enters the
  // panel/pack degradation blend.
  roofCostAdder: 0,
  taxCreditPct: 0,           // homeowner-claimed 25D - terminated for 2026 installs
  // How a third-party credit reaches the customer.  "none" | "discount" | "vendor".
  // "none" to match app/state.js (State.DEFAULTS.fin.incentiveMode).
  incentiveMode: "none",
  discountPct: 0,            // mode "discount": straight % off system price
  vendorCreditPct: 0.40,     // mode "vendor": the credit the vendor claims - context only
  passThroughPct: 0.34,      // mode "vendor": points off the system price they pass on
  sgipPerKwh: 0,             // SGIP storage rebate, $/kWh usable (closed as of 2026)
  rebates: 0,                // any other one-off rebate $ (CPA Sun Storage, ...)
  horizon: 25,               // analysis years
  escalation: 0.05,          // retail rate escalation, nominal $/yr (app/state.js)
  exportEscalation: 0.0,     // export credits are locked to a fixed ACC vintage
  // The ACC Plus adder is locked for nine years from interconnection and then ends;
  // from year accPlusYears + 1 the sim's accPlusRevenue is taken back out.
  accPlusYears: 9,
  investReturn: 0.07,        // nominal return on the same cash in the market
  discountRate: 0.025,       // inflation / real-terms discount
  panelDeg: 0.005,           // /yr production loss
  battDeg: 0.02,             // /yr usable capacity loss
  battReplYear: 20,
  battReplFraction: 0.5,     // of today's $/kWh
  omPerYear: 150,            // O&M + insurance, escalates with inflation
  inverterYear: 12,
  inverterPerW: 0.15,
  resaleValue: 0,            // home value credited at the horizon
  // Bills, savings and loan payments arrive through the year, not on 31 December,
  // so every year's flows are dated mid-year (the upfront price is day one).  Booking
  // them at year end would credit a borrower with a year of market return on money
  // already paid out and make a dear short loan look cheaper than cash.
  midYear: true,
  financing: {
    mode: "cash",                                                    // "cash"|"loan"|"lease"
    loan: { sharePct: 1.0, apr: 0.0699, termYears: 15, dealerFeePct: 0.0 },
    lease: { monthly: 180, escalatorPct: 0.029, termYears: 25, buyout: 0 },
  },
};

const FIN_MODES = ["cash", "loan", "lease"];

function num(v, d) { const x = +v; return (v === undefined || v === null || isNaN(x)) ? d : x; }

export function withDefaults(f) {
  const o = {};
  for (const k in DEFAULTS) {
    if (k === "financing") continue;
    const d = DEFAULTS[k], v = f ? f[k] : undefined;
    if (v === undefined || v === null) o[k] = d;
    else if (typeof d === "string" || typeof d === "boolean") o[k] = v;
    else o[k] = isNaN(v) ? d : +v;
  }
  const g = (f && f.financing) || {};
  const D = DEFAULTS.financing;
  o.financing = {
    mode: FIN_MODES.indexOf(g.mode) >= 0 ? g.mode : D.mode,
    loan: {
      sharePct: Math.max(0, Math.min(1, num(g.loan && g.loan.sharePct, D.loan.sharePct))),
      apr: Math.max(0, num(g.loan && g.loan.apr, D.loan.apr)),
      termYears: Math.max(1, Math.round(num(g.loan && g.loan.termYears, D.loan.termYears))),
      dealerFeePct: Math.max(0, num(g.loan && g.loan.dealerFeePct, D.loan.dealerFeePct)),
    },
    lease: {
      monthly: Math.max(0, num(g.lease && g.lease.monthly, D.lease.monthly)),
      escalatorPct: num(g.lease && g.lease.escalatorPct, D.lease.escalatorPct),
      termYears: Math.max(1, Math.round(num(g.lease && g.lease.termYears, D.lease.termYears))),
      buyout: Math.max(0, num(g.lease && g.lease.buyout, D.lease.buyout)),
    },
  };
  o.roofCostAdder = Math.max(0, o.roofCostAdder);
  o.costPerBattery = Math.max(0, o.costPerBattery);
  o.resilienceValue = Math.max(0, o.resilienceValue);
  o.vppPerBattery = Math.max(0, o.vppPerBattery);
  o.existingKwDc = Math.max(0, o.existingKwDc);
  o.microinverters = f && f.microinverters !== undefined && f.microinverters !== null
    ? (f.microinverters === "false" ? false : !!f.microinverters) : DEFAULTS.microinverters;
  o.accPlusYears = Math.max(0, o.accPlusYears);
  return o;
}

/**
 * The years in 1..H at which a part with a service life of `every` years is
 * replaced: every multiple of the (rounded) interval that leaves at least
 * REPLACE_MIN_REMAINING years of horizon after it.  `every` <= 0 means never.
 */
export function replacementYears(every, H) {
  const n = Math.round(every), out = [];
  if (!(n >= 1)) return out;
  for (let y = n; y <= H - REPLACE_MIN_REMAINING; y += n) out.push(y);
  return out;
}

/**
 * The share of the sticker price the customer never pays.
 *   "none"     nothing
 *   "discount" a straight negotiated discount
 *   "vendor"   the lease-to-own pitch: the vendor claims a Section 48E credit it can
 *              only claim because it owns the system, and passes part of it on as
 *              points off the price.  passThroughPct is those points - 34 means the
 *              customer pays 66% of the sticker price.  vendorCreditPct is carried
 *              only as context for the helper line; it does not enter the arithmetic,
 *              because what reaches the customer is a price, not a credit.
 * Under a lease the customer buys nothing, so no ownership incentive applies at all.
 */
export function effectiveDiscount(f) {
  if (f.financing && f.financing.mode === "lease") return 0;
  if (f.incentiveMode === "discount") return Math.max(0, Math.min(0.95, f.discountPct));
  if (f.incentiveMode === "vendor") return Math.max(0, Math.min(0.95, f.passThroughPct));
  return 0;
}

/**
 * When each year's cash flow is dated, in years from install: [0, 0.5, 1.5, ...]
 * under the mid-year convention, [0, 1, 2, ...] at year end.
 */
export function flowTimes(H, midYear = true) {
  const t = [0];
  for (let y = 1; y <= H; y++) t.push(midYear ? y - 0.5 : y);
  return t;
}

/** Present value of `cf` at `rate`; `times` dates each entry (default: year end). */
export function npvOf(cf, rate, times) {
  let v = 0;
  for (let y = 0; y < cf.length; y++) v += cf[y] / Math.pow(1 + rate, times ? times[y] : y);
  return v;
}

/** Bisection IRR on a cash-flow array starting at year 0. Null if it never crosses. */
export function irrOf(cf, times) {
  let lo = -0.9, hi = 3.0;
  let flo = npvOf(cf, lo, times), fhi = npvOf(cf, hi, times);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npvOf(cf, mid, times);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** First year the running total turns positive, linearly interpolated. */
export function crossing(series) {
  for (let y = 1; y < series.length; y++) {
    if (series[y] >= 0) {
      const prev = series[y - 1];
      return (y - 1) + (prev < 0 ? (-prev) / (series[y] - prev) : 0);
    }
  }
  return null;
}

/** Level monthly payment on `principal` at nominal `apr` over `months`. */
export function loanPayment(principal, apr, months) {
  if (months <= 0) return 0;
  const i = apr / 12;
  if (Math.abs(i) < 1e-12) return principal / months;
  return principal * i / (1 - Math.pow(1 + i, -months));
}

/**
 * Monthly amortization summed into annual rows.  Returns the level monthly `payment`,
 * one `rows` entry per year { year, payment, interest, principal, balance }, plus
 * `totalInterest`, `termYears` and the `principal` borrowed.
 * The final month absorbs rounding so the balance lands exactly on zero.
 */
export function amortize(principal, apr, termYears) {
  const months = Math.max(1, Math.round(termYears * 12));
  const pay = loanPayment(principal, apr, months);
  const i = apr / 12;
  const rows = [];
  let bal = principal;
  for (let y = 1; y <= Math.ceil(months / 12); y++) {
    let yPay = 0, yInt = 0, yPrin = 0;
    for (let mo = 0; mo < 12; mo++) {
      const idx = (y - 1) * 12 + mo;
      if (idx >= months) break;
      const interest = bal * i;
      let principalPart = pay - interest;
      let payment = pay;
      if (idx === months - 1 || principalPart > bal) {      // last payment clears the note
        principalPart = bal;
        payment = principalPart + interest;
      }
      bal -= principalPart;
      yPay += payment; yInt += interest; yPrin += principalPart;
    }
    rows.push({ year: y, payment: yPay, interest: yInt, principal: yPrin,
                balance: Math.abs(bal) < 1e-9 ? 0 : bal });
  }
  let totalInterest = 0;
  for (const r of rows) totalInterest += r.interest;
  return { payment: pay, rows, totalInterest, termYears: months / 12, principal };
}

/**
 * @param sim  { savings, importSavings, exportRevenue, bill, baselineBill,
 *               pvKwh, kwdc, battKWhTotal }
 *             `savings` is year-1 bill savings in dollars; `bill` the with-system
 *             annual bill; `baselineBill` today's annual bill.
 *             Optional `accPlusRevenue`: year-1 dollars of ACC Plus adder credit,
 *             a part of `exportRevenue` (and so of `savings`), not on top of it.
 *             It is removed from every year after f.accPlusYears (default 9),
 *             escalated and degraded exactly as the export revenue it sits in.
 *             Missing or 0 changes nothing.
 * @param f    finance inputs (see DEFAULTS)
 * @returns    among the rest, `irr` (levered, the household's own cash) with
 *             `irrReason` - null when irr is a number, else why it is undefined:
 *             "no money down", "never repays" or "no unique rate".
 */
export function evaluate(sim, f) {
  f = withDefaults(f);
  const mode = f.financing.mode;
  const isLease = mode === "lease";
  // Backward compatible: a sim that carries only `savings` is treated as all-import.
  const exportRev = sim.exportRevenue || 0;
  const importSav = sim.importSavings !== undefined ? sim.importSavings : (sim.savings - exportRev);
  // The adder is a slice of the export credit, so it can never exceed it or go below 0:
  // a hand-built sim with a stray value is clamped rather than inventing savings.
  const accPlusRev = Math.min(Math.max(0, +sim.accPlusRevenue || 0), Math.max(0, exportRev));
  const watts = sim.kwdc * 1000;
  const newWatts = Math.max(0, sim.kwdc - f.existingKwDc) * 1000;
  const units = Math.max(0, +sim.batteries || 0);
  const solarCost = newWatts * f.costPerW;
  const storageCost = sim.battKWhTotal * f.costPerKwh + units * f.costPerBattery;
  // Roof work (re-roofing a face, conduit runs, structural fixes) is the household's
  // own bill: it is not part of the system's sticker price, so no vendor pass-through,
  // tax credit or rebate reaches it, and under a lease it is still paid up front.
  const roofCost = watts > 0 ? f.roofCostAdder : 0;
  const gross = solarCost + storageCost + (watts > 0 || sim.battKWhTotal > 0 ? f.adder : 0);
  const disc = effectiveDiscount(f);
  const discounted = gross * (1 - disc);
  // A leased system is never bought, so no homeowner credit or rebate applies to it.
  const itc = isLease ? 0 : discounted * f.taxCreditPct;
  const sgip = isLease ? 0 : sim.battKWhTotal * f.sgipPerKwh;
  const rebates = isLease ? 0 : f.rebates;
  const netCost = (isLease ? gross : Math.max(0, discounted - itc - sgip - rebates)) + roofCost;

  const H = Math.max(1, Math.round(f.horizon));
  const times = flowTimes(H, f.midYear !== false);

  // ----------------------------------------------------------------- financing
  const pay = new Array(H + 1).fill(0);
  let upfront = 0, schedule = [], amort = null, principal = 0, dealerFee = 0;
  // Which years the household has the system, and which years it owns (pays O&M,
  // replacements, gets the resale credit).  Cash and loan: all of them.  Lease: has
  // it for the term, then owns it after a buyout or hands it back (see the header).
  let hasUntil = H, ownsFrom = 1, ownsAtH = false, leaseEnd = null;
  if (mode === "loan") {
    const L = f.financing.loan;
    dealerFee = netCost * L.sharePct * L.dealerFeePct;
    principal = netCost * L.sharePct * (1 + L.dealerFeePct);
    upfront = netCost * (1 - L.sharePct);
    amort = amortize(principal, L.apr, L.termYears);
    schedule = amort.rows;
    for (const r of schedule) if (r.year <= H) pay[r.year] = r.payment;
    // A term longer than the analysis horizon leaves a debt: pay it off at the horizon
    // so the comparison is like-for-like with cash.  A term that ends on or before the
    // horizon has already amortised to zero by then, so this adds nothing there.
    const atH = schedule.find((r) => r.year === H);
    if (atH) pay[H] += atH.balance;
  } else if (isLease) {
    const L = f.financing.lease;
    const term = Math.min(L.termYears, H);
    for (let y = 1; y <= term; y++) {
      pay[y] = L.monthly * 12 * Math.pow(1 + L.escalatorPct, y - 1);
      schedule.push({ year: y, payment: pay[y], interest: 0, principal: 0, balance: 0 });
    }
    if (L.buyout > 0 && L.termYears <= H) {
      pay[L.termYears] += L.buyout;
      const row = schedule[L.termYears - 1];
      if (row) row.payment = pay[L.termYears];
    }
    if (L.termYears === H && L.buyout > 0) {
      // Bought in the final year: the household owns it at the horizon, so the resale
      // credit is theirs even though no ownership year is left to run.
      ownsFrom = H + 1; ownsAtH = true;
      leaseEnd = { year: L.termYears, outcome: "buyout" };
    } else if (L.termYears >= H) {
      ownsFrom = H + 1;                                   // leased to the end of the analysis
      leaseEnd = { year: L.termYears, outcome: "runs to horizon" };
    } else if (L.buyout > 0) {
      ownsFrom = L.termYears + 1;
      leaseEnd = { year: L.termYears, outcome: "buyout" };
    } else {
      ownsFrom = H + 1; hasUntil = L.termYears;
      leaseEnd = { year: L.termYears, outcome: "returned" };
    }
    upfront = roofCost;                                   // the lessor does not fix the roof
  } else {
    upfront = netCost;
  }

  // How much of the saving is attributable to panels vs. pack, used to blend the
  // two degradation rates.  Cost share is a crude but stable proxy.  With no hardware
  // cost to divide - a price knob driven to zero, which is exactly what breakEven()
  // does - fall back to what is physically installed, so a zero-priced array still
  // degrades at the panel rate and never picks up the pack's replacement reset.
  const hardwareCost = solarCost + storageCost;
  let wS = 1;
  if (hardwareCost > 0) wS = solarCost / hardwareCost;
  else if (watts <= 0 && sim.battKWhTotal > 0) wS = 0;      // a pack and no panels
  const wB = 1 - wS;

  // netSav is what the system earns each year before any financing: savings less
  // O&M and replacements (plus the resale credit at the horizon).  cf is netSav
  // less the year's loan or lease payment.  The two are kept apart because the
  // "pays for itself" and project-IRR figures below are about the asset, while
  // NPV and wealth are about the household's actual money.
  const cf = [-upfront], netSav = [0], savings = [0], om = [0], extras = [0], prod = [0], payments = [pay[0] || 0];
  const extraRev = [0];
  const extraPerYear = units > 0 ? f.resilienceValue + f.vppPerBattery * units : 0;
  // Replacement years recur (see replacementYears and the header).  The pack's
  // fade clock restarts at each one whoever pays for it - a lessor swapping a pack
  // in year 20 hands back a fresh one just the same.
  const battRepl = replacementYears(f.battReplYear, H), invRepl = replacementYears(f.inverterYear, H);
  let lastBattRepl = 0;
  for (let y = 1; y <= H; y++) {
    const has = y <= hasUntil, owns = y >= ownsFrom;
    const battSwap = battRepl.indexOf(y) >= 0;
    const sFac = Math.pow(1 - f.panelDeg, y - 1);
    const bAge = y - lastBattRepl;                 // capacity resets after each replacement
    if (battSwap) lastBattRepl = y;                // the new pack arrives at the end of year y
    const bFac = Math.pow(1 - f.battDeg, bAge - 1);
    const esc = Math.pow(1 + f.escalation, y - 1);
    const escX = Math.pow(1 + f.exportEscalation, y - 1);
    const deg = wS * sFac + wB * bFac;
    // The ACC Plus adder rides inside exportRevenue for its nine-year lock, then ends.
    const exportY = exportRev - (y > f.accPlusYears ? accPlusRev : 0);
    const xr = has ? extraPerYear : 0;
    const sav = has ? importSav * esc * deg + exportY * escX * deg : 0;
    // O&M, replacements and resale are the owner's: the household under cash or a
    // loan, the lessor under a lease until a buyout hands the system over.
    const o = owns ? f.omPerYear * Math.pow(1 + f.discountRate, y - 1) : 0;
    let ex = 0;
    if (owns) {
      if (sim.battKWhTotal > 0 && battSwap) ex += storageCost * f.battReplFraction;
      if (newWatts > 0 && !f.microinverters && invRepl.indexOf(y) >= 0) ex += newWatts * f.inverterPerW;
    }
    const resale = (owns || (ownsAtH && y === H)) ? f.resaleValue : 0;
    const earned = sav + xr - o - ex + (y === H ? resale : 0);
    const net = earned - pay[y];
    cf.push(net); netSav.push(earned); savings.push(sav); extraRev.push(xr); om.push(o); extras.push(ex); payments.push(pay[y]);
    prod.push(has ? sim.pvKwh * sFac : 0);
  }

  const cum = [], dcum = [];
  let run = 0, drun = 0;
  for (let y = 0; y <= H; y++) {
    run += cf[y]; cum.push(run);
    drun += cf[y] / Math.pow(1 + f.investReturn, times[y]); dcum.push(drun);
  }

  const npv = npvOf(cf, f.investReturn, times);
  // IRR is the return on an investment, so it needs one: the first money to move
  // must be an outlay.  A stream that starts positive (a loan whose payments sit
  // below the savings from year one) and only dips negative at a battery
  // replacement decades later still has a sign change, and bisection would
  // dutifully return a deeply negative "rate" that describes nothing.
  // When there is no rate, say why, so the UI can print a reason and not "0.0%":
  //   "no money down"  nothing goes out before money comes in - a fully financed
  //                    loan whose payment sits below the saving, a good lease;
  //   "never repays"   the running total never turns positive (an underwater
  //                    lease, zero savings);
  //   "no unique rate" an outlay first and a positive running total, but the signs
  //                    flip back - typically a loan whose term outlasts the horizon,
  //                    its balance settled in the final year - and no single rate
  //                    in -90%..300% zeroes the NPV.
  // projectIrr below (the unlevered return on the cash price) is unaffected.
  const firstMove = cf.find((v) => Math.abs(v) > 1e-9);
  // (An outlay that is never earned back can still have a real, negative IRR; only
  // when bisection finds no root does "never repays" stand in for it.)
  let irr = null, irrReason = null;
  if (firstMove === undefined) irrReason = "never repays";
  else if (firstMove > 0) irrReason = "no money down";
  else {
    irr = irrOf(cf, times);
    if (irr === null) irrReason = crossing(cum) === null ? "never repays" : "no unique rate";
  }

  // The asset on its own, before financing.  "Pays for itself" is the year the
  // system's cumulative earnings (netSav) have covered everything it will ever
  // cost: the upfront share plus every loan or lease payment, interest and buyout
  // included.  For cash that is the classic simple payback exactly (total cost =
  // netCost, netSav = cf); for a loan it no longer reads "day one" merely because
  // the payment sits below the saving, and a dear loan takes longer, as it should.
  // The discounted twin discounts both sides at the investment return.
  // projectIrr is the return the system earns on its cash price, whoever pays it -
  // the number to hold against a loan's APR.  `irr` above stays the levered return
  // on the household's own cash flows, which is undefined with nothing down.
  let totalCost = upfront;
  for (let y = 1; y <= H; y++) totalCost += pay[y];
  const pb = [-totalCost], dpb = [-upfront];
  let dTotal = upfront;
  for (let y = 1; y <= H; y++) dTotal += pay[y] / Math.pow(1 + f.investReturn, times[y]);
  dpb[0] = -dTotal;
  for (let y = 1; y <= H; y++) {
    pb.push(pb[y - 1] + netSav[y]);
    dpb.push(dpb[y - 1] + netSav[y] / Math.pow(1 + f.investReturn, times[y]));
  }
  const payback = totalCost > 0 ? crossing(pb) : 0;
  const discountedPayback = dTotal > 0 ? crossing(dpb) : 0;
  const projectIrr = netCost > 0 ? irrOf([-netCost].concat(netSav.slice(1)), times) : null;

  // "Same cash in the market" comparison, stated as two end-of-horizon numbers.
  // Both arms start from the same cash: what buying this system outright costs
  // (`netCost`; the sticker price under a lease, where nothing is bought).  The
  // market arm leaves all of it invested.  The system arm spends `upfront` of it
  // - all the price for cash, the down payment for a loan, nothing for a lease -
  // keeps the rest invested, and reinvests every year's net cash flow (savings
  // less O&M, replacements and any loan or lease payment) at the same return from
  // the day it arrives.  Counting only the cash flows would forget the borrower's
  // still-invested principal and make a cheap loan look worse than paying cash.
  // The identity wealthSystem - wealthInvest = NPV x (1 + r)^H holds in every mode.
  // Because the pool is this system's own price, the two absolute numbers are not
  // comparable across systems of different price; their gap (NPV) is.
  const cashRef = netCost;
  const wealthInvest = cashRef * Math.pow(1 + f.investReturn, H);
  let wealthSystem = (cashRef - upfront) * Math.pow(1 + f.investReturn, H);
  for (let y = 1; y <= H; y++) wealthSystem += cf[y] * Math.pow(1 + f.investReturn, H - times[y]);

  // LCOE over PV generated (storage cost included - it is part of what you bought).
  let costPV = upfront, kwhPV = 0;
  for (let y = 1; y <= H; y++) {
    costPV += (om[y] + extras[y] + payments[y]) / Math.pow(1 + f.discountRate, times[y]);
    kwhPV += prod[y] / Math.pow(1 + f.discountRate, times[y]);
  }
  const lcoe = kwhPV > 0 ? costPV / kwhPV : null;

  // Lifetime cost of energy service = what you pay the utility plus what you paid
  // for the system (and for the money), in present value.  The no-system arm is the
  // same sum with savings = 0, which is how "min lifetime cost" stays comparable.
  let lifetime = upfront, lifetimeNoSystem = 0;
  for (let y = 1; y <= H; y++) {
    const escY = Math.pow(1 + f.escalation, y - 1), dis = Math.pow(1 + f.discountRate, times[y]);
    // The with-system bill in year y is today's bill escalated, less that year's
    // saving - which already carries the escalation split (import at retail,
    // export locked) and the degradation blend, so lifetime cost and NPV agree
    // on how much a slowly fading array is worth.
    const billY = sim.baselineBill * escY - savings[y] - extraRev[y];
    lifetime += (billY + om[y] + extras[y] + payments[y]) / dis;
    lifetimeNoSystem += (sim.baselineBill * escY) / dis;
  }

  // What the customer writes a cheque for each month: the loan's level payment, or a
  // lease's first-year payment spread over twelve (which is the quoted monthly unless
  // a buyout lands in year 1).  Cash buys nothing on instalment.
  let monthlyPayment = 0;
  if (mode === "loan") monthlyPayment = amort ? amort.payment : 0;
  else if (isLease) monthlyPayment = (pay[1] || 0) / 12;

  const firstYearPayment = pay[1] || 0;
  const firstYearMonthlyOutlay = firstYearPayment / 12 + (sim.bill || 0) / 12;
  const currentMonthlyBill = (sim.baselineBill || 0) / 12;

  return {
    inputs: f, gross, itc, sgip, rebates, netCost,
    solarCost, storageCost, roofCost,
    effectiveDiscount: disc, discountValue: gross - discounted,
    effectiveCostPerW: f.costPerW * (1 - disc), effectiveCostPerKwh: f.costPerKwh * (1 - disc),
    cashflows: cf, savingsByYear: savings, omByYear: om, extrasByYear: extras,
    paymentsByYear: payments,
    cumulative: cum, discountedCumulative: dcum, flowTimes: times,
    npv, irr, irrReason, projectIrr,
    payback, discountedPayback, totalCost,
    // When the household's own running cash turns positive (0 = from day one).
    cashFlowPayback: crossing(cum),
    loanPaidOffYear: amort ? Math.min(amort.termYears, H) : null,
    // Lease only: { year, outcome } - "buyout" (owned after `year`), "returned"
    // (savings stop after `year`) or "runs to horizon" (leased throughout).
    leaseEnd,
    // Years in which a replacement was booked (whoever paid for it).
    replacementYears: { battery: sim.battKWhTotal > 0 ? battRepl : [], inverter: newWatts > 0 && !f.microinverters ? invRepl : [] },
    netSavingsByYear: netSav,
    lcoe, lifetimeCost: lifetime, lifetimeCostNoSystem: lifetimeNoSystem,
    wealthInvest, wealthSystem, wealthDelta: wealthSystem - wealthInvest, cashRef,
    firstYearSavings: (savings[1] || 0) + (extraRev[1] || 0),
    // Non-bill battery value (year-1 figures; per-year stream in extraRevenueByYear).
    resilienceValue: extraRev[1] ? f.resilienceValue : 0,
    vppRevenue: extraRev[1] ? f.vppPerBattery * units : 0,
    extraRevenue: extraRev[1] || 0, extraRevenueByYear: extraRev,
    batteryFixedCost: units * f.costPerBattery, newKwDc: newWatts / 1000,
    importSavings: importSav, exportRevenue: exportRev,
    horizon: H,
    // financing
    financingMode: mode, upfront, downPayment: isLease ? 0 : upfront,
    loanPrincipal: principal, dealerFee, monthlyPayment,
    totalInterest: amort ? amort.totalInterest : 0,
    financingSchedule: schedule,
    firstYearPayment, firstYearMonthlyOutlay, currentMonthlyBill,
    monthlyOutlayDelta: firstYearMonthlyOutlay - currentMonthlyBill,
  };
}

/**
 * Price at which NPV crosses zero, holding everything else fixed.
 *
 * NPV is very nearly linear in $/W and $/kWh - both scale the year-0 outlay and
 * nothing else - but not exactly: the degradation blend weights panels against pack
 * by their COST share, so moving one price also tilts the savings stream a little.
 * On a system carrying both, the straight two-point line misses by thousands of
 * dollars, so it is used only as the first guess and secant steps land on the root.
 * Returns null when there is no root to find: a price NPV does not respond to has no
 * break-even, and under a lease the sticker price is not what the customer pays.
 */
export function breakEven(sim, f, key) {
  // Said in so many words: the sticker price only nudges a lease's NPV through the
  // cost-share degradation blend, and a root found that way would be noise.
  if (withDefaults(f).financing.mode === "lease") return null;
  const npvAt = (price) => evaluate(sim, Object.assign({}, f, { [key]: price })).npv;
  const at0 = npvAt(0), at1 = npvAt(1);
  const slope = at1 - at0;
  if (Math.abs(slope) < 1e-9) return null;
  let x0 = 0, y0 = at0;
  let x1 = -at0 / slope, y1 = npvAt(x1);
  for (let i = 0; i < 40 && Math.abs(y1) > 1e-6; i++) {
    const step = y1 * (x1 - x0) / (y1 - y0);
    if (!isFinite(step) || step === 0) break;
    x0 = x1; y0 = y1;
    x1 -= step; y1 = npvAt(x1);
  }
  // Only report a price that really does zero the NPV.  `slope` is dollars of NPV per
  // dollar of price, so this asks that the answer be right to a millionth of a $/W -
  // and refuses the huge number the secant wanders to when NPV is all but flat.
  return Math.abs(y1) <= Math.abs(slope) * 1e-6 ? x1 : null;
}

const SolarFinance = { evaluate, breakEven, withDefaults, effectiveDiscount, replacementYears,
                       REPLACE_MIN_REMAINING,
                       npvOf, irrOf, flowTimes, crossing, loanPayment, amortize, DEFAULTS };
export default SolarFinance;
