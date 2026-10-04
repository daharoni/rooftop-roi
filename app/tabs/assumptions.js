/* =============================================================================
 * tabs/assumptions.js — everything the model does, in the order it does it.
 *
 * Ported from the prototype's method panel and generalised off the single
 * house it was written for.  This is the tab that decides whether the rest of
 * the page deserves to be believed, so nothing here is hidden behind a link.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtNum, fmtPct } from "../ui/format.js";

export const id = "assumptions";
export const label = "Assumptions";

export function rail() {
  return [
    { group: "Reading this tab", open: true, items: [
      { path: "ui.assumptionsJump", kind: "select", label: "Jump to", opts: [
        { v: "method", t: "What is simulated" },
        { v: "quality", t: "Your data" },
        { v: "rates", t: "Rates and effective dates" },
        { v: "incentives", t: "Incentives in 2026" },
        { v: "sources", t: "Sources" },
        { v: "glossary", t: "Glossary" },
      ] },
    ] },
  ];
}

export function mount(pane) {
  clear(pane);

  pane.appendChild(card({
    id: "quality",
    title: "Your data",
    sub: "What the answer is actually built on, and where it is thinnest.",
    body: [
      el("dl.kv", { id: "quality-kv" }),
      el("div", { id: "quality-warnings", style: "margin-top:12px;display:flex;flex-direction:column;gap:8px" }),
    ],
  }));

  pane.appendChild(card({
    id: "rates",
    title: "Rates, effective dates and confidence",
    sub: "A tariff file goes stale the moment a rate case is decided. These are the dates on the file this "
      + "page is using.",
    body: [el("div.table-scroll", {}, [el("table", { id: "t-rates" })])],
  }));

  pane.appendChild(card({
    id: "incentives",
    title: "Incentives in 2026",
    sub: "What actually reaches a California homeowner this year, and what only looks like it does.",
    body: [el("div.method", { id: "incentives-body" })],
  }));

  pane.appendChild(card({
    id: "method",
    title: "Method",
    sub: "Everything below is what the model actually does.",
    body: [el("div.method", { id: "method-body" })],
  }));

  pane.appendChild(card({
    id: "sources",
    title: "Sources",
    body: [el("div.method", { id: "sources-body" })],
  }));

  pane.appendChild(card({
    id: "glossary",
    title: "Glossary",
    body: [el("dl.kv", { id: "glossary-kv" })],
  }));

  renderGlossary();
}

export function render(state, ctx) {
  renderQuality(state, ctx);
  renderRates(state, ctx);
  renderIncentives(state, ctx);
  renderMethod(state, ctx);
  renderSources(state, ctx);
}

function renderQuality(state, ctx) {
  const node = clear($("quality-kv"));
  const meta = (ctx.loadSet && ctx.loadSet.meta) || {};
  // Annual kWh as the engine counts it (usable days / 365), from main.js; the
  // hours / 8760 fallback only until the engine has seen this file.
  const usable = meta.quality && Number.isFinite(meta.quality.usableHours) ? meta.quality.usableHours : meta.nHours;
  const years = usable ? usable / 8760 : 0;
  const annualKwh = ctx.householdAnnualKwh || (meta.totalKwh && years ? meta.totalKwh / years : null);
  const solarMeta = firstSolarModel(state);

  const pairs = [
    ["Meter history", meta.nHours ? `${fmtNum(meta.nHours, 0)} hours · ${meta.start || "?"} → ${meta.end || "?"}` : "—"],
    ["Source", meta.source === "synthetic" ? "twelve monthly bills, hourly shape estimated" : (meta.source || "—")],
    ["Original interval", meta.intervalMinutes ? `${meta.intervalMinutes} min, summed to hours` : "—"],
    ["Consumption", annualKwh ? `${fmtNum(annualKwh, 0)} kWh/yr` : "—"],
    ["Gaps filled", meta.gapsFilled && meta.gapsFilled.length ? `${meta.gapsFilled.length} short gaps interpolated` : "none"],
    ["Flexible loads", state.flex.length
      ? state.flex.map((f) => `${f.name} ${fmtNum(f.annualKwh, 0)} kWh/yr (${f.source})`).join(" · ")
      : "none detected or added"],
    ["Roof", state.roof.planes.length
      ? state.roof.planes.map((p) => `${p.name}: ${p.tilt}° tilt, ${p.azimuth}° azimuth, ≤${p.maxPanels} panels, ${fmtPct(p.shading?.annual ?? 0, 0)} shaded`).join(" · ")
      : "—"],
    ["Location", state.site.lat !== null ? `${state.site.lat.toFixed(4)}, ${state.site.lon.toFixed(4)}` : "—"],
    ["Weather years", (state.solar.weatherYears || []).length ? state.solar.weatherYears.join(", ") : "—"],
    ["PV model", solarMeta ? `${fmtPct(solarMeta.losses, 0)} losses, DC:AC ${solarMeta.dcAcRatio}, inverter ${fmtPct(solarMeta.invEff, 0)}` : "—"],
    ["Weather scenario", state.ui.weatherKey],
  ];
  if (ctx.existingMode) {
    pairs.push(["Existing solar", `Existing solar: ${fmtNum(ctx.existingMode.kwDc, 1)} kW on ${ctx.existingMode.nem === "nem1" ? "NEM 1" : "NEM 2"}, battery add-on mode`]);
  }
  for (const [k, v] of pairs) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { text: v }));
  }

  // A banner is for something that needs attention. What the parser noticed on
  // the way through — a duplicated fall-back hour, a 23-hour spring day — is
  // provenance, not a problem, so it reads as a list.
  const warn = clear($("quality-warnings"));
  for (const w of ctx.dataWarnings || []) {
    warn.appendChild(el("div.banner" + (w.severity === "bad" ? ".banner-bad" : ""), { text: w.text }));
  }
  if (meta.source === "synthetic") {
    warn.appendChild(el("div.banner", { text: "This result is less certain than one built from meter data. Your bills "
      + "give twelve monthly totals; the hour-by-hour shape inside each month is estimated from a typical "
      + "household. Totals are exact, timing is not, and timing is what a battery and solar are paid for. "
      + "EV charging and pool pumps are the loads most affected, because when they run matters more than how "
      + "much they use. To tighten it, download a Green Button file from your utility (in your utility account, "
      + "under usage or energy data) and drop it on the landing page." }));
  }
  const notes = [].concat(meta.notes || []).filter(Boolean);
  if (notes.length) {
    warn.appendChild(el("details.data-view", { open: false }, [
      el("summary", { text: `What the parser noticed reading your file (${notes.length})` }),
      el("ul", { style: "margin:6px 0 0;padding-left:18px" },
        notes.map((n) => el("li", { style: "font-size:12px;color:var(--ink-2);margin-bottom:3px", text: n }))),
    ]));
  }
}

/**
 * One sentence per substitution flagged in the engine's result.tariffTerms.
 * Every field is read defensively: an older engine bundle may not carry the
 * plan fields yet, and a missing flag is treated as "no substitution".
 */
