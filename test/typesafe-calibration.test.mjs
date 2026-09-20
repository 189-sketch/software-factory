import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "typesafe-calibration.mjs");
const FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "calibration", "issues-100.json");

test("frozen calibration fixture contains exactly 100 issues with CJK coverage", async () => {
  const data = JSON.parse(await fs.readFile(FIXTURE, "utf8"));
  assert.ok(Array.isArray(data.issues));
  assert.equal(data.issues.length, 100);
  const cjk = data.issues.filter((issue) => /[一-鿿぀-ヿ가-힯]/.test(issue.title));
  assert.ok(cjk.length >= 20, `expected CJK samples per requirements.md R3, got ${cjk.length}`);
  const numbers = new Set(data.issues.map((issue) => issue.number));
  assert.equal(numbers.size, 100);
});

test("typesafe calibration gate exits 0 with CALIBRATION PASS offline (deterministic mock)", async () => {
  // Default path must never touch the network: no API key, no flags.
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const { stdout } = await run(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    env,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.match(stdout, /CALIBRATION PASS/);
  assert.match(stdout, /100 issues × 4 dimensions/);
  for (const dimension of ["spec", "impl", "review", "verify"]) {
    assert.match(stdout, new RegExp(`^${dimension}\\s`, "m"), `missing stats row for ${dimension}`);
  }
});

test("typesafe calibration gate is stable across separate invocations (re-run determinism)", async () => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const first = await run(process.execPath, [SCRIPT], { cwd: REPO_ROOT, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const second = await run(process.execPath, [SCRIPT], { cwd: REPO_ROOT, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  // P50/P90 lines must be byte-identical across process re-runs (±0.05 gate).
  const statsLine = (stdout) => stdout.split(/\r?\n/).filter((line) => /^(spec|impl|review|verify)\s/.test(line)).join("\n");
  assert.equal(statsLine(second.stdout), statsLine(first.stdout));
});
