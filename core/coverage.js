/* =============================================================================
 * core/coverage.js — is this ZIP somewhere the tool's model applies?
 *
 * The tool models the California Net Billing Tariff (NBT) of the three large
 * investor-owned utilities (SCE, PG&E, SDG&E). Publicly owned utilities (city
 * departments, irrigation and municipal utility districts, cooperatives) and the
 * small investor-owned utilities (Bear Valley, Liberty, PacifiCorp) are NOT on
 * NBT and have their own net-metering rules, so running the model there gives an
 * answer that is wrong in kind. This module says which case a ZIP is in:
 *
 *   coverageForZip(zip, lib, { city }) ->
 *     { kind: "iou", utilityId, ambiguous, candidates }     modelled; when the ZIP's
 *                                                            prefix belongs to two IOUs
 *                                                            (926, 931, 932, 935, 936)
 *                                                            ambiguous is true, utilityId
 *                                                            is null and the UI must ASK
 *                                                            among candidates
 *     { kind: "muni", name, owner, shared, iouHint? }       not modelled (block)
 *     { kind: "outside" }                                    not California
 *     { kind: "unknown" }                                    a CA ZIP nobody claims
 *
 * `shared: true` means the ZIP (or a city-name match) is split between the
 * public utility and an IOU, so the UI must ask rather than decide; `false`
 * means the ZIP is served (essentially) entirely by that utility.
 *
 * Sources and method. ZIP lists were compiled from each utility's own description
 * of its service area and from USPS ZIP-to-city assignments checked against
 * city limits, NOT from a service-territory GIS overlay, so they are a good-faith
 * screen rather than a determination. A ZIP was put in `zips` only where the
 * city or district covers essentially all of it; anywhere a ZIP straddles a
 * boundary (unincorporated pockets, neighbouring IOU cities) it went in `shared`.
 *   - CEC, "California Electric Utility Service Areas" map:
 *     https://cecgis-caenergy.opendata.arcgis.com/datasets/CAEnergy::electric-load-serving-entities-iou-pou
 *   - California Municipal Utilities Association member list: https://www.cmua.org/members
 *   - SMUD 2024 annual report fact sheet (Sacramento County plus slices of Placer
 *     and Yolo): https://www.smud.org/-/media/About-Us/Newsletters/Reports-and-Statements/2024-Annual-Report/AnnualReport_FactSheet.ashx
 *   - LADWP serves the City of Los Angeles; IID serves Imperial County and the
 *     eastern Coachella Valley; MID/TID/Merced ID their irrigation districts.
 * Utilities whose ZIPs could not be pinned down with reasonable confidence carry
 * only `cities`, matched against the geocoder's city (address path) as a
 * shared (ask-the-user) result.
 * ========================================================================== */

/**
 * owner: "public" (POU) or "small-iou" (investor-owned but not on the NBT this
 * tool models). zips: confident; shared: split with an IOU; cities: name match.
 */
