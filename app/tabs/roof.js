/* =============================================================================
 * tabs/roof.js — the roof faces, and what the sun does to each of them.
 *
 * The tab owns two things: it hands its container to the roof builder, and it
 * reacts to the planes coming back by asking core/weather.js + core/pv.js for
 * an hourly profile per face.  That is the one place in the app that goes to
 * the network for the user, so it says so, out loud, with a status line and a
 * cache indicator.
 *
 * The builder's contract (its own header, and ARCHITECTURE.md):
 *     mountRoofBuilder(el, { site, planes, panel, onChange, onSiteChange,
 *                            onCalibration })
 *       -> { destroy, setPlanes, setSite, setPath }
 * If the module is ever absent the simple path below (pitch, direction,
 * capacity per face) stands in, so the tab is never a dead end.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtNum, fmtPct } from "../ui/format.js";
import * as K from "../ui/knobs.js";

export const id = "roof";
export const label = "Roof";

let builderHandle = null;

export function rail(state, ctx) {
  return [
    { group: "Sunlight", open: true, items: [
      { ...K.item.weatherKey(ctx),
        note: "P90 is the conservative low-sun year, P10 the optimistic one — the solar industry's exceedance convention." },
    ] },
    { group: "Array", open: true, items: [K.item.panelW(), K.item.maxPanels()] },
  ];
}

export function mount(pane, state, ctx) {
  clear(pane);

  pane.appendChild(card({
    id: "roof-builder-card",
    title: "Your roof",
    tag: { id: "roof-source-tag", text: "simple" },
    sub: "Draw the faces you would actually put panels on. Every face gets its own tilt, direction and "
      + "shading, and the optimiser decides how many panels each one deserves.",
    body: [el("div", { id: "roof-builder" })],
  }));

  pane.appendChild(card({
    id: "roof-solar-card",
    title: "What the sun does here",
    tag: { id: "solar-cache-tag", text: "not computed" },
    sub: "Eleven years of hourly sunlight from Open-Meteo for your coordinates, run through a PVWatts-style "
      + "model for each face. Fetched once and cached in this browser.",
    body: [
      el("div.status", { id: "solar-status", role: "status", "aria-live": "polite" }, [
        el("span", { id: "solar-status-text", text: "Waiting for a roof face." }),
        el("span.bar", { id: "solar-status-bar" }, [el("i")]),
      ]),
      el("div.table-scroll", { style: "margin-top:12px" }, [el("table", { id: "t-planes" })]),
      el("p.note", { id: "roof-percentile-note", style: "margin-top:10px" }),
    ],
  }));

  mountBuilder(state, ctx);
}

async function mountBuilder(state, ctx) {
  const host = $("roof-builder");
  if (!host) return;
  try {
    const mod = await import("../roof/roofBuilder.js");
    const mountRoofBuilder = mod.mountRoofBuilder || (mod.default && mod.default.mountRoofBuilder);
    if (typeof mountRoofBuilder !== "function") throw new Error("no mountRoofBuilder export");
    builderHandle = mountRoofBuilder(host, {
      planes: state.roof.planes,
      site: state.site.lat === null ? null : { lat: state.site.lat, lon: state.site.lon },
      panel: { w: state.system.panelW },
      onChange: (planes) => ctx.actions.setPlanes(planes),
      onSiteChange: (site) => ctx.actions.setSite(site),
      onCalibration: (cal) => ctx.actions.setCalibration(cal),
    });
    const tag = $("roof-source-tag");
    if (tag) tag.textContent = "roof builder";
  } catch {
    simpleBuilder(host, state, ctx);
  }
}

/** The fallback path: a face is a pitch, a direction and a panel count. */
function simpleBuilder(host, state, ctx) {
  clear(host);

  const rows = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const draw = () => {
    clear(rows);
    const planes = ctx.getState().roof.planes;
    if (!planes.length) rows.appendChild(el("p.note", { text: "No faces yet. Add the one your panels would go on." }));
    planes.forEach((plane, i) => rows.appendChild(planeRow(plane, i, ctx, draw)));
  };

  host.appendChild(rows);
  host.appendChild(el("div", { style: "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap" }, [
    el("button.btn", { type: "button", text: "Add a roof face", on: { click: () => { ctx.actions.addPlane(); draw(); } } }),
    el("button.btn", { type: "button", text: "Reset to one south face",
      on: { click: () => { ctx.actions.resetPlanes(); draw(); } } }),
  ]));
  host.appendChild(el("p.note", { style: "margin-top:10px",
    text: "180° is due south, 90° east, 270° west. A 4:12 pitch is about 18°, 6:12 about 27°, 9:12 about 37°." }));
  draw();
}

