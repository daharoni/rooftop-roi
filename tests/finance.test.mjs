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

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);

/** 1 kW at $1/W saving $1,000/yr, no O&M, no degradation - everything hand-checkable. */
const SIM = { savings: 1000, bill: 0, baselineBill: 1000, pvKwh: 1000, kwdc: 1, battKWhTotal: 0 };
const FLAT = { costPerW: 1, adder: 0, taxCreditPct: 0, incentiveMode: "none", sgipPerKwh: 0,
               rebates: 0, horizon: 2, escalation: 0, investReturn: 0.10, discountRate: 0,
               panelDeg: 0, battDeg: 0, omPerYear: 0, battReplYear: 99, inverterYear: 99,
               resaleValue: 0 };

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

test("incentive modes", () => {
  const sim = { ...SIM, kwdc: 10 };
  const base = { costPerW: 3, adder: 0, taxCreditPct: 0, sgipPerKwh: 0, rebates: 0 };
  near(Finance.evaluate(sim, { ...base, incentiveMode: "none" }).netCost, 30000, 1e-6,
       "no incentive: 10 kW at $3.00/W = $30,000");
  near(Finance.evaluate(sim, { ...base, incentiveMode: "discount", discountPct: 0.25 }).netCost,
       22500, 1e-6, "direct discount: 25% off = $22,500");
  const vend = Finance.evaluate(sim, { ...base, incentiveMode: "vendor" });
  near(vend.effectiveDiscount, 0.34, 1e-12, "vendor pass-through defaults to 34 points off");
  near(vend.netCost, 30000 * 0.66, 1e-6, "...so a $30,000 system nets $19,800");
  near(vend.effectiveCostPerW, 1.98, 1e-12, "$3.00/W sticker shows $1.98/W net");
  const vendKwh = Finance.evaluate({ ...sim, battKWhTotal: 10 },
                                   { ...base, costPerKwh: 1000, incentiveMode: "vendor" });
  near(vendKwh.effectiveCostPerKwh, 660, 1e-9, "$1,000/kWh sticker shows $660/kWh net");
  assert.equal(Finance.DEFAULTS.incentiveMode, "vendor", "vendor pass-through is the default mode");
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
  near(r.wealthInvest, 0, 1e-12, "no cash was withheld from the market, so nothing to compare");

  const half = Finance.evaluate(sim, { ...f, financing: { mode: "loan",
    loan: { sharePct: 0.7, apr: 0.06, termYears: 10, dealerFeePct: 0 } } });
  near(half.downPayment, 6000, 1e-9, "a 70% loan leaves a 30% down payment");
  near(half.cashflows[0], -6000, 1e-9, "which is the year-0 outlay");
  near(half.loanPrincipal, 14000, 1e-9, "and borrows the other $14,000");
  near(half.wealthInvest, 6000 * Math.pow(1.10, 25), 1e-6, "only the down payment could have been invested");

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
  near(r.wealthInvest, 0, 1e-12, "there is no withheld cash to invest instead");
  near(r.wealthSystem, -200 * 1.1 - 200, 1e-9, "wealth at the horizon = -$420");
  near(r.wealthDelta, r.wealthSystem - r.wealthInvest, 1e-12, "wealthDelta is the difference");
  assert.equal(r.irr, null, "no sign change, so IRR is undefined (null, never a fake number)");
  assert.equal(r.payback, null, "and a lease that never turns positive never pays back");
  assert.equal(r.financingSchedule.length, 2, "one schedule row per lease year");
  near(r.financingSchedule[0].payment, 1200, 1e-9, "each row carries the annual payment");

  const good = Finance.evaluate({ ...sim, savings: 2000, baselineBill: 2600, bill: 600 },
                                { ...FLAT, costPerW: 3, horizon: 2, financing: lease });
  assert.equal(good.cashflows.join(","), "0,800,800", "a lease that beats the bill is cash positive");
  near(good.payback, 0, 1e-12, "with no outlay it is ahead from day one");
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
