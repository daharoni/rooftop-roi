/* =============================================================================
 * tests/finance.test.mjs - node --test tests/
 *
 * The prototype's finance assertions (hand arithmetic, incentive modes, the
 * import/export escalation split) are carried over unchanged - they all run in the
 * default `financing.mode: "cash"`, which is exactly what the prototype did - plus
 * the loan and lease arithmetic.
 * ========================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import Finance from "../core/finance.js";
import { DEFAULTS as STATE_DEFAULTS } from "../app/state.js";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);

/** 1 kW at $1/W saving $1,000/yr, no O&M, no degradation - everything hand-checkable. */
const SIM = { savings: 1000, bill: 0, baselineBill: 1000, pvKwh: 1000, kwdc: 1, battKWhTotal: 0 };
// Year-end timing keeps the hand arithmetic below on whole-year powers; the mid-year
// default (and the difference it makes) has its own tests further down.
const FLAT = { costPerW: 1, adder: 0, taxCreditPct: 0, incentiveMode: "none", sgipPerKwh: 0,
               rebates: 0, horizon: 2, escalation: 0, investReturn: 0.10, discountRate: 0,
               panelDeg: 0, battDeg: 0, omPerYear: 0, battReplYear: 99, inverterYear: 99,
               resaleValue: 0, midYear: false };

// ================================================================== cash (prototype)
test("cash: NPV / IRR / payback against hand arithmetic", () => {
  const r = Finance.evaluate(SIM, FLAT);
  assert.equal(r.financingMode, "cash", "cash is the default financing mode");
  near(r.netCost, 1000, 1e-9, "1 kW at $1.00/W = $1,000 net cost");
  assert.equal(r.cashflows.join(","), "-1000,1000,1000", "cash flows are -1000, +1000, +1000");
  near(r.npv, -1000 + 1000 / 1.1 + 1000 / 1.21, 1e-6, "NPV at 10% = $735.537");
  near(r.irr, 1 / ((Math.sqrt(5) - 1) / 2) - 1, 1e-6, "IRR = 61.8034% (golden-ratio root)");
  near(r.payback, 1.0, 1e-9, "simple payback exactly 1 year");
  near(r.wealthInvest, 1000 * 1.21, 1e-6, "cash in the market: $1,000 -> $1,210");
  near(r.wealthSystem, 1000 * 1.1 + 1000, 1e-6, "savings reinvested: $2,100");
  assert.equal(r.wealthSystem > r.wealthInvest, r.npv > 0,
               "NPV > 0 agrees with beating the investment account");
  near(r.upfront, 1000, 1e-9, "the whole net cost is paid at year 0");
  assert.deepEqual(r.financingSchedule, [], "cash has no payment schedule");
  near(r.firstYearPayment, 0, 1e-12, "and no financing payment");
});

test("cash: escalation, degradation, incentives and break-even", () => {
  const r2 = Finance.evaluate(SIM, { ...FLAT, horizon: 3, escalation: 0.05, panelDeg: 0.01 });
  near(r2.savingsByYear[3], 1000 * Math.pow(1.05, 2) * Math.pow(0.99, 2), 1e-6,
       "year-3 savings = esc^2 x (1-deg)^2");

  const r3 = Finance.evaluate({ ...SIM, battKWhTotal: 10 },
    { ...FLAT, costPerKwh: 1000, taxCreditPct: 0.30, sgipPerKwh: 150 });
  near(r3.netCost, (1000 + 10000) * 0.7 - 1500, 1e-6, "30% ITC then $150/kWh SGIP");

  const be = Finance.breakEven(SIM, FLAT, "costPerW");
  near(Finance.evaluate(SIM, { ...FLAT, costPerW: be }).npv, 0, 1e-6,
       `break-even $/W (${be.toFixed(3)}) really does give NPV = 0`);

  const noIrr = Finance.evaluate({ ...SIM, savings: 0 }, FLAT);
  assert.ok(noIrr.irr === null && noIrr.payback === null,
            "zero savings -> no IRR, no payback (not a fake number)");
});

test("break-even prices really are break-even, panels and pack together", () => {
  // The degradation blend weights panels against pack by COST share, so NPV is not
  // quite linear in either price: the straight line through $0/W and $1/W lands
  // thousands of dollars from the root on a system that carries both.
  const sim = { savings: 3500, importSavings: 2800, exportRevenue: 700, bill: 700,
                baselineBill: 4200, pvKwh: 14000, kwdc: 9.2, battKWhTotal: 10 };
  const f = { costPerW: 3, costPerKwh: 1000, incentiveMode: "none", horizon: 25 };
  for (const key of ["costPerW", "costPerKwh"]) {
    const be = Finance.breakEven(sim, f, key);
    assert.ok(be > 0, `the ${key} break-even is a real price (${be.toFixed(2)})`);
    near(Finance.evaluate(sim, { ...f, [key]: be }).npv, 0, 1e-6,
         `NPV really is zero at the ${key} break-even`);
  }
  assert.equal(Finance.breakEven({ ...sim, kwdc: 0, battKWhTotal: 0 }, f, "costPerW"), null,
               "a price NPV does not respond to has no break-even");
  const leased = { ...f, financing: { mode: "lease",
    lease: { monthly: 150, escalatorPct: 0.029, termYears: 25, buyout: 0 } } };
  assert.equal(Finance.breakEven(sim, leased, "costPerW"), null,
               "and neither does a lease: the sticker price is not what the customer pays");
});

