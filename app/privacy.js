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
  + "Here is every network request the page can make, and what is in it.";

/**
 * Each entry: who is called, what is sent, when, and whether it is avoidable.
 * `avoidable` entries get a way out in the UI, named in `escape`.
 */
export const CALLS = [
  {
    who: "Open-Meteo",
    what: "Your rounded latitude and longitude, to fetch eleven years of hourly sunlight for that spot.",
    when: "Once per roof location. The answer is cached in this browser, so moving a slider never calls again.",
    avoidable: false,
  },
  {
    who: "Esri",
    what: "Map tile coordinates, if you open the map to trace your roof or pick a location.",
    when: "Only while a map is on screen. Tiles are images; nothing of yours goes with the request.",
    avoidable: true,
    escape: "Skip the map and type a ZIP code, or enter tilt and azimuth by hand on the Roof tab.",
  },
  {
    who: "OpenStreetMap",
    what: "The address you type, sent to their Nominatim geocoder to turn it into coordinates.",
    when: "Only when you type an address and press Find. This is the one request that contains something you wrote.",
    avoidable: true,
    escape: "Click your roof on the map or enter a ZIP code instead — neither sends an address anywhere.",
  },
  {
    who: "cdnjs",
    what: "The charting library and the map library, plus the two IBM Plex fonts from Google Fonts.",
    when: "On first load, like any script tag. Standard CDN requests, cached by your browser afterwards.",
    avoidable: false,
  },
  {
    who: "Nothing else",
    what: "No analytics, no telemetry, no error reporting, no cookies, no uploads, no accounts.",
    when: "Ever. Your meter file is read with the browser's own FileReader and never crosses the network.",
    none: true,
  },
];

export const STORAGE_NOTE =
  "What stays on this device: your meter readings in IndexedDB, and your settings in localStorage "
  + "and in the page's URL. “Forget my data” erases all three. A street address you type is "
  + "never written to either store.";

/** Replaced at boot by core/geocode.js's own wording when that module exists. */
export let GEOCODE_NOTE =
  "Typing an address sends it to OpenStreetMap's Nominatim geocoder to get coordinates back. "
  + "Click the map or enter a ZIP code instead and nothing you typed is sent anywhere.";

/**
 * INTEGRATION: core/geocode.js may export PRIVACY_NOTE. Until it lands, the
 * string above stands in — same promise, written here instead of there.
 */
export async function adoptGeocodeNote() {
  try {
    const mod = await import("../core/geocode.js");
    const note = mod.PRIVACY_NOTE || (mod.default && mod.default.PRIVACY_NOTE);
    if (typeof note === "string" && note.trim()) {
      GEOCODE_NOTE = note.trim();
      const call = CALLS.find((c) => c.who === "OpenStreetMap");
      if (call) call.what = GEOCODE_NOTE;
    }
  } catch {
    /* module not built yet, or offline: the wording above is already accurate */
  }
  return GEOCODE_NOTE;
}

export default { CLAIM, EXPLANATION, CALLS, STORAGE_NOTE, GEOCODE_NOTE, adoptGeocodeNote };
