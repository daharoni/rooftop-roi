/* =============================================================================
 * tariff.js - the tariff library: load, look up, validate, describe.
 *
 * Pure data plumbing.  No DOM, no network except loadLibrary(), no user data ever
 * leaves the process.  Runs unchanged in the browser (fetch) and in Node (fs).
 *
 * -----------------------------------------------------------------------------
 * THE SHAPE OF A TARIFF FILE (data/tariffs/<id>.json)
 * -----------------------------------------------------------------------------
 * The schema IS data/tariffs/sce.json, which was calibrated line by line against a
 * real bill.  docs/tariff-schema.md documents every field.  In outline:
 *
 *   utility  { id, name, states[], zipPrefixes[], website, baselineRegions{} }
 *   meta     { as_of, rates_effective, sources[], confidence{}, climate_credit,
 *              baseline_region, baseline_kwh_per_day, escalation, notes }
 *   providers{ <providerId>: { name } }              // bundled utility + every CCA
 *   plans[]  { id, name, default?, eligibility_note, summer_months[],
 *              fixed_charge_per_day, minimum_charge_per_day,
 *              baseline_credit_per_kwh, period_ids[],
 *              schedule[season][weekday|weekend][24] -> period id,
 *              rates[season][periodId][providerId] -> TOTAL $/kWh }
 *   nbt      { vintage, lock_in_years, export_rates.{weekday,weekend}[12][24],
 *              net_surplus_compensation_per_kwh, nonbypassable_charges_per_kwh, ... }
 *   incentives {...}
 *
 * Two invariants the whole app leans on:
 *
 *  1. rates[season][period][providerId] is the FULL $/kWh that provider's customer
 *     pays in that hour - delivery + generation + every volumetric surcharge.  It is
 *     not a component to be added to something else.  That is why a CCA customer's
 *     number can legitimately exceed the bundled utility's.
 *
 *  2. Every [season][period] combination resolves, even the ones the 24-hour
 *     schedules never emit (summer has no super-off-peak on most plans; winter has
 *     no on-peak).  Those cells are filled with the nearest real period and are
 *     documented as filler in meta.notes.  A lookup can therefore never miss, and a
 *     correct simulation never reads the filler because the schedule never names it.
 * ========================================================================== */

"use strict";

/** Utilities the library ships, in the order the UI should offer them. */
export const UTILITY_IDS = ["sce", "pge", "sdge"];

/**
 * ACC Plus adder fallback, $/kWh on every exported kWh, by utility, for the
 * CURRENT (2026) NBT vintage.
 *
 * Normally this lives in the tariff file as `nbt.acc_plus_adder_per_kwh`.
 * data/tariffs/sce.json predates that field and is frozen (its rate values were
 * calibrated against a real bill and must not be edited), so SCE's value - which
 * its own nbt.notes states in prose - is carried here instead.  validate() emits a
 * warning for any file missing the field so this map does not quietly grow.
 */
const ACC_PLUS_FALLBACK = { sce: 0.016 };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const PERIOD_LABELS = {
  on: "on-peak", mid: "mid-peak / part-peak", off: "off-peak",
  super_off: "super-off-peak",
};

/* ------------------------------------------------------------------ calendar */

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(year, month, weekday) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
  return days - ((last - weekday + 7) % 7);
}

/**
 * The eight holidays on which California IOUs bill the WEEKEND schedule, for one
 * year, as a Set of "y-m-d" keys (month and day unpadded).
 *
 * Fixed-date holidays are entered on BOTH their actual date and their observed
 * date (Saturday -> the Friday before, Sunday -> the Monday after).  The actual
 * date matters when it is a weekday; the observed date is what makes a Monday
 * behave like a weekend when New Year's Day lands on a Sunday.  Adding both is
 * safe: the extra entry is always itself a weekend day.
 */
export function holidaysForYear(year) {
  const s = new Set();
  const add = (m, d) => s.add(year + "-" + m + "-" + d);
  const addObserved = (m, d) => {
    add(m, d);
    const dow = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (dow === 6) {                                  // Saturday -> Friday before
      const p = new Date(Date.UTC(year, m - 1, d - 1));
      add(p.getUTCMonth() + 1, p.getUTCDate());
    } else if (dow === 0) {                           // Sunday -> Monday after
      const n = new Date(Date.UTC(year, m - 1, d + 1));
      add(n.getUTCMonth() + 1, n.getUTCDate());
    }
  };
  addObserved(1, 1);                                  // New Year's Day
  add(2, nthWeekday(year, 2, 1, 3));                  // Presidents' Day
  add(5, lastWeekday(year, 5, 1));                    // Memorial Day
  addObserved(7, 4);                                  // Independence Day
  add(9, nthWeekday(year, 9, 1, 1));                  // Labor Day
  addObserved(11, 11);                                // Veterans Day
  add(11, nthWeekday(year, 11, 4, 4));                // Thanksgiving
  addObserved(12, 25);                                // Christmas
  return s;
}

const holidayCache = new Map();
function holidaySet(year) {
  let s = holidayCache.get(year);
  if (!s) { s = holidaysForYear(year); holidayCache.set(year, s); }
  return s;
}

