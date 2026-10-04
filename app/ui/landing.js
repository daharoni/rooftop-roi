/* =============================================================================
 * landing.js — the page before there is any data.
 *
 * Three jobs, in this order: say what the tool does, prove the privacy claim,
 * and take the file.  The hero figure is one real summer weekday from the demo
 * household's meter drawn against what 6 kW of panels would have made that
 * day — the gap between those two curves is the entire subject of the tool, so
 * it opens the page instead of a stock photograph of a roof.
 * ========================================================================== */

import { el, clear, $ } from "./dom.js";
import { DISCLAIMER } from "./blocks.js";
import { renderBillForm } from "./billform.js";
import { EXPLANATION, CALLS, STORAGE_NOTE, GEOCODE_NOTE, adoptGeocodeNote } from "../privacy.js";
import { REPO_URL, feedbackLink } from "./feedback.js";

/* Averaged summer weekday from data/demo/*.csv, and the TMY profile for 15 July
   at 20° tilt / 180° azimuth scaled to 6 kW DC. Real numbers, not a sketch. */
const DEMO_LOAD = [1.17, 1.15, 1.30, 1.80, 2.52, 3.05, 3.17, 2.04, 0.90, 0.97, 1.14, 1.48,
  1.84, 2.27, 2.61, 2.92, 3.33, 3.41, 3.30, 3.02, 2.75, 2.28, 1.84, 1.51];
const DEMO_PV = [0, 0, 0, 0, 0, 0.07, 0.65, 1.61, 2.50, 3.27, 3.82, 4.07,
  4.06, 3.70, 3.10, 2.41, 1.63, 0.64, 0.07, 0, 0, 0, 0, 0];

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
};

// The last bill spec the person typed or submitted, so Back and a failed
// build do not cost them twelve figures.
let lastBill = null;

export function renderLanding(root, handlers) {
  clear(root);

  root.appendChild(el("header.landing-head", {}, [
    el("div.wordmark", {}, [el("span.roof-mark", { "aria-hidden": "true" }), el("b", { text: "Rooftop ROI" })]),
    el("span.edition", { text: "A field guide to home energy · California" }),
  ]));
  root.appendChild(el("section.landing-hero", {}, [
    el("div.hero-intro", {}, [
      el("p.eyebrow", { text: "Your roof. Your money. Your call." }),
      el("h1.lede", {}, ["A sunny roof. ", el("em", { text: "A sound investment?" })]),
      el("p.landing-sub", { text: "Find out whether solar and a battery earn their keep. Run your home's electricity use hour by hour, check an installer's quote, and compare the cost with investing the same money." }),
      el("div.hero-actions", {}, [
        el("a.btn.btn-primary.btn-lg", { href: "#start", text: "Use my home’s numbers", on: { click: (e) => {
          e.preventDefault();
          const start = $("start");
          start.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          start.focus({ preventScroll: true });
        } } }),
        el("button.btn.btn-lg", { type: "button", text: "Explore a demo →", on: { click: () => handlers.onDemo() } }),
      ]),
      el("p.hero-trust", { text: "Free to use · No account · Your meter file stays on this device" }),
      el("p.hero-coverage", { text: "Built for SCE, PG&E and SDG&E households." }),
    ]),
    heroFigure(),
  ]));
  root.appendChild(el("div.landing-grid", {}, [startPanel(handlers), privacyPanel()]));

  root.appendChild(pipeline());

  root.appendChild(el("p.disclaimer", {
    text: DISCLAIMER + " The rate tables carry effective dates on the Assumptions tab; a real installer's "
      + "production estimate and a real vendor's price sheet both beat this model.",
  }));

  root.appendChild(el("footer.landing-foot", {}, [
    el("span", {}, [el("a", { href: REPO_URL, target: "_blank", rel: "noopener", text: "Source on GitHub" })]),
    el("span", {}, [feedbackLink()]),
    el("span", { text: "MIT licence" }),
    el("span", { text: "No accounts, no cookies, no tracking" }),
    // Open-Meteo's free tier is CC BY 4.0 and the licence asks for a visible credit.
    el("span", {}, ["Weather data by ",
      el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener", text: "Open-Meteo.com" }),
      " (", el("a", { href: "https://creativecommons.org/licenses/by/4.0/", target: "_blank", rel: "noopener license", text: "CC BY 4.0" }), ")"]),
  ]));

  adoptGeocodeNote().then((note) => {
    const node = $("geocode-disclosure");
    if (node && note) node.textContent = note;
  });
}

