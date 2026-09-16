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
 *
 * Every widget built here is kept in `this.widgets` with references to the
 * nodes that change, because `refresh` runs on every render and walking the
 * DOM for sixty controls each time is work the page does not need to do.
 * ========================================================================== */

import { el, clear } from "./dom.js";
import { fmtNum } from "./format.js";
import { getPath } from "../state.js";

/** The cost class a control's path implies, unless its spec names another. */
export function defaultReason(path) {
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

/** Two option lists are the same list if they name the same values in order. */
function sameOptions(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((o, i) => String(o.v) === String(b[i].v) && o.t === b[i].t);
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
    this.widgets = [];
  }

  /** Rebuild the rail from a new group list (called on every tab change). */
  build(groups, state) {
    this.groups = groups || [];
    this.widgets = [];
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

  /**
   * Build one widget and record what `refresh` will need to touch: the wrapper
   * (shown or hidden), the control itself, its printed value, and its warning
   * and footnote lines.
   */
  _widget(spec, state) {
    const id = this._id(spec);
    const value = getPath(state, spec.path);
    const wrap = el("div.ctl", { "data-path": spec.path });
    const emit = (v) => this.onSet(spec.path, v, spec);
    const w = { spec, wrap, control: null, value: null, warn: null, foot: null };

    if (spec.kind === "check") {
      w.control = el("input", { type: "checkbox", id, checked: !!value, on: { change: (e) => emit(e.target.checked) } });
      wrap.appendChild(el("label.switch", { htmlFor: id }, [w.control, el("span", { text: spec.label })]));
    } else if (spec.kind === "seg") {
      wrap.appendChild(this._head(spec, id, "").row);
      w.control = el("div.seg", { id, role: "group", "aria-label": spec.label });
      for (const o of spec.opts) {
        w.control.appendChild(el("button", {
          type: "button", text: o.t, "aria-pressed": String(o.v === value),
          on: { click: () => emit(o.v) },
        }));
      }
      wrap.appendChild(w.control);
    } else if (spec.kind === "select") {
      wrap.appendChild(this._head(spec, id, "").row);
      w.control = el("select", { id, on: { change: (e) => emit(e.target.value) } });
      this._fillSelect(w.control, spec, value);
      wrap.appendChild(w.control);
    } else if (spec.kind === "number" || spec.kind === "text" || spec.kind === "date") {
      wrap.appendChild(this._head(spec, id, "").row);
      w.control = el("input", {
        type: spec.kind, id, min: spec.min, max: spec.max, step: spec.step,
        placeholder: spec.placeholder, value: value ?? "",
        on: { change: (e) => emit(spec.kind === "number" ? Number(e.target.value) : e.target.value) },
      });
      wrap.appendChild(w.control);
    } else if (spec.kind === "button") {
      wrap.appendChild(el("button.btn", { type: "button", id, text: spec.label, on: { click: () => emit(true) } }));
    } else {
      const head = this._head(spec, id, formatValue(spec, value));
      w.value = head.val;
      wrap.appendChild(head.row);
      w.control = el("input", {
        type: "range", id, min: spec.min, max: spec.max, step: spec.step, value,
        on: {
          input: (e) => {
            // Paint the number immediately; the simulation catches up behind it.
            head.val.textContent = formatValue(spec, Number(e.target.value));
            emit(Number(e.target.value));
          },
        },
      });
      wrap.appendChild(w.control);
    }

    if (spec.note) wrap.appendChild(el("div.ctl-note", { text: spec.note }));
    if (spec.warn) {
      w.warn = el("div.ctl-warn", { id: "warn-" + id, hidden: true });
      wrap.appendChild(w.warn);
    }
    if (spec.footnote) {
      w.foot = el("div.ctl-note", { id: "foot-" + id });
      wrap.appendChild(w.foot);
    }
    this.widgets.push(w);
    return wrap;
  }

  _head(spec, id, valueText) {
    const val = el("span.ctl-val", { text: valueText });
    const row = el("div.ctl-head", {}, [el("label", { htmlFor: id, text: spec.label }), val]);
    return { row, val };
  }

  /** Re-sync every widget's value, visibility, warning and footnote. */
  refresh(state) {
    for (const w of this.widgets) {
      const spec = w.spec;
      w.wrap.hidden = !!(spec.show && !spec.show(state));
      if (w.warn) {
        const msg = spec.warn(state);
        w.warn.textContent = msg || "";
        w.warn.hidden = !msg;
      }
      if (w.foot) w.foot.textContent = spec.footnote(state) || "";
      if (!w.control) continue;               // a button has nothing to sync

      const v = getPath(state, spec.path);
      if (spec.kind === "check") {
        w.control.checked = !!v;
      } else if (spec.kind === "seg") {
        Array.from(w.control.children).forEach((b, i) => b.setAttribute("aria-pressed", String(spec.opts[i].v === v)));
      } else if (spec.kind === "select") {
        if (spec.opts && !spec.opts.some((o) => String(o.v) === String(w.control.value))) {
          this._fillSelect(w.control, spec, v);
        }
        w.control.value = String(v);
      } else {
        if (document.activeElement !== w.control) w.control.value = v ?? "";
        if (w.value) w.value.textContent = formatValue(spec, v);
      }
    }
  }

  /** Options can arrive after the rail is built (the tariff library loads async). */
  setOptions(path, opts, state) {
    const w = this.widgets.find((x) => x.spec.path === path);
    // Rebuilding a select on every render throws away the one the user is
    // looking at, so the list is only refilled when it has actually changed.
    if (!w || !w.control || sameOptions(w.spec.opts, opts)) return;
    w.spec.opts = opts;
    this._fillSelect(w.control, w.spec, getPath(state, path));
  }

  _fillSelect(node, spec, value) {
    clear(node);
    for (const o of spec.opts || []) node.appendChild(el("option", { value: String(o.v), text: o.t }));
    node.value = String(value);
  }
}

export default { ControlRail, formatValue, defaultReason };
