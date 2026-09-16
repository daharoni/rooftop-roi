// core/geocode.js — address/ZIP -> coordinates, elevation, and the serving IOU.
//
// Privacy: the ONLY thing that leaves the browser here is the text the user typed (or a
// ZIP code). No load data, no bill data, no identifiers. Every call is optional — the user
// can skip geocoding entirely by clicking their roof on the map. See PRIVACY_NOTE.
//
// Usage policy (Nominatim, https://operations.osmfoundation.org/policies/nominatim/):
//   * at most 1 request per second — enforced below by a serialised queue
//   * a descriptive User-Agent or Referer identifying the application. A browser cannot
//     set User-Agent, so the Referer header the browser sends (the GitHub Pages origin)
//     is what identifies us; from Node we set an explicit User-Agent. See docs/solar-model.md.
//   * results must be attributed: "© OpenStreetMap contributors" — the UI shows this
//     under the address field (ATTRIBUTION below).
//   * no bulk/systematic querying, no heavy use. One lookup per user session is fine.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OPEN_METEO_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

/** Sent as User-Agent where the runtime allows it (Node); browsers send Referer instead. */
export const USER_AGENT =
  "rooftop-roi/1.0 (static solar + battery planner; https://github.com/rooftop-roi)";

export const ATTRIBUTION = "Address search © OpenStreetMap contributors (Nominatim)";

/** Literal, UI-displayable statement of what geocoding sends. */
export const PRIVACY_NOTE =
  "Address lookup sends exactly one thing off your device: the text you type in the " +
  "address box, to OpenStreetMap's Nominatim geocoding service, which sends back " +
  "coordinates. Nothing else is sent — not your electricity data, not your bills, not " +
  "your name, and no identifier of any kind. If you would rather send nothing at all, " +
  "skip the address box and click your roof on the map, or type only a ZIP code (which " +
  "is looked up against Open-Meteo's place list instead). Results are © OpenStreetMap " +
  "contributors.";

/** Typed failure so the UI can tell 'no result' apart from 'no network'. */
export class GeocodeError extends Error {
  constructor(message, { code = "offline", userMessage, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "GeocodeError";
    this.code = code; // "offline" | "http" | "notfound" | "input" | "aborted"
    this.userMessage =
      userMessage ||
      "Couldn't look that address up. Type a ZIP code instead, or click your roof on the map.";
  }
}

// --- 1 request/second queue (Nominatim policy) -----------------------------

let lastCall = 0;
let chain = Promise.resolve();
const MIN_GAP_MS = 1100;

function rateLimited(fn) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

// --- helpers ---------------------------------------------------------------

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

async function getJson(url, { signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new GeocodeError("No fetch implementation available");
  const headers = { Accept: "application/json" };
  // Browsers forbid setting User-Agent; setting it there would make the request fail CORS.
  if (!isBrowser) headers["User-Agent"] = USER_AGENT;
  let res;
  try {
    res = await doFetch(url, { signal, headers });
  } catch (cause) {
    const aborted = cause?.name === "AbortError";
    throw new GeocodeError(`Request failed: ${cause?.message}`, {
      code: aborted ? "aborted" : "offline",
      cause,
      userMessage: aborted
        ? "Address lookup cancelled."
        : "Couldn't reach the address lookup service. Type a ZIP code, or click your roof on the map.",
    });
  }
  if (!res.ok)
    throw new GeocodeError(`HTTP ${res.status}`, {
      code: "http",
      userMessage:
        res.status === 429
          ? "The free address lookup service is rate-limiting us. Wait a few seconds and try again."
          : `Address lookup failed (HTTP ${res.status}). Try a ZIP code instead.`,
    });
  try {
    return await res.json();
  } catch (cause) {
    throw new GeocodeError("Response was not JSON", { code: "http", cause });
  }
}

/** Pull a 5-digit US ZIP out of free text, if there is one. */
export function extractZip(text) {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

const looksLikeBareZip = (q) => /^\s*\d{5}(?:-\d{4})?\s*$/.test(String(q ?? ""));

// --- geocoding -------------------------------------------------------------

/**
 * Address (or ZIP) -> coordinates.
 *
 * Tries Nominatim first; a bare ZIP, or a Nominatim miss/failure, falls back to
 * `zipCentroid`. Never returns a partially-filled result: it resolves with a full record
 * or throws a GeocodeError.
 *
 * @param {string} query
 * @param {{signal?:AbortSignal, fetchImpl?:Function, countryCodes?:string}} [opts]
 * @returns {Promise<{lat:number, lon:number, label:string, zip:string|null,
 *                    source:"nominatim"|"open-meteo", raw?:object}>}
 */
export async function geocode(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q)
    throw new GeocodeError("Empty query", {
      code: "input",
      userMessage: "Type an address or ZIP code first.",
    });

  const typedZip = extractZip(q);
  if (looksLikeBareZip(q)) return zipCentroid(typedZip, opts);

  const url =
    `${NOMINATIM_URL}?` +
    new URLSearchParams({
      format: "jsonv2",
      q,
      countrycodes: opts.countryCodes || "us",
      limit: "1",
      addressdetails: "1",
    });

  let rows;
  try {
    rows = await rateLimited(() => getJson(url, opts));
  } catch (err) {
    if (typedZip) return zipCentroid(typedZip, opts); // graceful degradation
    throw err;
  }
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) {
    if (typedZip) return zipCentroid(typedZip, opts);
    throw new GeocodeError(`No match for "${q}"`, {
      code: "notfound",
      userMessage:
        "No match for that address. Try adding the city and state, use a ZIP code, or " +
        "click your roof on the map.",
    });
  }
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    label: hit.display_name || q,
    zip: hit.address?.postcode ? String(hit.address.postcode).slice(0, 5) : typedZip,
    source: "nominatim",
    raw: hit,
  };
}

