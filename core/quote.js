/* =============================================================================
 * quote.js — check an installer's quote against the model.
 *
 * The optimiser answers "what should I buy?"; this answers "what am I being
 * offered?".  The household types the size, the battery count and the contract
 * price from a proposal; the quote is placed on the nearest cell of the grid
 * the optimiser already simulated and re-priced at the quoted price, so the
 * comparison uses the same load, tariff and weather as everything else on the
 * page.  Three numbers come out: the quote as written, the same hardware at a
 * market price, and the optimiser's own pick.
 *
 * Pure: no DOM, no state.  Money maths is core/finance.evaluate on the grid's
 * cached cells, so nothing here re-simulates anything.
 * ========================================================================== */

import Finance from "./finance.js";

/**
 * What a California homeowner is quoted per DC watt, all-in, in 2026.  A dated
 * constant on purpose: prices move, and the page says when this was written.
 */
export const MARKET_PER_W = {
  lo: 2.40, hi: 3.25, asOf: "2026-08",
  source: "EnergySage California marketplace averages",
};

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => finite(v) && v > 0;

/**
 * The price per watt of the solar alone.  With batteries in the quote the
 * storage is taken out at the model's own storage prices first, so a $/W figure
 * is comparable to the market band, which is a solar-only number.
 * null when the inputs are missing or the storage would swallow the price.
 */
export function impliedPerW({ price, kwDc, batteries = 0, battKWh = 0, costPerKwh = 0, costPerBattery = 0 }) {
  if (!pos(price) || !pos(kwDc)) return null;
  const storage = batteries > 0 ? batteries * battKWh * costPerKwh + batteries * costPerBattery : 0;
  const solar = price - storage;
  return solar > 0 ? solar / (kwDc * 1000) : null;
}

/**
 * The grid cell closest to a quote.  Batteries are a whole-number axis, so the
 * nearest battery count is chosen first, then the nearest panel count among
 * the cells with that many batteries (the panel axis can step by two).
 * `outside` says which axis the quote runs off the end of, if either.
 */
export function nearestCell(priced, panels, batteries) {
  const cells = priced && priced.cells;
  if (!cells || !cells.length) return null;
  const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  const bs = Array.from(new Set(cells.map((c) => c.batteries))).sort((a, b) => a - b);
  const b = nearest(bs, batteries);
  const row = cells.filter((c) => c.batteries === b);
  const ps = Array.from(new Set(row.map((c) => c.panels))).sort((a, b2) => a - b2);
  const p = nearest(ps, panels);
  const cell = row.find((c) => c.panels === p);
  const maxP = Math.max(...cells.map((c) => c.panels));
  const maxB = Math.max(...cells.map((c) => c.batteries));
  const outside = panels > maxP ? { axis: "panels", needed: panels, have: maxP }
    : batteries > maxB ? { axis: "batteries", needed: batteries, have: maxB } : null;
  return { cell, outside };
}

/**
 * The fee hidden in a financed quote.  A level payment implies a principal; any
 * principal above the share of the price being financed is a fee the lender
 * charged the installer and the installer folded into the loan.  Assumes the
 * monthly figure is the loan payment alone, with no down payment beyond
 * (1 - sharePct) of the price, and that the price is the cash price.
 * null when an input is missing.
 */
export function impliedDealerFee({ price, monthly, apr, termYears, sharePct = 1 }) {
  if (!pos(price) || !pos(monthly) || !pos(termYears) || !finite(apr) || apr < 0 || !pos(sharePct)) return null;
  const n = Math.round(termYears * 12);
  const i = apr / 12;
  const principal = i < 1e-12 ? monthly * n : monthly * (1 - Math.pow(1 + i, -n)) / i;
  const financed = price * Math.min(1, sharePct);
  const fee = principal - financed;
  return { principal, financed, fee, feeOfFinanced: fee / financed, feeOfPrice: fee / price };
}

/**
 * Installer's first-year kWh against the model's for the same size.  Ratio is
 * installer over model.  Within 5% either way is agreement; an installer who
 * is above the model is the costly direction, below it is merely cautious.
 */
export function productionCheck(installerKwh, modelKwh) {
  if (!pos(installerKwh) || !pos(modelKwh)) {
    return { installer: pos(installerKwh) ? installerKwh : null, model: pos(modelKwh) ? modelKwh : null, ratio: null, verdict: null };
  }
  const ratio = installerKwh / modelKwh;
  // Round to a tenth of a percent so 1.05 (a clean "5% over") lands on the line, not past it.
  const r = Math.round(ratio * 1000) / 1000;
  const verdict = r < 0.95 ? "conservative" : r <= 1.05 ? "in line" : r <= 1.15 ? "optimistic" : "very optimistic";
  return { installer: installerKwh, model: modelKwh, ratio, verdict };
}

