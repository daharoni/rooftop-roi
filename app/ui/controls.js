/* =============================================================================
 * controls.js — the left rail's widget framework.
 *
 * A control is declared, not built: a path into state, a kind, and the labels
 * and bounds a person needs to use it.  The rail for a tab is a list of those
 * declarations, so adding a knob is one line and it is automatically wired to
 * state, to the hash, and to the right cost class (see `reason`).
 *
 * `reason` is what keeps the page responsive: "finance" re-prices cached
 * simulation results in about 15 ms and renders immediately; "sim" queues a
 * debounced worker round-trip and dims the stale render until it returns.
 * ========================================================================== */

import { el, $, clear } from "./dom.js";
import { fmtNum } from "./format.js";
import { getPath } from "../state.js";

function defaultReason(path) {
  if (path.startsWith("fin.")) return "finance";
  if (path.startsWith("ui.")) return "ui";
  return "sim";
}

/** How a control prints its own value beside its label. */
export function formatValue(spec, v) {
  if (spec.fmt) return spec.fmt(v);
  if (spec.pct !== undefined) return (v * 100).toFixed(spec.pct) + "%" + (spec.unit || "");
  if (spec.money !== undefined) return "$" + Number(v).toFixed(spec.money) + (spec.unit || "");
  if (spec.hour) return String(v).padStart(2, "0") + ":00";
  const dp = spec.dp !== undefined ? spec.dp : (spec.step && spec.step < 1 ? 1 : 0);
  return fmtNum(Number(v), dp) + (spec.unit || "");
}

export class ControlRail {
  /**
   * @param root   the element to build into
   * @param onSet  (path, value, spec) => void — the only way a control writes
   */
  constructor(root, onSet) {
    this.root = root;
    this.onSet = onSet;
    this.groups = [];
    this.specs = [];
  }

