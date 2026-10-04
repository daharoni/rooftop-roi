// Usage: node tests/check-freshness.mjs [--today=YYYY-MM-DD]
// Prints one line per data/tariffs/*.json; exits 1 if any file is stale (> 365 days).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshness } from "../core/tariff.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tariffs");
const arg = process.argv.find((a) => a.startsWith("--today="));
const today = arg ? new Date(arg.slice(8) + "T00:00:00Z") : new Date();
if (Number.isNaN(today.getTime())) { console.error("bad --today"); process.exit(2); }

let stale = 0;
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  const meta = JSON.parse(readFileSync(join(DIR, f), "utf8")).meta || {};
  const r = freshness(meta, today);
  console.log(`${f}: as_of ${meta.as_of || "missing"}, ${r.days === null ? "age unknown" : r.days + " days old"} (${r.level})`);
  if (r.level === "stale" || r.level === "unknown") {
    stale++;
    console.log(`::error::${f} is ${r.level}; re-check the rates and update meta.as_of`);
  } else if (r.level === "aging") {
    console.log(`::warning::${f} is ${r.days} days old; re-check the rates soon`);
  }
}
process.exit(stale ? 1 : 0);