/**
 * Normalise anything date-like to { y, m (1-12), d, dow, hour }.
 * Accepts a Date, "YYYY-MM-DD", "YYYY-MM-DDTHH:MM" or { y, m, d }.
 * Strings are read as LOCAL wall-clock time and never passed through Date parsing,
 * so "2026-07-04" cannot slide a day on a machine east of Greenwich.
 */
export function partsOf(date, hour) {
  let y, m, d, h = hour;
  if (date instanceof Date) {
    y = date.getFullYear(); m = date.getMonth() + 1; d = date.getDate();
    if (h === undefined || h === null) h = date.getHours();
  } else if (typeof date === "string") {
    const mt = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}))?/.exec(date);
    if (!mt) throw new Error("tariff: unparseable date " + date);
    y = +mt[1]; m = +mt[2]; d = +mt[3];
    if (h === undefined || h === null) h = mt[4] === undefined ? 0 : +mt[4];
  } else if (date && typeof date === "object") {
    y = +date.y; m = +date.m; d = +date.d;
    if (h === undefined || h === null) h = +(date.h || date.hour || 0);
  } else {
    throw new Error("tariff: unusable date " + String(date));
  }
  h = Math.max(0, Math.min(23, Math.floor(h || 0)));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow, hour: h };
}

/** True on Saturday, Sunday, or one of the eight holidays (observed). */
export function isWeekendOrHoliday(date) {
  const p = partsOf(date, 0);
  return p.dow === 0 || p.dow === 6 || holidaySet(p.y).has(p.y + "-" + p.m + "-" + p.d);
}

/* -------------------------------------------------------------------- loading */

const isNode = typeof process !== "undefined" && process.versions && process.versions.node;

/** Resolve the shipped data/tariffs directory as a filesystem path (Node only). */
async function defaultBase() {
  if (!isNode) return "data/tariffs";
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  return join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tariffs");
}

async function readJson(base, name) {
  const sep = /[\\/]$/.test(base) ? "" : "/";
  const path = base + sep + name;
  if (isNode && !/^https?:/i.test(path)) {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(path, "utf8"));
  }
  const res = await fetch(path);
  if (!res.ok) throw new Error("tariff: cannot load " + path + " (" + res.status + ")");
  return res.json();
}

/**
 * Load every utility file into `{ utilities: { sce, pge, sdge }, errors, ids }`.
 *
 * `baseUrl` defaults to the shipped data/tariffs directory (a filesystem path under
 * Node, the relative URL "data/tariffs" in the browser).  A file that fails to load
 * is recorded in `errors` rather than rejecting the whole library, so one bad
 * utility never blanks the app.
 */
export async function loadLibrary(baseUrl, ids) {
  const base = baseUrl || await defaultBase();
  const want = ids && ids.length ? ids : UTILITY_IDS;
  const utilities = {}, errors = [];
  await Promise.all(want.map(async (id) => {
    try { utilities[id] = await readJson(base, id + ".json"); }
    catch (e) { errors.push({ id, message: String((e && e.message) || e) }); }
  }));
  return { utilities, errors, ids: want.filter((id) => utilities[id]) };
}

/* ------------------------------------------------------------------ selection */

/**
 * Which utility serves a ZIP.  Matches the 3-digit prefix against each utility's
 * `utility.zipPrefixes`.  California ZIP prefixes overlap between IOUs (PG&E and
 * SCE both appear in 932-935, 939, 93x), so when more than one utility claims a
 * prefix the caller gets the list and the UI must ask.
 *
 * Returns { utilityId, utility, ambiguous, candidates[] } or null when nothing matches.
 */
export function utilityForZip(zip, lib) {
  const z = String(zip == null ? "" : zip).replace(/\D/g, "");
  if (z.length < 3) return null;
  const p3 = z.slice(0, 3), p5 = z.slice(0, 5);
  const utils = (lib && lib.utilities) || lib || {};
  const exact = [], prefix = [];
  for (const id of Object.keys(utils)) {
    const u = utils[id] && utils[id].utility;
    if (!u) continue;
    const list = u.zipPrefixes || [];
    for (const raw of list) {
      const s = String(raw);
      if (s.length === 5 && s === p5) { exact.push(id); break; }
      if (s.length === 3 && s === p3) { prefix.push(id); break; }
    }
  }
  const candidates = exact.length ? exact : prefix;
  if (!candidates.length) return null;
  return {
    utilityId: candidates[0],
    utility: utils[candidates[0]],
    ambiguous: candidates.length > 1,
    candidates,
  };
}

