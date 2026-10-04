/* =============================================================================
 * privacy-hosts.test.mjs — the privacy panel lists every host the code can call.
 *
 * app/privacy.js CALLS is the single source of truth for the landing page and
 * the README. This scans app/, core/ and index.html for hostnames and fails if
 * one is missing from CALLS, or if CALLS names a host nothing uses any more. A
 * new fetch therefore cannot ship without the privacy statement changing with it.
 *
 * What it catches:
 *   - `http://`, `https://`, `ws://`, `wss://` and protocol-relative `//host`
 *     URLs anywhere in code or string literals;
 *   - a URL split across adjacent string literals, `"https://" + "host.com"`
 *     (adjacent literals joined by `+` are merged before matching).
 * Comments are removed by a small lexer that knows about string, template and
 * regex literals, so a string containing `/*` cannot swallow the code up to a
 * later `*\/`.  A line carrying the marker `privacy:ignore` is skipped, for the
 * rare literal that names a host without contacting it.
 *
 * What it cannot catch (review by hand):
 *   - a host assembled from variables or computed at run time
 *     (`const h = "open-meteo"; fetch("https://" + h + ".com")`, `atob(...)`,
 *     `new URL(path, someBase)`), or read from data files and responses;
 *   - requests made by third-party code once loaded (Leaflet, Chart.js) beyond
 *     the hosts this repo hands them.
 * ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CALLS, HOSTS, CONNECT_HOSTS, IMG_HOSTS, NOT_REQUESTS } from "../app/privacy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([".js", ".mjs", ".html", ".css"].includes(extname(p))) out.push(p);
  }
  return out;
}

/**
 * Remove comments from JS (or CSS when `css`), leaving string, template and
 * regex literals intact.  A `/` starts a regex when the previous significant
 * character cannot end an expression - the usual heuristic, enough for this repo.
 */