export function fallbackSentences(state, ctx) {
  const d = ctx && ctx.detail;
  const tt = (d && d.tariffTerms) || (d && d.baselineSameFlex && d.baselineSameFlex.tariffTerms) || null;
  if (!tt) return [];
  const t = ctx.tariff || {};
  const providerName = (id) => (id && t.providers && t.providers[id] && t.providers[id].name) || id || "an unnamed provider";
  const planName = (id) => {
    const pl = id && Array.isArray(t.plans) ? t.plans.find((x) => x && x.id === id) : null;
    return (pl && pl.name) || id || "an unnamed plan";
  };
  const out = [];
  if (tt.providerFallback === true) {
    const req = tt.providerRequested || (state && state.tariff && state.tariff.providerId);
    out.push(`Generation provider: you asked for ${providerName(req)}, which this rate book does not price, `
      + `so the run used ${providerName(tt.providerId)} instead.`);
  }
  if (tt.planFallback === true) {
    const req = tt.planRequested || (state && state.tariff && state.tariff.planId);
    out.push(`Rate plan: ${planName(req)} is not in this utility's rate book, so the run used ${planName(tt.planId)} instead.`);
  }
  if (tt.baselineRegionFallback === true) {
    const req = state && state.site && state.site.baselineRegion;
    out.push((req ? `Baseline region ${req} is not one this utility lists, so the` : "No baseline region is set, so the")
      + ` run used region ${tt.baselineRegion ?? "default"} (the tariff file's default); pick yours on the Bills tab.`);
  }
  return out;
}

