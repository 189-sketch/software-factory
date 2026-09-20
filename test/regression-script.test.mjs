/**
 * Spec `2026-09-20-decision-architecture` / Phase E / T11.1.
 *
 * Cheap static guard for the L7 merge gate wiring. Asserts that:
 *   - `scripts/regression-b-e.mjs` exists and `--help` exits 0 with usage;
 *   - `package.json` wires `npm run regression:b-e` to that script and
 *     `npm run spec-check` to `scripts/spec-lineage-check.mjs`;
 *   - the synthetic 10-issue calibration fixture exists, is a frozen
 *     subset of `issues-100.json`, and includes CJK samples.
 *
 * The full regression run is NOT executed here (too slow for the unit
 * layer); it is the L7 gate command run manually / by spec-testing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

test("regression:b-e script exists and is wired in package.json", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["regression:b-e"], "node scripts/regression-b-e.mjs");
  // The gate's spec-check step runs `npm run spec-check`; that script must
  // exist and point at the 16-check spec-lineage validator for this spec
  // (scripts/spec-check.mjs is the slug-based PRODUCT/TECH checker used by
  // the factory pipeline and does NOT apply to this spec directory).
  assert.equal(pkg.scripts["spec-check"], "node scripts/spec-lineage-check.mjs");
  const scriptPath = path.join(REPO_ROOT, "scripts", "regression-b-e.mjs");
  const source = readFileSync(scriptPath, "utf8");
  // All five gate steps must be present in the script source.
  for (const needle of ["npm test", "test:cli", "build:panel", "spec-check", "typesafe-calibration.mjs", "issues-10.json"]) {
    assert.ok(source.includes(needle), `regression-b-e.mjs must reference ${needle}`);
  }
});

test("regression-b-e.mjs --help exits 0 and lists the five steps", () => {
  const stdout = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "regression-b-e.mjs"), "--help"],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  assert.match(stdout, /usage: regression-b-e\.mjs/);
  assert.match(stdout, /npm test/);
  assert.match(stdout, /npm run test:cli/);
  assert.match(stdout, /npm run build:panel/);
  assert.match(stdout, /npm run spec-check/);
  assert.match(stdout, /typesafe-calibration\.mjs --fixture test\/fixtures\/calibration\/issues-10\.json/);
});

test("synthetic 10-issue fixture is a frozen CJK-bearing subset of issues-100", () => {
  const ten = JSON.parse(readFileSync(path.join(REPO_ROOT, "test", "fixtures", "calibration", "issues-10.json"), "utf8"));
  const hundred = JSON.parse(readFileSync(path.join(REPO_ROOT, "test", "fixtures", "calibration", "issues-100.json"), "utf8"));
  assert.ok(Array.isArray(ten.issues), "fixture must carry an issues array");
  assert.equal(ten.issues.length, 10);
  const byNumber = new Map(hundred.issues.map((issue) => [issue.number, issue]));
  const numbers = new Set();
  for (const issue of ten.issues) {
    assert.ok(!numbers.has(issue.number), `duplicate issue number ${issue.number}`);
    numbers.add(issue.number);
    assert.deepEqual(issue, byNumber.get(issue.number), `issue ${issue.number} must be byte-identical to its issues-100 source entry`);
  }
  const cjk = ten.issues.filter((issue) => /[一-鿿぀-ヿ가-힯]/.test(issue.title));
  assert.ok(cjk.length >= 2, `fixture must include CJK samples, got ${cjk.length}`);
});
