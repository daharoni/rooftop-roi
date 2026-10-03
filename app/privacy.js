/* =============================================================================
 * privacy.js — the privacy claim and the exact list of network calls.
 *
 * The claim on the landing page is literally true, and it is only allowed to
 * stay true if this file is the one place any call is described.  If a module
 * ever starts calling something new, it belongs in CALLS below and on the
 * page, or the sentence has to change.
 *
 * `core/geocode.js` owns the wording of the geocoder disclosure (it is the
 * module that makes the call); if it exports PRIVACY_NOTE we show that string
 * verbatim rather than a paraphrase of it.
 * ========================================================================== */

export const CLAIM = "Your data never leaves this browser.";

export const EXPLANATION =
  "Your meter readings are parsed, simulated and charted here, on this device. "
  + "There is no server to upload them to — this page is a folder of static files on GitHub Pages. "
  + "The page does make a few network requests, listed here with exactly what is in each; your meter "
  + "data is never in any of them.";

/**
 * Each entry: who is called (`hosts`, exactly as they appear in a URL), what is
 * sent, when, and whether it is avoidable.  `avoidable` entries get a way out in
 * the UI, named in `escape`.  tests/privacy-hosts.test.mjs greps app/, core/ and
 * index.html for every URL hostname and fails if one is missing here, or if a
 * host listed here is no longer used.
 */
export const CALLS = [
  {
    who: "Google Fonts",
    hosts: ["fonts.googleapis.com", "fonts.gstatic.com"],
    what: "A request for the IBM Plex typefaces. Like any web request it carries your IP address, and the browser tells Google which page asked.",
    when: "On first load; your browser caches the fonts afterwards.",
    avoidable: false,
  },
  {
    who: "cdnjs (Cloudflare)",
    hosts: ["cdnjs.cloudflare.com"],
    what: "The Chart.js charting library, and the Leaflet map library. Nothing of yours is in the request beyond your IP address.",
    when: "Chart.js on first load; Leaflet only when you open the map.",
    avoidable: false,
  },
  {
    who: "OpenStreetMap",
    hosts: ["nominatim.openstreetmap.org"],
    what: "The address you type, sent to their Nominatim geocoder to turn it into coordinates.",
    when: "Only when you type an address and press Find.",
    avoidable: true,
    escape: "Enter a ZIP code instead, or, once your meter file is loaded, set the location on the Roof tab's map.",
  },
  {
    who: "Open-Meteo place search",
    hosts: ["geocoding-api.open-meteo.com"],
    what: "The ZIP code you type, to find its approximate centre.",
    when: "Only when you use the ZIP box (or when an address lookup falls back to its ZIP).",
    avoidable: true,
    escape: "Load your meter file first, then set the location on the Roof tab's map or type coordinates there.",
  },
  {
    who: "Open-Meteo elevation",
    hosts: ["api.open-meteo.com"],
    what: "Your coordinates rounded to 0.05° (about 5 km), to get the ground elevation there.",
    when: "Once each time you set a location.",
    avoidable: false,
  },
  {
    who: "Open-Meteo weather archive",
    hosts: ["archive-api.open-meteo.com"],
    what: "Your coordinates rounded to 0.05° (about 5 km), to fetch eleven years of hourly sunlight and temperature.",
    when: "Once per location: eleven requests, then cached in this browser so moving a slider or editing the roof never calls again.",
    avoidable: false,
  },
  {
    who: "Esri satellite tiles",
    hosts: ["server.arcgisonline.com"],
    what: "Requests for map image tiles. The tile coordinates at the zoom used for tracing reveal roughly which block you are looking at (to about 75 m), along with your IP address.",
    when: "Only while a map is on screen.",
    avoidable: true,
    escape: "Skip the map: type a ZIP code, and enter tilt and direction by hand on the Roof tab.",
  },
  {
    who: "Nothing else",
    hosts: [],
    what: "No analytics, no telemetry, no error reporting, no cookies, no uploads, no accounts.",
    when: "Your meter file is read by the browser itself and never crosses the network.",
    none: true,
  },
];

/**
 * URLs that appear in the code but are never requested: an XML namespace, a
 * plain link the visitor may click, and the User-Agent text Node sends in tests.
 */
export const NOT_REQUESTS = {
  "www.w3.org": "the SVG namespace identifier, not a request",
  "github.com": "the 'Source on GitHub' link and the geocoder's User-Agent string; never fetched",
};

/** Every host the page can contact, for tests and for a future CSP connect-src. */
export const HOSTS = CALLS.flatMap((c) => c.hosts || []);

export const STORAGE_NOTE =
  "What stays on this device: your meter readings and the downloaded weather in IndexedDB, and "
  + "your settings in localStorage and in the page's URL. localStorage also keeps the roof outline "
  + "you traced and your location at full precision (share links round it to about 1 km). "
  + "“Forget my data” erases all of it. A street address you type is never written to either store.";

/** Replaced at boot by core/geocode.js's own wording when that module exists. */
export let GEOCODE_NOTE =
  "Typing an address sends it to OpenStreetMap's Nominatim geocoder to get coordinates back. "
  + "A ZIP code goes to Open-Meteo's place search instead. To send neither, load your meter file "
  + "first and set the location on the Roof tab, by clicking the map (which loads Esri satellite "
  + "tiles) or typing coordinates.";

/**
 * INTEGRATION: core/geocode.js may export PRIVACY_NOTE. Until it lands, the
 * string above stands in — same promise, written here instead of there.
 */
export async function adoptGeocodeNote() {
  try {
    const mod = await import("../core/geocode.js");
    const note = mod.PRIVACY_NOTE || (mod.default && mod.default.PRIVACY_NOTE);
    if (typeof note === "string" && note.trim()) {
      // The note under the address box; the CALLS entry keeps its own short wording.
      GEOCODE_NOTE = note.trim();
    }
  } catch {
    /* module not built yet, or offline: the wording above is already accurate */
  }
  return GEOCODE_NOTE;
}

export default { CLAIM, EXPLANATION, CALLS, HOSTS, NOT_REQUESTS, STORAGE_NOTE, GEOCODE_NOTE, adoptGeocodeNote };