test("a zero-priced array degrades like panels, not like a battery", () => {
  // Reachable from breakEven(), which evaluates at $0/W: with an install adder the
  // hardware cost is zero while `gross` is not, and the cost-share blend used to hand
  // the whole weight to the pack - degrading a battery-less system at the battery
  // rate, complete with the reset at the replacement year.
  const sim = { savings: 1000, bill: 0, baselineBill: 1000, pvKwh: 1000, kwdc: 5, battKWhTotal: 0 };
  const f = { adder: 5000, incentiveMode: "none", horizon: 25, escalation: 0, investReturn: 0.07,
              panelDeg: 0.005, battDeg: 0.02, battReplYear: 20, omPerYear: 0, inverterYear: 99 };
  const free = Finance.evaluate(sim, { ...f, costPerW: 0 });
  near(free.savingsByYear[25], 1000 * Math.pow(1 - 0.005, 24), 1e-9,
       "year-25 savings follow the panel degradation rate");
  near(free.savingsByYear[25], Finance.evaluate(sim, { ...f, costPerW: 1e-9 }).savingsByYear[25],
       1e-6, "and a price falling to zero is not a discontinuity");
});

test("incentive modes", () => {
  const sim = { ...SIM, kwdc: 10 };
  const base = { costPerW: 3, adder: 0, taxCreditPct: 0, sgipPerKwh: 0, rebates: 0 };
  near(Finance.evaluate(sim, { ...base, incentiveMode: "none" }).netCost, 30000, 1e-6,
       "no incentive: 10 kW at $3.00/W = $30,000");
  near(Finance.evaluate(sim, { ...base, incentiveMode: "discount", discountPct: 0.25 }).netCost,
       22500, 1e-6, "direct discount: 25% off = $22,500");
  const vend = Finance.evaluate(sim, { ...base, incentiveMode: "vendor" });
  near(vend.effectiveDiscount, 0.34, 1e-12, "vendor pass-through defaults to 34 points off");
  near(Finance.evaluate(sim, base).netCost, 30000, 1e-6, "and with no mode given, no incentive (the app's default)");
  near(vend.netCost, 30000 * 0.66, 1e-6, "...so a $30,000 system nets $19,800");
  near(vend.effectiveCostPerW, 1.98, 1e-12, "$3.00/W sticker shows $1.98/W net");
  const vendKwh = Finance.evaluate({ ...sim, battKWhTotal: 10 },
                                   { ...base, costPerKwh: 1000, incentiveMode: "vendor" });
  near(vendKwh.effectiveCostPerKwh, 660, 1e-9, "$1,000/kWh sticker shows $660/kWh net");
  assert.equal(Finance.DEFAULTS.incentiveMode, "none", "no incentive is the default mode, as in the app");
  near(Finance.DEFAULTS.vendorCreditPct, 0.40, 1e-12, "the vendor's 40% credit is context only");
  near(Finance.DEFAULTS.battReplYear, 20, 0, "battery replacement defaults to year 20");
});

test("import savings and export revenue escalate independently", () => {
  const s1 = { savings: 1000, importSavings: 600, exportRevenue: 400, bill: 0, baselineBill: 1000,
               pvKwh: 1000, kwdc: 1, battKWhTotal: 0 };
  const base = { costPerW: 1, incentiveMode: "none", horizon: 10, escalation: 0.05,
                 investReturn: 0.07, discountRate: 0.025, panelDeg: 0, battDeg: 0,
                 omPerYear: 0, battReplYear: 99, inverterYear: 99 };
  const locked = Finance.evaluate(s1, { ...base, exportEscalation: 0 });
  const rising = Finance.evaluate(s1, { ...base, exportEscalation: 0.05 });
  const legacy = Finance.evaluate({ ...s1, importSavings: undefined, exportRevenue: 0 }, base);
  assert.ok(locked.npv < rising.npv, "locked export credits give a lower NPV");
  near(rising.npv, legacy.npv, 1e-9, "exportEscalation = escalation reproduces the old formula");
  near(legacy.importSavings, 1000, 1e-9, "a sim carrying only `savings` is treated as all import");
  near(Finance.DEFAULTS.exportEscalation, 0, 1e-12, "export escalation defaults to zero");
  near(locked.savingsByYear[1], 1000, 1e-9, "year 1 is unchanged either way");
  near(locked.savingsByYear[3], 600 * 1.05 ** 2 + 400, 1e-9, "year 3: only the import half has grown");

  const lifeLocked = Finance.evaluate({ ...s1, bill: 500 }, { ...base, exportEscalation: 0 });
  const lifeRising = Finance.evaluate({ ...s1, bill: 500 }, { ...base, exportEscalation: 0.05 });
  assert.ok(lifeLocked.lifetimeCost > lifeRising.lifetimeCost,
            "locked export credits also raise modelled lifetime cost");
});

