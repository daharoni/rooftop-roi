/* =============================================================================
 * charts/base.js — the house style for every Chart.js figure on the page.
 *
 * Conventions carried over from the prototype and kept everywhere:
 *   - one y-scale per chart, never two;
 *   - thin marks, recessive grid, axis text in ink-3, series text in ink-2;
 *   - a legend whenever two or more series are drawn, plus a table twin in a
 *     <details> beneath, because three of the categorical slots sit below 3:1
 *     against the light surface and identity must never be colour-alone;
 *   - hover is on by default, in index mode, so a reader can interrogate any
 *     hour without clicking.
 * ========================================================================== */

import { $, el, clear, T, alpha } from "../ui/dom.js";
import { fmtNum } from "../ui/format.js";

const charts = new Map();

export function destroyChart(id) {
  const c = charts.get(id);
  if (c) { c.destroy(); charts.delete(id); }
}

export function destroyAll() {
  for (const c of charts.values()) c.destroy();
  charts.clear();
}

/**
 * Draw into the canvas with this id.  A chart already on that canvas is updated
 * in place, so Chart.js animates each line from where it was to where it now
 * belongs and a knob sweep reads as the lines sliding, not re-rising from the
 * axis on every render.  A fresh canvas (first paint, or a tab rebuilt) gets a
 * new chart and the one-time rise.
 */
export function draw(id, config) {
  const node = $(id);
  if (!node || typeof Chart === "undefined") return null;
  const prev = charts.get(id);
  if (prev && prev.canvas === node && prev.config.type === config.type) {
    prev.data.labels = config.data.labels;
    const ds = prev.data.datasets, next = config.data.datasets;
    ds.length = Math.min(ds.length, next.length);
    next.forEach((d, i) => {
      if (!ds[i]) { ds.push(d); return; }
      // Keep the dataset object so the transition starts from its current values.
      for (const k of Object.keys(ds[i])) if (!(k in d)) delete ds[i][k];
      Object.assign(ds[i], d);
    });
    prev.options = config.options;
    prev.update();
    return prev;
  }
  destroyChart(id);
  const chart = new Chart(node.getContext("2d"), config);
  charts.set(id, chart);
  return chart;
}

function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]);
    else a[k] = b[k];
  }
  return a;
}

export function baseOpts(extra) {
  const opts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? false : { duration: 220 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: T.surface, titleColor: T.ink, bodyColor: T["ink-2"],
        borderColor: T.rule, borderWidth: 1, padding: 9, cornerRadius: 4,
        titleFont: { weight: "600" }, displayColors: true, boxWidth: 9, boxHeight: 9,
      },
    },
    scales: {
      x: {
        grid: { display: false }, border: { color: T.rule },
        ticks: { color: T["ink-3"], font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        grid: { color: T.grid, drawTicks: false }, border: { display: false },
        ticks: { color: T["ink-3"], font: { size: 10 }, padding: 6 },
      },
    },
    elements: { line: { borderWidth: 2, tension: 0.15 }, point: { radius: 0, hitRadius: 12, hoverRadius: 4 } },
  };
  return deepMerge(opts, extra || {});
}

export function lineChart(id, labels, series, opt = {}) {
  return draw(id, {
    type: "line",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color,
        backgroundColor: s.fill ? alpha(s.color, 0.1) : "transparent",
        fill: !!s.fill,
        borderDash: s.dash || undefined,
        borderWidth: s.width || 2,
        spanGaps: true,
        pointRadius: opt.marker === undefined ? 0 : (c) => (c.dataIndex === opt.marker ? 4 : 0),
        pointBackgroundColor: s.color,
        pointBorderColor: T.surface,
        pointBorderWidth: 2,
      })),
    },
    options: baseOpts({
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => " " + c.dataset.label + ": " + (opt.yFmt ? opt.yFmt(c.parsed.y) : fmtNum(c.parsed.y, 1)),
          },
        },
      },
      scales: {
        x: { title: opt.xTitle ? { display: true, text: opt.xTitle, color: T["ink-3"], font: { size: 10 } } : undefined },
        y: {
          beginAtZero: !!opt.zero,
          stacked: !!opt.stacked,
          ticks: { callback: (v) => (opt.yFmt ? opt.yFmt(v) : v) },
        },
      },
    }, opt.options),
  });
}

export function legendHTML(targetId, items) {
  const node = $(targetId);
  if (!node) return;
  clear(node);
  for (const item of items) {
    node.appendChild(el("span.key", {}, [
      el("span" + (item.line ? ".sw.line" : ".sw"), { style: `background:${item.color}` }),
      item.label,
    ]));
  }
}

export default { draw, baseOpts, lineChart, legendHTML, destroyChart, destroyAll };
