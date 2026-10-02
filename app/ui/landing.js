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
import { CLAIM, EXPLANATION, CALLS, STORAGE_NOTE, adoptGeocodeNote } from "../privacy.js";

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

export function renderLanding(root, handlers) {
  clear(root);

  root.appendChild(el("header.landing-head", {}, [
    el("div.wordmark", {}, [el("b", { text: "Rooftop ROI" }), el("span", { text: "solar + battery, priced against your own meter" })]),
    el("h1.lede", { text: "Panels, a battery, or the index fund?" }),
    el("p.landing-sub", {
      text: "Rooftop ROI replays your own utility interval data hour by hour with panels and a battery bolted "
        + "on, bills the result under California's Net Billing rules, and sets it against leaving the same cash "
        + "in the market. It is for a homeowner holding an installer's quote who wants to know whether the "
        + "number on it is any good. You need one thing to start: a Green Button download from SCE, PG&E or "
        + "SDG&E — the instructions are below, and it takes about two minutes.",
    }),
  ]));

  root.appendChild(heroFigure());

  root.appendChild(el("div.landing-grid", {}, [startPanel(handlers), privacyPanel()]));

  root.appendChild(pipeline());

  root.appendChild(el("p.disclaimer", {
    text: "A planning tool, not financial advice and not a quote. Utility rates change every year and the "
      + "export-credit tables change with them — check the effective dates on the Assumptions tab before you "
      + "trust a figure to the dollar. A real installer's production estimate and a real vendor's price sheet "
      + "both beat this model.",
  }));

  root.appendChild(el("footer.landing-foot", {}, [
    el("span", {}, [el("a", { href: "https://github.com/", target: "_blank", rel: "noopener", text: "Source on GitHub" })]),
    el("span", { text: "MIT licence" }),
    el("span", { text: "No accounts, no cookies, no tracking" }),
  ]));

  adoptGeocodeNote().then(() => {
    const node = $("geocode-disclosure");
    const call = CALLS.find((c) => c.who === "OpenStreetMap");
    if (node && call) node.textContent = call.what;
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
    const label = svg("text", { x: ML - 8, y: y(v) + 3.5, "text-anchor": "end", fill: "var(--ink-3)", "font-size": 10 });
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
    const t = svg("text", { x: x(h), y: H - 8, "text-anchor": h === 0 ? "start" : h === 23 ? "end" : "middle", fill: "var(--ink-3)", "font-size": 10 });
    t.textContent = String(h).padStart(2, "0") + ":00";
    node.appendChild(t);
  }

  const tag = (text, hx, vy, color, anchor) => {
    const t = svg("text", { x: x(hx), y: y(vy), fill: color, "font-size": 11, "font-weight": 600, "text-anchor": anchor || "middle" });
    t.textContent = text;
    node.appendChild(t);
  };
  tag("What the roof makes", 10.5, 4.42, "var(--s2)");
  tag("What the house uses", 4.6, 3.62, "var(--ink)");
  tag("evening peak, no sun", 18.5, 4.42, "var(--ink-2)");

  return el("figure.hero-figure-wrap", { style: "margin-block:30px 0" }, [
    node,
    el("figcaption.figcap", {
      text: "One real summer weekday from the demo household's meter, against what 6 kW of panels would have "
        + "made that day. Midday surplus sells back at roughly a fifth of what it costs to buy — and the "
        + "house's own peak lands after the sun has gone. Whether a battery closes that gap profitably is the "
        + "question this tool answers with your numbers instead of these.",
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

  const zone = el("div.dropzone", { id: "dropzone" }, [
    el("div.dropzone-title", { text: "Drop your Green Button file here" }),
    el("p.dropzone-note", {
      text: "XML or CSV, from any of the three big California utilities. Drop several and they merge — two "
        + "years of readings gives a much steadier answer than one.",
    }),
    el("button.btn.btn-primary.btn-lg", { type: "button", text: "Choose a file", on: { click: () => fileInput.click() } }),
    el("button.btn.btn-lg", { type: "button", text: "Try the demo household", on: { click: () => handlers.onDemo() } }),
    fileInput,
  ]);

  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    handlers.onFiles(Array.from(e.dataTransfer.files || []));
  });

  const address = el("input", { type: "text", id: "addr-input", placeholder: "1 Main St, Agoura Hills CA" });
  const zip = el("input", { type: "text", id: "zip-input", inputMode: "numeric", pattern: "[0-9]{5}", placeholder: "91301", maxLength: 5 });

  return el("section.panel", {}, [
    el("h2", { text: "Start here" }),
    el("p.panel-sub", { text: "Two things: your meter readings, and where the roof is." }),
    zone,
    el("p.note", { id: "landing-error", hidden: true }),

    el("div.or-rule", { text: "and the location" }),

    el("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
      el("div", {}, [
        el("label.field-lab", { htmlFor: "addr-input", text: "Address" }),
        el("div.field-row", {}, [
          address,
          el("button.btn", { type: "button", text: "Find", on: { click: () => handlers.onAddress(address.value) } }),
        ]),
        el("p.ctl-note", { id: "geocode-disclosure", style: "margin-top:5px",
          text: "Typing an address sends it to OpenStreetMap's Nominatim geocoder to get coordinates back. "
            + "Click the map or enter a ZIP code instead and nothing you typed is sent anywhere." }),
      ]),
      el("div", {}, [
        el("label.field-lab", { htmlFor: "zip-input", text: "…or just a ZIP code" }),
        el("div.field-row", {}, [
          zip,
          el("button.btn", { type: "button", text: "Use this ZIP", on: { click: () => handlers.onZip(zip.value) } }),
        ]),
        el("p.ctl-note", { style: "margin-top:5px",
          text: "Enough to pick your utility and the right patch of sky. Sent nowhere." }),
      ]),
      el("div", {}, [
        el("button.btn", { type: "button", text: "Pick it on the map instead", on: { click: () => handlers.onMap() } }),
        el("p.ctl-note", { style: "margin-top:5px",
          text: "Opens satellite imagery from Esri. Clicking your roof sends nothing but tile coordinates." }),
      ]),
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
      el("p.privacy-claim", { text: CLAIM }),
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
  ]);
}

/* --------------------------------------------------------------- pipeline */

const STEPS = [
  { title: "Your meter file", body: "Green Button XML or CSV, parsed in this browser into one hourly series.", glyph: "file" },
  { title: "Flexible loads", body: "The detector finds the car charger and the pool pump inside the whole-house total.", glyph: "pulse" },
  { title: "Your roof", body: "Each face gets a tilt, a direction and eleven years of real sunlight.", glyph: "roof" },
  { title: "8,760 hours", body: "Every hour dispatched and billed under Net Billing, for every system size.", glyph: "grid" },
  { title: "Money", body: "Savings against the same cash in the market: NPV, IRR, payback, wealth.", glyph: "money" },
];

function pipeline() {
  return el("section.pipeline", {}, [
    el("h2", { text: "What happens after you drop the file" }),
    el("p.panel-sub", { text: "Five steps, all of them here on this device, in about a second." }),
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

export function landingError(message) {
  const node = $("landing-error");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
  node.className = "note banner banner-bad";
}

export default { renderLanding, landingError };
