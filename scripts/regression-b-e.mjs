#!/usr/bin/env node
// scripts/regression-b-e.mjs
//
// Spec `2026-09-20-decision-architecture` / Phase E / T11.1.
//
// Final regression gate for Phases B–E — the L7 merge gate command
// (`npm run regression:b-e`, validation.md §L7 "Phase B–E integration
// gate"). Runs the five gate steps IN ORDER, fail-fast: each step must
// exit 0 or the script prints `REGRESSION B-E FAIL: <step>` and exits 1.
//
// Steps:
//   1. npm test                 (typecheck + unit + fast + contract)
//   2. npm run test:cli         (package build + cli-package test)
//   3. npm run build:panel      (control-panel production build)
//   4. npm run spec-check       (scripts/spec-lineage-check.mjs — all 16 checks)
//   5. node scripts/typesafe-calibration.mjs
//        --fixture test/fixtures/calibration/issues-10.json
//      (synthetic 10-issue subset fixture, deterministic offline mock,
//       incl. CJK samples; must print CALIBRATION PASS and exit 0)
//
// Usage:
//   node scripts/regression-b-e.mjs           # run the full gate
//   node scripts/regression-b-e.mjs --help    # print usage
//
// Exit codes: 0 = REGRESSION B-E PASS, 1 = REGRESSION B-E FAIL, 2 = usage error.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const IS_WIN = process.platform === "win32";
// On Windows `npm` is `npm.cmd`; since the Node security patch that made
// spawning .cmd/.bat without a shell throw EINVAL, npm steps run through
// `shell: true` on win32. The `node` step spawns `process.execPath`
// directly (no shell) — its arguments are quoted manually when needed.
const NPM = IS_WIN ? "npm.cmd" : "npm";
const FIXTURE_10 = path.join(REPO_ROOT, "test", "fixtures", "calibration", "issues-10.json");

const USAGE = `usage: regression-b-e.mjs [--help]

L7 merge gate for spec 2026-09-20-decision-architecture (Phases B-E).
Runs, in order, fail-fast:
  1. npm test
  2. npm run test:cli
  3. npm run build:panel
  4. npm run spec-check   (scripts/spec-lineage-check.mjs)
  5. node scripts/typesafe-calibration.mjs --fixture test/fixtures/calibration/issues-10.json

Exit codes: 0 = REGRESSION B-E PASS, 1 = REGRESSION B-E FAIL, 2 = usage error.
`;

const STEPS = [
  { name: "npm test", command: NPM, args: ["test"], shell: IS_WIN },
  { name: "npm run test:cli", command: NPM, args: ["run", "test:cli"], shell: IS_WIN },
  { name: "npm run build:panel", command: NPM, args: ["run", "build:panel"], shell: IS_WIN },
  { name: "npm run spec-check", command: NPM, args: ["run", "spec-check"], shell: IS_WIN },
  {
    name: "calibration (synthetic 10-issue fixture)",
    command: process.execPath,
    args: [path.join(SCRIPT_DIR, "typesafe-calibration.mjs"), "--fixture", FIXTURE_10],
    shell: false,
  },
];

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (argv.length > 0) {
    process.stderr.write(`unknown argument: ${argv[0]}\n\n${USAGE}`);
    process.exit(2);
  }

  const startedAt = Date.now();
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    process.stdout.write(`\n=== regression:b-e step ${i + 1}/${STEPS.length}: ${step.name} ===\n`);
    const stepStartedAt = Date.now();
    const result = spawnSync(step.command, step.args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: step.shell,
    });
    const elapsedSec = ((Date.now() - stepStartedAt) / 1000).toFixed(1);
    if (result.error) {
      process.stderr.write(`\nREGRESSION B-E FAIL: ${step.name} (spawn error: ${result.error.message})\n`);
      process.exit(1);
    }
    if (result.status !== 0) {
      const how = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
      process.stderr.write(`\nREGRESSION B-E FAIL: ${step.name} (${how} after ${elapsedSec}s)\n`);
      process.exit(1);
    }
    process.stdout.write(`--- step ${i + 1}/${STEPS.length} ok: ${step.name} (${elapsedSec}s)\n`);
  }
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\nREGRESSION B-E PASS — ${STEPS.length}/${STEPS.length} steps ok in ${totalSec}s\n`);
  process.exit(0);
}

main();
