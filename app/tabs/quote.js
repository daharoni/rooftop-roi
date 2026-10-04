/* =============================================================================
 * tabs/quote.js — an installer's quote, held up against the model.
 *
 * Type the size, the battery count and the contract price from a proposal and
 * the page answers three things: what the quote is worth on this household's
 * own load and tariff, whether the price is in the market, and whether the
 * installer's production number is believable.  The last card turns what was
 * found into questions to put to the installer.  The questions are static text
 * chosen by condition: a checklist, not a guess.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card, tiles, tile } from "../ui/blocks.js";
import { fmtCompact, fmtMoney, fmtNum, fmtPct, fmtYears, plural } from "../ui/format.js";
import * as K from "../ui/knobs.js";
import { compareQuote, priceVerdict, MARKET_PER_W } from "../../core/quote.js";

export const id = "quote";
export const label = "Quote";

// "ui": these only change what this tab shows, so they never queue a simulation.
const ui = { reason: "ui", nullable: true };   // a cleared field means "not entered"
const loanOrLease = (s) => s.fin.financing.mode === "loan" || s.fin.financing.mode === "lease";

export function rail() {
  return [
    { group: "Your quote", open: true, items: [
      { path: "quote.kwDc", kind: "number", label: "System size, kW DC", min: 0.5, max: 50, step: 0.1, ...ui },
      { path: "quote.batteries", kind: "number", label: "Batteries", min: 0, max: 10, step: 1, ...ui },
      { path: "quote.battKWh", kind: "number", label: "Battery size, usable kWh each", min: 1, max: 100, step: 0.5,
        placeholder: "as in Hardware", ...ui,
        note: "Leave blank to use the battery size from the Hardware settings." },
      { path: "quote.price", kind: "number", label: "Total price, $", min: 0, max: 300000, step: 100, ...ui,
        note: "The contract price after any vendor discount, before financing." },
      { path: "quote.annualKwh", kind: "number", label: "Installer's production estimate, kWh/yr", min: 0, max: 100000, step: 10, ...ui },
      { path: "quote.monthly", kind: "number", label: "Quoted monthly payment, $", min: 0, max: 3000, step: 1, ...ui,
        show: loanOrLease },
    ] },
    K.financing(true),
    K.incentives(false),
  ];
}

export function mount(pane) {
  clear(pane);
  pane.appendChild(el("div", { id: "quote-empty" }));
  pane.appendChild(card({
    id: "quote-compare", title: "Your quote against this model",
    sub: "The same house, the same rates and the same weather, priced three ways.",
    body: [el("div", { id: "quote-compare-body" })],
  }));
  pane.appendChild(card({
    id: "quote-price", title: "Price check",
    sub: "What you are paying per watt, and what a loan adds on top.",
    body: [el("div", { id: "quote-price-body" })],
  }));
  pane.appendChild(card({
    id: "quote-prod", title: "Production check",
    sub: "How much power the installer says the panels will make, against what the model says for this roof.",
    body: [el("div", { id: "quote-prod-body" })],
  }));
  pane.appendChild(card({
    id: "quote-ask", title: "Ask the installer",
    sub: "Questions that follow from what the numbers above show.",
    body: [el("div", { id: "quote-ask-body" })],
  }));
}

/** Cards that only make sense once a quote has been compared. */
const RESULT_CARDS = ["quote-compare", "quote-price", "quote-prod", "quote-ask"];

export function render(state, ctx) {
  const q = state.quote || {};
  const priced = ctx.priced;
  const showCards = (on) => { for (const c of RESULT_CARDS) { const n = $(c); if (n) n.hidden = !on; } };

  const empty = $("quote-empty");
  clear(empty);

  if (!priced) {
    showCards(false);
    empty.appendChild(card({ title: "Check a quote", body: [
      el("p.note", { text: "The model is still working out the options for your house. Your quote will be checked as soon as it is ready." }),
    ] }));
    return;
  }

  const fin = ctx.finEff ? ctx.finEff(0) : fallbackFin(state, ctx);
  const cmp = compareQuote({
    quote: q, priced, fin, system: state.system, panelW: state.system.panelW,
    // Cells carry the roof extra they were priced with (main.js sets it per cell).
    roofAdderFor: (c) => (c && c.roofCostAdder) || 0,
  });

  if (cmp.status === "incomplete") {
    showCards(false);
    renderEmpty(empty, q);
    return;
  }
  if (cmp.status === "outside-grid") {
    showCards(false);
    renderOutside(empty, cmp, ctx);
    return;
  }

  showCards(true);
  renderCompare(state, cmp, q);
  renderPrice(state, cmp, q);
  renderProduction(cmp, q);
  renderAsk(state, cmp, q);
}