// ================================================================== loan
test("loan: the payment is the textbook annuity and the schedule amortises to zero", () => {
  // $20,000 at 6.00% over 10 years.  Hand arithmetic:
  //   i = 0.005, n = 120, pay = 20000 x 0.005 / (1 - 1.005^-120) = $222.0410/month
  const a = Finance.amortize(20000, 0.06, 10);
  near(a.payment, 222.0410, 0.0001, "monthly payment matches the hand-computed annuity");
  near(Finance.loanPayment(20000, 0.06, 120), a.payment, 1e-12, "loanPayment() agrees");
  assert.equal(a.rows.length, 10, "ten annual rows");
  near(a.rows[9].balance, 0, 1e-9, "the note is paid off exactly at the end of the term");
  const paid = a.rows.reduce((t, r) => t + r.payment, 0);
  const prin = a.rows.reduce((t, r) => t + r.principal, 0);
  const int = a.rows.reduce((t, r) => t + r.interest, 0);
  near(prin, 20000, 1e-6, "principal repaid equals the principal borrowed");
  near(paid, prin + int, 1e-6, "payments split exactly into principal and interest");
  near(int, a.totalInterest, 1e-9, "totalInterest is the sum of the interest column");
  near(paid, 222.0410 * 120, 0.02, "total paid = 120 level payments");
  for (let i = 1; i < a.rows.length; i++) {
    assert.ok(a.rows[i].interest < a.rows[i - 1].interest, "interest falls every year");
    assert.ok(a.rows[i].balance < a.rows[i - 1].balance, "balance falls every year");
  }
  const zero = Finance.amortize(1200, 0, 1);
  near(zero.payment, 100, 1e-12, "a 0% loan is just the principal over the term");
  near(zero.rows[0].balance, 0, 1e-12, "and still lands on zero");
});

test("loan: down payment, dealer fee and cash flows", () => {
  const sim = { ...SIM, kwdc: 10, savings: 4000, baselineBill: 5000, bill: 1000 };
  const f = { ...FLAT, costPerW: 2, horizon: 25, incentiveMode: "none",
              financing: { mode: "loan", loan: { sharePct: 1, apr: 0.06, termYears: 10, dealerFeePct: 0 } } };
  const r = Finance.evaluate(sim, f);
  near(r.netCost, 20000, 1e-9, "10 kW at $2/W = $20,000");
  near(r.loanPrincipal, 20000, 1e-9, "financing the whole thing borrows the whole thing");
  near(r.upfront, 0, 1e-12, "100% financed means nothing at year 0");
  near(r.cashflows[0], 0, 1e-12, "...and a year-0 cash flow of zero");
  near(r.monthlyPayment, 222.0410, 0.0001, "the monthly payment is the annuity");
  near(r.cashflows[1], sim.savings - 222.0410 * 12, 0.01, "year 1 = savings minus 12 payments");
  near(r.cashflows[11], sim.savings, 1e-6, "after the term the payments stop");
  near(r.financingSchedule[9].balance, 0, 1e-9, "the schedule amortises to zero");
  near(r.wealthInvest, 20000 * Math.pow(1.10, 25), 1e-6, "the market arm invests the cash price of the system");
  {
    // The borrower keeps the $20,000 invested and pays the loan out of savings.
    let fv = 20000 * Math.pow(1.10, 25);
    for (let y = 1; y <= 25; y++) fv += r.cashflows[y] * Math.pow(1.10, 25 - y);
    near(r.wealthSystem, fv, 1e-6, "system arm = invested principal + reinvested net cash flows");
  }
  near(r.wealthDelta, r.npv * Math.pow(1.10, 25), 1e-6, "wealthDelta is NPV compounded to the horizon");

  const half = Finance.evaluate(sim, { ...f, financing: { mode: "loan",
    loan: { sharePct: 0.7, apr: 0.06, termYears: 10, dealerFeePct: 0 } } });
  near(half.downPayment, 6000, 1e-9, "a 70% loan leaves a 30% down payment");
  near(half.cashflows[0], -6000, 1e-9, "which is the year-0 outlay");
  near(half.loanPrincipal, 14000, 1e-9, "and borrows the other $14,000");
  near(half.wealthInvest, 20000 * Math.pow(1.10, 25), 1e-6, "the market arm is the same whatever the down payment");
  near(half.wealthSystem - half.wealthInvest, half.npv * Math.pow(1.10, 25), 1e-6,
       "and the wealth gap is still NPV compounded");

  const dealer = Finance.evaluate(sim, { ...f, financing: { mode: "loan",
    loan: { sharePct: 1, apr: 0.06, termYears: 10, dealerFeePct: 0.20 } } });
  near(dealer.loanPrincipal, 24000, 1e-9, "a 20% dealer fee inflates the principal, not the price");
  near(dealer.netCost, 20000, 1e-9, "the system still costs $20,000");
  near(dealer.dealerFee, 4000, 1e-9, "the fee is reported separately");
  near(dealer.monthlyPayment, 222.0410 * 1.2, 0.001, "and the payment scales with it");
  assert.ok(dealer.npv < r.npv, "a dealer fee always makes the deal worse");

  // A term longer than the horizon is paid off at the horizon, so modes stay comparable.
  const long = Finance.evaluate(sim, { ...f, horizon: 5, financing: { mode: "loan",
    loan: { sharePct: 1, apr: 0.06, termYears: 10, dealerFeePct: 0 } } });
  const at5 = Finance.amortize(20000, 0.06, 10).rows[4].balance;
  assert.ok(at5 > 0, "there is still a balance in year 5");
  near(long.cashflows[5], sim.savings - 222.0410 * 12 - at5, 0.02,
       "the outstanding balance is settled in the final year");
});

