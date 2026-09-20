/**
 * M5: the stage-input-manifest's `findings[]` field was previously
 * hardcoded to `[]`. After the spec-review dead loop was diagnosed
 * (issue #29, 2026-09-17) the orchestrator needed a typed channel
 * for surfacing previous review findings to the next stage. This
 * test pins the contract: open findings from specReview + review
 * become InputFindingRef[] with the right truncation, severity,
 * requirementId, and stage scoping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildStageInputManifest } from "../core/stage-input-manifest.js";

const baseState = {
  issue: { number: 29 },
  specReview: {
    verdict: "REJECT",
    body: "...",
    findings: [
      { id: "F-1", ruleId: "duplicate-spec-directory", severity: "blocking", requirementIds: ["AC-5"], summary: "two spec directories", status: "open" },
      { id: "F-2", ruleId: "tbd-phrase", severity: "suggestion", requirementIds: [], summary: "uses TBD", status: "open" },
      { id: "F-3", ruleId: "resolved", severity: "important", summary: "fixed last time", status: "resolved" },
    ],
  },
  review: {
    verdict: "APPROVE",
    body: "...",
    findings: [
      { id: "F-4", ruleId: "missing-test", severity: "blocking", requirementIds: ["AC-2"], summary: "no test", status: "open" },
    ],
  },
  openQuestions: [
    { id: "Q-1", raisedBy: "spec", text: "which label?", blocking: true, raisedAt: "2026-09-17" },
    { id: "Q-2", raisedBy: "spec", text: "nice to know", blocking: false, raisedAt: "2026-09-17" },
  ],
} as const;

test("spec stage receives open specReview findings + blocking open questions", () => {
  const m = buildStageInputManifest(baseState, "spec", "r1", "/work");
  const ids = m.findings.map((f) => f.findingId);
  assert.ok(ids.includes("F-1"), "F-1 should appear");
  assert.ok(ids.includes("F-2"), "F-2 should appear");
  assert.ok(!ids.includes("F-3"), "F-3 is resolved, must be excluded");
  assert.ok(ids.includes("Q-1"), "Q-1 is blocking, must appear");
  assert.ok(!ids.includes("Q-2"), "Q-2 is non-blocking, must be excluded");
  // No review.findings at this stage.
  assert.ok(!ids.includes("F-4"));
});

test("implementation stage gets BOTH spec-review and review findings", () => {
  const m = buildStageInputManifest(baseState, "implementation", "r2", "/work");
  const ids = m.findings.map((f) => f.findingId);
  assert.ok(ids.includes("F-1"), "F-1 from spec-review");
  assert.ok(ids.includes("F-4"), "F-4 from review");
  assert.ok(!ids.includes("F-3"), "F-3 still resolved");
});

test("review-pr stage gets only review findings, not specReview", () => {
  const m = buildStageInputManifest(baseState, "review-pr", "r3");
  const ids = m.findings.map((f) => f.findingId);
  assert.ok(!ids.includes("F-1"), "F-1 is specReview, not for review-pr");
  assert.ok(ids.includes("F-4"), "F-4 is review, must appear");
});

test("findings cap at 20 + truncate summaries to 200 chars", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `F-${i}`,
    ruleId: "r",
    severity: "blocking" as const,
    summary: "x".repeat(500),
    status: "open",
  }));
  const m = buildStageInputManifest(
    { issue: { number: 1 }, specReview: { findings: many } },
    "spec",
    "r1",
  );
  assert.equal(m.findings.length, 20);
  assert.equal(m.findings[0].summary.length, 200);
  assert.ok(m.findings[0].summary.endsWith("..."));
});

test("empty findings list yields empty array (not undefined)", () => {
  const m = buildStageInputManifest({ issue: { number: 1 } }, "spec", "r1");
  assert.deepEqual(m.findings, []);
});