/** What main.js's finEff(0) produces, for a host that does not expose it. */
function fallbackFin(state, ctx) {
  const ngom = (ctx.tariff && ctx.tariff.meta && ctx.tariff.meta.ngom_cost) || 600;
  return Object.assign({}, state.fin, { adder: state.fin.adder + (state.system.ngom ? ngom : 0), roofCostAdder: 0 });
}

// -------------------------------------------------------------- empty states

function renderEmpty(host, q) {
  const have = [q.kwDc ? "size" : null, q.price ? "price" : null].filter(Boolean);
  host.appendChild(card({
    id: "quote-intro", title: "Check a quote",
    sub: "Got a proposal from an installer? Put its numbers in the left rail and see how it compares.",
    body: [
      el("p.note", { text: "You need three things from the proposal:" }),
      el("ul.quote-list", {}, [
        el("li", { text: "System size, in kW DC. It is on the first page, often as \"7.4 kW\"." }),
        el("li", { text: "Number of batteries, and their usable kWh each if the proposal says." }),
        el("li", { text: "Total price, the contract price after any discount and before financing." }),
      ]),
      el("p.note", { text: "For example: 7.4 kW, 1 battery, $31,000. Add the installer's production estimate in kWh a year "
        + "and, if you are financing, the monthly payment, to get the production and dealer-fee checks as well." }),
      have.length ? el("p.note", { text: `Still needed: ${["size", "price"].filter((x) => !have.includes(x)).join(" and ")}.` }) : null,
    ],
  }));
}

function renderOutside(host, cmp, ctx) {
  const o = cmp.outside;
  const knob = o.axis === "panels" ? "Most panels to consider" : "Most batteries to consider";
  const what = o.axis === "panels"
    ? `${plural(o.needed, "panel", "panels")}` : `${plural(o.needed, "battery", "batteries")}`;
  const actions = [];
  const act = ctx.actions || {};
  if (o.axis === "panels" && act.setMaxPanels && o.needed <= 80) {
    actions.push(el("button.btn.btn-primary", { type: "button", text: `Raise it to ${o.needed}`, on: { click: () => act.setMaxPanels(o.needed) } }));
  } else if (o.axis === "batteries" && act.setMaxBatteries && o.needed <= 20) {
    actions.push(el("button.btn.btn-primary", { type: "button", text: `Raise it to ${o.needed}`, on: { click: () => act.setMaxBatteries(o.needed) } }));
  }
  if (act.goTab) actions.push(el("button.btn", { type: "button", text: "Open the Dashboard", on: { click: () => act.goTab("dashboard") } }));
  host.appendChild(card({
    id: "quote-outside", title: "This quote is bigger than the options the model tried",
    body: [
      el("p", { text: `The quote has ${what}; the model only simulated up to ${o.have}. Raise "${knob}" on the Dashboard, `
        + "wait for the sweep to finish, and the comparison will appear here." }),
      actions.length ? el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" }, actions) : null,
    ],
  }));
}

// ------------------------------------------------------------------ compare

function sizeLine(s) {
  return `${fmtNum(s.kwDc, 1)} kW, ${plural(s.batteries, "battery", "batteries")}`;
}