test("IRR needs an outlay first: a stream that starts positive has none", () => {
  // 100% financed over 25 years at 1%: payments are below the savings from year 1,
  // so the only negative year is the battery replacement. Bisection would find a
  // sign change and a garbage negative rate; the model must report null instead.
  const sim = { savings: 5000, bill: 1000, baselineBill: 6000, pvKwh: 15000, kwdc: 10, battKWhTotal: 10 };
  const r = Finance.evaluate(sim, { ...FLAT, costPerW: 3, costPerKwh: 1000, horizon: 25, battReplYear: 20,
    battReplFraction: 0.5, financing: { mode: "loan", loan: { sharePct: 1, apr: 0.01, termYears: 25, dealerFeePct: 0 } } });
  assert.ok(r.cashflows[1] > 0, "year 1 is already cash positive");
  assert.ok(r.cashflows[20] < 0, "the replacement year is negative");
  assert.equal(r.irr, null, "so there is no levered rate of return to report");
  assert.equal(r.cashFlowPayback, 0, "the household is cash positive from day one");
  assert.ok(r.payback > 5 && r.payback < 25, "but the system takes years to pay for itself, interest included");
  assert.ok(r.projectIrr > 0, "and the project IRR is the return on the cash price");
  const cash = Finance.evaluate(sim, { ...FLAT, costPerW: 3, costPerKwh: 1000, horizon: 25 });
  assert.ok(cash.irr !== null && cash.irr > 0, "the same system bought for cash has a real IRR");
});

test("loan: monthly outlay against today's bill", () => {
  const sim = { savings: 3000, bill: 900, baselineBill: 3900, pvKwh: 12000, kwdc: 8, battKWhTotal: 0 };
  const r = Finance.evaluate(sim, { ...FLAT, costPerW: 2, horizon: 25,
    financing: { mode: "loan", loan: { sharePct: 1, apr: 0.06, termYears: 10, dealerFeePct: 0 } } });
  near(r.currentMonthlyBill, 3900 / 12, 1e-9, "today's bill, per month");
  near(r.firstYearMonthlyOutlay, r.monthlyPayment + 900 / 12, 1e-9,
       "first-year outlay = loan payment + the remaining utility bill, per month");
  near(r.monthlyOutlayDelta, r.firstYearMonthlyOutlay - r.currentMonthlyBill, 1e-12,
       "and the delta answers 'is my monthly outlay lower than today's bill?'");
  const cash = Finance.evaluate(sim, { ...FLAT, costPerW: 2, horizon: 25 });
  near(cash.firstYearMonthlyOutlay, 900 / 12, 1e-9, "a cash buyer's outlay is just the new bill");
});

// ================================================================== timing
test("mid-year timing: flows dated when they arrive, loans no longer flattered", () => {
  assert.equal(Finance.DEFAULTS.midYear, true, "mid-year is the default");
  assert.deepEqual(Finance.flowTimes(3), [0, 0.5, 1.5, 2.5], "day one, then the middle of each year");
  assert.deepEqual(Finance.flowTimes(3, false), [0, 1, 2, 3], "or year end on request");

  const endY = Finance.evaluate(SIM, FLAT);
  const midY = Finance.evaluate(SIM, { ...FLAT, midYear: true });
  assert.deepEqual(midY.flowTimes, [0, 0.5, 1.5], "the result reports its own dating");
  near(midY.npv, -1000 + 1000 / 1.1 ** 0.5 + 1000 / 1.1 ** 1.5, 1e-6, "NPV discounts to t = 0.5 and 1.5");
  near(midY.npv, endY.cashflows[0] + (endY.npv - endY.cashflows[0]) * 1.1 ** 0.5, 1e-6,
       "which is the year-end NPV of the later flows brought forward half a year");
  assert.ok(midY.irr > endY.irr, "earlier receipts mean a higher IRR");
  near(midY.payback, endY.payback, 1e-12, "simple payback is undiscounted and does not move");
  near(midY.wealthDelta, midY.npv * 1.21, 1e-9, "the wealth identity holds under mid-year timing");
  near(midY.wealthSystem, 1000 * 1.1 ** 1.5 + 1000 * 1.1 ** 0.5, 1e-6,
       "savings reinvested from the middle of each year");

  // The bug this fixes: a 2-year loan at 8.25% while the market pays 7%.  Dated at
  // year end, each payment was credited with up to a year of return it never earned
  // and borrowing beat cash; dated when it is paid, it loses, as it must.
  const sim = { savings: 3000, bill: 600, baselineBill: 3600, pvKwh: 15000, kwdc: 10, battKWhTotal: 0 };
  const base = { ...FLAT, costPerW: 3, horizon: 25, investReturn: 0.07, midYear: true };
  const loan = { mode: "loan", loan: { sharePct: 1, apr: 0.0825, termYears: 2, dealerFeePct: 0 } };
  const cash = Finance.evaluate(sim, base);
  const dear = Finance.evaluate(sim, { ...base, financing: loan });
  assert.ok(dear.npv < cash.npv, `borrowing at 8.25% loses to cash when the market pays 7% (${Math.round(dear.npv - cash.npv)})`);
  const oldDear = Finance.evaluate(sim, { ...base, midYear: false, financing: loan });
  const oldCash = Finance.evaluate(sim, { ...base, midYear: false });
  assert.ok(oldDear.npv > oldCash.npv, "(year-end dating had it the other way round)");
  // Borrowing at the market rate is very nearly a wash - only monthly compounding
  // makes 7.00% APR a touch dearer than 7% a year - and always within 1% of the price.
  const par = Finance.evaluate(sim, { ...base, financing: { ...loan, loan: { ...loan.loan, apr: 0.07 } } });
  assert.ok(par.npv < cash.npv && cash.npv - par.npv < 0.01 * cash.netCost,
            `a 7% loan against a 7% market is a small loss (${Math.round(par.npv - cash.npv)})`);
  // And the exact monthly schedule agrees with the mid-year shortcut to a fraction of a percent.
  const a = Finance.amortize(dear.netCost, 0.0825, 2);
  let monthly = 0;
  for (let m = 1; m <= 24; m++) monthly += a.payment * 1.07 ** (25 - m / 12);
  let midYearCost = 0;
  for (const row of a.rows) midYearCost += row.payment * 1.07 ** (25 - (row.year - 0.5));
  near(midYearCost, monthly, 0.005 * monthly, "mid-year dating matches month-by-month timing within 0.5%");
});