function firstSolarModel(state) {
  const p = Object.values(state.solar.byPlane || {})[0];
  return p && p.model;
}

function renderRates(state, ctx) {
  const table = clear($("t-rates"));
  const t = ctx.tariff;
  if (!t || !t.meta) {
    table.appendChild(el("tbody", {}, [el("tr", {}, [el("td", { text: "No tariff file loaded yet." })])]));
    return;
  }
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: "What" }), el("th", { text: "Value" }), el("th", { text: "Confidence" }),
  ])]));
  const conf = t.meta.confidence || {};
  const rows = [
    ["Rates effective", t.meta.rates_effective || "—", conf.rates],
    ["Rate schedules", "hours and seasons per plan", conf.schedules],
    ["Generation providers", `${Object.keys(t.providers || {}).length} priced`, conf.providers],
    ["File compiled", t.meta.as_of || "—", null],
    ["Export rate vintage", (t.nbt && t.nbt.vintage) || "—", conf.nbt || conf.export_rates],
    ["Export lock-in", t.nbt && t.nbt.lock_in_years ? `${t.nbt.lock_in_years} years from permission to operate` : "—", null],
    ["Net surplus compensation", t.nbt ? `$${fmtNum(t.nbt.net_surplus_compensation_per_kwh, 5)}/kWh` : "—", conf.nbt || conf.export_rates],
    ["Baseline allocation", t.meta.baseline_kwh_per_day
      ? `${t.meta.baseline_kwh_per_day.summer} kWh/day summer, ${t.meta.baseline_kwh_per_day.winter} winter (region ${t.meta.baseline_region || "?"})`
      : "—", conf.baseline],
    ["Rate escalation used", fmtPct(state.fin.escalation, 1) + "/yr",
      t.meta.escalation ? `history ${fmtPct(t.meta.escalation.historical_cagr, 2)}/yr over ${t.meta.escalation.period}` : null],
  ];
  table.appendChild(el("tbody", {}, rows.map(([what, value, confidence]) => el("tr", {}, [
    el("td", { text: what }),
    el("td.n", { text: String(value) }),
    el("td", {}, confidenceCell(confidence)),
  ]))));
}

// Shorten a note to its first two sentences; the full text sits behind "more".
function twoSentences(text) {
  const parts = String(text || "").match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [String(text || "")];
  return parts.length > 2 ? { short: parts.slice(0, 2).join("").trim(), full: String(text).trim() } : { short: String(text).trim(), full: null };
}

function expandable(text, cls = "") {
  const { short, full } = twoSentences(text);
  const p = el("p", { class: cls, style: "margin:4px 0", text: short });
  if (!full) return p;
  const btn = el("button.btn", { type: "button", text: "more", style: "margin-left:6px;padding:0 8px;font-size:12px" });
  let open = false;
  btn.addEventListener("click", () => {
    open = !open;
    p.firstChild.nodeValue = open ? full : short;
    btn.textContent = open ? "less" : "more";
  });
  p.appendChild(btn);
  return p;
}

function levelTag(level) {
  const cls = level === "high" ? ".tag.tag-good" : level === "low" ? ".tag.tag-warn" : ".tag";
  return el("span" + cls, { text: level, style: "margin-left:6px" });
}

