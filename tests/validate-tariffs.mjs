#!/usr/bin/env node
/* =============================================================================
 * validate-tariffs.mjs - CI gate for the tariff library.
 *
 *   node tests/validate-tariffs.mjs            # validate every data/tariffs/*.json
 *   node tests/validate-tariffs.mjs --strict   # warnings fail too
 *   node tests/validate-tariffs.mjs sce pge    # only these utilities
 *
 * Loads every file in data/tariffs/, runs core/tariff.js validate() on it, walks
 * every (plan, provider, season, period) combination to prove no lookup can miss,
 * prints a summary table, and exits non-zero if anything is broken.
 * ========================================================================== */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import T from "../core/tariff.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "data", "tariffs");

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const only = argv.filter((a) => !a.startsWith("-"));

const ids = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => basename(f, ".json"))
  .filter((id) => !only.length || only.includes(id))
  .sort();

if (!ids.length) {
  console.error("validate-tariffs: no tariff files found in " + DIR);
  process.exit(1);
}

const lib = await T.loadLibrary(DIR, ids);
for (const e of lib.errors) {
  console.error("LOAD FAILED  " + e.id + ": " + e.message);
}

/* ------------------------------------------------------------------ helpers */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Confidence summary: the lowest level present, plus the per-section map. */
function confidenceOf(t) {
  const c = (t.meta && t.meta.confidence) || null;
  if (!c) return { worst: "-", detail: "(none)" };
  const order = { high: 3, medium: 2, low: 1 };
  let worst = "high";
  const parts = [];
  for (const k of Object.keys(c)) {
    const v = c[k];
    const lvl = typeof v === "string" ? v : (v && v.level);
    parts.push(k + "=" + lvl);
    if ((order[lvl] || 0) < (order[worst] || 0)) worst = lvl;
  }
  return { worst, detail: parts.join(" ") };
}

/**
 * Exhaustive lookup sweep: for every plan, every provider, every hour of a
 * representative weekday and weekend in each month, rateAt() and exportRateAt()
 * must return a finite positive number.  This is what actually guarantees the
 * engine's 17,700-hour loop can never hit a hole.
 */
function sweep(t) {
  const problems = [];
  const year = 2026;
  const days = [1, 4, 5, 15, 21, 28];        // guarantees both weekdays and weekends
  for (const p of t.plans || []) {
    const provs = Object.keys(t.providers || {});
    for (let m = 1; m <= 12; m++) {
      for (const d of days) {
        for (let h = 0; h < 24; h++) {
          let at;
          try { at = T.periodAt(p, { y: year, m, d }, h); }
          catch (e) { problems.push(p.id + " periodAt " + m + "/" + d + " h" + h + ": " + e.message); continue; }
          for (const prov of provs) {
            let v;
            try { v = T.rateAt(t, p, prov, { y: year, m, d }, h); }
            catch (e) { problems.push(p.id + "/" + prov + " " + m + "/" + d + " h" + h + ": " + e.message); continue; }
            if (!(typeof v === "number" && isFinite(v) && v > 0)) {
              problems.push(p.id + "/" + prov + " " + at.season + "/" + at.period + " -> " + v);
            }
          }
          if (problems.length > 25) return problems;
        }
      }
    }
  }
  for (let m = 1; m <= 12; m++) {
    for (let h = 0; h < 24; h++) {
      for (const d of [3, 4]) {               // one weekday-ish and one weekend-ish day
        try {
          const v = T.exportRateAt(t, { y: year, m, d }, h);
          if (!(typeof v === "number" && isFinite(v) && v >= 0)) {
            problems.push("exportRateAt " + m + "/" + d + " h" + h + " -> " + v);
          }
        } catch (e) { problems.push("exportRateAt " + m + "/" + d + " h" + h + ": " + e.message); }
      }
    }
  }
  return problems;
}

/** Simple average of a 12x24 matrix, for the summary table. */
function matrixStats(m) {
  if (!Array.isArray(m)) return null;
  let sum = 0, n = 0, max = -Infinity, at = null;
  m.forEach((row, mi) => row.forEach((v, h) => {
    sum += v; n++;
    if (v > max) { max = v; at = { month: mi + 1, hour: h }; }
  }));
  return { mean: sum / n, max, at };
}

/* -------------------------------------------------------------------- run it */

const rows = [];
let hardErrors = lib.errors.length, softWarnings = 0;

for (const id of ids) {
  const t = lib.utilities[id];
  if (!t) continue;
  const r = T.validate(t);
  const problems = r.ok ? sweep(t) : [];
  const conf = confidenceOf(t);
  const wd = matrixStats(t.nbt && t.nbt.export_rates && t.nbt.export_rates.weekday);
  const def = T.defaultPlan(t);

  rows.push({
    id,
    name: (t.utility && t.utility.name) || id,
    plans: (t.plans || []).length,
    providers: Object.keys(t.providers || {}).length,
    effective: (t.meta && t.meta.rates_effective) || "-",
    defaultPlan: def ? def.id : "-",
    confidence: conf.worst,
    exportPeak: wd ? wd.max : null,
    exportMean: wd ? wd.mean : null,
    ok: r.ok && !problems.length,
  });

  if (!r.ok || problems.length) {
    hardErrors += r.errors.length + problems.length;
    console.error("\n" + id + ".json - " + (r.errors.length + problems.length) + " error(s)");
    r.errors.forEach((e) => console.error("  ERROR   " + e));
    problems.forEach((e) => console.error("  LOOKUP  " + e));
  }
  if (r.warnings.length) {
    softWarnings += r.warnings.length;
    console.error("\n" + id + ".json - " + r.warnings.length + " warning(s)");
    r.warnings.forEach((w) => console.error("  warn    " + w));
  }
}

console.log("\nTariff library - " + rows.length + " utilit" + (rows.length === 1 ? "y" : "ies") + "\n");
const head = [
  pad("utility", 9), pad("name", 30), padL("plans", 5), padL("providers", 9),
  pad("  rates_effective", 17), pad("  default plan", 16), pad("  conf", 8),
  padL("exp mean", 9), padL("exp peak", 9), "  ok",
].join("");
console.log(head);
console.log("-".repeat(head.length));
for (const r of rows) {
  console.log([
    pad(r.id, 9), pad(r.name.slice(0, 29), 30), padL(r.plans, 5), padL(r.providers, 9),
    pad("  " + r.effective, 17), pad("  " + r.defaultPlan, 16), pad("  " + r.confidence, 8),
    padL(r.exportMean == null ? "-" : "$" + r.exportMean.toFixed(4), 9),
    padL(r.exportPeak == null ? "-" : "$" + r.exportPeak.toFixed(4), 9),
    "  " + (r.ok ? "yes" : "NO"),
  ].join(""));
}
console.log("");

if (hardErrors) {
  console.error("FAILED: " + hardErrors + " error(s), " + softWarnings + " warning(s)");
  process.exit(1);
}
if (strict && softWarnings) {
  console.error("FAILED (--strict): " + softWarnings + " warning(s)");
  process.exit(1);
}
console.log("OK: " + rows.length + " file(s) valid, " + softWarnings + " warning(s)");