// ================================================================== lease
test("lease: no upfront, escalating payments, no ownership incentives", () => {
  const sim = { ...SIM, kwdc: 10, savings: 3000, baselineBill: 3600, bill: 600 };
  const lease = { mode: "lease", lease: { monthly: 100, escalatorPct: 0, termYears: 2, buyout: 0 } };
  const r = Finance.evaluate({ ...sim, savings: 1000, baselineBill: 1000, bill: 0 },
                             { ...FLAT, costPerW: 3, incentiveMode: "vendor", taxCreditPct: 0.3,
                               horizon: 2, financing: lease });
  near(r.upfront, 0, 1e-12, "a lease costs nothing at signing");
  near(r.itc, 0, 1e-12, "no homeowner tax credit on a system the homeowner does not own");
  near(r.effectiveDiscount, 0, 1e-12, "and no vendor pass-through either");
  near(r.netCost, 30000, 1e-9, "netCost reports the sticker price, for reference only");
  assert.equal(r.cashflows.join(","), "0,-200,-200", "cf = savings 1000 - payments 1200, twice");
  near(r.npv, -200 / 1.1 - 200 / 1.21, 1e-9, "NPV at 10% = -$347.107");
  near(r.wealthInvest, 30000 * 1.21, 1e-9, "the reference cash is the sticker price, left invested");
  near(r.wealthSystem, 30000 * 1.21 - 200 * 1.1 - 200, 1e-9, "the lessee keeps it invested and loses $420 on the lease");
  near(r.wealthDelta, r.npv * 1.21, 1e-9, "the gap is NPV compounded to the horizon");
  near(r.wealthDelta, r.wealthSystem - r.wealthInvest, 1e-12, "wealthDelta is the difference");
  assert.equal(r.irr, null, "no sign change, so IRR is undefined (null, never a fake number)");
  assert.equal(r.payback, null, "and a lease that never turns positive never pays back");
  assert.equal(r.financingSchedule.length, 2, "one schedule row per lease year");
  near(r.financingSchedule[0].payment, 1200, 1e-9, "each row carries the annual payment");

  const good = Finance.evaluate({ ...sim, savings: 2000, baselineBill: 2600, bill: 600 },
                                { ...FLAT, costPerW: 3, horizon: 2, financing: lease });
  assert.equal(good.cashflows.join(","), "0,800,800", "a lease that beats the bill is cash positive");
  near(good.cashFlowPayback, 0, 1e-12, "with no outlay it is cash positive from day one");
  // savings 2000/yr against 2400 of total lease payments: covered 1.2 years in.
  near(good.payback, 1.2, 1e-9, "and pays for its whole lease 1.2 years in");
  near(good.totalCost, 2400, 1e-9, "total cost is every lease payment");
  near(good.firstYearMonthlyOutlay, 100 + 600 / 12, 1e-9, "outlay = lease payment + remaining bill");
  near(good.currentMonthlyBill, 2600 / 12, 1e-9, "against today's bill");

  const esc = Finance.evaluate({ ...sim, savings: 2000 }, { ...FLAT, costPerW: 3, horizon: 3,
    financing: { mode: "lease", lease: { monthly: 100, escalatorPct: 0.029, termYears: 3, buyout: 0 } } });
  near(esc.paymentsByYear[1], 1200, 1e-9, "year 1 pays the quoted monthly x 12");
  near(esc.paymentsByYear[2], 1200 * 1.029, 1e-9, "year 2 escalates by 2.9%");
  near(esc.paymentsByYear[3], 1200 * 1.029 ** 2, 1e-9, "and compounds");

  const buy = Finance.evaluate({ ...sim, savings: 2000 }, { ...FLAT, costPerW: 3, horizon: 3,
    financing: { mode: "lease", lease: { monthly: 100, escalatorPct: 0, termYears: 2, buyout: 3000 } } });
  near(buy.paymentsByYear[2], 1200 + 3000, 1e-9, "the buyout lands in the final lease year");
  near(buy.paymentsByYear[3], 0, 1e-12, "and nothing is owed after it");
});

test("lease: the lessor carries O&M, inverter and battery replacement", () => {
  const sim = { savings: 2000, bill: 600, baselineBill: 2600, pvKwh: 12000, kwdc: 8, battKWhTotal: 10 };
  const f = { ...FLAT, costPerW: 3, costPerKwh: 1000, horizon: 15, omPerYear: 200,
              inverterYear: 12, inverterPerW: 0.15, battReplYear: 10, battReplFraction: 0.5 };
  const cash = Finance.evaluate(sim, f);
  const lease = Finance.evaluate(sim, { ...f, financing: { mode: "lease",
    lease: { monthly: 0, escalatorPct: 0, termYears: 15, buyout: 0 } } });
  assert.ok(cash.omByYear[1] > 0 && lease.omByYear[1] === 0, "no O&M line under a lease");
  assert.ok(cash.extrasByYear[10] > 0 && lease.extrasByYear[10] === 0, "no battery replacement either");
  assert.ok(cash.extrasByYear[12] > 0 && lease.extrasByYear[12] === 0, "and no inverter swap");
  near(lease.cashflows[1], 2000, 1e-9, "with a $0 lease payment the saving is the whole cash flow");
});