function planeRow(plane, index, ctx, redraw) {
  const change = (key, value) => { ctx.actions.updatePlane(plane.id, key, value); redraw(); };
  const field = (labelText, node) => el("label", { style: "display:grid;gap:3px;min-width:92px;flex:1" }, [
    el("span.field-lab", { text: labelText }), node,
  ]);

  return el("div", { style: "border:1px solid var(--border);border-radius:var(--r-md);padding:11px 13px;display:flex;flex-direction:column;gap:9px" }, [
    el("div", { style: "display:flex;gap:10px;align-items:center" }, [
      el("input", { type: "text", value: plane.name, "aria-label": "Face name",
        style: "flex:1", on: { change: (e) => change("name", e.target.value) } }),
      el("button.btn.btn-danger", { type: "button", text: "Remove", on: { click: () => { ctx.actions.removePlane(plane.id); redraw(); } } }),
    ]),
    el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, [
      field("Pitch", el("select", { on: { change: (e) => change("tilt", Number(e.target.value)) } },
        [["2", "Nearly flat (2°)"], ["10", "2:12 (10°)"], ["18", "4:12 (18°)"], ["27", "6:12 (27°)"],
         ["37", "9:12 (37°)"], ["45", "12:12 (45°)"]].map(([v, t]) =>
          el("option", { value: v, text: t, selected: Math.round(plane.tilt) === Number(v) })))),
      field("Direction °", el("input", { type: "number", min: 0, max: 359, step: 1, value: plane.azimuth,
        on: { change: (e) => change("azimuth", Number(e.target.value)) } })),
      field("Panels it fits", el("input", { type: "number", min: 1, max: 80, step: 1, value: plane.maxPanels,
        on: { change: (e) => change("maxPanels", Math.round(Number(e.target.value))) } })),
      field("Shading lost", el("select", { on: { change: (e) => change("shading", { annual: Number(e.target.value) }) } },
        [["0", "None"], ["0.05", "Light (5%)"], ["0.12", "Moderate (12%)"], ["0.25", "Heavy (25%)"]].map(([v, t]) =>
          el("option", { value: v, text: t, selected: Math.abs((plane.shading?.annual ?? 0) - Number(v)) < 0.001 })))),
      field("Extra cost $", el("input", { type: "number", min: 0, step: 100, value: plane.costAdder || 0,
        on: { change: (e) => change("costAdder", Number(e.target.value)) } })),
    ]),
  ]);
}

export function render(state, ctx) {
  // The builder owns its own list while it is mounted; pushing back what it
  // just emitted would reset its selection on every keystroke.  Only the site
  // is synced inward, and only when it changed elsewhere (the landing form).
  if (builderHandle && typeof builderHandle.setSite === "function" && state.site.lat !== null) {
    builderHandle.setSite({ lat: state.site.lat, lon: state.site.lon });
  }

  const statusText = $("solar-status-text");
  const bar = $("solar-status-bar");
  if (statusText) statusText.textContent = ctx.solarStatusText || "Waiting for a roof face.";
  if (bar) {
    bar.firstElementChild.style.width = Math.round((ctx.solarProgress || 0) * 100) + "%";
    bar.style.visibility = ctx.solarProgress > 0 && ctx.solarProgress < 1 ? "visible" : "hidden";
  }
  const tag = $("solar-cache-tag");
  if (tag) {
    const cached = state.solar.cached;
    tag.textContent = state.solar.status === "ready"
      ? (cached ? "from this browser's cache" : "fetched just now")
      : state.solar.status === "error" ? "could not fetch" : "not computed";
    tag.className = "tag" + (state.solar.status === "error" ? " tag-warn" : cached ? " tag-good" : "");
  }

  const table = $("t-planes");
  if (!table) return;
  clear(table);
  const planes = state.roof.planes;
  if (!planes.length) {
    table.appendChild(el("tbody", {}, [el("tr", {}, [el("td", { text: "Add a roof face to see its yield." })])]));
    return;
  }
  table.appendChild(el("thead", {}, [el("tr", {}, [
    "Face", "Tilt", "Direction", "Panels", "Shading", "kWh/kW-yr", "P90 / P50 / P10", "Annual kWh at full",
  ].map((h, i) => el(i === 0 ? "th" : "th.n", { text: h })))]));
  table.appendChild(el("tbody", {}, planes.map((p) => {
    const prof = state.solar.byPlane[p.id];
    const perKw = prof && prof.annualPerKw ? prof.annualPerKw[state.ui.weatherKey] ?? Object.values(prof.annualPerKw)[0] : null;
    const pc = prof && prof.percentiles;
    const kwdc = (p.maxPanels * state.system.panelW) / 1000;
    const shade = 1 - (p.shading?.annual ?? 0);
    return el("tr", {}, [
      el("td", { text: p.name }),
      el("td.n", { text: p.tilt + "°" }),
      el("td.n", { text: p.azimuth + "°" }),
      el("td.n", { text: String(p.maxPanels) }),
      el("td.n", { text: fmtPct(p.shading?.annual ?? 0, 0) }),
      el("td.n", { text: perKw ? fmtNum(perKw, 0) : "—" }),
      el("td.n", { text: pc ? `${fmtNum(pc.p90Year, 0)} / ${fmtNum(pc.p50Year, 0)} / ${fmtNum(pc.p10Year, 0)}` : "—" }),
      el("td.n", { text: perKw ? fmtNum(perKw * kwdc * shade, 0) : "—" }),
    ]);
  })));

  const note = $("roof-percentile-note");
  if (note && ctx.installerAnnualKwh && ctx.selected && ctx.selected.pvKwh) {
    const ratio = ctx.selected.pvKwh / ctx.installerAnnualKwh;
    note.textContent = `Your installer's proposal claims ${fmtNum(ctx.installerAnnualKwh, 0)} kWh/yr; this model `
      + `says ${fmtNum(ctx.selected.pvKwh, 0)} kWh/yr for the selected system — `
      + `${fmtPct(ratio, 0)} of the proposal. `
      + (ratio < 0.9 ? "A proposal more than 10% above an independent model is worth questioning."
        : ratio > 1.1 ? "The proposal is conservative against this model."
        : "The two agree within 10%, which is as close as either deserves to be read.");
  } else if (note) {
    note.textContent = state.solar.status === "ready"
      ? `Modelled on ${(state.solar.weatherYears || []).length} weather years. P90 is the yield exceeded in nine years out of ten — the number to plan against; P10 is the sunny-year case.`
      : state.solar.status === "error"
        ? "Sunlight could not be fetched. Everything else on the page still works; the Roof tab will retry when you change a face."
        : "";
  }
}

export function unmount() {
  if (builderHandle && typeof builderHandle.destroy === "function") builderHandle.destroy();
  builderHandle = null;
}

export default { id, label, rail, mount, render, unmount };
