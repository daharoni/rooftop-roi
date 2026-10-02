/* =============================================================================
 * dom.js — the four DOM helpers this app actually needs, and the theme-token
 * reader every chart draws through.
 *
 * Charts are drawn on a canvas, which cannot inherit a CSS variable, so the
 * token values are read once out of the computed style of :root and re-read
 * whenever the OS theme flips.
 * ========================================================================== */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** el("div.card", { id: "x" }, [child, "text"]) */
export function el(spec, attrs, kids) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k in node && k !== "list" && typeof v !== "object") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of [].concat(kids || [])) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

const TOKEN_KEYS = [
  "--ink", "--ink-2", "--ink-3", "--grid", "--rule", "--surface", "--page", "--sunken",
  "--neutral-mid", "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8",
  "--good-text", "--critical", "--warning",
];

export const T = {};

export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of TOKEN_KEYS) T[k.replace("--", "")] = cs.getPropertyValue(k).trim();
  return T;
}

function hexToRgb(h) {
  h = String(h || "#000").replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function alpha(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`;
}

let toastTimer = null;
export function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) { node = el("div.toast", { role: "status", "aria-live": "polite" }); document.body.appendChild(node); }
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}

export default { $, $$, el, clear, T, readTokens, alpha, mix, toast };
