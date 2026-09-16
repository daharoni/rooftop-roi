/* =============================================================================
 * charts/bills.js — where the bill goes, month by month.
 *
 * Two stacks per month: the bill today on the left, the bill with the system
 * on the right, both broken into the lines the tariff actually charges for.
 * The same component keeps the same colour in both stacks — that is the whole
 * point of the pairing — and a 2 px surface-coloured gap separates segments
 * so adjacent fills never blend into one block.
 * ========================================================================== */

import { $, el, clear, T, alpha } from "../ui/dom.js";
import { fmtCompact, fmtMoney, fmtNum } from "../ui/format.js";
import { draw, baseOpts, legendHTML } from "./base.js";

const PARTS = [
  { k: "fixed", label: "Base services charge", tok: "ink-3" },
  { k: "energy", label: "Energy charges", tok: "s2" },
  { k: "exportCreditUsed", label: "Export credit", tok: "s1" },
  { k: "accPlus", label: "ACC Plus adder", tok: "s4" },
  { k: "baselineCredit", label: "Baseline credit", tok: "s3" },
  { k: "climateCredit", label: "Climate credit", tok: "s7" },
  { k: "trueUp", label: "Annual true-up", tok: "s5" },
];

export function renderMonthlyBills({ before, after, planLabel }) {
  if (!before || !after || !before.length) return;
  const labels = after.map((m) => (m.key || "").slice(2));
  const datasets = [];

  for (const [stack, rows] of [["before", before], ["after", after]]) {
    for (const p of PARTS) {
      datasets.push({
        label: (stack === "before" ? "Today · " : "With system · ") + p.label,
        stack,
        backgroundColor: p.tok === "ink-3" ? alpha(T["ink-3"], 0.5) : T[p.tok],
        data: rows.map((m) => m[p.k] || 0),
        borderColor: T.surface,
        borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
        borderSkipped: false,
      });
    }
  }

  draw("c-month", {
    type: "bar",
    data: { labels, datasets },
    options: baseOpts({
      scales: {
        x: { stacked: true, ticks: { font: { size: 9 } } },
        y: { stacked: true, ticks: { callback: fmtCompact } },
      },
      plugins: {
        tooltip: {
          filter: (c) => Math.abs(c.parsed.y) > 0.5,
          callbacks: { label: (c) => " " + c.dataset.label + ": " + fmtMoney(c.parsed.y, 2) },
        },
      },
    }),
  });

  legendHTML("l-month", PARTS.map((p) => ({
    label: p.label, color: p.tok === "ink-3" ? alpha(T["ink-3"], 0.5) : T[p.tok],
  })));
  const legend = $("l-month");
  if (legend) legend.appendChild(el("span", { style: "color:var(--ink-3)", text: "left bar of each pair = today · right bar = with the system" }));
  if ($("bill-plan") && planLabel) $("bill-plan").textContent = planLabel;

  const table = $("t-month");
  if (!table) return;
  clear(table);
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: "Month" }), el("th.n", { text: "Bill today" }), el("th.n", { text: "With system" }),
    el("th.n", { text: "Saved" }), el("th.n", { text: "Import kWh" }), el("th.n", { text: "Export kWh" }),
  ])]));
  table.appendChild(el("tbody", {}, after.map((m, i) => {
    const b = before[i] || {};
    return el("tr", {}, [
      el("td", { text: m.key || "" }),
      el("td.n", { text: fmtMoney(b.bill, 2) }),
      el("td.n", { text: fmtMoney(m.bill, 2) }),
      el("td.n", { text: fmtMoney((b.bill || 0) - (m.bill || 0), 2) }),
      el("td.n", { text: fmtNum(m.importKwh, 0) }),
      el("td.n", { text: fmtNum(m.exportKwh, 0) }),
    ]);
  })));
}

/** Same system, every rate plan / every generation provider. */
export function renderComparisonTable(targetId, rows, { selectedId, bestBy, labelHead }) {
  const table = $(targetId);
  if (!table) return;
  clear(table);
  if (!rows || !rows.length) {
    table.appendChild(el("tbody", {}, [el("tr", {}, [el("td", { text: "No alternatives modelled yet." })])]));
    return;
  }
  const best = rows.reduce((a, b) => (bestBy(b) > bestBy(a) ? b : a));
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: labelHead }), el("th.n", { text: "Bill today" }),
    el("th.n", { text: "With system" }), el("th.n", { text: "Saved / yr" }),
  ])]));
  table.appendChild(el("tbody", {}, rows.map((r) => el("tr" + (r === best ? ".is-best" : ""), {}, [
    el("td", {}, [r.name, r.id === selectedId ? el("span.tag", { text: "yours" }) : null]),
    el("td.n", { text: fmtMoney(r.baselineBill) }),
    el("td.n", { text: fmtMoney(r.bill) }),
    el("td.n", { text: fmtMoney((r.baselineBill || 0) - (r.bill || 0)) }),
  ]))));
  return best;
}

export default { renderMonthlyBills, renderComparisonTable };