export const NON_NBT_UTILITIES = [
  { name: "Los Angeles Department of Water and Power (LADWP)", owner: "public",
    zips: ["90004", "90005", "90006", "90007", "90010", "90012", "90013", "90014", "90015", "90017",
      "90019", "90021", "90026", "90027", "90028", "90029", "90031", "90032", "90033", "90034",
      "90035", "90036", "90037", "90038", "90039", "90041", "90042", "90045", "90049",
      "90057", "90062", "90064", "90065", "90066", "90067", "90068", "90071", "90077", "90089",
      "90094", "90095", "90272", "90293", "90710", "90731", "90744",
      "91040", "91042", "91303", "91306", "91316", "91324", "91325", "91326",
      "91330", "91331", "91335", "91343", "91344", "91345", "91352", "91356", "91364", "91367",
      "91401", "91402", "91403", "91405", "91406", "91411", "91423", "91436",
      "91601", "91602", "91604", "91605", "91606", "91607"],
    shared: ["90001", "90002", "90003", "90008", "90011", "90016", "90018", "90020", "90023",
      "90024", "90025", "90043", "90044", "90046", "90048", "90059", "90061", "90291", "90292",
      "90247", "90248", "90501", "90502", "91304", "91340", "91342",
      // Moved out of `zips` by the 2026-10-03 review: Bell Canyon (91307, SCE), the
      // Chatsworth hills (91311), the Harbor/Rancho Palos Verdes edge (90732) and
      // the unincorporated Westmont strip (90047) all straddle the LADWP line.
      "90047", "90732", "91307", "91311"],
    cities: ["los angeles"] },
  { name: "Pasadena Water and Power", owner: "public",
    zips: ["91101", "91103", "91105", "91106", "91125", "91126"], shared: ["91104", "91107"], cities: ["pasadena"] },
  { name: "Burbank Water and Power", owner: "public",
    zips: ["91501", "91502", "91505", "91506", "91521", "91522", "91523"], shared: ["91504"], cities: ["burbank"] },
  { name: "Glendale Water and Power", owner: "public",
    zips: ["91201", "91202", "91203", "91204", "91205", "91206", "91207", "91208", "91210"],
    shared: ["91020", "91214"], cities: ["glendale"] },
  { name: "Anaheim Public Utilities", owner: "public",
    zips: ["92801", "92805", "92806", "92807", "92808"], shared: ["92802", "92804"], cities: ["anaheim"] },
  { name: "Riverside Public Utilities", owner: "public",
    zips: ["92501", "92505", "92506"], cities: ["riverside"],
    // 92507 reaches into unincorporated Highgrove, which SCE serves.
    shared: ["92503", "92504", "92507", "92508"] },
  { name: "Azusa Light & Water", owner: "public", shared: ["91702"], cities: ["azusa"] },
  { name: "Colton Electric Utility", owner: "public", shared: ["92324"], cities: ["colton"] },
  { name: "Banning Electric Utility", owner: "public", shared: ["92220"], cities: ["banning"] },
  { name: "Vernon Public Utilities", owner: "public", zips: ["90058"], cities: ["vernon"] },
  { name: "Alameda Municipal Power", owner: "public", zips: ["94501", "94502"], cities: ["alameda"] },
  { name: "City of Palo Alto Utilities", owner: "public",
    zips: ["94301", "94306"], shared: ["94303", "94304"], cities: ["palo alto"] },
  { name: "Silicon Valley Power (Santa Clara)", owner: "public",
    zips: ["95050", "95051", "95053", "95054"], cities: ["santa clara"] },
  { name: "Roseville Electric Utility", owner: "public",
    zips: ["95661", "95678"], shared: ["95747"], cities: ["roseville"] },
  { name: "Redding Electric Utility", owner: "public",
    zips: ["96001", "96002"], shared: ["96003"], cities: ["redding"] },
  { name: "Lodi Electric Utility", owner: "public", shared: ["95240", "95242"], cities: ["lodi"] },
  { name: "City of Lompoc Utilities", owner: "public", shared: ["93436"], cities: ["lompoc"] },
  { name: "Modesto Irrigation District (MID)", owner: "public",
    zips: ["95350", "95351", "95354", "95355", "95356", "95357", "95358"],
    shared: ["95361", "95367", "95368", "95386"], cities: ["modesto", "riverbank", "salida", "oakdale"] },
  { name: "Turlock Irrigation District (TID)", owner: "public",
    zips: ["95380", "95382", "95307", "95316", "95326", "95328"], cities: ["turlock", "ceres", "hughson", "denair"] },
  { name: "Merced Irrigation District", owner: "public", shared: ["95340", "95341", "95348"] },
  { name: "Imperial Irrigation District (IID)", owner: "public",
    zips: ["92227", "92231", "92233", "92243", "92249", "92250", "92251", "92257", "92273",
      "92201", "92236", "92254", "92274"],
    shared: ["92203", "92210", "92211", "92253", "92260"],
    cities: ["imperial", "el centro", "brawley", "calexico", "holtville", "calipatria", "indio", "coachella"] },
  { name: "Sacramento Municipal Utility District (SMUD)", owner: "public",
    zips: ["95608", "95610", "95621", "95624", "95626", "95628", "95630", "95632", "95655",
      "95660", "95662", "95670", "95673", "95683", "95693", "95742", "95757", "95758",
      "95811", "95814", "95815", "95816", "95817", "95818", "95819", "95820", "95821", "95822",
      "95823", "95824", "95825", "95826", "95827", "95828", "95829", "95830", "95831", "95832",
      "95833", "95834", "95835", "95838", "95841", "95842", "95843", "95864"],
    shared: ["95641", "95638", "95690"],
    cities: ["sacramento", "elk grove", "citrus heights", "rancho cordova", "folsom", "galt"] },
  { name: "Trinity Public Utilities District", owner: "public",
    zips: ["96093", "96052", "96041", "96024", "96048", "96091"] },
  { name: "Truckee Donner Public Utility District", owner: "public",
    zips: ["96160", "96161", "96162"], cities: ["truckee"] },
  { name: "City of Ukiah Electric Utility", owner: "public", shared: ["95482"], cities: ["ukiah"] },
  { name: "City of Healdsburg Electric", owner: "public", shared: ["95448"], cities: ["healdsburg"] },
  { name: "City of Biggs Electric", owner: "public", shared: ["95917"], cities: ["biggs"] },
  { name: "City of Gridley Electric", owner: "public", shared: ["95948"], cities: ["gridley"] },
  { name: "City of Shasta Lake Electric", owner: "public", zips: ["96019"], cities: ["shasta lake"] },
  { name: "City of Needles Public Utility Authority", owner: "public", zips: ["92363"], cities: ["needles"] },
  { name: "Moreno Valley Utility", owner: "public", shared: ["92551", "92553", "92555", "92557"] },
  { name: "Rancho Cucamonga Municipal Utility", owner: "public", shared: ["91701", "91730", "91737", "91739"] },
  { name: "Pittsburg Power Company (Island Energy)", owner: "public", shared: ["94592"] },
  { name: "Corona Department of Water and Power", owner: "public",
    shared: ["92878", "92879", "92880", "92881", "92882", "92883"] },
  { name: "Cerritos Electric Utility", owner: "public", shared: ["90703"] },
  { name: "Lassen Municipal Utility District", owner: "public",
    zips: ["96130"], shared: ["96114", "96117", "96128"], cities: ["susanville"] },
  { name: "Plumas-Sierra Rural Electric Cooperative", owner: "public",
    zips: ["96122", "96103", "96118", "96105", "96129"], shared: ["96124", "96126", "96113", "96109"],
    cities: ["portola", "loyalton"] },
  { name: "Surprise Valley Electrification", owner: "public", zips: ["96104", "96112", "96115", "96108"] },
  { name: "Anza Electric Cooperative", owner: "public", zips: ["92539"], shared: ["92536"] },

  // Investor-owned, but not one of the three large utilities whose NBT this tool models.
  { name: "Bear Valley Electric Service", owner: "small-iou",
    zips: ["92314", "92315", "92333", "92386"], cities: ["big bear lake", "big bear city"] },
  { name: "Liberty Utilities (Lake Tahoe)", owner: "small-iou",
    zips: ["96150", "96151", "96158", "96140", "96141", "96142", "96143", "96145", "96146", "96148"],
    cities: ["south lake tahoe"] },
  { name: "Pacific Power (PacifiCorp)", owner: "small-iou",
    zips: ["96097", "96067", "96094", "96025", "95531", "96134", "96101"],
    cities: ["yreka", "mount shasta", "weed", "dunsmuir", "crescent city", "alturas"] },
];