function renderIncentives(state, ctx) {
  const node = clear($("incentives-body"));
  const inc = (ctx.tariff && ctx.tariff.incentives) || {};
  const item = (head, level, text) => el("div", { style: "margin-bottom:10px" }, [
    el("h3", { style: "margin:0 0 2px" }, [head, levelTag(level)]),
    el("p", { style: "margin:0", text }),
  ]);
  node.append(
    item("Homeowner tax credit (Section 25D): 0%", "high",
      "The 30% credit for a system you own ended for 2026. The law counts the money as spent when the install is "
      + "finished, not when you pay, so paying in 2025 for an install finished in 2026 does not keep it."),
    item("Credit for a leased or PPA system (Section 48E): 30% or more", "high",
      "Only the company that owns the system can claim it. You see it only as a lower lease or PPA payment, "
      + "and that is the company's pricing choice, not something you are owed. That is why the Incentives "
      + "controls have a \"vendor pass-through\" mode: use it when a quote shows a discount that comes from the owner's credit."),
    item("California battery rebate (SGIP): closed", "high",
      "General-market budgets stopped taking applications on 2025-12-30 and waitlists were cancelled. What remains "
      + "is the income-qualified equity programme (RSSE), which is small and mostly waitlisted."),
    item("Property tax: new solar is excluded from reassessment", "medium",
      "California does not raise your property tax assessment for a new rooftop solar system (Revenue and Taxation "
      + "Code section 73). Under the law as last checked the exclusion covers systems completed through 2026-12-31. "
      + "The tariff files do not record this, and whether it was extended is unverified here. Ask your installer."),
    item("HOA rules: limited by the Solar Rights Act", "medium",
      "An HOA can ask for reasonable placement changes, but it cannot ban solar or add rules that raise the cost "
      + "much or cut output much. It is a legal protection, not money, so the model does not price it."),
  );

  const others = [];
  const add = (name, value, note, level) => others.push({ name, value, note, level });
  if (inc.sgip_note && !/closed|CLOSED/.test(inc.sgip_note)) add("Storage rebate", "", inc.sgip_note, "medium");
  for (const o of inc.other || []) {
    // The 48E and base-charge rows are covered above or are costs, not incentives.
    if (/Section 48E|Base Services Charge/i.test(o.name || "")) continue;
    add(o.name, o.value, o.note, o.confidence || "medium");
  }
  if (others.length) {
    node.appendChild(el("h3", { text: "Programmes from your utility or community choice aggregator" }));
    for (const o of others) {
      node.appendChild(el("div", { style: "margin-bottom:10px" }, [
        el("div", {}, [el("strong", { text: o.name }), o.value ? el("span", { text: " · " + o.value }) : null, levelTag(typeof o.level === "string" ? o.level : "medium")].filter(Boolean)),
        o.note ? expandable(o.note, "ctl-note") : null,
      ].filter(Boolean)));
    }
  }
  node.appendChild(el("p", { class: "ctl-note", text: "To model any of this, use the Incentives controls on the Dashboard rail." }));
}

/**
 * A confidence entry is either a bare level ("high") or `{ level, note }` — the
 * note is where the compiler says which figures are verbatim off a bill and
 * which are derived, so it belongs on the page rather than in the JSON.
 */
function confidenceCell(confidence) {
  if (!confidence) return [el("span", { style: "color:var(--ink-3)", text: "—" })];
  const level = typeof confidence === "string" ? confidence : confidence.level || "—";
  const note = typeof confidence === "string" ? null : confidence.note;
  const cls = level === "high" ? ".tag.tag-good" : level === "low" ? ".tag.tag-warn" : ".tag";
  return [
    el("span" + cls, { text: level }),
    note ? el("div.ctl-note", { style: "margin-top:4px;max-width:52ch;text-align:left", text: note }) : null,
  ].filter(Boolean);
}