/** Baseline region hint for a ZIP, from utility.baselineRegions.zipHints. */
export function baselineRegionForZip(t, zip) {
  const br = t && t.utility && t.utility.baselineRegions;
  if (!br) return null;
  const z = String(zip == null ? "" : zip).replace(/\D/g, "");
  const hints = br.zipHints || {};
  // Longest prefix wins, so a 5-digit exception beats the 3-digit default it sits inside.
  const key = Object.keys(hints)
    .filter((k) => z.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const regions = [].concat(hints[key]);
  return {
    regions, region: regions[0], ambiguous: regions.length > 1,
    allocation: (br.allocations || {})[regions[0]] || null,
    zipPrefix: key,
  };
}

/** Baseline allocation kWh/day for a region, as { summer, winter, ... }. */
export function baselineAllocation(t, region) {
  const br = t && t.utility && t.utility.baselineRegions;
  if (br && br.allocations && br.allocations[region]) return br.allocations[region];
  // Fall back to the calibrated household in meta, which every file carries.
  return (t && t.meta && t.meta.baseline_kwh_per_day) || null;
}

/** A plan by id (case-insensitive, tolerant of the "TOU-D-4-9PM" / "TOU-D-4-9" split). */
export function plan(t, id) {
  if (!t || !t.plans) return null;
  if (!id) return defaultPlan(t);
  const want = String(id).toUpperCase();
  return t.plans.find((p) => String(p.id).toUpperCase() === want)
      || t.plans.find((p) => String(p.name || "").toUpperCase() === want)
      || null;
}

/** The utility's default residential plan: `plans[].default === true`, else the first. */
export function defaultPlan(t) {
  if (!t || !t.plans || !t.plans.length) return null;
  return t.plans.find((p) => p.default === true) || t.plans[0];
}

/** Every provider id a plan actually prices, in file order. */
export function providersOf(t, p) {
  const pl = p && p.rates ? p : plan(t, p);
  const ids = Object.keys((t && t.providers) || {});
  if (!pl) return ids;
  const seasons = Object.keys(pl.rates || {});
  if (!seasons.length) return ids;
  const first = pl.rates[seasons[0]];
  const periods = Object.keys(first || {});
  if (!periods.length) return ids;
  const priced = new Set(Object.keys(first[periods[0]] || {}));
  return ids.filter((id) => priced.has(id));
}

/** The provider the utility's customers are on unless they opted out. */
export function defaultProvider(t) {
  const provs = (t && t.providers) || {};
  const marked = Object.keys(provs).find((id) => provs[id] && provs[id].default === true);
  return marked || (t && t.utility && t.utility.id) || Object.keys(provs)[0] || null;
}

/* -------------------------------------------------------------------- lookups */

/** "summer" or "winter" for a plan and a month (1-12). */
export function seasonOf(p, month) {
  const months = (p && p.summer_months) || [];
  return months.indexOf(+month) >= 0 ? "summer" : "winter";
}

/**
 * Which TOU period a plan is in at a given local date and hour.
 * Returns { season, dayType: "weekday"|"weekend", period, holiday, month, hour }.
 * Holidays bill the weekend schedule, so dayType is "weekend" on them and
 * `holiday` is true.
 */
export function periodAt(p, date, hour) {
  if (!p || !p.schedule) throw new Error("tariff: periodAt needs a plan with a schedule");
  const t = partsOf(date, hour);
  const holiday = holidaySet(t.y).has(t.y + "-" + t.m + "-" + t.d);
  const weekend = holiday || t.dow === 0 || t.dow === 6;
  const season = seasonOf(p, t.m);
  const dayType = weekend ? "weekend" : "weekday";
  const bySeason = p.schedule[season];
  if (!bySeason) throw new Error("tariff: plan " + p.id + " has no " + season + " schedule");
  const row = bySeason[dayType] || bySeason.weekday;
  let period = row[t.hour];
  if (!period) throw new Error("tariff: plan " + p.id + " " + season + "/" + dayType + " hour " + t.hour + " has no period");

  /* Month-scoped overrides.  The summer/winter split cannot express a window that
     covers only part of a season - SDG&E's March/April weekday 10am-2pm
     super-off-peak is the live example - so a plan may carry a short override list
     that is applied after the base lookup.  Last match wins. */
  let overridden = false;
  for (const ov of (p.schedule_overrides || [])) {
    if (ov.months && ov.months.indexOf(t.m) < 0) continue;
    if (ov.daytype && ov.daytype !== dayType) continue;
    if (ov.hours && ov.hours.indexOf(t.hour) < 0) continue;
    period = ov.period;
    overridden = true;
  }

  return { season, dayType, period, holiday, overridden, month: t.m, hour: t.hour, dow: t.dow };
}

/**
 * Total $/kWh a `providerId` customer pays on `p` at this local date and hour.
 * `p` may be a plan object or a plan id.
 */
export function rateAt(t, p, providerId, date, hour) {
  const pl = p && p.rates ? p : plan(t, p);
  if (!pl) throw new Error("tariff: no such plan " + p);
  const at = periodAt(pl, date, hour);
  const cell = pl.rates[at.season] && pl.rates[at.season][at.period];
  if (!cell) throw new Error("tariff: " + pl.id + " has no rates for " + at.season + "/" + at.period);
  const pid = providerId || defaultProvider(t);
  const v = cell[pid];
  if (typeof v !== "number") {
    throw new Error("tariff: " + pl.id + " " + at.season + "/" + at.period + " has no rate for provider " + pid);
  }
  return v;
}

/** The same lookup, but returning the period context alongside the price. */
export function rateDetailAt(t, p, providerId, date, hour) {
  const pl = p && p.rates ? p : plan(t, p);
  const at = periodAt(pl, date, hour);
  return Object.assign({}, at, {
    planId: pl.id,
    providerId: providerId || defaultProvider(t),
    rate: rateAt(t, pl, providerId, date, hour),
    baselineCreditPerKwh: pl.baseline_credit_per_kwh || 0,
  });
}

/** The ACC Plus adder, $/kWh, paid on top of the export matrix for this vintage. */
export function accPlusAdder(t) {
  const n = (t && t.nbt) || {};
  if (typeof n.acc_plus_adder_per_kwh === "number") return n.acc_plus_adder_per_kwh;
  const id = t && t.utility && t.utility.id;
  return (id && ACC_PLUS_FALLBACK[id]) || 0;
}

/**
 * NBT export credit, $/kWh, at a local date and hour.
 * By default this is the raw matrix value (generation + delivery components, what
 * the ACC pays).  Pass { includeAdder: true } to add the vintage's ACC Plus adder,
 * which the matrices deliberately exclude.
 */
export function exportRateAt(t, date, hour, opts) {
  const n = (t && t.nbt) || {};
  const m = n.export_rates;
  if (!m) throw new Error("tariff: " + (t && t.utility && t.utility.id) + " has no nbt.export_rates");
  const p = partsOf(date, hour);
  const weekend = p.dow === 0 || p.dow === 6 || holidaySet(p.y).has(p.y + "-" + p.m + "-" + p.d);
  const table = weekend ? (m.weekend || m.weekday) : m.weekday;
  const row = table[p.m - 1];
  if (!row) throw new Error("tariff: export matrix has no month " + p.m);
  const v = row[p.hour];
  if (typeof v !== "number") throw new Error("tariff: export matrix month " + p.m + " hour " + p.hour + " is not a number");
  return (opts && opts.includeAdder) ? v + accPlusAdder(t) : v;
}

/** The whole export matrix for a day type, for charts. */
export function exportMatrix(t, dayType) {
  const m = (t && t.nbt && t.nbt.export_rates) || {};
  return (dayType === "weekend" ? m.weekend : m.weekday) || null;
}

/**
 * Unavoidable fixed charge, $/day.  This is the CPUC income-graduated fixed charge
 * (D.24-05-028) as each utility implemented it.  Solar exports do not offset it, so
 * it floors the bill.
 */
export function fixedChargePerDay(t, p) {
  const pl = p && p.rates ? p : plan(t, p);
  if (pl && typeof pl.fixed_charge_per_day === "number") return pl.fixed_charge_per_day;
  const d = defaultPlan(t);
  return (d && d.fixed_charge_per_day) || 0;
}

/** Minimum charge $/day, or 0 where the fixed charge replaced it. */
export function minimumChargePerDay(t, p) {
  const pl = p && p.rates ? p : plan(t, p);
  return (pl && pl.minimum_charge_per_day) || 0;
}

/**
 * California Climate Credit: { amount, months: [1-12], annual }.
 * `amount` is per appearance, not per year - most utilities now split it over two
 * bills, so the annual total is amount x months.length.
 */
export function climateCredit(t) {
  const c = (t && t.meta && t.meta.climate_credit) || null;
  if (!c) return { amount: 0, months: [], annual: 0 };
  const months = (c.months || []).slice();
  return { amount: c.amount || 0, months, annual: (c.amount || 0) * months.length };
}

/** Net surplus compensation, $/kWh, paid for energy left over at the annual true-up. */
export function netSurplusRate(t) {
  return (t && t.nbt && t.nbt.net_surplus_compensation_per_kwh) || 0;
}

/** Non-bypassable charges, $/kWh of IMPORT. Already inside the rate tables. */
export function nonBypassablePerKwh(t) {
  return (t && t.nbt && t.nbt.nonbypassable_charges_per_kwh) || 0;
}

/* ------------------------------------------------------------------ validation */

function isFinitePositive(v) { return typeof v === "number" && isFinite(v) && v > 0; }
function isFiniteNonNeg(v) { return typeof v === "number" && isFinite(v) && v >= 0; }

/**
 * Structural + sanity check on one utility file.
 *
 * Errors are things that would make a lookup throw or produce a wrong bill.
 * Warnings are things a human should look at (missing confidence labels, rates far
 * outside the plausible California residential band, no sources).
 */
export function validate(t) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!t || typeof t !== "object") return { ok: false, errors: ["not an object"], warnings: [] };

  /* ---- utility block ---- */
  const u = t.utility;
  if (!u) E("missing top-level `utility` block");
  else {
    if (!u.id) E("utility.id missing");
    if (!u.name) E("utility.name missing");
    if (!Array.isArray(u.states) || !u.states.length) E("utility.states must be a non-empty array");
    if (!Array.isArray(u.zipPrefixes) || !u.zipPrefixes.length) E("utility.zipPrefixes must be a non-empty array");
    else if (u.zipPrefixes.some((z) => !/^\d{3}(\d{2})?$/.test(String(z)))) E("utility.zipPrefixes must be 3- or 5-digit strings");
    if (!u.website) W("utility.website missing");
    if (u.baselineRegions) {
      const br = u.baselineRegions;
      if (!br.allocations || !Object.keys(br.allocations).length) W("utility.baselineRegions has no allocations");
      else {
        for (const r of Object.keys(br.allocations)) {
          const a = br.allocations[r];
          if (!isFinitePositive(a.summer) || !isFinitePositive(a.winter)) {
            E("baselineRegions.allocations." + r + " needs positive summer and winter kWh/day");
          }
        }
      }
      if (br.zipHints) {
        for (const k of Object.keys(br.zipHints)) {
          if (!/^\d{3,5}$/.test(k)) E("baselineRegions.zipHints key " + k + " is not a ZIP prefix");
          const regions = [].concat(br.zipHints[k]).map(String);
          const known = Object.keys(br.allocations || {});
          const bad = regions.filter((r) => known.indexOf(r) < 0);
          if (bad.length) E("baselineRegions.zipHints." + k + " names unknown region(s) " + bad.join(","));
        }
      }
    } else W("no utility.baselineRegions - ZIP -> baseline region lookup unavailable");
  }

  /* ---- meta ---- */
  const meta = t.meta || {};
  if (!meta.rates_effective) E("meta.rates_effective missing");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.rates_effective)) E("meta.rates_effective must be YYYY-MM-DD");
  if (!Array.isArray(meta.sources) || !meta.sources.length) E("meta.sources[] missing or empty");
  else {
    meta.sources.forEach((s, i) => {
      if (!s || !s.url) E("meta.sources[" + i + "] has no url");
      if (!s || !s.used_for) W("meta.sources[" + i + "] has no used_for");
    });
  }
  if (!meta.confidence) W("meta.confidence missing (per-section high/medium/low)");
  else {
    for (const k of Object.keys(meta.confidence)) {
      const v = meta.confidence[k];
      const lvl = typeof v === "string" ? v : (v && v.level);
      if (["high", "medium", "low"].indexOf(lvl) < 0) {
        E("meta.confidence." + k + " must be high|medium|low (got " + JSON.stringify(v) + ")");
      }
    }
  }
  const cc = meta.climate_credit;
  if (cc) {
    if (!isFiniteNonNeg(cc.amount)) E("meta.climate_credit.amount must be a non-negative number");
    if (!Array.isArray(cc.months) || cc.months.some((m) => !(m >= 1 && m <= 12))) {
      E("meta.climate_credit.months must be month numbers 1-12");
    }
  } else W("no meta.climate_credit");

  /* ---- providers ---- */
  const provs = t.providers || {};
  const providerIds = Object.keys(provs);
  if (!providerIds.length) E("providers{} is empty");
  providerIds.forEach((id) => { if (!provs[id] || !provs[id].name) E("providers." + id + ".name missing"); });

  /* ---- plans ---- */
  const plans = t.plans || [];
  if (!plans.length) E("plans[] is empty");
  const defaults = plans.filter((p) => p.default === true);
  if (defaults.length === 0) E("no plan is marked `default: true`");
  if (defaults.length > 1) E("more than one plan marked default: " + defaults.map((p) => p.id).join(", "));

  const seen = new Set();
  plans.forEach((p, pi) => {
    const tag = "plans[" + pi + "]" + (p.id ? " (" + p.id + ")" : "");
    if (!p.id) E(tag + " has no id");
    else if (seen.has(p.id)) E("duplicate plan id " + p.id);
    else seen.add(p.id);
    if (!p.name) W(tag + " has no name");

    if (!Array.isArray(p.summer_months) || !p.summer_months.length) E(tag + " summer_months must be a non-empty array");
    else if (p.summer_months.some((m) => !(m >= 1 && m <= 12))) E(tag + " summer_months must be 1-12");

    if (!isFiniteNonNeg(p.fixed_charge_per_day)) E(tag + " fixed_charge_per_day must be a number >= 0");
    if (!isFiniteNonNeg(p.minimum_charge_per_day)) E(tag + " minimum_charge_per_day must be a number >= 0");
    if (!isFiniteNonNeg(p.baseline_credit_per_kwh)) E(tag + " baseline_credit_per_kwh must be a number >= 0");

    /* schedules: 24 entries, every emitted id known and priced */
    const emitted = {};
    const seasons = ["summer", "winter"];
    seasons.forEach((season) => {
      const bySeason = p.schedule && p.schedule[season];
      if (!bySeason) { E(tag + " has no " + season + " schedule"); return; }
      ["weekday", "weekend"].forEach((dt) => {
        const row = bySeason[dt];
        if (!Array.isArray(row)) { E(tag + " " + season + "." + dt + " missing"); return; }
        if (row.length !== 24) { E(tag + " " + season + "." + dt + " has " + row.length + " entries, need 24"); return; }
        row.forEach((pid, h) => {
          if (typeof pid !== "string" || !pid) { E(tag + " " + season + "." + dt + "[" + h + "] is not a period id"); return; }
          if (Array.isArray(p.period_ids) && p.period_ids.indexOf(pid) < 0) {
            E(tag + " " + season + "." + dt + "[" + h + "] emits '" + pid + "' which is not in period_ids");
          }
          (emitted[season] || (emitted[season] = new Set())).add(pid);
        });
      });
    });

    (p.schedule_overrides || []).forEach((ov, oi) => {
      const otag = tag + " schedule_overrides[" + oi + "]";
      if (!ov || typeof ov !== "object") { E(otag + " is not an object"); return; }
      if (!ov.period || (Array.isArray(p.period_ids) && p.period_ids.indexOf(ov.period) < 0)) {
        E(otag + " emits '" + ov.period + "' which is not in period_ids");
      }
      if (ov.months && (!Array.isArray(ov.months) || ov.months.some((m) => !(m >= 1 && m <= 12)))) {
        E(otag + ".months must be month numbers 1-12");
      }
      if (ov.hours && (!Array.isArray(ov.hours) || ov.hours.some((h) => !(h >= 0 && h <= 23)))) {
        E(otag + ".hours must be hours 0-23");
      }
      if (ov.daytype && ["weekday", "weekend"].indexOf(ov.daytype) < 0) {
        E(otag + ".daytype must be weekday or weekend");
      }
      if (!ov.note) W(otag + " has no note explaining why it exists");
      /* an override may move an hour into a season where that period is only
         priced as filler; make sure the destination cell is real */
      (ov.months || []).forEach((mo) => {
        const season = seasonOf(p, mo);
        const cell = p.rates && p.rates[season] && p.rates[season][ov.period];
        if (!cell) E(otag + " targets " + season + "/" + ov.period + " which has no rates");
        else (emitted[season] || (emitted[season] = new Set())).add(ov.period);
      });
    });

    /* rates: every emitted period priced for every provider; every declared
       period id present too, so the documented filler cells cannot go missing */
    seasons.forEach((season) => {
      const bySeason = p.rates && p.rates[season];
      if (!bySeason) { E(tag + " has no " + season + " rates"); return; }
      const need = new Set(Array.isArray(p.period_ids) ? p.period_ids : []);
      (emitted[season] || new Set()).forEach((x) => need.add(x));
      need.forEach((pid) => {
        const cell = bySeason[pid];
        if (!cell) { E(tag + " rates." + season + "." + pid + " missing"); return; }
        providerIds.forEach((prov) => {
          const v = cell[prov];
          if (typeof v !== "number" || !isFinite(v)) {
            E(tag + " rates." + season + "." + pid + "." + prov + " is not a number");
          } else if (v <= 0) {
            E(tag + " rates." + season + "." + pid + "." + prov + " must be > 0 (got " + v + ")");
          } else if (v < 0.03 || v > 2.0) {
            W(tag + " rates." + season + "." + pid + "." + prov + " = $" + v + "/kWh is outside the plausible band $0.03-$2.00");
          }
        });
      });
      /* a period priced but never emitted is fine (documented filler); a period
         emitted but never priced is fatal and is caught above */
    });
  });

  /* ---- nbt ---- */
  const n = t.nbt;
  if (!n) E("missing `nbt` block");
  else {
    if (!n.vintage) W("nbt.vintage missing");
    const er = n.export_rates || {};
    ["weekday", "weekend"].forEach((dt) => {
      const m = er[dt];
      if (!Array.isArray(m)) { E("nbt.export_rates." + dt + " missing"); return; }
      if (m.length !== 12) { E("nbt.export_rates." + dt + " has " + m.length + " months, need 12"); return; }
      m.forEach((row, mi) => {
        if (!Array.isArray(row) || row.length !== 24) {
          E("nbt.export_rates." + dt + "[" + mi + "] has " + (row && row.length) + " hours, need 24");
          return;
        }
        row.forEach((v, h) => {
          if (typeof v !== "number" || !isFinite(v)) E("nbt.export_rates." + dt + "[" + mi + "][" + h + "] is not a number");
          else if (v < 0) E("nbt.export_rates." + dt + "[" + mi + "][" + h + "] is negative");
          else if (v > 3) W("nbt.export_rates." + dt + "[" + mi + "][" + h + "] = $" + v + "/kWh looks implausibly high");
        });
      });
    });
    if (!isFiniteNonNeg(n.net_surplus_compensation_per_kwh)) E("nbt.net_surplus_compensation_per_kwh must be a number >= 0");
    if (!isFiniteNonNeg(n.nonbypassable_charges_per_kwh)) E("nbt.nonbypassable_charges_per_kwh must be a number >= 0");
    if (typeof n.acc_plus_adder_per_kwh !== "number") {
      W("nbt.acc_plus_adder_per_kwh missing - falling back to the value hard-coded in core/tariff.js");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* -------------------------------------------------------------------- fromBill */

function deepClone(o) {
  return typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}

/**
 * Build a one-plan Tariff from what a user can read off their own bill.
 *
 * Everything the user does not supply is inherited from the library plan they
 * picked, so the schedule, the seasons, the export matrix and the NBT mechanics
 * stay real; only the prices they typed are substituted.  The result is a complete
 * Tariff object - engine.js cannot tell it apart from a shipped one except by
 * meta.custom.
 *
 * spec = {
 *   utilityId, planId, providerId,
 *   periods: { summer: { on: 0.58, mid: 0.46, off: 0.34 }, winter: {...} },
 *   fixedPerDay, minimumPerDay, baselineCreditPerKwh,
 *   climateCredit: { amount, months },
 *   label
 * }
 *
 * Periods the user omits keep the library value, scaled by nothing - they are left
 * exactly as shipped, and listed in meta.custom_fields.inherited so the UI can say so.
 */
export function fromBill(spec, lib) {
  if (!spec) throw new Error("tariff: fromBill needs a spec");
  const utils = (lib && lib.utilities) || lib || {};
  const src = utils[spec.utilityId];
  if (!src) throw new Error("tariff: fromBill - unknown utility " + spec.utilityId);
  const basePlan = plan(src, spec.planId);
  if (!basePlan) throw new Error("tariff: fromBill - unknown plan " + spec.planId + " for " + spec.utilityId);

  const providerId = spec.providerId || defaultProvider(src);
  const t = deepClone(src);
  const p = deepClone(basePlan);
  p.default = true;

  const substituted = [], inherited = [];
  const periods = spec.periods || {};
  for (const season of Object.keys(p.rates || {})) {
    for (const pid of Object.keys(p.rates[season])) {
      const given = periods[season] && periods[season][pid];
      const cell = p.rates[season][pid];
      if (typeof given === "number" && isFinite(given) && given > 0) {
        // Keep every provider column in step so a later provider switch still works:
        // shift each other provider by the same delta the user implied for theirs.
        const was = cell[providerId];
        const delta = typeof was === "number" ? given - was : 0;
        for (const prov of Object.keys(cell)) {
          if (typeof cell[prov] !== "number") continue;
          cell[prov] = prov === providerId ? given : Math.max(0.0001, +(cell[prov] + delta).toFixed(6));
        }
        substituted.push(season + "." + pid);
      } else {
        inherited.push(season + "." + pid);
      }
    }
  }

  if (typeof spec.fixedPerDay === "number" && isFinite(spec.fixedPerDay) && spec.fixedPerDay >= 0) {
    p.fixed_charge_per_day = spec.fixedPerDay;
  }
  if (typeof spec.minimumPerDay === "number" && isFinite(spec.minimumPerDay) && spec.minimumPerDay >= 0) {
    p.minimum_charge_per_day = spec.minimumPerDay;
  }
  if (typeof spec.baselineCreditPerKwh === "number" && isFinite(spec.baselineCreditPerKwh) && spec.baselineCreditPerKwh >= 0) {
    p.baseline_credit_per_kwh = spec.baselineCreditPerKwh;
  }

  t.plans = [p];
  if (spec.climateCredit && typeof spec.climateCredit.amount === "number") {
    t.meta.climate_credit = {
      amount: spec.climateCredit.amount,
      months: (spec.climateCredit.months || (t.meta.climate_credit && t.meta.climate_credit.months) || []).slice(),
    };
  }
  t.meta.custom = true;
  t.meta.as_of = new Date().toISOString().slice(0, 10);
  t.meta.custom_fields = {
    label: spec.label || ("My " + (src.utility ? src.utility.name : spec.utilityId) + " bill"),
    derived_from: { utilityId: spec.utilityId, planId: basePlan.id, providerId },
    substituted, inherited,
  };
  t.meta.notes = "CUSTOM TARIFF built from the user's own bill on " + t.meta.as_of +
    ". Cloned from " + spec.utilityId + " / " + basePlan.id + " / " + providerId +
    "; the periods listed in meta.custom_fields.substituted carry the user's own $/kWh, " +
    "everything else (TOU schedule, seasons, export matrix, NBT mechanics) is the shipped tariff. " +
    "Original file notes follow. --- " + (src.meta && src.meta.notes ? src.meta.notes : "");
  return t;
}

/* -------------------------------------------------------------------- describe */

function fmtMoney(v, dp) { return "$" + (+v).toFixed(dp === undefined ? 2 : dp); }
function fmtCents(v) { return (v * 100).toFixed(1) + "¢"; }

/** "4-9 p.m." from a run of hours. */
function hourLabel(h) {
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + " " + suffix;
}
function runsOf(row, pid) {
  const runs = [];
  let start = -1;
  for (let h = 0; h < 24; h++) {
    if (row[h] === pid && start < 0) start = h;
    if (row[h] !== pid && start >= 0) { runs.push([start, h]); start = -1; }
  }
  if (start >= 0) runs.push([start, 24]);
  // midnight wrap: merge a run ending at 24 with one starting at 0
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === 24) {
    const last = runs.pop();
    runs[0] = [last[0], runs[0][1] + 24];
  }
  return runs;
}
function windowText(row, pid) {
  return runsOf(row, pid)
    .map(([a, b]) => hourLabel(a % 24) + "–" + hourLabel(b % 24))
    .join(" and ");
}

/**
 * Plain-language summary of a plan, for the Assumptions / Bills tabs.
 * Returns { title, lines[], seasons{}, table[], text } - `text` is everything
 * joined, `lines`/`table` let the UI lay it out itself.
 */
export function describe(t, p, providerId) {
  const pl = (p && p.rates) ? p : plan(t, p);
  if (!pl) throw new Error("tariff: describe needs a plan");
  const prov = providerId || defaultProvider(t);
  const provName = (t.providers && t.providers[prov] && t.providers[prov].name) || prov;
  const uName = (t.utility && t.utility.name) || (t.meta && t.meta.utility) || "your utility";

  const summerMonths = (pl.summer_months || []).slice().sort((a, b) => a - b);
  const seasonText = summerMonths.length
    ? "Summer runs " + MONTH_NAMES[summerMonths[0] - 1] + "–" +
      MONTH_NAMES[summerMonths[summerMonths.length - 1] - 1] + "; winter is the rest of the year."
    : "This plan does not vary by season.";

  const lines = [];
  lines.push(uName + ", plan " + (pl.name || pl.id) + ", generation from " + provName + ".");
  if (pl.eligibility_note) lines.push(pl.eligibility_note);
  lines.push(seasonText);

  const table = [];
  const seasons = ["summer", "winter"];
  for (const season of seasons) {
    const sched = pl.schedule && pl.schedule[season];
    if (!sched) continue;
    const emitted = new Set([].concat(sched.weekday || [], sched.weekend || []));
    for (const pid of (pl.period_ids || [])) {
      if (!emitted.has(pid)) continue;                       // skip documented filler
      const rate = pl.rates[season] && pl.rates[season][pid] && pl.rates[season][pid][prov];
      const wd = (sched.weekday || []).indexOf(pid) >= 0 ? windowText(sched.weekday, pid) : null;
      const we = (sched.weekend || []).indexOf(pid) >= 0 ? windowText(sched.weekend, pid) : null;
      table.push({
        season, period: pid, label: PERIOD_LABELS[pid] || pid,
        weekday: wd, weekend: we, rate,
        text: season + " " + (PERIOD_LABELS[pid] || pid) + ": " + (typeof rate === "number" ? fmtCents(rate) + "/kWh" : "n/a") +
          (wd ? ", weekdays " + wd : "") + (we ? (wd ? "; weekends/holidays " + we : ", weekends/holidays " + we) : ""),
      });
    }
  }

  const fixed = fixedChargePerDay(t, pl);
  if (fixed > 0) {
    lines.push("A fixed charge of " + fmtMoney(fixed, 2) + "/day (about " +
      fmtMoney(fixed * 30.4, 2) + "/month) applies whatever you use. Solar exports do not offset it.");
  }
  const minimum = minimumChargePerDay(t, pl);
  if (minimum > 0) lines.push("Minimum charge " + fmtMoney(minimum, 2) + "/day.");
  if (pl.baseline_credit_per_kwh > 0) {
    lines.push("Usage up to the baseline allocation earns a credit of " +
      fmtCents(pl.baseline_credit_per_kwh) + "/kWh.");
  }
  const cred = climateCredit(t);
  if (cred.annual > 0) {
    lines.push("California Climate Credit: " + fmtMoney(cred.amount, 0) + " on your " +
      cred.months.map((m) => MONTH_NAMES[m - 1]).join(" and ") + " bill" +
      (cred.months.length > 1 ? "s" : "") + " (" + fmtMoney(cred.annual, 0) + "/year).");
  }
  lines.push("Holidays are billed on the weekend schedule (New Year's Day, Presidents' Day, " +
    "Memorial Day, Independence Day, Labor Day, Veterans Day, Thanksgiving, Christmas).");

  const n = t.nbt || {};
  if (n.export_rates) {
    const adder = accPlusAdder(t);
    lines.push("Exports are credited under the Net Billing Tariff at hourly avoided-cost prices" +
      (n.vintage ? " (" + n.vintage + " vintage" + (n.lock_in_years ? ", locked " + n.lock_in_years + " years" : "") + ")" : "") +
      (adder > 0 ? ", plus an ACC Plus adder of " + fmtCents(adder) + "/kWh" : "") +
      ". Midday export is worth a small fraction of the retail import price, which is why " +
      "self-consumption and evening battery discharge carry most of the value.");
  }
  if (t.meta && t.meta.rates_effective) {
    lines.push("Rates effective " + t.meta.rates_effective +
      (t.meta.as_of ? ", recorded " + t.meta.as_of : "") + ".");
  }
  if (t.meta && t.meta.custom) lines.push("These rates came from your own bill, not the shipped tariff library.");

  return {
    title: uName + " — " + (pl.name || pl.id),
    planId: pl.id, providerId: prov, providerName: provName,
    lines, table,
    text: lines.concat(table.map((r) => "• " + r.text)).join("\n"),
  };
}

/* --------------------------------------------------------------------- default */

const Tariff = {
  UTILITY_IDS,
  loadLibrary,
  utilityForZip, baselineRegionForZip, baselineAllocation,
  plan, defaultPlan, providersOf, defaultProvider,
  seasonOf, periodAt, rateAt, rateDetailAt,
  exportRateAt, exportMatrix, accPlusAdder,
  fixedChargePerDay, minimumChargePerDay, climateCredit,
  netSurplusRate, nonBypassablePerKwh,
  validate, fromBill, describe,
  holidaysForYear, isWeekendOrHoliday, partsOf,
};
export default Tariff;