test("financing defaults and lifetime cost", () => {
  assert.equal(Finance.DEFAULTS.financing.mode, "cash", "cash is the default");
  near(Finance.DEFAULTS.financing.loan.apr, 0.0699, 1e-12, "default APR 6.99%");
  near(Finance.DEFAULTS.financing.loan.termYears, 15, 0, "default term 15 years");
  near(Finance.DEFAULTS.financing.lease.escalatorPct, 0.029, 1e-12, "default lease escalator 2.9%");
  const f = Finance.withDefaults({ financing: { mode: "loan", loan: { apr: 0.05 } } });
  near(f.financing.loan.apr, 0.05, 1e-12, "a partial financing block merges with the defaults");
  near(f.financing.loan.termYears, 15, 0, "...keeping the rest");
  assert.equal(Finance.withDefaults({ financing: { mode: "nonsense" } }).financing.mode, "cash",
               "an unknown mode falls back to cash");

  // Lifetime cost must count the money as well as the energy.
  const sim = { savings: 2000, bill: 600, baselineBill: 2600, pvKwh: 12000, kwdc: 8, battKWhTotal: 0 };
  const base = { ...FLAT, costPerW: 2, horizon: 10, escalation: 0, discountRate: 0 };
  const cash = Finance.evaluate(sim, base);
  const loan = Finance.evaluate(sim, { ...base, financing: { mode: "loan",
    loan: { sharePct: 1, apr: 0.06, termYears: 10, dealerFeePct: 0 } } });
  assert.ok(loan.lifetimeCost > cash.lifetimeCost,
            "borrowing costs more over the life than paying cash");
  near(cash.lifetimeCost, 16000 + 600 * 10, 1e-6, "cash: the system plus ten years of bills");
  near(loan.lifetimeCost, loan.paymentsByYear.reduce((a, b) => a + b, 0) + 600 * 10, 1e-6,
       "loan: every payment plus ten years of bills");
});

// ================================================================== P1 money-math fixes
// A battery-and-panels system with numbers in the range the app produces.
const SYS = { savings: 3500, importSavings: 2800, exportRevenue: 700, bill: 700,
              baselineBill: 4200, pvKwh: 14000, kwdc: 9.2, battKWhTotal: 10 };

test("lease ending before the horizon: returned without a buyout, owned after one", () => {
  const lease = (termYears, buyout) => ({ mode: "lease",
    lease: { monthly: 150, escalatorPct: 0.029, termYears, buyout } });
  const f = { horizon: 25, resaleValue: 4000 };

  // No buyout: the panels go back to the lessor and the savings stop with the payments.
  const back = Finance.evaluate(SYS, { ...f, financing: lease(15, 0) });
  assert.deepEqual(back.leaseEnd, { year: 15, outcome: "returned" }, "the lease ends in year 15, system returned");
  assert.ok(back.savingsByYear[15] > 0, "the household saves through the last lease year");
  for (let y = 16; y <= 25; y++) {
    assert.equal(back.savingsByYear[y], 0, `no savings in year ${y} from a system that has gone`);
    assert.equal(back.cashflows[y], 0, `and no cash flow at all in year ${y}`);
  }
  assert.equal(back.omByYear.concat(back.extrasByYear).every((v) => v === 0), true,
               "the lessor's O&M and replacements never reach the household");
  near(back.wealthDelta, back.npv * Math.pow(1.07, 25), 1e-6, "the wealth identity holds");
  const full = Finance.evaluate(SYS, { ...f, financing: lease(25, 0) });
  assert.ok(back.npv < full.npv,
            "a short lease no longer beats the full-term one by handing out ten free years of savings");

  // A buyout: paid in the last term year, then the household owns it like a cash buyer.
  const own = Finance.evaluate(SYS, { ...f, financing: lease(15, 8000) });
  assert.deepEqual(own.leaseEnd, { year: 15, outcome: "buyout" }, "owned after the year-15 buyout");
  near(own.paymentsByYear[15], 150 * 12 * 1.029 ** 14 + 8000, 1e-6, "the buyout lands in year 15");
  near(own.paymentsByYear[16], 0, 1e-12, "and nothing is owed after it");
  assert.ok(own.savingsByYear[16] > 0 && own.savingsByYear[25] > 0, "the savings carry on");
  assert.equal(own.omByYear[15], 0, "O&M is the lessor's in the lease years");
  near(own.omByYear[16], 150 * 1.025 ** 15, 1e-9, "and the owner's from year 16, inflation-escalated");
  assert.equal(own.extrasByYear[12], 0, "the year-12 inverter swap is still the lessor's");
  near(own.extrasByYear[20], 10 * 1000 * 0.5, 1e-9, "the year-20 battery replacement is the owner's");
  near(own.netSavingsByYear[25], own.savingsByYear[25] - own.omByYear[25] + 4000, 1e-9,
       "and so is the resale credit at the horizon");
  near(own.wealthDelta, own.npv * Math.pow(1.07, 25), 1e-6, "the wealth identity holds after a buyout");
  near(own.wealthDelta, own.wealthSystem - own.wealthInvest, 1e-9, "wealthDelta is still the difference");
  assert.equal(Finance.breakEven(SYS, { ...f, financing: lease(15, 8000) }, "costPerKwh"), null,
               "a lease has no sticker break-even, even when the owner later pays for a pack");

  const toEnd = Finance.evaluate(SYS, { ...f, financing: lease(25, 0) });
  assert.deepEqual(toEnd.leaseEnd, { year: 25, outcome: "runs to horizon" }, "a full-term lease runs to the horizon");
  assert.equal(Finance.evaluate(SYS, f).leaseEnd, null, "cash has no lease end");
});

