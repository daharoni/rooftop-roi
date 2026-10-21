/* =============================================================================
 * charts/day.js — a typical weekday, hour by hour, plus the week of load
 * reshaping on the Loads tab.
 *
 * The day chart stacks who served the house (solar / battery / grid) as areas
 * and draws production, export and flexible load as lines over the top: the
 * stack answers "where did my kWh come from", the lines answer "what did the
 * array and the car do", and both share one kWh axis.  Solar keeps one hue: the
 * production line and the part of it the house used are the same colour.  The
 * tariff period in force is a ribbon under the axis, drawn as one price ramp
 * (pale for cheap, red for on-peak) so it borrows no series colour.
 * ========================================================================== */

import { $, el, clear, T, alpha } from "../ui/dom.js";
import { fmtNum, fmtPct } from "../ui/format.js";
import { draw, baseOpts, legendHTML } from "./base.js";

const PERIOD_NAMES = { on: "On-peak", mid: "Mid-peak", off: "Off-peak", super_off: "Super-off-peak" };
const PERIOD_ORDER = ["on", "mid", "off", "super_off"];
const periodColors = () => ({ on: T.s8, mid: alpha(T.s8, 0.5), off: alpha(T["ink-3"], 0.35), super_off: alpha(T["ink-3"], 0.15) });

export function renderTypicalDay({ day, schedule, flexLabel }) {
  if (!day || !day.hours) return;
  const hours = day.hours;
  const labels = hours.map((h) => String(h.hour).padStart(2, "0"));
  const pvToLoad = hours.map((h) => Math.min(h.pv || 0, h.load || 0));
  const fromBattery = hours.map((h) => h.discharge || 0);
  const fromGrid = hours.map((h) => h.gridImport || 0);
  // The three sources are stacked by hand (each area fills to the one below), so
  // the lines drawn over them keep their own values on the same axis.
  const upToBattery = pvToLoad.map((v, i) => v + fromBattery[i]);
  const upToGrid = upToBattery.map((v, i) => v + fromGrid[i]);

  draw("c-day", {
    type: "line",
    data: {
      labels,
      datasets: [
        area("Load served by solar", pvToLoad, pvToLoad, T.s2, 0.3, "origin"),
        area("by battery", upToBattery, fromBattery, T.s3, 0.45, "-1"),
        area("by the grid", upToGrid, fromGrid, T["ink-3"], 0.3, "-1"),
        line("Solar produced", hours.map((h) => h.pv || 0), T.s2),
        line("Exported", hours.map((h) => h.gridExport || 0), T.s1, [4, 3]),
        line(flexLabel || "Flexible load", hours.map((h) => h.flex ?? h.ev ?? 0), T.s7),
      ],
    },
    options: baseOpts({
      scales: {
        y: { stacked: false, beginAtZero: true, ticks: { callback: (v) => v + " kWh" } },
      },
      plugins: {
        tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtNum((c.dataset.own || c.dataset.data)[c.dataIndex], 2) + " kWh" } },
      },
    }),
  });

  const cols = periodColors();
  const periods = schedule ? PERIOD_ORDER.filter((p) => schedule.includes(p)) : [];
  legendHTML("l-day", [
    { label: "Load served by solar", color: alpha(T.s2, 0.3) },
    { label: "by battery", color: alpha(T.s3, 0.45) },
    { label: "by the grid", color: alpha(T["ink-3"], 0.3) },
    { label: "Solar produced", color: T.s2, line: true },
    { label: "Exported", color: T.s1, line: true },
    { label: flexLabel || "Flexible load", color: T.s7, line: true },
    ...periods.map((p) => ({ label: PERIOD_NAMES[p], color: cols[p], period: true })),
  ]);

  draw("c-soc", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Battery state of charge", data: hours.map((h) => (h.soc || 0) * 100),
        borderColor: T.s3, backgroundColor: alpha(T.s3, 0.12), fill: true, borderWidth: 2, tension: 0,
      }],
    },
    options: baseOpts({
      scales: { y: { min: 0, max: 100, ticks: { stepSize: 50, callback: (v) => v + "%" } } },
      plugins: { tooltip: { callbacks: { label: (c) => " state of charge: " + c.parsed.y.toFixed(0) + "%" } } },
    }),
  });

  const ribbon = $("period-ribbon");
  if (ribbon && schedule) {
    clear(ribbon);
    for (const p of schedule) {
      ribbon.appendChild(el("span", {
        title: PERIOD_NAMES[p] || p,
        style: `flex:1;background:${cols[p] || T.grid}`,
      }));
    }
  }

  const table = $("t-day");
  if (!table) return;
  clear(table);
  table.appendChild(el("thead", {}, [el("tr", {}, [
    "Hour", "Load", "Flexible", "Solar", "Batt in", "Batt out", "Import", "Export", "SOC",
  ].map((h, i) => el(i === 0 ? "th" : "th.n", { text: h })))]));
  table.appendChild(el("tbody", {}, hours.map((h) => el("tr", {}, [
    el("td.n", { text: String(h.hour).padStart(2, "0") + ":00" }),
    ...[h.load, h.flex ?? h.ev, h.pv, h.charge, h.discharge, h.gridImport, h.gridExport]
      .map((v) => el("td.n", { text: fmtNum(v || 0, 2) })),
    el("td.n", { text: fmtPct(h.soc || 0, 0) }),
  ]))));
}

/* `data` is the top of the band (cumulative); `own` is this source's share, for the tooltip. */
function area(label, data, own, color, a, fill) {
  return {
    label, data, own, borderColor: "transparent", backgroundColor: alpha(color, a),
    fill, borderWidth: 0, pointRadius: 0, tension: 0,
  };
}

// Straight segments: these are hourly averages, and a curve would invent values between them.
function line(label, data, color, dash) {
  return {
    label, data, borderColor: color, backgroundColor: "transparent", fill: false,
    borderWidth: 2, borderDash: dash, pointRadius: 0, tension: 0,
  };
}

/**
 * The Loads tab's before/after: one typical week of household draw, as
 * recorded and as rescheduled.  Energy is conserved exactly, so the two
 * curves enclose the same area — what moves is when.
 */
export function renderWeek({ before, after, hourLabels }) {
  if (!before || !after) return;
  const labels = hourLabels || before.map((_, i) => (i % 24 === 12 ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(i / 24)] : ""));
  draw("c-week", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "As recorded", data: before, borderColor: alpha(T["ink-3"], 0.9), borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.2 },
        { label: "As scheduled", data: after, borderColor: T.s1, backgroundColor: alpha(T.s1, 0.12), borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2 },
      ],
    },
    options: baseOpts({
      scales: {
        x: { ticks: { autoSkip: false, font: { size: 12 } } },
        y: { beginAtZero: true, ticks: { callback: (v) => v + " kWh" } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtNum(c.parsed.y, 2) + " kWh" } } },
    }),
  });
  legendHTML("l-week", [
    { label: "As recorded", color: alpha(T["ink-3"], 0.9), line: true },
    { label: "As scheduled", color: T.s1, line: true },
  ]);
}

export default { renderTypicalDay, renderWeek };
