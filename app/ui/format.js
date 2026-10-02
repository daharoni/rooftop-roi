/* =============================================================================
 * format.js — every number the page prints goes through here.
 *
 * One rule: a figure never appears without its unit, and money keeps its sign
 * as a real minus (U+2212), not a hyphen, so columns of tabular figures line up.
 * ========================================================================== */

const NBSP = " ";

export function fmtMoney(v, dp) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const s = Math.abs(v) >= 1000 && !dp
    ? Math.round(Math.abs(v)).toLocaleString("en-US")
    : Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  return (v < 0 ? "−$" : "$") + s;
}

/** Compact money for axes, tiles and heat-map legends: $1.2M, $34k, $812. */
export function fmtCompact(v) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(a >= 1e7 ? 0 : 2) + "M";
  if (a >= 1e4) return sign + "$" + Math.round(a / 1e3) + "k";
  return sign + "$" + Math.round(a).toLocaleString("en-US");
}

export function fmtNum(v, dp) {
  return (v === null || v === undefined || !isFinite(v)) ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
}

export function fmtPct(v, dp) {
  return (v === null || v === undefined || !isFinite(v)) ? "—"
    : (v * 100).toFixed(dp === undefined ? 1 : dp) + "%";
}

export function fmtKwh(v, dp) { return fmtNum(v, dp === undefined ? 0 : dp) + NBSP + "kWh"; }
export function fmtKw(v, dp) { return fmtNum(v, dp === undefined ? 1 : dp) + NBSP + "kW"; }

export function fmtYears(v) {
  return (v === null || v === undefined || !isFinite(v)) ? "never" : v.toFixed(1) + NBSP + "yr";
}

export function fmtHour(h) { return String(h).padStart(2, "0") + ":00"; }

export function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

/** Escape anything that came out of a data file before it meets innerHTML. */
export function esc(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export default { fmtMoney, fmtCompact, fmtNum, fmtPct, fmtKwh, fmtKw, fmtYears, fmtHour, plural, esc };