function renderCompare(state, cmp, q) {
  const host = $("quote-compare-body");
  clear(host);
  const { quotePriced: qp, marketPriced: mp, optimum: op, quoteCell } = cmp;
  const years = state.fin.horizon;

  const t = tiles("quote-tiles");
  t.classList.add("tiles-3");
  t.appendChild(tile({ k: "Quote as priced", v: fmtCompact(qp.npv), key: true,
    d: `${sizeLine(qp)} at ${fmtMoney(q.price)}` }));
  t.appendChild(tile({ k: "Same size at market price", v: fmtCompact(mp.npv),
    d: `${sizeLine(mp)} at ${fmtMoney(mp.price)}` }));
  t.appendChild(tile({ k: "Optimiser's pick", v: fmtCompact(op.npv),
    d: `${sizeLine(op)} at ${fmtMoney(op.price)}` }));
  host.appendChild(t);
  host.appendChild(el("p.note", { text: `Each figure is net present value over ${years} years, after what the money would have earned elsewhere.` }));

  const lines = [];
  if (qp.npv < 0) {
    lines.push(`At the quoted price this system loses ${fmtMoney(-qp.npv)} over ${years} years against putting the same money elsewhere.`);
  } else {
    lines.push(`At the quoted price this system comes out ${fmtMoney(qp.npv)} ahead over ${years} years.`);
  }
  const gapMarket = mp.npv - qp.npv;
  if (gapMarket > 500) {
    lines.push(`At the model's market price the same hardware would be worth ${fmtMoney(gapMarket)} more, so the quote costs you that much above it.`);
  } else if (gapMarket < -500) {
    lines.push(`The quote is ${fmtMoney(-gapMarket)} better than the model's market price for the same hardware.`);
  } else {
    lines.push("The quoted price is close to the model's market price for the same hardware.");
  }
  const gapOpt = op.npv - qp.npv;
  const sameAsPick = op.panels === quoteCell.panels && op.batteries === quoteCell.batteries;
  if (!sameAsPick && gapOpt > 1000) {
    lines.push(`A different size, ${sizeLine(op)}, would be ${fmtMoney(gapOpt)} better than this quote.`);
  } else if (sameAsPick) {
    lines.push("The quote is the size the optimiser picks.");
  }
  host.appendChild(el("p", { text: lines.join(" ") }));
  if (cmp.sizeDiffers) {
    host.appendChild(el("p.note", { text: `The model tried ${quoteCell.panels} panels, the closest to your ${cmp.panelsQuoted}, and the figures use that.` }));
  }
  if (q.battKWh && q.battKWh !== state.system.battKWh && q.batteries > 0) {
    host.appendChild(el("p.note", { text: `The model simulates batteries of ${state.system.battKWh} kWh (the Hardware setting). `
      + `Set it to ${q.battKWh} on the Dashboard to see how this quote's battery size behaves.` }));
  }
}

// -------------------------------------------------------------------- price

const AXIS = { min: 1.5, max: 4.5 };
const pctOnAxis = (v) => Math.max(0, Math.min(100, ((v - AXIS.min) / (AXIS.max - AXIS.min)) * 100));

function renderPrice(state, cmp, q) {
  const host = $("quote-price-body");
  clear(host);
  const { perW, band } = cmp;
  const rows = [];

  if (perW === null) {
    host.appendChild(el("p.note", { text: "The price per watt cannot be worked out: the price is smaller than the storage in the quote at the model's storage prices." }));
  } else {
    const verdict = priceVerdict(perW, band);
    const word = verdict === "below" ? "below the market band" : verdict === "above" ? "above the market band" : "inside the market band";
    host.appendChild(el("p", {}, [
      el("strong.num", { text: `${fmtMoney(perW, 2)} per watt` }),
      ` for the solar${q.batteries > 0 ? ", after taking out the batteries at the model's prices" : ""}. That is ${word}.`,
    ]));
    host.appendChild(el("div.qband", { role: "img",
      "aria-label": `${fmtMoney(perW, 2)} per watt against a market band of ${fmtMoney(band.lo, 2)} to ${fmtMoney(band.hi, 2)}` }, [
      el("div.qband-track"),
      el("div.qband-zone", { style: `left:${pctOnAxis(band.lo)}%;width:${pctOnAxis(band.hi) - pctOnAxis(band.lo)}%` }),
      el("div.qband-marker" + (verdict === "within" ? "" : ".qband-out"), { style: `left:${pctOnAxis(perW)}%` }),
    ]));
    host.appendChild(el("div.qband-axis", {}, [
      el("span", { text: fmtMoney(AXIS.min, 2) }),
      el("span", { text: `market ${fmtMoney(band.lo, 2)} to ${fmtMoney(band.hi, 2)}` }),
      el("span", { text: fmtMoney(AXIS.max, 2) }),
    ]));
    host.appendChild(el("p.note", { text: `${band.source}, as of ${band.asOf}. A guide, not a rule: roof work, a main-panel upgrade `
      + "and premium panels all move a fair price outside it." }));
  }

  const fee = cmp.dealerFee;
  if (fee) {
    const implied = fee.source === "implied";
    rows.push(["Dealer fee", fee.dollars > 0
      ? `${fmtMoney(fee.dollars)}, ${fmtPct(fee.pctOfPrice, 1)} of the price`
      : "none found"]);
    rows.push(["Where that comes from", implied
      ? "the monthly payment you entered, worked back to the loan it implies"
      : "the Dealer fee setting in the left rail"]);
    if (fee.dollars > 0) rows.push(["Price with the fee counted", fmtMoney(cmp.cashEquivalent)]);
  }
  if (rows.length) host.appendChild(dl(rows));

  if (fee && fee.dollars > 0) {
    host.appendChild(el("p.note", { text: "A low interest rate on a solar loan is often paid for by a dealer fee: the lender charges "
      + "the installer, and the installer adds it to the loan. The second figure is the price you are really paying." }));
  } else if (fee && !q.monthly) {
    host.appendChild(el("p.note", { text: "Enter the quoted monthly payment in the left rail and the page will work out any fee hidden in the loan." }));
  }
}

