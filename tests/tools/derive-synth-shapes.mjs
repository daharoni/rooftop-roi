/* tests/tools/derive-synth-shapes.mjs - derive the load shapes embedded in core/synthload.js.
 *
 *   node tests/tools/derive-synth-shapes.mjs            prints the JS constants
 *   node tests/tools/derive-synth-shapes.mjs --json     prints the same as JSON
 *
 * Why it exists: a household that only has bills has no hourly data, so the tool
 * borrows the *shape* of a real one.  The shape comes from the demo household
 * (data/demo/*.csv, real SCE interval data) with its detected EV subtracted, so
 * the borrowed shape is a home without a car.  Only shapes are kept, never the
 * household's kWh: each month's 24-hour profile sums to 1, and the month shares
 * sum to 1.  Re-run this and paste the output over the constants in
 * core/synthload.js if the demo data changes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GB from "../../core/greenbutton.js";
import { detectEV } from "../../core/flexload.js";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dir = path.join(ROOT, "data/demo");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
const sets = files.map((f) => GB.parse(fs.readFileSync(path.join(dir, f), "utf8"), { filename: f }));
const load = GB.mergeLoadSets(sets);

const ev = detectEV(load);
const base = Float64Array.from(load.kwh);
let evKwh = 0;
if (ev && ev.kwhByHour) {
  for (let i = 0; i < base.length; i++) { evKwh += ev.kwhByHour[i]; base[i] = Math.max(0, base[i] - ev.kwhByHour[i]); }
}

// Per calendar month: hour sums for weekday and weekend days, and day counts.
const wk = Array.from({ length: 12 }, () => ({ h: new Float64Array(24), d: 0 }));
const we = Array.from({ length: 12 }, () => ({ h: new Float64Array(24), d: 0 }));
let curDay = "", cur = null;
const flush = () => { if (cur) { cur.bucket.d++; for (let h = 0; h < 24; h++) cur.bucket.h[h] += cur.h[h]; } };
for (let i = 0; i < load.ts.length; i++) {
  const s = load.ts[i];
  const day = s.slice(0, 10), hr = +s.slice(11, 13);
  if (day !== curDay) {
    flush(); curDay = day;
    const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1, dd = +s.slice(8, 10);
    const dow = new Date(Date.UTC(y, m, dd)).getUTCDay();
    cur = { h: new Float64Array(24), bucket: (dow === 0 || dow === 6 ? we : wk)[m], full: true };
  }
  if (Number.isFinite(base[i])) cur.h[hr] += base[i];
}
flush();

const norm = (v) => { let t = 0; for (const x of v) t += x; return Array.from(v, (x) => x / t); };
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const weekday = [], weekend = [], weekendRatio = [], dailyKwh = [];
for (let m = 0; m < 12; m++) {
  if (!wk[m].d || !we[m].d) throw new Error("month " + (m + 1) + " lacks weekday or weekend days");
  weekday.push(norm(wk[m].h).map(r5));
  weekend.push(norm(we[m].h).map(r5));
  const wkDay = wk[m].h.reduce((a, b) => a + b, 0) / wk[m].d;
  const weDay = we[m].h.reduce((a, b) => a + b, 0) / we[m].d;
  weekendRatio.push(r5(weDay / wkDay));
  // average kWh/day over the month's mix of days (5/7 weekday, 2/7 weekend)
  dailyKwh.push((wkDay * 5 + weDay * 2) / 7);
}
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const monthShare = norm(dailyKwh.map((d, m) => d * DAYS[m])).map(r5);

const out = { weekday, weekend, weekendRatio, monthShare };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out));
} else {
  console.error(`// source: ${files.join(", ")}; ${load.ts.length} hours; EV removed: ${Math.round(evKwh)} kWh`);
  const rows = (a) => "[\n" + a.map((r) => "  [" + r.join(", ") + "]").join(",\n") + ",\n]";
  console.log("const WEEKDAY = " + rows(weekday) + ";");
  console.log("const WEEKEND = " + rows(weekend) + ";");
  console.log("const WEEKEND_RATIO = [" + weekendRatio.join(", ") + "];");
  console.log("const MONTH_SHARE = [" + monthShare.join(", ") + "];");
}
