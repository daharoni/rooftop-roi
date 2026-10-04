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

/**
 * A typed number, clamped to the control's min/max and snapped to an integer
 * when the step is whole.  null for blank or unparseable input, which the
 * caller treats as "keep the previous value" (never as 0).
 */
export function clampNumber(spec, raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (text === "") return null;
  let n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (spec.min !== undefined && n < spec.min) n = spec.min;
  if (spec.max !== undefined && n > spec.max) n = spec.max;
  if (spec.step !== undefined && Number.isInteger(spec.step) && spec.step >= 1) n = Math.round(n);
  return n;
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
    this._shown = [];
  }

  /** Rebuild the rail from a new group list (called on every tab change). */
  build(groups, state) {
    this.groups = groups || [];
    this.widgets = [];
    this._shown = [];
    this.state = state;
    clear(this.root);
    // The rail is an accordion: one group open at a time, so a long list of
    // knobs never pushes the one being dragged off the bottom of the screen.
    // The first group marked open starts open; opening another closes it.
    let opened = false;
    for (const g of this.groups) {
      const body = el("div.group-body");
      for (const spec of g.items) body.appendChild(this._widget(spec, state));
      // A pinned group starts open at any width and sits outside the accordion.
      // Keep the first explicitly-open group available on phones too. The
      // mobile jump button lands on this rail; leaving every group collapsed
      // forces an extra discovery tap before the first setting is reachable.
      const startOpen = g.pinned ? true : g.open !== false && !opened;
      if (startOpen && !g.pinned) opened = true;
      const details = el("details.group", { open: startOpen }, [
        el("summary", { text: g.group }), body,
      ]);
      if (g.pinned) details.dataset.pinned = "1";
      details.addEventListener("toggle", () => {
        if (!details.open || g.pinned) return;
        for (const other of this.root.querySelectorAll("details.group[open]")) {
          if (other !== details && !other.dataset.pinned) other.open = false;
        }
      });
      if (g.show) this._shown.push({ g, details });
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
      const head = this._head(spec, id, "", { forControl: false });
      wrap.appendChild(head.row);
      w.control = el("div.seg", { id, role: "group", "aria-labelledby": id + "-label" });
      for (const [i, o] of spec.opts.entries()) {
        w.control.appendChild(el("button", {
          type: "button", id: id + "-option-" + i, text: o.t, "aria-pressed": String(o.v === value),
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
      let timer = null;
      w.pendingInput = false;
      const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        w.pendingInput = false;
      };
      const later = (v) => {
        cancel();
        w.pendingInput = true;
        timer = setTimeout(() => { timer = null; w.pendingInput = false; emit(v); }, 350);
      };
      w.control = el("input", {
        type: spec.kind, id, min: spec.min, max: spec.max, step: spec.step,
        placeholder: spec.placeholder, inputMode: spec.inputMode || (spec.kind === "number" ? "decimal" : undefined),
        autocomplete: spec.autocomplete, value: value ?? "",
        on: {
          // Commit while typing, but only a finished, in-range number: "2" in a
          // field whose minimum is 100 is a number on its way, not an answer.
          input: (e) => {
            if (spec.kind !== "number") return;
            const text = String(e.target.value).trim();
            if (text === "") { cancel(); if (spec.nullable) later(null); return; }
            const n = Number(text);
            if (!Number.isFinite(n)) { cancel(); return; }
            if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) { cancel(); return; }
            later(clampNumber(spec, text));
          },
          keydown: (e) => {
            if (e.key !== "Enter" || spec.kind !== "number") return;
            e.preventDefault();
            e.target.dispatchEvent(new Event("change", { bubbles: true }));
          },
          change: (e) => {
            cancel();
            if (spec.kind !== "number") { emit(e.target.value); return; }
            const v = clampNumber(spec, e.target.value);
            const prev = getPath(this.state || state, spec.path);
            // Blank or unparseable: put the previous value back rather than writing 0,
            // unless the control is nullable, where a cleared field means "not entered".
            if (v === null) {
              if (spec.nullable && String(e.target.value).trim() === "") { emit(null); return; }
              e.target.value = prev ?? ""; return;
            }
            if (String(v) !== e.target.value) e.target.value = String(v);
            emit(v);
          },
        },
      });
      wrap.appendChild(w.control);
    } else if (spec.kind === "button") {
      wrap.appendChild(el("button.btn", { type: "button", id, text: spec.label, on: { click: () => emit(true) } }));
    } else {
      const head = this._head(spec, id, formatValue(spec, value));
      w.value = head.val;
      wrap.appendChild(head.row);
      // aria-valuetext: a screen reader announces "$2.75/W" or "5.0%", not the raw 2.75 or 0.05.
      w.control = el("input", {
        type: "range", id, min: spec.min, max: spec.max, step: spec.step, value,
        "aria-valuetext": formatValue(spec, value),
        on: {
          input: (e) => {
            // Paint the number immediately; the simulation catches up behind it.
            const text = formatValue(spec, Number(e.target.value));
            head.val.textContent = text;
            e.target.setAttribute("aria-valuetext", text);
            emit(Number(e.target.value));
          },
        },
      });
      wrap.appendChild(w.control);
    }

    const describedBy = [];
    if (spec.note) {
      const noteId = "note-" + id;
      wrap.appendChild(el("div.ctl-note", { id: noteId, text: spec.note }));
      describedBy.push(noteId);
    }
    if (spec.warn) {
      const warnId = "warn-" + id;
      w.warn = el("div.ctl-warn", { id: warnId, hidden: true, "aria-live": "polite" });
      wrap.appendChild(w.warn);
      describedBy.push(warnId);
    }
    if (spec.footnote) {
      const footId = "foot-" + id;
      w.foot = el("div.ctl-note", { id: footId });
      wrap.appendChild(w.foot);
      describedBy.push(footId);
    }
    if (w.control && describedBy.length) w.control.setAttribute("aria-describedby", describedBy.join(" "));
    this.widgets.push(w);
    return wrap;
  }

  _head(spec, id, valueText, opts = {}) {
    const val = el("span.ctl-val", { text: valueText });
    const labelAttrs = { id: id + "-label", text: spec.label };
    if (opts.forControl !== false) labelAttrs.htmlFor = opts.forControl || id;
    if (opts.forControl === false) labelAttrs.style = "font-size:12px;color:var(--ink-2)";
    const row = el("div.ctl-head", {}, [el(opts.forControl === false ? "span.ctl-head-label" : "label", labelAttrs), val]);
    return { row, val };
  }

  /** Re-sync every widget's value, visibility, warning and footnote. */
  refresh(state) {
    this.state = state;
    for (const { g, details } of this._shown) details.hidden = !g.show(state);
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
        w.control.value = v === null || v === undefined ? "" : String(v);
      } else {
        if (document.activeElement !== w.control && !w.pendingInput) w.control.value = v ?? "";
        if (w.value) {
          const text = formatValue(spec, v);
          w.value.textContent = text;
          if (w.control.type === "range") w.control.setAttribute("aria-valuetext", text);
        }
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
    node.value = value === null || value === undefined ? "" : String(value);
  }
}

export default { ControlRail, formatValue, defaultReason, clampNumber };