const ZIP_INDEX = (() => {
  const m = new Map();
  for (const u of NON_NBT_UTILITIES) {
    for (const z of u.zips || []) m.set(z, { u, shared: false });
    for (const z of u.shared || []) if (!m.has(z)) m.set(z, { u, shared: true });
  }
  return m;
})();

const CITY_INDEX = (() => {
  const m = new Map();
  for (const u of NON_NBT_UTILITIES) for (const c of u.cities || []) m.set(c, u);
  return m;
})();

const normCity = (c) => String(c == null ? "" : c).toLowerCase().replace(/^city of\s+/, "").replace(/\s+/g, " ").trim();

/** True for a 5-digit ZIP in California's USPS range (900xx-961xx). */
export function isCaliforniaZip(z) {
  if (!/^\d{5}$/.test(z)) return false;
  const p = Number(z.slice(0, 3));
  return p >= 900 && p <= 961;
}

/** The IOU the tariff library assigns a ZIP to, or null. */
function iouFor(zip, lib) {
  if (!lib) return null;
  const utils = lib.utilities || lib;
  const p3 = zip.slice(0, 3);
  const hits = [];
  for (const id of Object.keys(utils || {})) {
    const u = utils[id] && utils[id].utility;
    if (!u) continue;
    const list = (u.zipPrefixes || []).map(String);
    if (list.includes(zip)) return { utilityId: id, ambiguous: false, candidates: [id] };
    if (list.includes(p3)) hits.push(id);
  }
  if (!hits.length) return null;
  // Two IOUs share the prefix (92672 San Clemente is SDG&E, 92630 Lake Forest is
  // SCE): there is no default to fall back on, so name nobody and let the UI ask.
  if (hits.length > 1) return { utilityId: null, ambiguous: true, candidates: hits };
  return { utilityId: hits[0], ambiguous: false, candidates: hits };
}

