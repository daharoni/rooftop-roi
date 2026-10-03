/* The committed app/worker-bundle.js must equal what core/bundle-for-worker.mjs
 * generates from the current core/ sources.  The bundler only writes to
 * app/worker-bundle.js, so run it against a temp copy of the repo layout. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("app/worker-bundle.js is up to date with core/", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  try {
    fs.cpSync(path.join(ROOT, "core"), path.join(tmp, "core"), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(tmp, "core", "bundle-for-worker.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const fresh = fs.readFileSync(path.join(tmp, "app", "worker-bundle.js"));
    const committed = fs.readFileSync(path.join(ROOT, "app", "worker-bundle.js"));
    assert.ok(fresh.equals(committed), "app/worker-bundle.js is stale: run `npm run bundle` and commit the result");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
