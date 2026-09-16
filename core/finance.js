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
 * Savings accrue in all three.
 * ========================================================================== */

export const DEFAULTS = {
  costPerW: 3.00,            // $/W DC, installed, before incentives
  costPerKwh: 1000,          // $/kWh usable storage, installed
  adder: 0,                  // fixed install adder (panel upgrade, trenching, ...)
  taxCreditPct: 0,           // homeowner-claimed 25D - terminated for 2026 installs
  // How a third-party credit reaches the customer.  "none" | "discount" | "vendor".
  incentiveMode: "vendor",
  discountPct: 0,            // mode "discount": straight % off system price
  vendorCreditPct: 0.40,     // mode "vendor": the credit the vendor claims - context only
  passThroughPct: 0.34,      // mode "vendor": points off the system price they pass on
  sgipPerKwh: 0,             // SGIP storage rebate, $/kWh usable (closed as of 2026)
  rebates: 0,                // any other one-off rebate $ (CPA Sun Storage, ...)
  horizon: 25,               // analysis years
  escalation: 0.045,         // retail rate escalation, nominal $/yr
  exportEscalation: 0.0,     // export credits are locked to a fixed ACC vintage
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
  return o;
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

export function npvOf(cf, rate) {
  let v = 0;
  for (let y = 0; y < cf.length; y++) v += cf[y] / Math.pow(1 + rate, y);
  return v;
}

/** Bisection IRR on a cash-flow array starting at year 0. Null if it never crosses. */
export function irrOf(cf) {
  let lo = -0.9, hi = 3.0;
  let flo = npvOf(cf, lo), fhi = npvOf(cf, hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npvOf(cf, mid);
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
 * Monthly amortization summed into annual rows.
 * Returns { payment /*monthly*​/, rows: [{ year, payment, interest, principal, balance }],
 *           totalInterest, termYears }.
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
 * @param f    finance inputs (see DEFAULTS)
 */
export function evaluate(sim, f) {
  f = withDefaults(f);
  const mode = f.financing.mode;
  const isLease = mode === "lease";
  // Backward compatible: a sim that carries only `savings` is treated as all-import.
  const exportRev = sim.exportRevenue || 0;
  const importSav = sim.importSavings !== undefined ? sim.importSavings : (sim.savings - exportRev);
  const watts = sim.kwdc * 1000;
  const solarCost = watts * f.costPerW;
  const storageCost = sim.battKWhTotal * f.costPerKwh;
  const gross = solarCost + storageCost + (watts > 0 || sim.battKWhTotal > 0 ? f.adder : 0);
  const disc = effectiveDiscount(f);
  const discounted = gross * (1 - disc);
  // A leased system is never bought, so no homeowner credit or rebate applies to it.
  const itc = isLease ? 0 : discounted * f.taxCreditPct;
  const sgip = isLease ? 0 : sim.battKWhTotal * f.sgipPerKwh;
  const rebates = isLease ? 0 : f.rebates;
  const netCost = isLease ? gross : Math.max(0, discounted - itc - sgip - rebates);

  const H = Math.max(1, Math.round(f.horizon));

  // ----------------------------------------------------------------- financing
  const pay = new Array(H + 1).fill(0);
  let upfront = 0, schedule = [], amort = null, principal = 0, dealerFee = 0;
  if (mode === "loan") {
    const L = f.financing.loan;
    dealerFee = netCost * L.sharePct * L.dealerFeePct;
    principal = netCost * L.sharePct * (1 + L.dealerFeePct);
    upfront = netCost * (1 - L.sharePct);
    amort = amortize(principal, L.apr, L.termYears);
    schedule = amort.rows;
    for (const r of schedule) if (r.year <= H) pay[r.year] = r.payment;
    // A term longer than the analysis horizon leaves a debt: pay it off at the horizon
    // so the comparison is like-for-like with cash.
    const atH = schedule.find((r) => r.year === H);
    if (schedule.length > H && atH) pay[H] += atH.balance;
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
  } else {
    upfront = netCost;
  }

  // How much of the saving is attributable to panels vs. pack, used to blend the
  // two degradation rates.  Cost share is a crude but stable proxy.
  let wS = gross > 0 ? solarCost / Math.max(1e-9, solarCost + storageCost) : 1;
  if (!isFinite(wS)) wS = 1;
  const wB = 1 - wS;

  const cf = [-upfront], savings = [0], om = [0], extras = [0], prod = [0], payments = [pay[0] || 0];
  for (let y = 1; y <= H; y++) {
    const sFac = Math.pow(1 - f.panelDeg, y - 1);
    // capacity resets when the pack is replaced
    const bAge = (f.battReplYear > 0 && y > f.battReplYear) ? y - f.battReplYear : y;
    const bFac = Math.pow(1 - f.battDeg, bAge - 1);
    const esc = Math.pow(1 + f.escalation, y - 1);
    const escX = Math.pow(1 + f.exportEscalation, y - 1);
    const deg = wS * sFac + wB * bFac;
    const sav = importSav * esc * deg + exportRev * escX * deg;
    // Under a lease the third party owns and maintains the hardware.
    const o = isLease ? 0 : f.omPerYear * Math.pow(1 + f.discountRate, y - 1);
    let ex = 0;
    if (!isLease) {
      if (sim.battKWhTotal > 0 && y === Math.round(f.battReplYear)) ex += sim.battKWhTotal * f.costPerKwh * f.battReplFraction;
      if (watts > 0 && y === Math.round(f.inverterYear)) ex += watts * f.inverterPerW;
    }
    const resale = isLease ? 0 : f.resaleValue;
    const net = sav - o - ex - pay[y] + (y === H ? resale : 0);
    cf.push(net); savings.push(sav); om.push(o); extras.push(ex); payments.push(pay[y]);
    prod.push(sim.pvKwh * sFac);
  }

  const cum = [], dcum = [];
  let run = 0, drun = 0;
  for (let y = 0; y <= H; y++) {
    run += cf[y]; cum.push(run);
    drun += cf[y] / Math.pow(1 + f.investReturn, y); dcum.push(drun);
  }

  const npv = npvOf(cf, f.investReturn);
  const irr = irrOf(cf);

  // "Same cash in the market" comparison, stated as two end-of-horizon numbers.
  // With no upfront outlay (a lease) there is no cash to invest instead, so the
  // comparison collapses to "is the system cash-flow positive?".
  const wealthInvest = upfront * Math.pow(1 + f.investReturn, H);
  let wealthSystem = 0;
  for (let y = 1; y <= H; y++) wealthSystem += cf[y] * Math.pow(1 + f.investReturn, H - y);

  // LCOE over PV generated (storage cost included - it is part of what you bought).
  let costPV = upfront, kwhPV = 0;
  for (let y = 1; y <= H; y++) {
    costPV += (om[y] + extras[y] + payments[y]) / Math.pow(1 + f.discountRate, y);
    kwhPV += prod[y] / Math.pow(1 + f.discountRate, y);
  }
  const lcoe = kwhPV > 0 ? costPV / kwhPV : null;

  // Lifetime cost of energy service = what you pay the utility plus what you paid
  // for the system (and for the money), in present value.  The no-system arm is the
  // same sum with savings = 0, which is how "min lifetime cost" stays comparable.
  let lifetime = upfront, lifetimeNoSystem = 0;
  for (let y = 1; y <= H; y++) {
    const escY = Math.pow(1 + f.escalation, y - 1), dis = Math.pow(1 + f.discountRate, y);
    const escXY = Math.pow(1 + f.exportEscalation, y - 1);
    // The bill is net of export credits; only its charge side follows retail rates.
    const billY = (sim.bill + exportRev) * escY - exportRev * escXY;
    lifetime += (billY + om[y] + extras[y] + payments[y]) / dis;
    lifetimeNoSystem += (sim.baselineBill * escY) / dis;
  }

  const firstYearPayment = pay[1] || 0;
  const firstYearMonthlyOutlay = firstYearPayment / 12 + (sim.bill || 0) / 12;
  const currentMonthlyBill = (sim.baselineBill || 0) / 12;

  return {
    inputs: f, gross, itc, sgip, rebates, netCost,
    solarCost, storageCost,
    effectiveDiscount: disc, discountValue: gross - discounted,
    effectiveCostPerW: f.costPerW * (1 - disc), effectiveCostPerKwh: f.costPerKwh * (1 - disc),
    cashflows: cf, savingsByYear: savings, omByYear: om, extrasByYear: extras,
    paymentsByYear: payments,
    cumulative: cum, discountedCumulative: dcum,
    npv, irr,
    payback: crossing(cum), discountedPayback: crossing(dcum),
    lcoe, lifetimeCost: lifetime, lifetimeCostNoSystem: lifetimeNoSystem,
    wealthInvest, wealthSystem, wealthDelta: wealthSystem - wealthInvest,
    firstYearSavings: savings[1] || 0,
    importSavings: importSav, exportRevenue: exportRev,
    horizon: H,
    // financing
    financingMode: mode, upfront, downPayment: mode === "loan" ? upfront : (mode === "cash" ? netCost : 0),
    loanPrincipal: principal, dealerFee,
    monthlyPayment: mode === "loan" ? (amort ? amort.payment : 0)
                  : isLease ? (pay[1] || 0) / 12 : 0,
    totalInterest: amort ? amort.totalInterest : 0,
    financingSchedule: schedule,
    firstYearPayment, firstYearMonthlyOutlay, currentMonthlyBill,
    monthlyOutlayDelta: firstYearMonthlyOutlay - currentMonthlyBill,
  };
}

/**
 * Price at which NPV crosses zero, holding everything else fixed.  NPV is exactly
 * linear in $/W and $/kWh (both scale the year-0 outlay and nothing else), so two
 * evaluations pin the line - no search needed.
 */
export function breakEven(sim, f, key) {
  const a = evaluate(sim, Object.assign({}, f, { [key]: 0 })).npv;
  const b = evaluate(sim, Object.assign({}, f, { [key]: 1 })).npv;
  const slope = b - a;
  if (Math.abs(slope) < 1e-9) return null;
  return -a / slope;
}

const SolarFinance = { evaluate, breakEven, withDefaults, effectiveDiscount,
                       npvOf, irrOf, crossing, loanPayment, amortize, DEFAULTS };
export default SolarFinance;
