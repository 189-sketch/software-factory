/**
 * IssueStore M2 tests (schema version, revision, migration preview).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IssueStore } from "../core/state.js";
import type { FactoryIssueState } from "../core/types.js";

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-m2-state-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function freshIssue(overrides: Partial<FactoryIssueState> = {}): FactoryIssueState {
  return {
    issue: {
      number: 1,
      title: "t",
      body: "",
      labels: [],
      author: "tester",
      url: "",
      createdAt: new Date().toISOString(),
      comments: [],
    },
    merged: false,
    agentMode: "llm",
    ...overrides,
  };
}

test("save stamps CURRENT_CHECKPOINT_SCHEMA_VERSION and bumps revision", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    const state = freshIssue();
    await store.save(state);
    const onDisk = JSON.parse(readFileSync(path.join(root, "issues", "1.json"), "utf-8")) as FactoryIssueState;
    assert.equal(onDisk.schemaVersion, 2);
    assert.equal(onDisk.revision, 1);

    const state2 = { ...state };
    await store.save(state2);
    const onDisk2 = JSON.parse(readFileSync(path.join(root, "issues", "1.json"), "utf-8")) as FactoryIssueState;
    assert.equal(onDisk2.revision, 2, "second save must increment revision");
  } finally {
    cleanup();
  }
});

test("save with bumpRevision=false preserves the caller's revision (migration preview use case)", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    const state = freshIssue({ revision: 7 });
    await store.save(state, { bumpRevision: false });
    const onDisk = JSON.parse(readFileSync(path.join(root, "issues", "1.json"), "utf-8")) as FactoryIssueState;
    assert.equal(onDisk.revision, 7);
    assert.equal(onDisk.schemaVersion, 2, "schema version is still stamped on a preview write");
  } finally {
    cleanup();
  }
});

test("save refuses to overwrite a newer checkpoint (revision guard)", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    await store.save(freshIssue({ revision: 5 }));
    // Caller holds revision 5, but disk has revision 5+1=6 from the
    // first save. A second save with revision=5 should be refused.
    const stale = freshIssue({ revision: 5 });
    await assert.rejects(
      () => store.save(stale),
      /Refusing to overwrite newer checkpoint/,
    );
  } finally {
    cleanup();
  }
});

test("save writes a content hash sidecar so readers can verify integrity", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    await store.save(freshIssue({ issue: { ...freshIssue().issue, number: 2 } }));
    const sidecar = path.join(root, "issues", "2.json.sha256");
    assert.ok(existsSync(sidecar), "sidecar must exist after save");
  } finally {
    cleanup();
  }
});

test("load stamps legacy records with schemaVersion 1", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const issuesDir = path.join(root, "issues");
    mkdirSync(issuesDir, { recursive: true });
    const legacy = {
      issue: { number: 3, title: "legacy", body: "", labels: [], author: "x", url: "", createdAt: "", comments: [] },
      merged: false,
      attempts: 2,
    };
    writeFileSync(path.join(issuesDir, "3.json"), JSON.stringify(legacy), "utf-8");
    const store = new IssueStore(root);
    const loaded = await store.load(3);
    assert.equal(loaded?.schemaVersion, 1, "missing schemaVersion must be stamped as 1");
  } finally {
    cleanup();
  }
});

test("previewMigration reports missing v2 fields on a legacy checkpoint", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const issuesDir = path.join(root, "issues");
    mkdirSync(issuesDir, { recursive: true });
    const legacy = {
      schemaVersion: 1,
      issue: { number: 4, title: "legacy", body: "", labels: [], author: "x", url: "", createdAt: "", comments: [] },
      merged: false,
    };
    writeFileSync(path.join(issuesDir, "4.json"), JSON.stringify(legacy), "utf-8");
    const store = new IssueStore(root);
    const preview = await store.previewMigration(4);
    assert.equal(preview.exists, true);
    assert.equal(preview.schemaVersion, 1);
    assert.deepEqual(preview.missing.sort(), ["artifacts", "externalOps", "revision"]);
    assert.equal(preview.recommendation, "migrate");
    assert.deepEqual(preview.proposed.artifacts, []);
    assert.deepEqual(preview.proposed.externalOps, []);
    assert.equal(preview.proposed.revision, 1);
    // Source file must NOT be modified.
    const reread = JSON.parse(readFileSync(path.join(issuesDir, "4.json"), "utf-8")) as FactoryIssueState;
    assert.equal(reread.schemaVersion, 1, "preview must be read-only");
  } finally {
    cleanup();
  }
});

test("previewMigration reports ready when the checkpoint is already v2", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    await store.save(freshIssue({ issue: { ...freshIssue().issue, number: 5 } }));
    const preview = await store.previewMigration(5);
    assert.equal(preview.exists, true);
    assert.equal(preview.schemaVersion, 2);
    assert.equal(preview.missing.length, 0);
    assert.equal(preview.recommendation, "ready");
  } finally {
    cleanup();
  }
});

test("previewMigration returns a clean report for a missing checkpoint", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const store = new IssueStore(root);
    const preview = await store.previewMigration(99);
    assert.equal(preview.exists, false);
    assert.equal(preview.recommendation, "ready");
  } finally {
    cleanup();
  }
});