export function stripComments(text, { css = false } = {}) {
  let out = "";
  let i = 0;
  let prev = "";                                  // last significant character emitted
  const n = text.length;
  const copyQuoted = (q) => {                     // copies text[i..] through the closing quote
    let j = i + 1;
    while (j < n && text[j] !== q) {
      if (text[j] === "\\") j++;
      else if (q !== "`" && text[j] === "\n") break;   // unterminated: stop at the line end
      j++;
    }
    out += text.slice(i, j + 1);
    i = j + 1;
    prev = q;
  };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (!css && c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'" || (!css && c === "`")) { copyQuoted(c); continue; }
    if (!css && c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      // A regex literal: copy through the closing slash (classes may contain `/`).
      let j = i + 1, cls = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        else if (text[j] === "/" && !cls) break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Comment-free text for one file, with ignored lines dropped and adjacent literals merged. */
export function scannable(text, ext) {
  text = text.split("\n").filter((l) => !l.includes("privacy:ignore")).join("\n");
  if (ext === ".html") {
    text = text.replace(/<!--[\s\S]*?-->/g, " ");
    // Only the inline scripts are JavaScript; the markup itself is scanned as is.
    text = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, js, b) => a + stripComments(js) + b);
  } else {
    text = stripComments(text, { css: ext === ".css" });
  }
  // "https://" + "host.com"  ->  "https://host.com"  (also across line breaks).
  return text.replace(/(["'`])\s*\+\s*(["'`])/g, "");
}

const URL_RE = /(?:\b(?:https?|wss?):)?\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;

export function hostsIn(text, ext) {
  const out = new Set();
  for (const m of scannable(text, ext).matchAll(URL_RE)) out.add(m[1].toLowerCase());
  return out;
}

function hostsInCode() {
  // app/vendor holds third-party libraries (Chart.js, Leaflet): their URLs are
  // namespaces and links, and the CSP below is what bounds what they can request.
  const files = [...walk(join(ROOT, "app")).filter((f) => !f.includes(`${join("app", "vendor")}/`)),
    ...walk(join(ROOT, "core")), join(ROOT, "index.html")];
  const found = new Map();
  for (const f of files) {
    for (const host of hostsIn(readFileSync(f, "utf8"), extname(f))) {
      if (!found.has(host)) found.set(host, f.slice(ROOT.length + 1));
    }
  }
  return found;
}

test("the scanner sees protocol-relative, websocket and concatenated hosts", () => {
  const js = [
    'const a = "//cdn.example.com/x.js";',
    "const b = 'wss://live.example.org/feed';",
    'const c = "https://" + "split.example.net/path";',
    'const d = "https://" +\n  "multi.example.io";',
    'const e = "ws://plain.example.dev";',
    'const n = "https://ignored.example.com"; // privacy:ignore',
  ].join("\n");
  assert.deepEqual([...hostsIn(js, ".js")].sort(),
    ["cdn.example.com", "live.example.org", "multi.example.io", "plain.example.dev", "split.example.net"]);
});

test("a string holding /* does not hide the code after it from the scanner", () => {
  const js = 'const glob = "a/*";\nfetch("https://hidden.example.com/");\nconst end = "*/";';
  assert.ok(hostsIn(js, ".js").has("hidden.example.com"));
  // Real comments still do not count: a cited source is not a request.
  assert.equal(hostsIn("/* see https://cited.example.com */\n// https://also.example.com\nx = 1 / 2; // y", ".js").size, 0);
  // A regex literal containing // is not a comment start.
  assert.ok(hostsIn('const r = /\\/\\//; fetch("https://after.example.com");', ".js").has("after.example.com"));
});

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
  assert.ok(!HOSTS.includes("fonts.googleapis.com") && !HOSTS.includes("cdnjs.cloudflare.com"), "vendored assets are no longer third-party calls");
  for (const h of ["nominatim.openstreetmap.org", "geocoding-api.open-meteo.com", "api.open-meteo.com",
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
  // The repo URL lives in app/ui/feedback.js; the landing footer links it from there.
  const feedback = readFileSync(join(ROOT, "app/ui/feedback.js"), "utf8");
  assert.match(feedback, /github\.com\/daharoni\/rooftop-roi/);
  assert.match(landing, /REPO_URL/);
  assert.match(landing, /feedbackLink\(/);
});

/** The hosts of one CSP directive in index.html (scheme-less host sources only). */
function cspHosts(directive) {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  assert.ok(m, "index.html has a Content-Security-Policy meta tag");
  const d = m[1].split(";").map((x) => x.trim()).find((x) => x.startsWith(directive + " "));
  assert.ok(d, `CSP has ${directive}`);
  return d.split(/\s+/).slice(1).filter((t) => !t.startsWith("'") && !/^[a-z]+:$/.test(t))
    .map((t) => t.replace(/^https:\/\//, ""));
}

test("CSP connect-src and img-src name exactly the hosts in privacy.js", () => {
  assert.deepEqual(cspHosts("connect-src").sort(), [...CONNECT_HOSTS].sort());
  assert.deepEqual(cspHosts("img-src").sort(), [...IMG_HOSTS].sort());
});

test("CSP keeps scripts, fonts and workers local", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)[1];
  assert.match(csp, /(^|; )script-src 'self'(;|$)/);
  assert.match(csp, /(^|; )font-src 'self'(;|$)/);
  assert.match(csp, /(^|; )default-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  // No external script or stylesheet is referenced from the page.
  assert.doesNotMatch(html, /<(script|link)\b[^>]*(src|href)="https?:\/\//);
});

test("the tile provider block in roofBuilder.js only names hosts that are in IMG_HOSTS", () => {
  const src = readFileSync(join(ROOT, "app/roof/roofBuilder.js"), "utf8");
  const block = src.slice(src.indexOf("TILE_PROVIDERS = {"), src.indexOf("export const TILE_PROVIDER ="));
  const urls = [...block.matchAll(/url: 'https:\/\/([^/']+)/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), [...IMG_HOSTS].sort());
});
