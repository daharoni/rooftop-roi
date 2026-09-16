/* =============================================================================
 * charts/heatmap.js — the optimiser surface.
 *
 * Total panels across the columns, batteries up the rows, one full hourly
 * simulation behind every cell.  The scale is diverging because the quantity
 * is polar: above zero the roof beat the market, below zero it did not, and
 * the midpoint is a real, meaningful zero rather than a median.  Each arm is
 * normalised on its own extreme so a single spectacular cell cannot flatten
 * the other half of the surface.
 *
 * Clicking a cell overrides the optimiser; the table twin beneath prints the
 * whole surface for anyone who cannot or does not want to read colour.
 * ========================================================================== */

import { $, el, clear, T, mix } from "../ui/dom.js";
import { fmtCompact, fmtMoney, fmtPct, fmtYears, plural } from "../ui/format.js";
import { lineChart } from "./base.js";

export const OBJ_LABEL = {
  npv: "max NPV", lifetime: "lowest lifetime cost", irr: "max IRR", payback: "fastest payback",
};

/** Every objective restated as "higher is better, zero = no better than nothing". */
export function goodness(cell, objective, fin) {
  if (objective === "irr") return cell.irr === null || cell.irr === undefined ? -1 : cell.irr - fin.investReturn;
  if (objective === "payback") {
    return cell.payback === null || cell.payback === undefined ? -fin.horizon : fin.horizon - cell.payback;
  }
  if (objective === "lifetime") {
    return (cell.finance ? cell.finance.lifetimeCostNoSystem : 0) - (cell.lifetimeCost || 0);
  }
  return cell.npv;
}

export function sliceFmt(v, objective) {
  if (objective === "irr") return fmtPct(v, 0);
  if (objective === "payback") return v.toFixed(0) + " yr";
  return fmtCompact(v);
}

const findCell = (priced, p, b) => priced.cells.find((c) => c.panels === p && c.batteries === b);

export function renderHeatmap({ hostId, priced, selected, objective, fin, onPick }) {
  const host = $(hostId);
  if (!host || !priced || !priced.cells || !priced.cells.length) return;

  const g = (c) => goodness(c, objective, fin);
  const values = priced.cells.map(g).filter(Number.isFinite);
  const hi = Math.max(1e-6, Math.max(...values));
  const lo = Math.min(-1e-6, Math.min(...values));
  const norm = (v) => (v >= 0 ? v / hi : v / -lo);
  const colorFor = (v) => mix(T["neutral-mid"], v >= 0 ? T.s1 : T.s8, 0.1 + 0.9 * Math.min(1, Math.abs(norm(v))));

  const panels = priced.panelList, batteries = priced.battList;
  clear(host);
  host.style.gridTemplateColumns = `34px repeat(${panels.length}, minmax(8px, 1fr))`;
  host.appendChild(el("div.heat-axis.v"));
  for (const p of panels) host.appendChild(el("div.heat-axis.h", { text: p % 5 === 0 ? String(p) : "" }));

  for (const b of [...batteries].reverse()) {
    host.appendChild(el("div.heat-axis.v", { text: b + "b" }));
    for (const p of panels) {
      const cell = findCell(priced, p, b);
      if (!cell) { host.appendChild(el("div")); continue; }
      const v = g(cell);
      const isBest = cell.panels === priced.best.panels && cell.batteries === priced.best.batteries;
      const isSel = selected && cell.panels === selected.panels && cell.batteries === selected.batteries;
      host.appendChild(el("button.heat-cell", {
        type: "button",
        style: `background:${colorFor(v)}`,
        "data-p": p, "data-b": b,
        "data-best": isBest ? "1" : null,
        "data-sel": isSel ? "1" : null,
        title: `${p} panels, ${plural(b, "battery", "batteries")} — NPV ${fmtMoney(cell.npv)}, payback ${fmtYears(cell.payback)}`,
        "aria-label": `${p} panels, ${plural(b, "battery", "batteries")}, NPV ${fmtMoney(cell.npv)}`,
        on: { click: () => onPick && onPick(p, b) },
      }));
    }
  }

  const ramp = $("heat-ramp");
  if (ramp) {
    clear(ramp);
    for (const t of [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]) {
      ramp.appendChild(el("span", {
        style: `background:${mix(T["neutral-mid"], t >= 0 ? T.s1 : T.s8, 0.1 + 0.9 * Math.abs(t))}`,
      }));
    }
  }
  if ($("heat-lo")) $("heat-lo").textContent = "worst " + sliceFmt(lo, objective);
  if ($("heat-hi")) $("heat-hi").textContent = "best " + sliceFmt(hi, objective);
  if ($("heat-obj")) $("heat-obj").textContent = OBJ_LABEL[objective] || objective;

  renderSlices(priced, selected, objective, fin);
  renderHeatTable(priced, selected);
}

function renderSlices(priced, sel, objective, fin) {
  if (!sel) return;
  const g = (c) => goodness(c, objective, fin);
  const alongP = priced.panelList.map((p) => { const c = findCell(priced, p, sel.batteries); return c ? g(c) : null; });
  const alongB = priced.battList.map((b) => { const c = findCell(priced, sel.panels, b); return c ? g(c) : null; });
  const fmt = (v) => sliceFmt(v, objective);

  lineChart("c-slice-p", priced.panelList, [{ label: "panels", data: alongP, color: T.s1 }], {
    xTitle: "panels, holding storage at " + plural(sel.batteries, "battery", "batteries"),
    yFmt: fmt, marker: priced.panelList.indexOf(sel.panels),
  });
  lineChart("c-slice-b", priced.battList, [{ label: "batteries", data: alongB, color: T.s2 }], {
    xTitle: "batteries, holding the array at " + plural(sel.panels, "panel", "panels"),
    yFmt: fmt, marker: priced.battList.indexOf(sel.batteries),
  });
}

function renderHeatTable(priced, sel) {
  const table = $("t-heat");
  if (!table) return;
  clear(table);
  const head = el("tr", {}, [el("th", { text: "Panels" }),
    ...priced.battList.map((b) => el("th.n", { text: b + " batt" }))]);
  const body = el("tbody", {}, priced.panelList.map((p) => el("tr", {}, [
    el("td.n", { text: String(p) }),
    ...priced.battList.map((b) => {
      const c = findCell(priced, p, b);
      const on = c && sel && c.panels === sel.panels && c.batteries === sel.batteries;
      return el("td.n", { text: c ? fmtCompact(c.npv) : "—", style: on ? "font-weight:600" : null });
    }),
  ])));
  table.appendChild(el("thead", {}, [head]));
  table.appendChild(body);
}

export default { renderHeatmap, goodness, sliceFmt, OBJ_LABEL };
