import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

for (const kind of ["uncaughtException", "unhandledRejection"]) test(`daemon exits and records ${kind}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-fatal-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const stateDir = path.join(root, "state");
  const issuesDir = path.join(root, "issues");
  mkdirSync(issuesDir);
  try {
    const child = spawnSync(process.execPath, [
      "--import", pathToFileURL(path.join(here, "fixtures", "daemon-fatal-preload.mjs")).href,
      path.join(here, "..", "scripts", "factory-daemon.mjs"),
      "--local-dir", issuesDir, "--interval", "60", "--no-env-file",
    ], {
      cwd: root,
      env: { ...process.env, FACTORY_STATE_DIR: stateDir, FACTORY_FATAL_PROBE_KIND: kind, FACTORY_GH_REPO: "", GH_TOKEN: "", GITHUB_TOKEN: "" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.ok(existsSync(path.join(stateDir, "daemon-death.json")), child.stderr || child.stdout);
    const death = JSON.parse(readFileSync(path.join(stateDir, "daemon-death.json"), "utf8"));
    assert.equal(death.reason, kind);
    assert.match(death.message, /fatal-probe/);
    assert.equal(death.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
