/* =============================================================================
 * privacy-hosts.test.mjs — the privacy panel lists every host the code can call.
 *
 * app/privacy.js CALLS is the single source of truth for the landing page and
 * the README. This greps app/, core/ and index.html for URL hostnames (outside
 * comments) and fails if one is missing from CALLS, or if CALLS names a host
 * nothing uses any more. A new fetch therefore cannot ship without the privacy
 * statement changing with it.
 * ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CALLS, HOSTS, NOT_REQUESTS } from "../app/privacy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([".js", ".mjs", ".html", ".css"].includes(extname(p))) out.push(p);
  }
  return out;
}

/** Drop comments so source citations and policy links in them do not count as calls. */
function stripComments(text, ext) {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (ext === ".html") t = t.replace(/<!--[\s\S]*?-->/g, " ");
  // A line comment starts at `//` that is not part of `://`.
  if (ext !== ".css") t = t.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  return t;
}

function hostsInCode() {
  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "core")), join(ROOT, "index.html")];
  const found = new Map();
  for (const f of files) {
    const text = stripComments(readFileSync(f, "utf8"), extname(f));
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const host = m[1].toLowerCase();
      if (!found.has(host)) found.set(host, f.slice(ROOT.length + 1));
    }
  }
  return found;
}

test("every host in the code is disclosed in app/privacy.js CALLS", () => {
  const found = hostsInCode();
  const missing = [...found.entries()].filter(([h]) => !HOSTS.includes(h) && !(h in NOT_REQUESTS));
  assert.deepEqual(missing, [], "undisclosed hosts (add them to CALLS): " + JSON.stringify(missing));
});

test("every host in CALLS is still used somewhere", () => {
  const found = hostsInCode();
  const stale = HOSTS.filter((h) => !found.has(h));
  assert.deepEqual(stale, [], "CALLS lists hosts no code calls any more: " + stale.join(", "));
});

test("the hosts the 2026-10-02 review found undisclosed are all listed", () => {
  for (const h of ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com",
    "nominatim.openstreetmap.org", "geocoding-api.open-meteo.com", "api.open-meteo.com",
    "archive-api.open-meteo.com", "server.arcgisonline.com"]) {
    assert.ok(HOSTS.includes(h), h);
  }
});

test("each call says what is sent and when", () => {
  for (const c of CALLS) {
    assert.ok(c.who && c.what && c.when, c.who);
    if (c.avoidable) assert.ok(c.escape, `${c.who} is avoidable, so it needs an escape`);
  }
});

test("the landing page no longer promises that a ZIP or the map sends nothing", () => {
  const landing = readFileSync(join(ROOT, "app/ui/landing.js"), "utf8");
  assert.doesNotMatch(landing, /Sent nowhere/);
  assert.doesNotMatch(landing, /nothing you typed is sent anywhere/);
  assert.doesNotMatch(landing, /sends nothing but tile coordinates/);
  assert.match(landing, /github\.com\/daharoni\/rooftop-roi/);
});
