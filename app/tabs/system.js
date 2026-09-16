/* =============================================================================
 * tabs/system.js — how big, and how the battery behaves.
 *
 * The heat map is the tab: every cell is a complete hourly simulation, and
 * clicking one overrides the optimiser.  The per-plane table underneath says
 * where the optimiser put the panels for the cell you are looking at, because
 * "34 panels" means nothing until you know which faces they went on.
 * ========================================================================== */

import { el, clear, $ } from "../ui/dom.js";
import { card } from "../ui/blocks.js";
import { fmtNum, fmtPct, plural } from "../ui/format.js";
import { renderHeatmap } from "../charts/heatmap.js";
import { renderTypicalDay } from "../charts/day.js";

export const id = "system";
export const label = "System";

export function rail(state, ctx) {
  return [
    { group: "Hardware", open: true, items: [
      { path: "system.panelW", kind: "range", label: "Panel wattage", min: 350, max: 560, step: 5, unit: " W" },
      { path: "system.battKWh", kind: "range", label: "Battery size, usable", min: 5, max: 20, step: 0.5, unit: " kWh each" },
      { path: "system.battKW", kind: "range", label: "Battery power", min: 2.5, max: 11.5, step: 0.5, unit: " kW each" },
      { path: "system.minReserve", kind: "range", label: "Reserved for backup", min: 0, max: 0.5, step: 0.05, pct: 0 },
      { path: "system.rte", kind: "range", label: "Round-trip efficiency", min: 0.8, max: 0.98, step: 0.01, pct: 0 },
    ] },
    { group: "Dispatch", open: true, items: [
      { path: "system.strategy", kind: "select", label: "Battery strategy", opts: [
        { v: "self_consumption", t: "Self-consumption" },
        { v: "tou_arbitrage", t: "Time-of-use arbitrage" },
        { v: "export_arbitrage", t: "Export arbitrage" },
        { v: "backup_only", t: "Backup only (never cycles)" }] },
      { path: "system.gridCharge", kind: "check", label: "Charge from the grid when the sun will not fill the pack",
        show: (s) => s.system.strategy === "tou_arbitrage" || s.system.strategy === "export_arbitrage",
        warn: (s) => (s.system.gridCharge
          ? "Not permitted under California's Net Billing paired-storage agreement; shown for comparison only. "
            + "Battery export is disabled while this is on, because grid energy cannot earn an export credit."
          : null) },
      { path: "system.exportThreshold", kind: "range", label: "Sell to the grid above", min: 0, max: 2, step: 0.05, money: 2, unit: " /kWh",
        show: (s) => s.system.strategy === "export_arbitrage" },
      { path: "system.ngom", kind: "check", label: "Net Generation Output Meter (removes the export cap)",
        note: "Without one, paired storage under 10 kW has its monthly export credit capped at the utility's "
          + "estimate of PV production, and the excess is forfeited from the most expensive hours first. "
          + "Worth it if the battery is meant to sell into the evening." },
    ] },
    { group: "Search space", open: true, items: [
      { path: "ui.objective", kind: "select", label: "Optimise for", opts: [
        { v: "npv", t: "Most NPV vs. investing" }, { v: "lifetime", t: "Lowest lifetime cost" },
        { v: "irr", t: "Highest IRR" }, { v: "payback", t: "Fastest payback" }] },
      { path: "system.maxPanels", kind: "range", label: "Most panels to consider", min: 4, max: 80, step: 1,
        footnote: (s) => {
          const cap = s.roof.planes.reduce((a, p) => a + p.maxPanels, 0);
          return cap ? `Your roof faces hold ${cap} panels in total.` : "";
        } },
      { path: "system.maxBatteries", kind: "range", label: "Most batteries to consider", min: 0, max: 8, step: 1 },
      { path: "system.override.batteries", kind: "number", label: "Override: batteries", min: -1, max: 12, step: 1,
        note: "−1 means “let the optimiser choose”. Clicking a cell fills this in." },
    ] },
    { group: "Typical day", open: true, items: [
      { path: "ui.season", kind: "seg", label: "Season", opts: [{ v: 0, t: "Summer" }, { v: 1, t: "Winter" }] },
      { path: "ui.weatherKey", kind: "select", label: "Weather scenario",
        opts: ctx.weatherOptions || [{ v: "tmy", t: "TMY (typical year)" }] },
    ] },
  ];
}