// --------------------------------------------------------------- production

function renderProduction(cmp, q) {
  const host = $("quote-prod-body");
  clear(host);
  const pc = cmp.productionCheck;
  if (!pc || pc.ratio === null) {
    host.appendChild(el("p.note", { text: `Enter the installer's production estimate in kWh a year (usually on the proposal's first page) `
      + `to compare it with the model's ${pc && pc.model ? fmtNum(pc.model, 0) + " kWh" : "figure"}.` }));
    return;
  }
  host.appendChild(dl([
    ["Installer says", `${fmtNum(pc.installer, 0)} kWh/yr`],
    ["Model says", `${fmtNum(pc.model, 0)} kWh/yr`],
    ["Installer over model", fmtPct(pc.ratio, 0)],
  ]));
  const words = {
    "in line": "In line. The two agree to within 5%.",
    "conservative": "Conservative. The installer expects less than the model does.",
    "optimistic": "Optimistic. The installer's number is 5% to 15% above the model's.",
    "very optimistic": "Very optimistic. The installer's number is more than 15% above the model's.",
  };
  host.appendChild(el("p", {}, [el("strong", { text: words[pc.verdict] })]));
  if (pc.verdict === "optimistic" || pc.verdict === "very optimistic") {
    host.appendChild(el("p.note", { text: `If the model is right, this quote pays back in ${fmtYears(pc.paybackModel)} rather than the `
      + `${fmtYears(pc.paybackInstaller)} the installer's number would give. Ask what weather, shading and panel losses their estimate assumes.` }));
  } else {
    host.appendChild(el("p.note", { text: "Production estimates differ a little between tools, so a gap under 5% is not worth arguing about." }));
  }
}

// ---------------------------------------------------------------------- ask

function renderAsk(state, cmp, q) {
  const host = $("quote-ask-body");
  clear(host);
  const items = [];
  const fee = cmp.dealerFee;
  const mode = state.fin.financing.mode;
  const pc = cmp.productionCheck;

  if (mode === "loan") {
    items.push(fee && fee.dollars > 0
      ? `The loan seems to carry about ${fmtMoney(fee.dollars)} in dealer fees. What is the price if I pay cash, and what is the fee in dollars?`
      : "Is there a dealer fee in this loan? What is the price if I pay cash?");
  }
  if (mode === "lease") items.push("What is the price to buy the system outright, and what does the lease cost over its whole term, escalator included?");
  items.push(state.fin.microinverters
    ? "Are the panels fitted with microinverters, and what is the warranty on each one?"
    : "Is it a string inverter or microinverters? A string inverter usually needs replacing once, around year 10 to 15. What does the warranty cover and for how long?");
  if (q.batteries > 0 || cmp.optimum.batteries > 0) {
    items.push(state.system.ngom
      ? "Does the price include the production meter that lets the battery export to the grid (a net generation output meter, NGOM)?"
      : "Does the price include a net generation output meter (NGOM)? Without one the battery cannot be paid for exporting at the best hours.");
  }
  if (cmp.optimum.batteries !== cmp.quoteCell.batteries) {
    const diff = cmp.optimum.batteries - cmp.quoteCell.batteries;
    items.push(diff > 0
      ? `The model likes ${plural(cmp.optimum.batteries, "battery", "batteries")} for this house, not ${q.batteries || 0}. What would an extra battery add to the price?`
      : `The model finds ${cmp.optimum.batteries === 0 ? "no battery" : plural(cmp.optimum.batteries, "battery", "batteries")} worth it here, against the ${q.batteries} quoted. What does the battery add to the price, and what do I lose if I drop it?`);
  }
  if (pc && (pc.verdict === "optimistic" || pc.verdict === "very optimistic")) {
    items.push("What weather data, shading and system losses does your production estimate assume? Will you guarantee it in writing?");
  }
  if (cmp.perW !== null && priceVerdict(cmp.perW, cmp.band) === "above") {
    items.push("The price per watt is above the usual range. What is in the price that a standard install would not have (roof work, panel upgrade, premium equipment)?");
  }
  items.push("What is the warranty on the work itself, and who services it if your company closes?");

  host.appendChild(el("ul.quote-list", {}, items.map((t) => el("li", { text: t }))));
}

function dl(rows) {
  const node = el("dl.kv", { style: "margin:8px 0" });
  for (const [k, v] of rows) { node.appendChild(el("dt", { text: k })); node.appendChild(el("dd", { text: v })); }
  return node;
}

export default { id, label, rail, mount, render };
