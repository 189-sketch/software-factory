/**
 * Plan §3.2 / M6: the panel must answer "why is this issue waiting?"
 * without grepping log files. `projectIssue` now injects a `leaseWait`
 * field from `<stateDir>/lease-waits/issue-<n>.json` so the UI can
 * surface the holder, blockedAt, and next-attempt-at alongside the
 * persisted issue document.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordLeaseWait } from "../runtime/lease-wait-state.mjs";
import { createPanelReadModel } from "../runtime/panel-read-model.mjs";

function freshProject() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "factory-panel-"));
  const stateDir = path.join(projectRoot, ".factory");
  mkdirSync(path.join(stateDir, "issues"), { recursive: true });
  return {
    projectRoot,
    stateDir,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

async function withPanelReadModel(projectRoot, includeGitHub = false) {
  // createPanelReadModel expects at minimum a package.json + .factory/projects.json.
  writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "demo", version: "0.0.0" }),
    "utf8",
  );
  const factoryDir = path.join(projectRoot, ".factory");
  mkdirSync(factoryDir, { recursive: true });
  writeFileSync(path.join(factoryDir, "projects.json"), JSON.stringify({ projects: [] }), "utf8");
  const model = await createPanelReadModel(projectRoot, { includeGitHub });
  return { model, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

test("issues() projects a leaseWait field when the wait sidecar exists", async () => {
  const { projectRoot, stateDir, cleanup } = freshProject();
  try {
    writeFileSync(path.join(projectRoot, "package.json"), "{}", "utf8");
    mkdirSync(path.join(stateDir, "issues"), { recursive: true });
    const issueDoc = {
      issue: { number: 7, title: "demo", body: "", labels: [], author: "alice", url: "", createdAt: "", comments: [] },
      merged: false,
    };
    writeFileSync(path.join(stateDir, "issues", "7.json"), JSON.stringify(issueDoc), "utf8");
    await recordLeaseWait(stateDir, 7, {
      reason: "lease-busy",
      holder: "daemon-pid-99",
      expectedRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
      note: "stale reclaim in 60s",
    });
    const { model } = await withPanelReadModel(projectRoot);
    const list = await model.issues("current");
    const found = list.find((entry) => entry.issue.number === 7);
    assert.ok(found, "issue must appear in the projection");
    assert.ok(found.leaseWait, "leaseWait must be projected when the sidecar exists");
    assert.equal(found.leaseWait.reason, "lease-busy");
    assert.equal(found.leaseWait.holder, "daemon-pid-99");
    assert.match(found.leaseWait.note ?? "", /stale reclaim/);
  } finally {
    cleanup();
  }
});

test("issues() omits leaseWait when no wait sidecar exists", async () => {
  const { projectRoot, stateDir, cleanup } = freshProject();
  try {
    writeFileSync(path.join(projectRoot, "package.json"), "{}", "utf8");
    mkdirSync(path.join(stateDir, "issues"), { recursive: true });
    const issueDoc = {
      issue: { number: 8, title: "demo", body: "", labels: [], author: "alice", url: "", createdAt: "", comments: [] },
      merged: false,
    };
    writeFileSync(path.join(stateDir, "issues", "8.json"), JSON.stringify(issueDoc), "utf8");
    const { model } = await withPanelReadModel(projectRoot);
    const list = await model.issues("current");
    const found = list.find((entry) => entry.issue.number === 8);
    assert.ok(found, "issue must appear");
    assert.equal(found.leaseWait, undefined, "leaseWait must be absent when no sidecar exists");
  } finally {
    cleanup();
  }
});