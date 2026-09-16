/**
 * StageInputManifest tests (M3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildStageInputManifest,
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

test("buildStageInputManifest stamps the runId and turns spec bodies into artifact refs", () => {
  const state = {
    issue: { number: 7 },
    specLoopVersion: 4,
    specs: { product: { body: "PRODUCT body", slug: "issue-7-x" }, tech: { body: "TECH body", slug: "issue-7-x" } },
    specReview: { verdict: "REJECT", body: "scope creep" },
    implementation: { commitSha: "abc123", branch: "factory/issue-7" },
    review: { verdict: "APPROVE", body: "looks good" },
    correction: { targetStage: "spec", turns: ["trim scope"] },
  };
  const manifest = buildStageInputManifest(state, "review-spec", "run-123", "/workdir");
  assert.equal(manifest.stage, "review-spec");
  assert.equal(manifest.manifestId, "manifest-run-123");
  assert.equal(manifest.requirementVersion, 4, "requirementVersion follows specLoopVersion");
  const kinds = manifest.artifacts.map((a) => a.kind);
  assert.ok(kinds.includes("spec-product"), "review-spec reads PRODUCT");
  assert.ok(kinds.includes("spec-tech"), "review-spec reads TECH");
  // review-spec produces specReview; it must not see its own output.
  assert.ok(!kinds.includes("spec-review"), "review-spec must not see its own output");
  // review-spec is upstream of implementation; downstream must not
  // leak forward.
  assert.ok(!kinds.includes("implementation"));
  // spec-product path is built from workdir + slug
  const productRef = manifest.artifacts.find((a) => a.kind === "spec-product");
  assert.equal(productRef?.path, "/workdir/specs/issue-7-x/PRODUCT.md");
  assert.equal(productRef?.hash, hashText("PRODUCT body"));
  assert.equal(manifest.decisions.length, 1, "supervisor correction becomes a decision");
  assert.equal(manifest.decisions[0].status, "accepted");
  assert.match(manifest.note ?? "", /trim scope/);
  assert.ok(manifest.completionCriteria.length > 0, "completionCriteria must not be empty");
});

test("buildStageInputManifest for an empty state still produces a valid manifest", () => {
  const state = { issue: { number: 1 } };
  const manifest = buildStageInputManifest(state, "triage", "run-empty");
  assert.equal(manifest.stage, "triage");
  assert.equal(manifest.requirementVersion, 1);
  assert.equal(manifest.artifacts.length, 0);
  assert.equal(manifest.decisions.length, 0);
  assert.equal(manifest.findings.length, 0);
  assert.ok(manifest.completionCriteria.length > 0, "even triage has criteria");
});