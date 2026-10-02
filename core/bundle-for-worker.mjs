#!/usr/bin/env node
/* =============================================================================
 * core/bundle-for-worker.mjs - the project's only build step, run by hand.
 *
 *     node core/bundle-for-worker.mjs
 *
 * writes app/worker-bundle.js, THE ONE GENERATED FILE IN THE REPO (and it is
 * committed, so GitHub Pages stays a no-build static site).  Re-run it after editing
 * any core module that the worker uses, and commit the result alongside the change.
 *
 * Why it exists: a Web Worker started from a Blob URL cannot `import` a relative
 * module (the blob has no path to resolve against), and the project has no bundler.
 * So the core modules are concatenated into one classic script.  Each module becomes
 * an IIFE assigned to its namespace global, and three mechanical rewrites are applied
 * to the source - nothing else is touched:
 *
 *   1. `import X from "./mod.js";`   ->  `const X = <namespace of mod.js>;`
 *      (the namespace is held in an internal `__ns_*` binding so a module may import
 *      another under the same name it is published as)
 *   2. `export default <expr>;`      ->  `var __default = <expr>;`  (+ `return __default;`)
 *   3. a leading `export ` on a declaration, and a whole `export { ... };` line, drop.
 *
 * Anything else an ES module can do (side-effect imports, `import *`, re-exports,
 * top-level await) is deliberately NOT supported: keep the core modules to the plain
 * `export`/`import` style docs/ARCHITECTURE.md already requires, and this stays a
 * 60-line script instead of a bundler.
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORE);
const OUT = path.join(ROOT, "app", "worker-bundle.js");

/** Module file -> the global the worker script knows it by.  Order matters. */
const MODULES = [
  ["flexload.js", "FlexLoad"],
  ["engine.js", "SolarEngine"],
  ["finance.js", "SolarFinance"],
  ["optimizer.js", "SolarOptimizer"],
];
const NS = new Map(MODULES);

function rewrite(src, file) {
  const out = [];
  let sawDefault = false;
  for (const line of src.split("\n")) {
    let m = /^import\s+(\w+)\s+from\s+["']\.\/([\w.-]+)["'];?\s*$/.exec(line);
    if (m) {
      const ns = NS.get(m[2]);
      if (!ns) throw new Error(`${file}: imports ${m[2]}, which is not in the bundle`);
      out.push(`const ${m[1]} = __ns_${ns};`);
      continue;
    }
    if (/^import\s/.test(line)) throw new Error(`${file}: unsupported import form: ${line.trim()}`);
    if (/^export\s*\{/.test(line)) continue;                       // export { a, b };
    if (/^export\s+default\s/.test(line)) {
      if (sawDefault) throw new Error(`${file}: two default exports`);
      sawDefault = true;
      out.push(line.replace(/^export\s+default\s/, "var __default = "));
      continue;
    }
    out.push(line.replace(/^export\s+(?=(const|let|var|function|class|async)\b)/, ""));
  }
  if (!sawDefault) throw new Error(`${file}: no default export to expose as a namespace`);
  return out.join("\n");
}

function wrap(file, ns) {
  const src = fs.readFileSync(path.join(CORE, file), "utf8");
  return `/* ===== core/${file} ${"=".repeat(Math.max(0, 62 - file.length))} */\n` +
         `var __ns_${ns} = (function () {\n${rewrite(src, file)}\nreturn __default;\n})();\n` +
         `var ${ns} = __ns_${ns};\n`;
}

const header = `/* GENERATED FILE - DO NOT EDIT.
 * Built by \`node core/bundle-for-worker.mjs\` from core/{${MODULES.map((m) => m[0]).join(",")}}
 * and core/worker.js.  Edit those, re-run the script, commit the result.
 */
`;

const body = MODULES.map(([f, ns]) => wrap(f, ns)).join("\n") + "\n" +
  `/* ===== core/worker.js ${"=".repeat(52)} */\n` +
  fs.readFileSync(path.join(CORE, "worker.js"), "utf8");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + body);
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${path.relative(ROOT, OUT)} (${kb} kB) from ${MODULES.length + 1} files`);