/**
 * ZIP code -> approximate centroid, via Open-Meteo's geocoding index. Used as the fallback
 * for `geocode` and as the privacy-preserving path (a ZIP is much coarser than an address).
 */
export async function zipCentroid(zip, opts = {}) {
  const z = extractZip(zip);
  if (!z)
    throw new GeocodeError(`"${zip}" is not a 5-digit ZIP`, {
      code: "input",
      userMessage: "That doesn't look like a 5-digit ZIP code.",
    });
  const url =
    `${OPEN_METEO_GEOCODE_URL}?` +
    new URLSearchParams({ name: z, count: "1", countryCode: "US", language: "en", format: "json" });
  const json = await getJson(url, opts);
  const hit = json?.results?.[0];
  if (!hit)
    throw new GeocodeError(`No centroid for ZIP ${z}`, {
      code: "notfound",
      userMessage: `Couldn't find ZIP ${z}. Click your roof on the map instead.`,
    });
  const place = [hit.name, hit.admin2, hit.admin1].filter(Boolean).join(", ");
  return {
    lat: Number(hit.latitude),
    lon: Number(hit.longitude),
    label: place ? `${z} (${place})` : z,
    zip: z,
    elevationM: Number.isFinite(hit.elevation) ? hit.elevation : null,
    source: "open-meteo",
    raw: hit,
  };
}

/**
 * Ground elevation in metres for a coordinate (Open-Meteo elevation API, 90 m DEM).
 * Returns null rather than throwing if the service is unreachable — elevation only tunes
 * the temperature downscaling, so the model is fine without it.
 */