/** Where a $/W figure sits against the market band. */
export function priceVerdict(perW, band = MARKET_PER_W) {
  if (!pos(perW)) return null;
  return perW < band.lo ? "below" : perW > band.hi ? "above" : "within";
}

/** The headline numbers of one evaluated cell. */
function summary(res, cell, price) {
  return {
    panels: cell.panels, batteries: cell.batteries, kwDc: cell.kwdc, battKWhTotal: cell.battKWhTotal,
    price, netCost: res.netCost, npv: res.npv, irr: res.irr, payback: res.payback,
    firstYearSavings: res.firstYearSavings, monthlyPayment: res.monthlyPayment, finance: res,
  };
}

/** A cell as the finance model wants it. */
function simOf(cell, baselineBill, scale = 1) {
  return {
    savings: cell.savings * scale, importSavings: cell.importSavings * scale,
    exportRevenue: cell.exportRevenue * scale, accPlusRevenue: (cell.accPlusRevenue || 0) * scale,
    bill: cell.bill, baselineBill, pvKwh: cell.pvKwh * scale,
    kwdc: cell.kwdc, battKWhTotal: cell.battKWhTotal, batteries: cell.batteries,
  };
}

/**
 * @param quote  { kwDc, batteries, battKWh, price, annualKwh, monthly }, any may be null
 * @param priced the priced grid (core/optimizer.priceGrid, or main.js's priceGridWithRoof)
 * @param fin    effective finance inputs (main.js finEff(0)): the household's own price knobs
 * @param system state.system (reads panelW, battKWh)
 * @param roofAdderFor (cell) => dollars of roof work that cell's panels put on the bill
 *
 * status: "incomplete" (no size or no price), "outside-grid" (the quote is
 * bigger than anything simulated; `outside` names the axis) or "ok".
 */
