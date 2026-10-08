/* =============================================================================
 * blocks.js — the handful of repeated layout objects.
 *
 * Border, fill and radius are spent by role here rather than stamped on every
 * container: a `card` is a titled result surface, a `tile` is one figure in a
 * grid of figures, and plain text sits on the page with neither.
 * ========================================================================== */

import { el } from "./dom.js";

export function card({ id, title, tag, sub, body, dataView }) {
  const head = el("div.card-head", {}, [
    el("h2", { id: id ? id + "-h" : null, text: title }),
    tag ? el("span.tag", { id: typeof tag === "string" ? null : tag.id, text: typeof tag === "string" ? tag : tag.text }) : null,
  ]);
  const node = el("section.card", { id, "aria-labelledby": id ? id + "-h" : null }, [
    head,
    sub ? el("p.card-sub", { text: sub }) : null,
    ...[].concat(body || []),
    dataView ? el("details.data-view", {}, [
      el("summary", { text: dataView.summary || "Show the numbers as a table" }),
      el("div.table-scroll", {}, [el("table", { id: dataView.tableId })]),
    ]) : null,
  ]);
  return node;
}



export function tiles(id) { return el("div.tiles", { id }); }

export function tile({ k, v, d, key }) {
  return el("div.tile" + (key ? ".key" : ""), {}, [
    el("span.k", { text: k }),
    el("span.v.num", { text: v }),
    el("span.d", { text: d || "" }),
  ]);
}

export function kv(pairs) {
  const node = el("dl.kv");
  for (const [k, v] of pairs) {
    node.appendChild(el("dt", { text: k }));
    node.appendChild(el("dd", { text: v }));
  }
  return node;
}

export default { card, tiles, tile, kv };

/**
 * The one disclaimer: under the dashboard, on the landing page and in the
 * copied summary, in the same words everywhere.
 */
export const DISCLAIMER = "Estimates from a model, not a quote and not financial or tax advice. Utility rates, "
  + "export credits and incentives change, sometimes several times a year. Before you sign anything, verify the "
  + "rates with your utility, the price and production with an installer, and any tax treatment with a tax professional.";