test("ACC Plus revenue drops out after its nine-year lock", () => {
  const sim = { ...SYS, accPlusRevenue: 200 };                   // inside the $700 export revenue
  const f = { horizon: 25, escalation: 0.05, exportEscalation: 0, panelDeg: 0.005, battDeg: 0,
              battReplYear: 0, inverterYear: 0, omPerYear: 0 };
  near(Finance.DEFAULTS.accPlusYears, 9, 0, "the adder is locked for nine years by default");
  const r = Finance.evaluate(sim, f), plain = Finance.evaluate(SYS, f);
  for (let y = 1; y <= 9; y++) near(r.savingsByYear[y], plain.savingsByYear[y], 1e-9, `year ${y} keeps the adder`);
  for (const y of [10, 17, 25]) {
    const deg = plain.savingsByYear[y] / (2800 * 1.05 ** (y - 1) + 700);   // that year's blend
    near(r.savingsByYear[y], (2800 * 1.05 ** (y - 1) + 500) * deg, 1e-6,
         `year ${y}: the export half has lost the $200 adder, degraded like the rest`);
  }
  assert.ok(r.npv < plain.npv, "so NPV falls");
  near(Finance.evaluate({ ...SYS, accPlusRevenue: 0 }, f).npv, plain.npv, 1e-12, "zero adder: unchanged");
  near(Finance.evaluate(sim, { ...f, accPlusYears: 25 }).npv, plain.npv, 1e-9,
       "and a lock as long as the horizon changes nothing");
});

test("roof cost adder: in the price whenever there are panels, never in the degradation blend", () => {
  const f = { horizon: 25, roofCostAdder: 2500 };
  const r = Finance.evaluate(SYS, f), plain = Finance.evaluate(SYS, { horizon: 25 });
  near(r.gross - plain.gross, 0, 1e-9, "the adder is not part of the system's sticker price");
  near(r.roofCost, 2500, 1e-12, "and is reported on its own");
  near(r.netCost - plain.netCost, 2500, 1e-9, "it lands in the net cost in full");
  near(Finance.evaluate(SYS, { ...f, incentiveMode: "vendor" }).netCost
       - Finance.evaluate(SYS, { horizon: 25, incentiveMode: "vendor" }).netCost, 2500, 1e-9,
       "no vendor pass-through or tax credit reaches roof work");
  near(Finance.evaluate(SYS, { ...f, taxCreditPct: 0.3 }).netCost
       - Finance.evaluate(SYS, { horizon: 25, taxCreditPct: 0.3 }).netCost, 2500, 1e-9,
       "nor does the ITC");
  const leaseF = { ...f, financing: { mode: "lease", lease: { monthly: 150, escalatorPct: 0.02, termYears: 25, buyout: 0 } } };
  near(Finance.evaluate(SYS, leaseF).upfront, 2500, 1e-9, "under a lease the household still pays for the roof up front");
  assert.deepEqual(r.savingsByYear, plain.savingsByYear, "the panel/pack degradation blend does not move");
  near(Finance.evaluate({ ...SYS, kwdc: 0 }, f).gross, 10 * 1000, 1e-9, "a pack alone pays no roof adder");
  near(Finance.withDefaults({ roofCostAdder: -500 }).roofCostAdder, 0, 0, "a negative adder clamps to zero");
  near(Finance.DEFAULTS.roofCostAdder, 0, 0, "and it defaults to zero");
});

test("replacements recur on long horizons, but not in the last few years", () => {
  assert.equal(Finance.REPLACE_MIN_REMAINING, 3, "a replacement needs three years of horizon after it");
  assert.deepEqual(Finance.replacementYears(12, 25), [12], "inverter at 12, not 24, on 25 years");
  assert.deepEqual(Finance.replacementYears(20, 25), [20], "battery at 20 on 25 years");
  assert.deepEqual(Finance.replacementYears(12, 40), [12, 24, 36], "every 12 years on a 40-year horizon");
  assert.deepEqual(Finance.replacementYears(12, 27), [12, 24], "year 24 of 27 still counts");
  assert.deepEqual(Finance.replacementYears(0, 25), [], "an interval of zero means never");

  // The demo default is pinned: exactly the one inverter and one battery it always had.
  const d = Finance.evaluate(SYS, {});
  for (let y = 1; y <= 25; y++) {
    const want = y === 12 ? 9200 * 0.15 : y === 20 ? 10 * 1000 * 0.5 : 0;
    near(d.extrasByYear[y], want, 1e-9, `25-year default: replacement spend in year ${y}`);
  }
  assert.deepEqual(d.replacementYears, { battery: [20], inverter: [12] }, "and reports them");

  // Forty years: the pack is replaced at 15 and 30 and its fade clock restarts each time.
  const pack = { ...SYS, kwdc: 0, savings: 1000, importSavings: 1000, exportRevenue: 0 };
  const g = { horizon: 40, escalation: 0, battDeg: 0.02, battReplYear: 15, omPerYear: 0 };
  const b = Finance.evaluate(pack, g);
  near(b.extrasByYear[15], 5000, 1e-9, "first pack replacement");
  near(b.extrasByYear[30], 5000, 1e-9, "second pack replacement");
  near(b.savingsByYear[16], 1000, 1e-9, "fresh pack in year 16");
  near(b.savingsByYear[31], 1000, 1e-9, "and again in year 31");
  near(b.savingsByYear[30], 1000 * 0.98 ** 14, 1e-9, "year 30 is the old pack's 15th year");
  // Too close to the end to book: no cost and no reset.
  const late = Finance.evaluate(pack, { ...g, horizon: 22, battReplYear: 20 });
  near(late.extrasByYear[20], 0, 0, "no pack bought in year 20 of 22");
  near(late.savingsByYear[21], 1000 * 0.98 ** 20, 1e-9, "so the old pack keeps fading");
});