export async function elevationFor(lat, lon, opts = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const url =
    `${OPEN_METEO_ELEVATION_URL}?` +
    new URLSearchParams({ latitude: String(lat), longitude: String(lon) });
  try {
    const json = await getJson(url, opts);
    const v = json?.elevation?.[0];
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// California investor-owned utility by ZIP prefix
// ---------------------------------------------------------------------------

/**
 * Three-digit ZIP prefixes for the three California IOUs.
 *
 * Sources / method: the CPUC electric service-territory map, each utility's own
 * "service area" pages, and the USPS 3-digit ZIP prefix (SCF) areas. This is a coarse
 * first guess for prefilling the tariff picker, NOT a service-territory determination:
 *
 *   * 3-digit resolution: a handful of prefixes straddle a boundary (922 covers both SCE's
 *     Coachella Valley and Imperial Irrigation District; 934 and 931 straddle SCE/PG&E in
 *     Ventura/Santa Barbara; 926 straddles SCE and SDG&E in south Orange County). The UI
 *     must let the user override the guess.
 *   * Municipal utilities inside these prefixes are NOT IOUs and have their own rates
 *     (LADWP, Glendale, Burbank, Pasadena, Anaheim, Riverside, Azusa, Vernon, Silicon
 *     Valley Power/Santa Clara, Alameda, Palo Alto, Roseville, SMUD, Redding, Lodi,
 *     Modesto ID, Turlock ID, Imperial ID). They map to the IOU here and the user must
 *     correct it.
 *   * Community Choice Aggregators (Clean Power Alliance, MCE, Ava, SVCE, 3CE, CPSF, ...)
 *     share the IOU's delivery territory and are handled by the tariff layer's
 *     `providers` list, not here — the utility id is still the IOU.
 */
export const IOU_ZIP_PREFIXES = {
  sdge: ["919", "920", "921"],
  sce: [
    "900", "901", "902", "903", "904", "905", "906", "907", "908",
    "910", "911", "912", "913", "914", "915", "916", "917", "918",
    "922", "923", "924", "925", "926", "927", "928",
    "930", "931", "934", "935",
  ],
  pge: [
    "932", "933", "936", "937", "938", "939",
    "940", "941", "942", "943", "944", "945", "946", "947", "948", "949",
    "950", "951", "952", "953", "954", "955", "956", "957", "958", "959",
    "960", "961",
  ],
};

const PREFIX_TO_IOU = (() => {
  const m = new Map();
  for (const [id, prefixes] of Object.entries(IOU_ZIP_PREFIXES))
    for (const p of prefixes) m.set(p, id);
  return m;
})();

/** Prefixes where the 3-digit guess is known to be wrong for part of the area. */
export const AMBIGUOUS_ZIP_PREFIXES = {
  "922": "Coachella Valley is SCE; the Imperial Valley is Imperial Irrigation District.",
  "926": "South Orange County (San Clemente, San Juan Capistrano) is SDG&E, not SCE.",
  "931": "Most of Santa Barbara County is PG&E north of Gaviota; SCE serves the south coast.",
  "934": "Ventura County is mostly SCE; a northern sliver is PG&E.",
  "935": "Mostly SCE (Tehachapi, Ridgecrest); a few Kern communities are PG&E.",
  "939": "Monterey/Salinas is PG&E; a sliver of south Monterey County is SCE.",
};

/**
 * ZIP (or any text containing one) -> "sce" | "pge" | "sdge" | null.
 * Coarse and advisory — see IOU_ZIP_PREFIXES for the caveats.
 */
export function utilityForZip(zip) {
  const z = extractZip(zip);
  if (!z) return null;
  return PREFIX_TO_IOU.get(z.slice(0, 3)) || null;
}

/** Same as `utilityForZip` but with the caveat text, for the Assumptions tab. */
export function utilityForZipDetailed(zip) {
  const z = extractZip(zip);
  const id = utilityForZip(z);
  return {
    utilityId: id,
    zip: z,
    confident: !!id && !AMBIGUOUS_ZIP_PREFIXES[z?.slice(0, 3)],
    note: (z && AMBIGUOUS_ZIP_PREFIXES[z.slice(0, 3)]) || null,
  };
}

export default {
  ATTRIBUTION,
  AMBIGUOUS_ZIP_PREFIXES,
  GeocodeError,
  IOU_ZIP_PREFIXES,
  PRIVACY_NOTE,
  USER_AGENT,
  elevationFor,
  extractZip,
  geocode,
  utilityForZip,
  utilityForZipDetailed,
  zipCentroid,
};