  /** Rebuild the rail from a new group list (called on every tab change). */
  build(groups, state) {
    this.groups = groups || [];
    this.specs = this.groups.flatMap((g) => g.items);
    clear(this.root);
    const wide = typeof window === "undefined" || window.innerWidth > 1000;
    // The rail is an accordion: one group open at a time, so a long list of
    // knobs never pushes the one being dragged off the bottom of the screen.
    // The first group marked open starts open; opening another closes it.
    let opened = false;
    for (const g of this.groups) {
      const body = el("div.group-body");
      for (const spec of g.items) body.appendChild(this._widget(spec, state));
      const startOpen = g.open !== false && wide && !opened;
      if (startOpen) opened = true;
      const details = el("details.group", { open: startOpen }, [
        el("summary", { text: g.group }), body,
      ]);
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        for (const other of this.root.querySelectorAll("details.group[open]")) {
          if (other !== details) other.open = false;
        }
      });
      this.root.appendChild(details);
    }
    this.refresh(state);
  }

  _id(spec) { return "ctl-" + spec.path.replace(/\./g, "-"); }

  _widget(spec, state) {
    const id = this._id(spec);
    const value = getPath(state, spec.path);
    const wrap = el("div.ctl", { "data-path": spec.path });
    const emit = (v) => this.onSet(spec.path, v, spec);

    if (spec.kind === "check") {
      const box = el("input", { type: "checkbox", id, checked: !!value, on: { change: (e) => emit(e.target.checked) } });
      wrap.appendChild(el("label.switch", { htmlFor: id }, [box, el("span", { text: spec.label })]));
    } else if (spec.kind === "seg") {
      wrap.appendChild(this._head(spec, id, "").row);
      const seg = el("div.seg", { id, role: "group", "aria-label": spec.label });
      for (const o of spec.opts) {
        seg.appendChild(el("button", {
          type: "button", text: o.t, "aria-pressed": String(o.v === value),
          on: { click: () => emit(o.v) },
        }));
      }
      wrap.appendChild(seg);
    } else if (spec.kind === "select") {
      wrap.appendChild(this._head(spec, id, "").row);
      const sel = el("select", { id, on: { change: (e) => emit(e.target.value) } });
      for (const o of spec.opts || []) sel.appendChild(el("option", { value: String(o.v), text: o.t }));
      sel.value = String(value);
      wrap.appendChild(sel);
    } else if (spec.kind === "number" || spec.kind === "text" || spec.kind === "date") {
      wrap.appendChild(this._head(spec, id, "").row);
      wrap.appendChild(el("input", {
        type: spec.kind, id, min: spec.min, max: spec.max, step: spec.step,
        placeholder: spec.placeholder, value: value ?? "",
        on: { change: (e) => emit(spec.kind === "number" ? Number(e.target.value) : e.target.value) },
      }));
    } else if (spec.kind === "button") {
      wrap.appendChild(el("button.btn", { type: "button", id, text: spec.label, on: { click: () => emit(true) } }));
    } else {
      const head = this._head(spec, id, formatValue(spec, value));
      wrap.appendChild(head.row);
      wrap.appendChild(el("input", {
        type: "range", id, min: spec.min, max: spec.max, step: spec.step, value,
        on: {
          input: (e) => {
            // Paint the number immediately; the simulation catches up behind it.
            head.val.textContent = formatValue(spec, Number(e.target.value));
            emit(Number(e.target.value));
          },
        },
      }));
    }

    if (spec.note) wrap.appendChild(el("div.ctl-note", { text: spec.note }));
    if (spec.warn) wrap.appendChild(el("div.ctl-warn", { id: "warn-" + id, hidden: true }));
    if (spec.footnote) wrap.appendChild(el("div.ctl-note", { id: "foot-" + id }));
    return wrap;
  }

  _head(spec, id, valueText) {
    const val = el("span.ctl-val", { text: valueText });
    const row = el("div.ctl-head", {}, [el("label", { htmlFor: id, text: spec.label }), val]);
    return { row, val };
  }

  /** Re-sync every widget's value, visibility, warning and footnote. */
  refresh(state) {
    for (const spec of this.specs) {
      const wrap = this.root.querySelector(`[data-path="${CSS.escape(spec.path)}"]`);
      if (!wrap) continue;
      wrap.hidden = !!(spec.show && !spec.show(state));
      const id = this._id(spec);

      if (spec.warn) {
        const node = $("warn-" + id), msg = spec.warn(state);
        if (node) { node.textContent = msg || ""; node.hidden = !msg; }
      }
      if (spec.footnote) {
        const node = $("foot-" + id);
        if (node) node.textContent = spec.footnote(state) || "";
      }

      const node = $(id);
      if (!node) continue;
      const v = getPath(state, spec.path);
      if (spec.kind === "check") node.checked = !!v;
      else if (spec.kind === "seg") {
        Array.from(node.children).forEach((b, i) => b.setAttribute("aria-pressed", String(spec.opts[i].v === v)));
      } else if (spec.kind === "select") {
        if (spec.opts && !spec.opts.some((o) => String(o.v) === String(node.value))) this._refillSelect(node, spec, v);
        node.value = String(v);
      } else if (spec.kind === "button") {
        /* nothing to sync */
      } else {
        if (document.activeElement !== node) node.value = v ?? "";
        const label = wrap.querySelector(".ctl-val");
        if (label && spec.kind !== "number" && spec.kind !== "text" && spec.kind !== "date") {
          label.textContent = formatValue(spec, v);
        }
      }
    }
  }

  /** Options can arrive after the rail is built (the tariff library loads async). */
  setOptions(path, opts, state) {
    const spec = this.specs.find((s) => s.path === path);
    if (!spec) return;
    spec.opts = opts;
    const node = $(this._id(spec));
    if (node) this._refillSelect(node, spec, getPath(state, path));
  }

  _refillSelect(node, spec, value) {
    clear(node);
    for (const o of spec.opts || []) node.appendChild(el("option", { value: String(o.v), text: o.t }));
    node.value = String(value);
  }
}

export default { ControlRail, formatValue };