/* ------------------------------------------------------------------ hero */

function heroFigure() {
  const W = 760, H = 220, ML = 62, MR = 14, MT = 12, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const yMax = 4.5;
  const x = (h) => ML + (h / 23) * plotW;
  const y = (v) => MT + plotH - (v / yMax) * plotH;

  const node = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "hero-fig-title" });
  node.appendChild(svg("title", { id: "hero-fig-title" }));
  node.lastChild.textContent = "A typical summer weekday: household draw peaks at 5 p.m., while the roof's "
    + "production peaks at noon and is gone by 6 p.m.";

  // The unit rides the top tick rather than floating above the axis, where it
  // would sit on top of that tick's own label.
  for (let v = 0; v <= yMax; v += 1.5) {
    node.appendChild(svg("line", { x1: ML, x2: W - MR, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    const label = svg("text", { x: ML - 8, y: y(v) + 3.5, "text-anchor": "end", fill: "var(--ink-3)", "font-size": 14 });
    label.textContent = v >= yMax - 0.01 ? v.toFixed(1) + " kWh" : v.toFixed(1);
    node.appendChild(label);
  }

  // The evening band: the house's peak, with no sun left in it.
  node.appendChild(svg("rect", {
    x: x(16), y: MT, width: x(21) - x(16), height: plotH,
    fill: "var(--s8)", opacity: 0.07,
  }));

  const areaPath = DEMO_PV.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("")
    + `L${x(23).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  node.appendChild(svg("path", { d: areaPath, fill: "var(--s2)", opacity: 0.16 }));
  node.appendChild(svg("path", {
    d: DEMO_PV.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    fill: "none", stroke: "var(--s2)", "stroke-width": 2, "stroke-linejoin": "round",
  }));
  node.appendChild(svg("path", {
    d: DEMO_LOAD.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    fill: "none", stroke: "var(--ink)", "stroke-width": 2, "stroke-linejoin": "round",
  }));

  for (const h of [0, 6, 12, 18, 23]) {
    const t = svg("text", { x: x(h), y: H - 8, "text-anchor": h === 0 ? "start" : h === 23 ? "end" : "middle", fill: "var(--ink-3)", "font-size": 14 });
    t.textContent = String(h).padStart(2, "0") + ":00";
    node.appendChild(t);
  }

  const tag = (text, hx, vy, color, anchor) => {
    const t = svg("text", { x: x(hx), y: y(vy), fill: color, "font-size": 14, "font-weight": 600, "text-anchor": anchor || "middle" });
    t.textContent = text;
    node.appendChild(t);
  };
  tag("What the roof makes", 10.5, 4.42, "var(--s2)");
  tag("What the house uses", 4.6, 3.62, "var(--ink)");
  tag("evening peak, no sun", 18.5, 4.42, "var(--ink-2)");

  return el("figure.hero-figure-wrap", {}, [
    el("div.figure-heading", {}, [el("span.eyebrow", { text: "Field note / 01" }), el("h2", { text: "The sun keeps different hours." })]),
    node,
    el("figcaption.figcap", {
      text: "A summer weekday at the demo home. A modeled 6 kW roof makes most of its power at midday; the home needs more in the evening. A battery can bridge the gap. The question is what that gap is worth.",
    }),
  ]);
}

/* ------------------------------------------------------------------ start */

function startPanel(handlers) {
  const fileInput = el("input", {
    type: "file", id: "file-input", multiple: true,
    accept: ".xml,.csv,.txt", style: "display:none",
    on: { change: (e) => { handlers.onFiles(Array.from(e.target.files || [])); e.target.value = ""; } },
  });

  // The panel keeps one "door" slot: the dropzone by default, the bill form on request.
  const door = el("div.door");
  const zone = el("div.dropzone", { id: "dropzone" }, [
    el("div.dropzone-title", { text: "Drop your Green Button file here" }),
    el("p.dropzone-note", {
      text: "XML or CSV, from any of the three big California utilities. Drop several and they merge — two "
        + "years of readings gives a much steadier answer than one.",
    }),
    el("button.btn.btn-primary.btn-lg", { type: "button", text: "Choose a file", on: { click: () => fileInput.click() } }),
    el("button.btn.btn-lg", { type: "button", text: "Enter monthly usage", on: { click: () => showBills() } }),
    el("button.btn.btn-lg", { type: "button", text: "Try the demo household", on: { click: () => handlers.onDemo() } }),
    fileInput,
  ]);

  // The bill form carries its own ZIP, so the location block below is hidden
  // while it is open: two ZIP fields on one screen is a question nobody can answer.
  const locationBlock = () => door.parentElement && door.parentElement.querySelector(".landing-location");
  function showDrop() {
    clear(door); door.appendChild(zone);
    const loc = locationBlock(); if (loc) loc.hidden = false;
  }
  function showBills() {
    // A ZIP already typed in the location field carries over, so it is not asked twice.
    const z = zip.value.trim();
    const form = renderBillForm(door, {
      initial: lastBill || (/^\d{5}$/.test(z) ? { zip: z } : null),
      onSubmit: (spec) => { lastBill = spec; if (handlers.onMonthlyBills) handlers.onMonthlyBills(spec); },
      onBack: (partial) => { if (partial) lastBill = partial; showDrop(); zone.querySelector("button").focus(); },
      seasonalSplit: handlers.seasonalSplit,
    });
    const loc = locationBlock(); if (loc) loc.hidden = true;
    form.focus();
  }
  showDrop();

  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    handlers.onFiles(Array.from(e.dataTransfer.files || []));
  });

  const address = el("input", { type: "text", id: "addr-input", placeholder: "Street address, city, CA", on: { keydown: (e) => { if (e.key === "Enter") { e.preventDefault(); handlers.onAddress(address.value); } } } });
  const zip = el("input", { type: "text", id: "zip-input", inputMode: "numeric", pattern: "[0-9]{5}", placeholder: "91301", maxLength: 5,
    on: { keydown: (e) => { if (e.key === "Enter") { e.preventDefault(); handlers.onZip(zip.value); } } } });

  return el("section.panel.start-panel", { id: "start", tabindex: "-1", "aria-labelledby": "start-title" }, [
    el("p.eyebrow", { text: "Start with what you have" }),
    el("h2", { id: "start-title", text: "Give your roof some real numbers." }),
    el("p.panel-sub", { text: "Two things: your meter readings (or twelve monthly bills), and where the roof is." }),
    door,
    el("p.field-error", { id: "landing-error", role: "alert", hidden: true }),
    el("div", { id: "landing-notice", hidden: true }),

    el("div.landing-location", {}, [
    el("div.or-rule", { text: "Your location · optional until you run your home" }),

    el("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
      el("div", {}, [
        el("label.field-lab", { htmlFor: "addr-input", text: "Address" }),
        el("div.field-row", {}, [
          address,
          el("button.btn", { type: "button", text: "Find", on: { click: () => handlers.onAddress(address.value) } }),
        ]),
        el("details.utility-guide", {}, [el("summary", { text: "What is sent when I look up a location?" }), el("p.ctl-note", { id: "geocode-disclosure", text: GEOCODE_NOTE })]),
      ]),
      el("div", {}, [
        el("label.field-lab", { htmlFor: "zip-input", text: "…or just a ZIP code" }),
        el("div.field-row", {}, [
          zip,
          el("button.btn", { type: "button", text: "Use this ZIP", on: { click: () => handlers.onZip(zip.value) } }),
        ]),
        el("p.ctl-note", { style: "margin-top:5px",
          text: "Enough to pick your utility and the right patch of sky. The ZIP is sent to Open-Meteo's "
            + "place search to find its centre; the street address is not needed." }),
      ]),
      el("div", {}, [
        el("button.btn", { type: "button", text: "Use the roof map after loading data", on: { click: () => handlers.onMap() } }),
        el("p.ctl-note", { style: "margin-top:5px",
          text: "Available once your meter file is loaded: the map lives on the Roof tab. It shows satellite "
            + "imagery from Esri, and the tile requests show Esri roughly which block you are looking at "
            + "(about 75 m), along with your IP address. No address or ZIP is sent from the map." }),
      ]),
    ]),
    el("p.note", { id: "landing-location-status", role: "status", hidden: true }),
    ]),

    utilityGuide(),
  ]);
}

function utilityGuide() {
  const steps = [
    ["Southern California Edison", [
      "Sign in at sce.com and open My Account → Data Sharing → Share My Data, or go to the Green Button page directly.",
      "Choose “Green Button Download My Data”.",
      "Pick the longest range offered — two years if it is there — and hourly or 15-minute interval detail.",
      "Download the CSV. It arrives as SCE_Usage_<account>_<dates>.csv.",
    ]],
    ["Pacific Gas & Electric", [
      "Sign in at pge.com and open Energy Usage Details from your account dashboard.",
      "Click “Green Button — Download my data” at the bottom right of the usage chart.",
      "Choose a date range (a full year or more) and “Export usage for a bill period or date range”.",
      "Download the CSV or ZIP. If it is a ZIP, unzip it first and drop the CSV inside.",
    ]],
    ["San Diego Gas & Electric", [
      "Sign in at sdge.com and open My Energy → My Account → Energy Use.",
      "Select Green Button Download My Data.",
      "Pick the longest available period and hourly detail.",
      "Download the CSV or the Green Button XML — this page reads both.",
    ]],
  ];

  return el("details.utility-guide", {}, [
    el("summary", { text: "How do I get a Green Button file from my utility?" }),
    el("div", {}, [
      el("p.note", {
        text: "Green Button is the standard format US utilities use to hand you your own interval readings. "
          + "It is free, it is yours, and it takes about two minutes to download.",
      }),
      ...steps.flatMap(([name, list]) => [
        el("h4", { text: name }),
        el("ol", {}, list.map((s) => el("li", { text: s }))),
      ]),
      el("p.note", {
        text: "Any hourly or 15-minute CSV with a timestamp and a kWh column will also work — the parser does "
          + "its best with a generic file and tells you what it assumed.",
      }),
    ]),
  ]);
}

/* ---------------------------------------------------------------- privacy */

function privacyPanel() {
  return el("section.panel", {}, [
    el("div.privacy", {}, [
      el("p.eyebrow", { text: "A calculator, not a sales pitch" }),
      el("h2.privacy-claim", { text: "Your meter readings stay yours." }),
      el("p.panel-sub", { text: "Your readings are processed on this device. No account, no upload, no request for your phone number. You can inspect the assumptions and the source code behind the answer." }),
      el("details.privacy-details", {}, [el("summary", { text: "See network requests & local storage" }),
      el("p.panel-sub", { text: EXPLANATION }),
      el("ul.calls", {}, CALLS.map((c) => el("li" + (c.none ? ".none" : ""), {}, [
        el("span.who", { text: c.who }),
        el("span", {}, [
          c.what,
          el("br"),
          el("span", { style: "color:var(--ink-3)", text: c.when }),
          c.escape ? el("span", { style: "color:var(--ink-3)", text: " " + c.escape }) : null,
        ]),
      ]))),
      el("p.panel-sub", { style: "margin-top:14px", text: STORAGE_NOTE }),
      ]),
      el("div.field-note", {}, [el("h3", { text: "Start curious. Leave better prepared." }), el("p", { text: "Try the demo to get your bearings. Then bring your own readings, check your roof and rate plan, and see how the answer changes with the price you were quoted." })]),
    ]),
  ]);
}

/* --------------------------------------------------------------- pipeline */

const STEPS = [
  { title: "Your meter file", body: "Green Button XML or CSV, parsed in this browser into one hourly series.", glyph: "file" },
  { title: "Flexible loads", body: "The detector looks for a car charger and a pool pump inside the whole-house total. Anything it finds stays at the hours it was recorded until you choose to move it.", glyph: "pulse" },
  { title: "Your roof", body: "Each face gets a tilt, a direction and eleven years of real sunlight.", glyph: "roof" },
  { title: "8,760 hours", body: "Every hour dispatched and billed under Net Billing, for every system size.", glyph: "grid" },
  { title: "Money", body: "Savings against the same cash in the market: NPV, IRR, payback, wealth.", glyph: "money" },
];

function pipeline() {
  return el("section.pipeline", {}, [
    el("h2", { text: "What happens after you drop the file" }),
    el("p.panel-sub", { text: "The calculations run here. Weather loads for your location first; after that, explore at your own pace." }),
    el("ol.pipe", {}, STEPS.map((s, i) => el("li.pipe-step", {}, [
      el("span.pipe-glyph", {}, [glyph(s.glyph)]),
      el("strong", { text: s.title }),
      el("span.pipe-body", { text: s.body }),
      i < STEPS.length - 1 ? el("span.pipe-arrow", { "aria-hidden": "true", text: "→" }) : null,
    ]))),
  ]);
}

function glyph(kind) {
  const node = svg("svg", { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none",
    stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  const paths = {
    file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
    pulse: ["M2 13h4l3-8 4 16 3-8h6"],
    roof: ["M3 12 12 4l9 8", "M6 12v8h12v-8"],
    grid: ["M4 4h16v16H4z", "M4 10h16", "M4 16h16", "M10 4v16", "M16 4v16"],
    money: ["M12 3v18", "M16.5 7.5c0-1.7-2-2.5-4.5-2.5s-4.5.9-4.5 2.8S9.5 11 12 11.5s4.8 1.2 4.8 3.3S14.5 19 12 19s-4.5-.9-4.5-2.6"],
  }[kind] || [];
  for (const d of paths) node.appendChild(svg("path", { d }));
  return node;
}

/**
 * A blocking notice in the start panel: a message plus explicit choices.
 *   landingNotice({ tone: "bad"|"warn"|"info", text, actions: [{ label, primary, onClick }] })
 * landingNotice(null) hides it.
 */
export function landingNotice(spec) {
  const node = $("landing-notice");
  if (!node) return;
  clear(node);
  node.hidden = !spec;
  if (!spec) return;
  node.className = "note banner" + (spec.tone === "bad" ? " banner-bad" : spec.tone === "info" ? " banner-info" : "");
  node.setAttribute("role", spec.tone === "info" ? "status" : "alert");
  node.style.marginTop = "10px";
  node.appendChild(el("p", { style: "margin:0 0 8px", text: spec.text }));
  if (spec.actions && spec.actions.length) {
    node.appendChild(el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" }, spec.actions.map((a) =>
      el("button.btn" + (a.primary ? ".btn-primary" : ""), { type: "button", text: a.label, on: { click: a.onClick } }))));
  }
  if (typeof node.scrollIntoView === "function") node.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Prefer an error's own user-facing wording (GeocodeError, parser errors) over its technical message. */
export const GENERIC_ERROR = "We couldn’t finish that step. Please try again. For a meter file, use an unzipped CSV or XML; you can also start with monthly usage or the demo.";

/**
 * The sentence to show for an error.  Only errors written for people carry a
 * `userMessage` (LoadFileError, WeatherUnavailableError, the geocoder's errors,
 * userError() in main.js); anything else - a TypeError, a DOMException, a bare
 * Error from deep inside a parser - is a bug or an internal detail, so the page
 * says something went wrong and the console (where callers log `err`) has the rest.
 */
export function userMessageOf(err, fallback) {
  if (err && typeof err.userMessage === "string" && err.userMessage) return err.userMessage;
  if (!err) return fallback || GENERIC_ERROR;
  return GENERIC_ERROR;
}

/** A plain confirmation line under the address/ZIP row ("Using Agoura Hills, CA"); empty text hides it. */
export function landingLocation(text) {
  const node = $("landing-location-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
}

export function landingError(message) {
  const node = $("landing-error");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
  node.className = "note banner banner-bad";
}

export default { renderLanding, landingLocation, landingError, landingNotice, userMessageOf };