function renderMethod(state, ctx) {
  const node = clear($("method-body"));
  const nbt = (ctx.tariff && ctx.tariff.nbt) || {};
  const meta = (ctx.loadSet && ctx.loadSet.meta) || {};

  const h = (t) => el("h3", { text: t });
  const p = (t) => el("p", { text: t });
  const ul = (items) => el("ul", {}, items.map((x) => el("li", { text: x })));

  // What the engine had to substitute: shown only when it did.
  const subs = fallbackSentences(state, ctx);
  if (subs.length) {
    node.append(h("What this run substituted"),
      el("div", { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:10px" },
        subs.map((t) => el("div.banner", { text: t }))));
  }

  node.append(
    h("What is simulated"),
    p(`Every hour of your own meter history — ${meta.nHours ? fmtNum(meta.nHours, 0) + " hours" : "your whole record"}`
      + `${meta.start ? ` from ${meta.start} to ${meta.end}` : ""} — is replayed with a solar array and battery `
      + "bolted on. Results are divided by elapsed days over 365 to give a per-year figure, so a two-year "
      + "record is not double counted."),
    p("Load timestamps are your meter's local clock time and shift with daylight saving; the solar profiles "
      + "are in local standard time. Summer hours are shifted back one hour before they are paired, and the "
      + "tariff clock is left alone, because the tariff is defined in clock time too. Spring-forward days "
      + "have 23 hours and are handled as such."),

    h("How the battery decides"),
    ul([
      "Self-consumption. Solar serves the house, the surplus charges the pack, the rest exports. At night the "
        + "pack serves the house down to the backup reserve. Never charges from the grid.",
      "Time-of-use arbitrage. Same, but during off-peak hours the pack holds back whatever tonight's peak needs "
        + "and tomorrow's sun cannot refill. When the forecast is sunny the pack is free to run the house "
        + "overnight, because a kWh kept off an off-peak import beats a kWh exported at avoided-cost prices.",
      "Export arbitrage. Time-of-use arbitrage plus: in any hour where the export price beats your threshold, "
        + "the pack sells whatever is above the reserve after the house is served.",
      "Backup only. The pack sits full and never cycles. Solar still self-consumes and exports. This is the "
        + "honest zero-arbitrage comparison.",
    ]),
    p("The lookahead is one day and it uses the actual next-day profile as its forecast, which flatters every "
      + "rule by exactly the amount a real forecast is wrong. Charge and discharge each pay the square root of "
      + "round-trip efficiency; the pack never crosses the reserve floor, its usable capacity, or its kW rating."),

    h("How the bill is computed"),
    p("Under California's Net Billing Tariff there is no netting: each hour, imports are billed at that hour's "
      + "retail rate for your plan, season and day type, and exports are credited at that hour's avoided-cost "
      + "export price. Holidays use the weekend schedule."),
    ul([
      "Monthly: base services charge + energy − baseline credit, floored at the minimum charge (or the fixed "
        + "charge, whichever is higher).",
      "Export credits then offset that subtotal down to the floor and no further. What is left rolls to next month.",
      "At annual true-up the leftover balance is cashed out at net surplus compensation, applied to the kWh "
        + "those credits came from.",
      "The California Climate Credit is a flat credit in its months, in both the with-system and no-system "
        + "bills, so it cancels out of savings but still shows in the bill chart.",
      `Non-bypassable charges (${nbt.nonbypassable_charges_per_kwh ? "$" + fmtNum(nbt.nonbypassable_charges_per_kwh, 5) + "/kWh" : "as published"}) `
        + "are already inside the published retail rates. They are not added on top — they are the part of the "
        + "import price solar cannot escape.",
      "Without a Net Generation Output Meter, paired storage under 10 kW has its monthly export credit capped "
        + "at the utility's estimate of PV production, and the forfeited kWh are deemed to have happened in the "
        + "customer's highest-priced hours. The cap here is approximated as this model's own monthly PV output, "
        + "and credit is stripped from the most expensive price band downward.",
      "Grid-charging a paired-storage battery is prohibited outright. The control is left in for comparison, "
        + "and while it is on the battery is barred from exporting, since grid energy cannot earn an export credit.",
      "At annual true-up the credit bank is first reduced by the average retail export compensation rate "
        + "applied to the net surplus kWh, and only then are those kWh paid at net surplus compensation — "
        + "roughly a third of the rate at which the credits were just removed. A bank built out of cheap midday "
        + "export is therefore wiped out. That asymmetry is the tariff's penalty for oversizing, and it is why "
        + "this model will not recommend an array sized to annual kWh offset.",
    ]),

    h("The export prices are a snapshot of a nine-year trajectory"),
    p("A permission-to-operate date locks one avoided-cost vintage for nine years, but that vintage specifies a "
      + "different 12×24 price matrix every year. Across all hours the first year runs well below the nine-year "
      + "mean — but in the late-summer evening hours that actually earn a battery its money, the first year is "
      + "higher than the mean, because the summer-evening capacity spike decays after the first couple of years. "
      + "So this model, using one vintage flat, slightly overstates battery export revenue and understates "
      + "everything else. There is no single correction factor that fixes both."),

    h("How flexible load moves"),
    p("A flexible load is one the household can choose to run at a different hour without noticing: a car "
      + "charger, a pool pump, a water heater. The detector pulls the recorded shape of each one out of your "
      + "meter data; the schedule controls then put it back somewhere else."),
    ul([
      "Each Monday-to-Sunday week's recorded energy for that load is taken as given, then divided evenly across "
        + "the chosen number of running days.",
      "Running days are picked in the order Mon, Tue, Wed, Thu, Fri, Sat, Sun — five days means weekdays, "
        + "seven means every day.",
      "On each running day the daylight share goes into the daytime window weighted by the solar profile's own "
        + "shape, so the load follows the array; the remainder runs overnight.",
      "No hour ever exceeds the appliance's kW rating; anything a cap blocks spills to the nearest hours of the "
        + "same day.",
      "A week with no recorded activity stays empty, and the weekly and annual kWh totals are unchanged to the "
        + "last decimal — only the timing moves.",
    ]),
    p("The split between house load and flexible load is an estimate out of a single whole-house meter, not a "
      + "submeter reading. It is usually the largest and most schedulable thing on site, which is why the "
      + "sensitivity panel varies it."),

    h("How the money is computed"),
    p("The dispatch is simulated once at year-1 condition and the resulting saving is then scaled — but it is "
      + "split in two first, because its halves do not grow at the same rate:"),
    el("p", {}, [el("code", { text: "savings_y = importSavings × escalation^(y−1) × degradation(y) + exportRevenue × exportEscalation^(y−1) × degradation(y)" })]),
    p("Import savings are power you no longer buy: they ride retail rates and escalate with them. Export revenue "
      + "is every dollar sourced from an exported kWh, and it does not ride retail rates, because the avoided-cost "
      + "vintage is locked. Escalating export credits alongside the bill would inflate the value of every "
      + "exported kWh and push the optimiser toward an oversized array, so export escalation defaults to zero."),
    ul([
      "Price. Solar $/W × kW DC plus storage $/kWh × usable kWh, plus the fixed install adder, plus each roof "
        + "face's \"Extra cost $\" (Roof tab) for the faces that system actually puts panels on. The optimiser fills "
        + "faces greedily, so every cell on the map knows its own faces: a 10-panel system that fits on the south "
        + "face does not pay for re-roofing the west one. Discounts and incentives then apply as set in the rail.",
      "Cash. The whole net price is a year-0 outlay.",
      "Loan. A down payment at year 0 plus level annual payments for the term; the principal is the net price "
        + "times the share financed, inflated by any dealer fee. A low APR bought with a big dealer fee is not a "
        + "cheap loan, and the model prices the fee. The loan and lease tiles state the financing decision as money: "
        + "this system's NPV minus the same system bought for cash. Positive means the rate is below your investment "
        + "return and borrowing wins; negative is what not paying up front costs.",
      "Lease or PPA. No upfront cost, escalating annual payments, an optional buyout at the end, and no "
        + "ownership incentives — the third party keeps those. The savings still accrue to the household.",
      "NPV discounts the cash flows at the return you could have earned on the same money. Above zero means the "
        + "roof beat the market. The upfront price is paid on day one; bills, savings and loan or lease payments "
        + "arrive through the year, so each year's flows are dated mid-year. Booking them at year end would credit "
        + "a borrower with a year of market return on money already paid out.",
      "Wealth at the horizon (the money-over-time chart) starts from this system's own price: leave it invested, "
        + "or spend it on the system and reinvest every year's saving. The gap between the two is NPV compounded "
        + "to the horizon. Because a dearer system starts from more cash, the absolute figures compare financing "
        + "modes for one system, not systems of different price - use NPV for that.",
      "IRR is the project IRR: the return the system earns on its cash price, whoever pays it, so it means "
        + "the same thing under cash, a loan and a lease. Under a loan the number to beat is the APR. If savings "
        + "never repay the price there is no IRR and none is shown.",
      "Pays for itself is the first year the system's cumulative earnings (savings less O&M and replacements) "
        + "have covered everything it will ever cost - the upfront share plus every loan or lease payment, interest "
        + "and buyout included - interpolated within the year. For cash that is the classic simple payback. "
        + "Whether the household is cash-positive from day one is reported separately.",
      "LCOE divides present-value lifetime cost by present-value lifetime generation.",
      "Backup power is the usable storage divided by the house's average daily draw with the flexible loads "
        + "off - nobody charges the cars from a battery in a blackout. A real outage runs longer, since the panels "
        + "recharge the pack by day and people trim load; without a battery a grid-tied array gives no backup at all.",
      state.site.utilityId === "sce"
        ? "SCE sizing line. SCE accepts a system up to 150% of your previous 12 months of usage (an attestation above "
          + "100%, refused above 150%) and estimates production as CEC-AC kW × 720 × 0.20 × 12, a flat 20% capacity "
          + "factor. CEC-AC per panel is the PTC rating times inverter efficiency, about 0.90 of nameplate; the "
          + "Hardware knob sets it. Columns past the line are faded on the grid."
        : "System size limit. Each utility caps interconnection relative to your past usage; only SCE's 150% "
          + "line is drawn on the grid so far. Check your utility's Net Billing rules before oversizing.",
      "Break-even price is the $/W or $/kWh at which NPV is exactly zero, solved directly — NPV is linear in both.",
    ]),

    h("Known limits"),
    p("No horizon or obstruction shading model beyond the per-face fraction you set; no snow or soiling beyond "
      + "the standard loss bundle; a meter record that already contains solar cannot show how the household "
      + "would behave once it has a battery; and one or two years of readings is a short sample of a 25-year "
      + "decision. Rates change. Check the effective dates above before trusting a number to the dollar."),
  );
}

function renderSources(state, ctx) {
  const node = clear($("sources-body"));
  const t = ctx.tariff || {};
  const solar = firstSolarModel(state);
  const items = [];

  if (t.meta && t.meta.sources) items.push(["Tariffs", [].concat(t.meta.sources).map(srcText)]);
  if (solar && solar.notes) items.push(["PV model", [solar.notes]]);
  items.push(["Weather", ["Open-Meteo historical archive (ERA5 reanalysis), hourly irradiance and temperature for your coordinates."]]);
  items.push(["Map imagery", ["Esri World Imagery, used only while a map is open."]]);
  items.push(["Geocoding", ["OpenStreetMap Nominatim, used only if you type an address."]]);
  if (ctx.loadSet && ctx.loadSet.meta && ctx.loadSet.meta.source) {
    items.push(["Your meter", [`${ctx.loadSet.meta.source} export, read in this browser.`]]);
  }

  for (const [head, lines] of items) {
    node.appendChild(el("h3", { text: head }));
    node.appendChild(el("ul", {}, lines.map((l) => el("li", { text: l }))));
  }
}

function srcText(s) {
  if (typeof s === "string") return s;
  return [s.title || s.name, s.url, s.retrieved].filter(Boolean).join(" — ");
}

function renderGlossary() {
  const node = clear($("glossary-kv"));
  const terms = [
    ["NPV", "Net present value. Today's value of every future dollar the system saves, minus what it costs, discounted at the return you could have earned instead. Above zero, the roof won."],
    ["IRR", "Internal rate of return. The annual return the system earns on its cash price, before financing. Beat the loan's APR and borrowing pays."],
    ["Pays for itself", "The year cumulative savings first exceed everything the system costs, financing included."],
    ["LCOE", "Levelised cost of energy. Lifetime cost divided by lifetime generation, both discounted — what a kWh off your own roof really costs."],
    ["NBT", "Net Billing Tariff. California's post-2023 rule: exports earn an hourly avoided-cost credit, not a retail-rate offset."],
    ["ACC", "Avoided Cost Calculator. The state's hour-by-hour estimate of what an exported kWh is worth to the grid. Its yearly edition is its vintage."],
    ["NGOM", "Net Generation Output Meter. A second meter that measures the array alone, which removes the export-credit cap on small paired storage."],
    ["P90 / P50 / P10", "Exceedance percentiles for annual sunlight. P90 is the yield beaten in nine years out of ten — the conservative one to plan against."],
    ["TMY", "Typical meteorological year. A synthetic year stitched from the most representative months of a long record."],
    ["Green Button", "The standard format US utilities use to hand you your own interval meter data."],
    ["Self-sufficiency", "The share of the household's kWh that came off the roof or out of the battery rather than the grid."],
    ["True-up", "The annual settlement where leftover export credits are cashed out, usually at a much lower rate than they were earned."],
  ];
  for (const [k, v] of terms) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { style: "font-family:var(--sans)", text: v }));
  }
}

export default { id, label, rail, mount, render };