function muni(u, shared, iou) {
  const out = { kind: "muni", name: u.name, owner: u.owner, shared: !!shared };
  if (shared && iou) out.iouHint = iou;
  return out;
}

/**
 * @param zip   5-digit ZIP (or text containing one); may be null when only a city is known
 * @param lib   the tariff library from core/tariff.loadLibrary (for IOU prefixes)
 * @param opts  { city, state } from a geocoder, when there is one
 */
export function coverageForZip(zip, lib, opts = {}) {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(zip == null ? "" : zip));
  const z = m ? m[1] : null;
  const city = normCity(opts.city);
  const state = String(opts.state || "").toLowerCase();

  if (!z) {
    if (state && state !== "california" && state !== "ca") return { kind: "outside" };
    const u = city && CITY_INDEX.get(city);
    return u ? muni(u, true, null) : { kind: "unknown" };
  }
  if (!isCaliforniaZip(z)) return { kind: "outside" };

  const iou = iouFor(z, lib);
  const hit = ZIP_INDEX.get(z);
  if (hit && !hit.shared) return muni(hit.u, false, null);

  // A city name from the geocoder is a weaker signal than a ZIP the utility owns,
  // so it never blocks outright: it asks.
  const byCity = city && CITY_INDEX.get(city);
  if (hit) return muni(hit.u, true, iou);
  if (byCity) return muni(byCity, true, iou);

  if (iou) return Object.assign({ kind: "iou" }, iou);
  return { kind: "unknown" };
}

/** One sentence for the block screen. */
export function coverageMessage(cov) {
  if (!cov) return "";
  if (cov.kind === "outside") return "California only for now: this tool models California's Net Billing Tariff.";
  if (cov.kind === "muni") {
    const what = cov.owner === "small-iou"
      ? `${cov.name} is a small investor-owned utility that is not on the Net Billing Tariff this tool models`
      : `${cov.name} is a publicly owned utility that is not on Net Billing`;
    return `${what}; this tool does not model it yet.`;
  }
  if (cov.kind === "unknown") {
    return "This ZIP is not in any utility list this tool has. Pick your utility below only if your bill "
      + "comes from SCE, PG&E or SDG&E; otherwise the results will be wrong.";
  }
  return "";
}