export function compareQuote({ quote, priced, fin, system, panelW, roofAdderFor }) {
  const q = quote || {};
  const band = { lo: MARKET_PER_W.lo, hi: MARKET_PER_W.hi, source: MARKET_PER_W.source, asOf: MARKET_PER_W.asOf };
  const empty = (status, extra) => Object.assign({
    status, quoteCell: null, quotePriced: null, marketPriced: null, optimum: null,
    perW: null, band, dealerFee: null, productionCheck: null, outside: null,
  }, extra);

  const watts = pos(panelW) ? panelW : (system && system.panelW) || 460;
  if (!pos(q.kwDc) || !pos(q.price) || !priced || !priced.cells || !priced.cells.length) return empty("incomplete");

  const panels = Math.round(q.kwDc * 1000 / watts);
  const batteries = Math.max(0, Math.round(q.batteries || 0));
  const near = nearestCell(priced, panels, batteries);
  if (!near || !near.cell) return empty("incomplete");
  const cell = near.cell;
  // A quote too small to reach the first grid step lands on "do nothing", whose
  // gross is 0, so no price could be reproduced: treat it as not yet entered.
  if (cell.panels === 0 && cell.batteries === 0) return empty("incomplete");
  const optimumCell = priced.best || priced.doNothing || cell;
  const baselineBill = priced.baseline ? priced.baseline.bill : 0;
  if (near.outside) return empty("outside-grid", { outside: near.outside, optimum: optimumCell });

  const f = Finance.withDefaults(fin);
  const loan = f.financing.loan;
  const battKWh = pos(q.battKWh) ? q.battKWh : (system && system.battKWh) || 0;
  const perW = impliedPerW({
    price: q.price, kwDc: q.kwDc, batteries, battKWh,
    costPerKwh: f.costPerKwh, costPerBattery: f.costPerBattery,
  });

  // ------------------------------------------------------------- dealer fee
  let dealerFee = null;
  if (f.financing.mode === "loan") {
    const imp = impliedDealerFee({
      price: q.price, monthly: q.monthly, apr: loan.apr, termYears: loan.termYears, sharePct: loan.sharePct,
    });
    if (imp) {
      const dollars = Math.max(0, imp.fee);
      dealerFee = { source: "implied", dollars, pctOfPrice: dollars / q.price, pctOfFinanced: imp.feeOfFinanced,
                    principal: imp.principal, raw: imp.fee };
    } else {
      const dollars = q.price * loan.sharePct * loan.dealerFeePct;
      dealerFee = { source: "setting", dollars, pctOfPrice: dollars / q.price, pctOfFinanced: loan.dealerFeePct,
                    principal: null, raw: dollars };
    }
  }
  const feeDollars = dealerFee ? dealerFee.dollars : 0;
  const feePct = dealerFee ? dealerFee.pctOfFinanced : 0;

  // ----------------------------------------------------- the three pricings
  // Quote as priced: the contract price is the whole gross.  The model's own $/W and
  // $/kWh are kept (they set the solar/storage weights in the degradation blend and the
  // battery swap price) and the fixed adder is solved so that gross == price exactly.
  const hw = Math.max(0, cell.kwdc - f.existingKwDc) * 1000 * f.costPerW
    + cell.battKWhTotal * f.costPerKwh + cell.batteries * f.costPerBattery;
  const quoteFin = Object.assign({}, fin, {
    adder: q.price - hw, roofCostAdder: 0, incentiveMode: "none", discountPct: 0,
    financing: Object.assign({}, f.financing, {
      loan: Object.assign({}, loan, { dealerFeePct: dealerFee ? Math.max(0, feePct) : loan.dealerFeePct }),
      lease: Object.assign({}, f.financing.lease, pos(q.monthly) && f.financing.mode === "lease" ? { monthly: q.monthly } : {}),
    }),
  });
  let quoteRes = Finance.evaluate(simOf(cell, baselineBill), quoteFin);
  if (dealerFee && dealerFee.source === "implied" && quoteRes.netCost > 0 && loan.sharePct > 0) {
    // The lender finances the price net of any credit or rebate, so the fee implied
    // by the quoted payment is measured against that net figure, not the sticker.
    const financed = quoteRes.netCost * loan.sharePct;
    const pct = Math.max(0, dealerFee.principal / financed - 1);
    dealerFee.pctOfFinanced = pct;
    dealerFee.dollars = Math.max(0, dealerFee.principal - financed);
    dealerFee.pctOfPrice = dealerFee.dollars / q.price;
    quoteFin.financing.loan.dealerFeePct = pct;
    quoteRes = Finance.evaluate(simOf(cell, baselineBill), quoteFin);
  }
  // An array already on the roof carries no roof-work adder: main.js drops it from
  // the Dashboard's pricing in that mode, so the Quote tab must too.
  const roofFor = (c) => (roofAdderFor && !(f.existingKwDc > 0) ? roofAdderFor(c) : 0);
  const marketFin = Object.assign({}, fin, { roofCostAdder: roofFor(cell) });
  const marketRes = Finance.evaluate(simOf(cell, baselineBill), marketFin);
  const optFin = Object.assign({}, fin, { roofCostAdder: roofFor(optimumCell) });
  const optRes = Finance.evaluate(simOf(optimumCell, baselineBill), optFin);

  // ------------------------------------------------------------- production
  // The nearest cell may be a panel or two off the quote; scale the model's kWh to the
  // quoted size so the comparison is per quoted kW.
  const modelKwh = cell.kwdc > 0 ? cell.pvKwh * q.kwDc / cell.kwdc : cell.pvKwh;
  const pc = productionCheck(q.annualKwh, modelKwh);
  if (pc.ratio !== null) {
    // What the optimism is worth: the same quote with savings as the installer's kWh
    // would deliver them.  Scaling every saving by the ratio is a rough stand-in (the
    // battery's share does not scale with sun) but it is the right order of magnitude.
    const claimed = Finance.evaluate(simOf(cell, baselineBill, pc.ratio), quoteFin);
    pc.paybackModel = quoteRes.payback;
    pc.paybackInstaller = claimed.payback;
    pc.npvModel = quoteRes.npv;
    pc.npvInstaller = claimed.npv;
  }

  return {
    status: "ok",
    quoteCell: cell,
    quotePriced: summary(quoteRes, cell, q.price),
    marketPriced: summary(marketRes, cell, marketRes.gross + marketRes.roofCost),
    optimum: summary(optRes, optimumCell, optRes.gross + optRes.roofCost),
    perW, band, dealerFee,
    cashEquivalent: q.price + feeDollars,
    productionCheck: pc, outside: null, panelsQuoted: panels,
    sizeDiffers: cell.panels !== panels,
  };
}

export default { MARKET_PER_W, impliedPerW, nearestCell, impliedDealerFee, productionCheck, priceVerdict, compareQuote };