export function mount(pane) {
  clear(pane);

  pane.appendChild(card({
    id: "heat-card",
    title: "Which system size wins",
    tag: { id: "heat-obj", text: "max NPV" },
    sub: "Every cell is a full hourly simulation of your own meter history. Click one to override the "
      + "optimiser and price that system instead.",
    body: [
      el("div.heat-wrap", {}, [el("div.heat", { id: "heat", role: "grid", "aria-label": "Objective value by panel and battery count" })]),
      el("div.heat-legend", {}, [
        el("span", { id: "heat-lo", text: "—" }),
        el("span.heat-ramp", { id: "heat-ramp" }),
        el("span", { id: "heat-hi", text: "—" }),
        el("span", { style: "margin-left:auto", id: "heat-hint", text: "solid ring = optimum · dashed = your pick · columns are panels" }),
      ]),
      el("h3", { style: "margin:18px 0 2px", text: "Slices through the chosen system" }),
      el("div.chart-box", { style: "height:140px" }, [el("canvas", { id: "c-slice-p" })]),
      el("div.chart-box", { style: "height:140px" }, [el("canvas", { id: "c-slice-b" })]),
    ],
    dataView: { summary: "Show the full grid as a table", tableId: "t-heat" },
  }));

  pane.appendChild(card({
    id: "alloc-card",
    title: "Where the panels go",
    sub: "Panels are allocated face by face, greediest first: the model simulates one more panel on each face "
      + "and fills whichever earns most, until that face runs out of room.",
    body: [el("div.table-scroll", {}, [el("table", { id: "t-alloc" })])],
  }));

  pane.appendChild(card({
    id: "day-card",
    title: "A typical weekday, hour by hour",
    tag: { id: "day-season-tag", text: "summer" },
    sub: "Average weekday shape for the selected system. The band under the axis is the tariff period in "
      + "force at that hour.",
    body: [
      el("div.chart-box", { style: "height:250px" }, [el("canvas", { id: "c-day" })]),
      el("div", { id: "period-ribbon", "aria-hidden": "true" }),
      el("div.legend", { id: "l-day" }),
      el("div.chart-box", { style: "height:100px;margin-top:6px" }, [el("canvas", { id: "c-soc" })]),
    ],
    dataView: { summary: "Show the hourly table", tableId: "t-day" },
  }));
}

export function render(state, ctx) {
  if (!ctx.priced) return;

  renderHeatmap({
    hostId: "heat",
    priced: ctx.priced,
    selected: ctx.selected,
    objective: state.ui.objective,
    fin: state.fin,
    onPick: (panels, batteries) => ctx.actions.pickCell(panels, batteries),
  });

  renderAllocation(state, ctx);

  const tag = $("day-season-tag");
  if (tag) tag.textContent = state.ui.season === 0 ? "summer" : "winter";

  const detail = ctx.detail;
  if (detail && detail.typicalDay) {
    renderTypicalDay({
      day: detail.typicalDay[state.ui.season],
      schedule: detail.schedule && detail.schedule[state.ui.season === 0 ? "summer" : "winter"],
      flexLabel: state.flex.length ? state.flex[0].name : "Flexible load",
    });
  }
}

function renderAllocation(state, ctx) {
  const table = $("t-alloc");
  if (!table) return;
  clear(table);

  const cell = ctx.selected;
  const planes = state.roof.planes;
  // The engine returns panelsByPlane as an array aligned with planeIds; the
  // table wants it by id, and a single-face roof may carry neither.
  const alloc = {};
  const byPlane = cell && cell.panelsByPlane;
  if (Array.isArray(byPlane)) {
    const ids = cell.planeIds || planes.map((p) => p.id);
    ids.forEach((pid, i) => { alloc[pid] = byPlane[i] || 0; });
  } else if (byPlane && typeof byPlane === "object") {
    Object.assign(alloc, byPlane);
  }
  const pvByPlane = {};
  if (cell && Array.isArray(cell.pvKwhByPlane)) {
    (cell.planeIds || planes.map((p) => p.id)).forEach((pid, i) => { pvByPlane[pid] = cell.pvKwhByPlane[i]; });
  }
  if (!planes.length) {
    table.appendChild(el("tbody", {}, [el("tr", {}, [el("td", { text: "Define a roof face first." })])]));
    return;
  }

  table.appendChild(el("thead", {}, [el("tr", {}, [
    "Face", "Tilt / direction", "Panels", "of capacity", "kW DC", "kWh/yr", "Share of production",
  ].map((h, i) => el(i === 0 ? "th" : "th.n", { text: h })))]));

  const totalPv = cell ? cell.pvKwh || 0 : 0;
  table.appendChild(el("tbody", {}, planes.map((p) => {
    const n = alloc[p.id] ?? (cell && planes.length === 1 ? cell.panels : 0);
    const kwdc = (n * state.system.panelW) / 1000;
    const byPlane = pvByPlane[p.id] ?? null;
    return el("tr", {}, [
      el("td", { text: p.name }),
      el("td.n", { text: `${p.tilt}° / ${p.azimuth}°` }),
      el("td.n", { text: String(n) }),
      el("td.n", { text: fmtPct(p.maxPanels ? n / p.maxPanels : 0, 0) }),
      el("td.n", { text: fmtNum(kwdc, 2) }),
      el("td.n", { text: byPlane === null || byPlane === undefined ? "—" : fmtNum(byPlane, 0) }),
      el("td.n", { text: byPlane && totalPv ? fmtPct(byPlane / totalPv, 0) : "—" }),
    ]);
  })));

  const total = Object.values(alloc).reduce((a, b) => a + b, 0) || (cell ? cell.panels : 0);
  table.appendChild(el("tfoot", {}, [el("tr", {}, [
    el("td", { text: "Total" }),
    el("td.n", { text: "" }),
    el("td.n", { text: plural(total, "panel", "panels") }),
    el("td.n", { text: "" }),
    el("td.n", { text: cell ? fmtNum(cell.kwdc, 2) : "—" }),
    el("td.n", { text: cell ? fmtNum(cell.pvKwh, 0) : "—" }),
    el("td.n", { text: "" }),
  ])]));
}

export default { id, label, rail, mount, render };
