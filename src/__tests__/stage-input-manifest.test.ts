/**
 * StageInputManifest tests (M3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashFile,
  hashText,
  verifyArtifact,
  summarizeManifest,
  type InputArtifactRef,
  type StageInputManifest,
} from "../core/stage-input-manifest.js";

function tempFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-m3-"));
  const filePath = path.join(dir, "artifact.bin");
  writeFileSync(filePath, content, "utf-8");
  return { path: filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("hashText is deterministic and 64-char hex", () => {
  const h = hashText("hello");
  assert.equal(h.length, 64);
  assert.equal(h, hashText("hello"));
  assert.notEqual(h, hashText("hello!"));
});

test("hashFile matches hashText for the same content", async () => {
  const { path: p, cleanup } = tempFile("payload");
  try {
    assert.equal(await hashFile(p), hashText("payload"));
  } finally {
    cleanup();
  }
});

test("verifyArtifact succeeds when file content matches the recorded hash", async () => {
  const { path: p, cleanup } = tempFile("abc");
  try {
    const ref: InputArtifactRef = { kind: "x", hash: hashText("abc"), path: p, sourceRunId: "r", sourceStage: "spec" };
    const result = await verifyArtifact(ref);
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test("verifyArtifact reports a hash mismatch when the file was edited out of band", async () => {
  const { path: p, cleanup } = tempFile("abc");
  try {
    const ref: InputArtifactRef = { kind: "x", hash: hashText("abc"), path: p, sourceRunId: "r", sourceStage: "spec" };
    writeFileSync(p, "abc-edited", "utf-8");
    const result = await verifyArtifact(ref);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "mismatch");
  } finally {
    cleanup();
  }
});

test("verifyArtifact reports missing when the path does not exist", async () => {
  const ref: InputArtifactRef = { kind: "x", hash: "deadbeef", path: "/no/such/file", sourceRunId: "r", sourceStage: "spec" };
  const result = await verifyArtifact(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing");
});

test("verifyArtifact reports missing when the ref has no path", async () => {
  const ref: InputArtifactRef = { kind: "x", hash: "deadbeef", sourceRunId: "r", sourceStage: "spec" };
  const result = await verifyArtifact(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing");
});

test("summarizeManifest produces a one-line preview with the right counts", () => {
  const manifest: StageInputManifest = {
    manifestId: "m-1",
    stage: "review-spec",
    issueNumber: 1,
    sourceRunId: "r-1",
    createdAt: "2026-09-14T00:00:00.000Z",
    requirementVersion: 3,
    artifacts: [
      { kind: "spec-product", hash: "p", sourceRunId: "r-0", sourceStage: "spec-product" },
      { kind: "spec-tech", hash: "t", sourceRunId: "r-0", sourceStage: "spec-tech" },
    ],
    findings: [
      { findingId: "f-1", ruleId: "r-1", severity: "blocking", summary: "x" },
    ],
    decisions: [],
    rules: [
      { ruleId: "r-1", contentHash: "h", label: "severity" },
    ],
    completionCriteria: [],
  };
  const summary = summarizeManifest(manifest);
  assert.match(summary, /stage=review-spec/);
  assert.match(summary, /req=3/);
  assert.match(summary, /artifacts=2/);
  assert.match(summary, /findings=1/);
  assert.match(summary, /rules=1/);
});