test("levered IRR: null with a reason, never a fake number", () => {
  const loan = (sharePct, termYears) => ({ mode: "loan",
    loan: { sharePct, apr: 0.0699, termYears, dealerFeePct: 0 } });
  const cash = Finance.evaluate(SYS, {});
  assert.ok(cash.irr > 0 && cash.irrReason === null, "cash: a real IRR and no reason needed");

  // 100% financed with the payment below the saving: no money of the household's goes in first.
  const free = Finance.evaluate(SYS, { financing: loan(1, 25) });
  assert.equal(free.irr, null, "100% financed over 25 years has no levered IRR");
  assert.equal(free.irrReason, "no money down", "because nothing was put down");
  assert.ok(free.projectIrr > 0, "the project IRR is still there");

  // A 30-year note on a 25-year horizon is settled at the horizon: -, +, +, ..., - .
  const long = Finance.evaluate(SYS, { financing: loan(0.8, 30) });
  assert.ok(long.cashflows[0] < 0 && long.cashflows[1] > 0 && long.cashflows[25] < 0,
            "down payment, positive years, then the balloon payoff");
  assert.equal(long.irr, null, "no single rate fits that stream");
  assert.equal(long.irrReason, "no unique rate", "and the reason says so");
  near(long.projectIrr, cash.projectIrr, 1e-12, "the project IRR does not care how it was paid for");

  const under = Finance.evaluate(SYS, { financing: { mode: "lease",
    lease: { monthly: 400, escalatorPct: 0.029, termYears: 25, buyout: 0 } } });
  assert.equal(under.irr, null, "an underwater lease has no IRR");
  assert.equal(under.irrReason, "never repays", "because it never comes back above water");

  const short = Finance.evaluate(SYS, { financing: loan(0.8, 15) });
  assert.ok(short.irr > 0 && short.irrReason === null, "an ordinary loan with money down keeps its IRR");
});

test("finance defaults match the app's State.DEFAULTS.fin", () => {
  assert.equal(Finance.DEFAULTS.incentiveMode, "none", "incentive mode");
  near(Finance.DEFAULTS.escalation, 0.05, 1e-12, "retail escalation");
  const app = STATE_DEFAULTS.fin;
  for (const k of Object.keys(Finance.DEFAULTS)) {
    if (!(k in app)) continue;
    assert.deepEqual(Finance.DEFAULTS[k], app[k], `finance DEFAULTS.${k} matches app/state.js`);
  }
});

test("a lease bought out in the final year still earns the resale credit", () => {
  const sim = { savings: 2500, importSavings: 2000, exportRevenue: 500, bill: 1500, baselineBill: 4000,
                pvKwh: 9000, kwdc: 6, battKWhTotal: 0 };
  const lease = (termYears, buyout) => Finance.evaluate(sim, {
    horizon: 25, resaleValue: 10000,
    financing: { mode: "lease", lease: { monthly: 150, escalatorPct: 0.02, termYears, buyout } },
  });
  const at25 = lease(25, 1), at24 = lease(24, 1), none = lease(25, 0);
  assert.equal(at25.leaseEnd.outcome, "buyout");
  // Buying for $1 in year 25 is worth the resale credit, not a pure cost: the NPV sits
  // just under the 24-year buyout (one fewer year of ownership) and well above no buyout.
  const resalePv = 10000 / Math.pow(1.07, 24.5) - 1 / Math.pow(1.07, 24.5);   // mid-year flows
  near(at25.npv - none.npv, resalePv, 1, `buyout at the horizon earns the discounted resale credit (${at25.npv} vs ${none.npv})`);
  assert.ok(Math.abs(at25.npv - at24.npv) < 1500, `continuous across the term boundary (${at25.npv} vs ${at24.npv})`);
  // The wealth identity still holds in that corner.
  const H = 25, r = 0.07;
  assert.ok(Math.abs(at25.wealthDelta - at25.npv * Math.pow(1 + r, H)) < 1e-6 * Math.abs(at25.wealthDelta) + 1e-6);
});

test("a stray accPlusRevenue is clamped to the export revenue", () => {
  const base = { savings: 2500, importSavings: 1700, exportRevenue: 800, bill: 1500, baselineBill: 4000,
                 pvKwh: 9000, kwdc: 6, battKWhTotal: 0 };
  const ok = Finance.evaluate(Object.assign({}, base, { accPlusRevenue: 800 }), { horizon: 25 });
  const big = Finance.evaluate(Object.assign({}, base, { accPlusRevenue: 5000 }), { horizon: 25 });
  const neg = Finance.evaluate(Object.assign({}, base, { accPlusRevenue: -500 }), { horizon: 25 });
  const none = Finance.evaluate(base, { horizon: 25 });
  assert.equal(big.npv, ok.npv, "more than the export revenue is treated as all of it");
  assert.equal(neg.npv, none.npv, "a negative value is treated as none");
  assert.ok(ok.savingsByYear[10] >= 0, "savings never go negative when the adder expires");
});
