/* =============================================================================
 * tests/quote.test.mjs - node --test tests/
 *
 * The quote checker: where a quote lands on the grid, what price per watt it
 * implies, the dealer fee a monthly payment hides, and the three statuses of
 * compareQuote.  The grid is a real, small sweep of the Agoura fixture.
 * ========================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";

import Engine from "../core/engine.js";
import Optimizer from "../core/optimizer.js";
import Finance from "../core/finance.js";
import Quote, { MARKET_PER_W, impliedPerW, nearestCell, impliedDealerFee, productionCheck, compareQuote } from "../core/quote.js";
import { loadSet, refParams, TARIFF } from "./fixtures/agoura.mjs";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} +-${tol}, got ${a}`);

const ctx = Engine.prepare({ load: loadSet(), tariffs: TARIFF });
const GRID = Optimizer.searchGrid(ctx, refParams(0, 0), { maxPanelsTotal: 20, maxBatteries: 2, step: 2 });
const FIN = {};
const PRICED = Optimizer.priceGrid(GRID, FIN, "npv", "sameFlex");
const SYSTEM = { panelW: 460, battKWh: 10 };

test("the market band is dated and sourced", () => {
  assert.equal(MARKET_PER_W.lo, 2.40);
  assert.equal(MARKET_PER_W.hi, 3.25);
  assert.equal(MARKET_PER_W.asOf, "2026-08");
  assert.match(MARKET_PER_W.source, /EnergySage/);
  assert.equal(Quote.MARKET_PER_W, MARKET_PER_W);
});

test("nearestCell picks the right cell, and says when the quote is off the grid", () => {
  const exact = nearestCell(PRICED, 10, 1);
  assert.equal(exact.cell.panels, 10);
  assert.equal(exact.cell.batteries, 1);
  assert.equal(exact.outside, null);

  // The panel axis steps by two: 11 is equally near 10 and 12, either is acceptable, 13 is nearer 12 or 14.
  const odd = nearestCell(PRICED, 13, 2);
  assert.ok([12, 14].includes(odd.cell.panels), `13 panels lands on ${odd.cell.panels}`);
  assert.equal(odd.cell.batteries, 2);

  const bigP = nearestCell(PRICED, 30, 1);
  assert.equal(bigP.cell.panels, 20, "off the top of the panel axis it takes the last cell");
  assert.deepEqual(bigP.outside, { axis: "panels", needed: 30, have: 20 });
  const bigB = nearestCell(PRICED, 10, 5);
  assert.equal(bigB.cell.batteries, 2);
  assert.equal(bigB.outside.axis, "batteries");
  assert.equal(nearestCell({ cells: [] }, 4, 0), null);
});

test("impliedPerW, with and without a battery", () => {
  near(impliedPerW({ price: 22000, kwDc: 8 }), 2.75, 1e-9, "solar only: price over watts");
  // $22,000 with one 10 kWh battery at $1,000/kWh and $500 fixed: $11,500 left for 8 kW.
  near(impliedPerW({ price: 22000, kwDc: 8, batteries: 1, battKWh: 10, costPerKwh: 1000, costPerBattery: 500 }),
       11500 / 8000, 1e-9, "storage is taken out first");
  assert.equal(impliedPerW({ price: 5000, kwDc: 8, batteries: 1, battKWh: 10, costPerKwh: 1000 }), null,
               "storage bigger than the price: no honest $/W");
  assert.equal(impliedPerW({ price: null, kwDc: 8 }), null);
  assert.equal(impliedPerW({ price: 20000, kwDc: 0 }), null);
});

test("impliedDealerFee recovers a known fee from a synthetic payment", () => {
  const price = 30000, apr = 0.0499, years = 20, fee = 0.18;
  const principal = price * (1 + fee);
  const monthly = Finance.loanPayment(principal, apr, years * 12);
  const got = impliedDealerFee({ price, monthly, apr, termYears: years, sharePct: 1 });
  near(got.principal, principal, 1e-6, "the principal the payment implies");
  near(got.fee, price * fee, 1e-4, "the fee in dollars");
  near(got.feeOfFinanced, fee, 1e-9, "the fee as a share of what is financed");
  near(got.feeOfPrice, fee, 1e-9, "all financed, so the same share of the price");

  // Half financed: the fee is charged on the financed half only.
  const half = Finance.loanPayment(price * 0.5 * (1 + fee), apr, years * 12);
  const g2 = impliedDealerFee({ price, monthly: half, apr, termYears: years, sharePct: 0.5 });
  near(g2.fee, price * 0.5 * fee, 1e-4, "half-financed fee");
  near(g2.feeOfPrice, fee / 2, 1e-9, "as a share of the whole price");

  // Zero APR is a straight division.
  near(impliedDealerFee({ price: 12000, monthly: 100, apr: 0, termYears: 10 }).principal, 12000, 1e-9, "0% loan");
  assert.equal(impliedDealerFee({ price, monthly: null, apr, termYears: years }), null);
  assert.equal(impliedDealerFee({ price: 0, monthly: 100, apr, termYears: years }), null);
  assert.equal(impliedDealerFee({ price, monthly: 100, apr: undefined, termYears: years }), null);
});

test("productionCheck verdicts at the boundaries", () => {
  const v = (r) => productionCheck(r * 10000, 10000).verdict;
  assert.equal(v(1.00), "in line");
  assert.equal(v(1.05), "in line", "exactly 5% over is still in line");
  assert.equal(v(1.051), "optimistic");
  assert.equal(v(1.15), "optimistic", "exactly 15% over is optimistic, not very");
  assert.equal(v(1.151), "very optimistic");
  assert.equal(v(0.95), "in line", "exactly 5% under is in line");
  assert.equal(v(0.949), "conservative");
  near(productionCheck(11000, 10000).ratio, 1.1, 1e-12, "ratio is installer over model");
  assert.equal(productionCheck(null, 10000).verdict, null);
  assert.equal(productionCheck(11000, 0).ratio, null);
});

test("compareQuote: incomplete, outside-grid and ok", () => {
  const base = { priced: PRICED, fin: FIN, system: SYSTEM, panelW: 460 };
  const inc = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 0, price: null } });
  assert.equal(inc.status, "incomplete");
  assert.equal(compareQuote({ ...base, quote: {} }).status, "incomplete");
  assert.equal(compareQuote({ ...base, quote: { kwDc: 4.6, price: 15000 }, priced: null }).status, "incomplete");

  const out = compareQuote({ ...base, quote: { kwDc: 20, batteries: 1, price: 60000 } });
  assert.equal(out.status, "outside-grid");
  assert.equal(out.outside.axis, "panels");
  const outB = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 4, price: 40000 } });
  assert.equal(outB.status, "outside-grid");
  assert.equal(outB.outside.axis, "batteries");

  // 10 panels x 460 W = 4.6 kW, one battery.
  const ok = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 1, price: 18000, annualKwh: 9000 } });
  assert.equal(ok.status, "ok");
  assert.equal(ok.quoteCell.panels, 10);
  assert.equal(ok.quoteCell.batteries, 1);
  assert.equal(ok.band.lo, 2.40);
  assert.equal(ok.band.hi, 3.25);
  near(ok.quotePriced.finance.gross, 18000, 1e-6, "the quote's price is the whole gross");
  assert.ok(ok.perW > 0);
  assert.equal(ok.dealerFee, null, "cash: no dealer fee");
  assert.ok(ok.productionCheck.ratio > 0 && ok.productionCheck.verdict);

  // At the model's own price, the quote and the market pricing are the same thing.
  const hw = Finance.evaluate({ savings: 0, kwdc: ok.quoteCell.kwdc, battKWhTotal: ok.quoteCell.battKWhTotal, batteries: 1 }, FIN).gross;
  const same = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 1, price: hw } });
  near(same.quotePriced.npv, same.marketPriced.npv, 1e-6, "quote at the model's price == market pricing");
  const dear = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 1, price: hw + 10000 } });
  near(same.quotePriced.npv - dear.quotePriced.npv, 10000, 10000 * 0.5, "ten thousand dollars more costs about that much NPV");
  assert.ok(dear.quotePriced.npv < same.quotePriced.npv);
});

test("compareQuote on a loan: the implied dealer fee, and a setting-based one without a payment", () => {
  const loanFin = { financing: { mode: "loan", loan: { sharePct: 1, apr: 0.0599, termYears: 20, dealerFeePct: 0.1 } } };
  const base = { priced: PRICED, fin: loanFin, system: SYSTEM, panelW: 460 };
  const noPay = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 0, price: 15000 } });
  assert.equal(noPay.dealerFee.source, "setting");
  near(noPay.dealerFee.dollars, 1500, 1e-9, "10% of $15,000");

  const monthly = Finance.loanPayment(15000 * 1.2, 0.0599, 240);
  const withPay = compareQuote({ ...base, quote: { kwDc: 4.6, batteries: 0, price: 15000, monthly } });
  assert.equal(withPay.dealerFee.source, "implied");
  near(withPay.dealerFee.dollars, 3000, 1e-3, "the 20% hidden in the payment");
  near(withPay.cashEquivalent, 18000, 1e-3, "price with the fee counted");
  assert.ok(withPay.quotePriced.npv < noPay.quotePriced.npv, "a bigger fee, a worse quote");
});