/** Sentinel answers to a coverage question that are not a modelled utility. */
export const ANSWER_MUNI = "__muni";
export const ANSWER_OTHER = "__other";

/**
 * Turn a coverage answer into what the UI must do, without touching the UI:
 *   { utilityId }                         go on with this modelled utility
 *   { block: message }                    stop, and say why
 *   { ask: { tone, text, options } }      put a question with these options
 *                                         ({ label, value, primary? }) to the
 *                                         person; feed the answer to answerCoverage
 *
 * `prior` is a utility the person already chose for this same location in an
 * earlier session (a reload); it settles a question only when it is one of the
 * answers the question would have offered, so a reload does not re-ask, and a
 * NEW location never silently inherits it (callers pass prior only on reload).
 *
 * @param cov   coverageForZip's answer
 * @param o     { zip, ids: string[], nameOf(id) -> string, prior }
 */
export function coverageDecision(cov, o = {}) {
  const ids = o.ids || [];
  const nameOf = o.nameOf || ((id) => String(id).toUpperCase());
  const prior = o.prior && ids.includes(o.prior) ? o.prior : null;
  const zipText = o.zip ? `ZIP ${o.zip}` : "This area";
  const msg = coverageMessage(cov);
  const other = { label: "Another utility", value: ANSWER_OTHER };
  if (!cov || cov.kind === "outside") return { block: msg || "California only for now." };
  if (cov.kind === "iou") {
    if (!cov.ambiguous) return { utilityId: cov.utilityId };
    const cands = (cov.candidates || []).filter((id) => ids.includes(id));
    if (prior && cands.includes(prior)) return { utilityId: prior };
    return { ask: {
      tone: "warn",
      text: `${zipText} is served by more than one utility (${cands.map(nameOf).join(" or ")}). `
        + "Who sends your electricity bill?",
      options: [...cands.map((id) => ({ label: nameOf(id), value: id })), other],
    } };
  }
  if (cov.kind === "muni" && !cov.shared) return { block: msg };
  if (cov.kind === "muni") {
    const hint = cov.iouHint || null;
    const ious = hint ? (hint.candidates || [hint.utilityId]).filter((id) => id && ids.includes(id)) : ids.slice();
    if (prior && ious.includes(prior)) return { utilityId: prior };
    return { ask: {
      tone: "warn",
      text: `Part of this area is served by ${cov.name}, a publicly owned utility that is not on Net Billing; `
        + "this tool does not model it yet. Who sends your electricity bill?",
      options: [
        { label: cov.name, value: ANSWER_MUNI },
        ...ious.map((id) => ({ label: nameOf(id), value: id, primary: ious.length === 1 })),
      ],
    } };
  }
  // unknown: the person picks explicitly, with a warning.
  if (prior) return { utilityId: prior };
  return { ask: {
    tone: "warn",
    text: msg || "This ZIP is not in any utility list this tool has.",
    options: [...ids.map((id) => ({ label: nameOf(id), value: id })), other],
    handPicked: true,
  } };
}

/**
 * The person's answer to a coverageDecision question:
 *   { utilityId }      a modelled utility they picked
 *   { block: message } they named a utility this tool does not model
 *   { superseded }     the question was replaced before they answered (null)
 */
export function answerCoverage(cov, answer) {
  if (answer === null || answer === undefined) return { superseded: true };
  if (answer === ANSWER_MUNI) return { block: coverageMessage(cov) };
  if (answer === ANSWER_OTHER) return { block: "This tool only models SCE, PG&E and SDG&E under Net Billing for now." };
  return { utilityId: String(answer) };
}

export default {
  NON_NBT_UTILITIES, coverageForZip, coverageMessage, isCaliforniaZip,
  coverageDecision, answerCoverage, ANSWER_MUNI, ANSWER_OTHER,
};
