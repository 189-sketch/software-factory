/**
 * Finding lifecycle tests (M4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  countByStatus,
  dismissFinding,
  makeFinding,
  mergeFindings,
  resolveFinding,
  supersedeFinding,
  validateFinding,
} from "../core/findings.js";
import type { Finding, ReviewerFindingsBundle } from "../core/types.js";

function makeOpen(overrides: Partial<Finding> = {}): Finding {
  return makeFinding({
    ruleId: "missing-acceptance-criteria",
    severity: "blocking",
    summary: "PRODUCT.md has no Acceptance Criteria heading",
    sourceStage: "review-spec",
    sourceRunId: "r-1",
    requirementIds: ["req-1"],
    ...overrides,
  });
}

test("validateFinding accepts a well-formed blocking finding with a requirementId", () => {
  assert.deepEqual(validateFinding(makeOpen()), []);
});

test("validateFinding rejects a blocking finding with no requirementIds", () => {
  const f = makeOpen({ requirementIds: [] });
  const problems = validateFinding(f);
  assert.ok(problems.some((p) => p.includes("requirementId")));
});

test("validateFinding allows advisory findings without a requirementId", () => {
  const f = makeOpen({ severity: "suggestion", requirementIds: [] });
  assert.deepEqual(validateFinding(f), []);
});

test("validateFinding flags missing id / ruleId / stage / runId / registeredAt", () => {
  const f = makeOpen();
  delete (f as Partial<Finding>).id;
  delete (f as Partial<Finding>).ruleId;
  delete (f as Partial<Finding>).sourceStage;
  delete (f as Partial<Finding>).sourceRunId;
  delete (f as Partial<Finding>).registeredAt;
  const problems = validateFinding(f);
  assert.ok(problems.some((p) => p.includes("id")));
  assert.ok(problems.some((p) => p.includes("ruleId")));
  assert.ok(problems.some((p) => p.includes("sourceStage")));
  assert.ok(problems.some((p) => p.includes("sourceRunId")));
  assert.ok(problems.some((p) => p.includes("registeredAt")));
});

test("resolveFinding transitions open → resolved and records the resolver", () => {
  const f = makeOpen();
  const closed = resolveFinding(f, { revisionId: "rev-2", note: "Acceptance section added" });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedByRevisionId, "rev-2");
  assert.equal(closed.resolutionNote, "Acceptance section added");
  // Input is not mutated.
  assert.equal(f.status, "open");
});

test("resolveFinding throws on a non-open finding", () => {
  const f = makeOpen();
  const closed = resolveFinding(f, { revisionId: "rev-2" });
  assert.throws(() => resolveFinding(closed, { revisionId: "rev-3" }), /Cannot resolve/);
});

test("dismissFinding records the reason and marks dismissed", () => {
  const f = makeOpen();
  const closed = dismissFinding(f, "User replied it is not in scope");
  assert.equal(closed.status, "dismissed");
  assert.equal(closed.resolutionNote, "User replied it is not in scope");
});

test("supersedeFinding links to the replacement finding", () => {
  const f = makeOpen();
  const replacementId = "f-new";
  const closed = supersedeFinding(f, replacementId, "Reworded with sharper evidence");
  assert.equal(closed.status, "superseded");
  assert.equal(closed.resolvedByRevisionId, replacementId);
});

test("mergeFindings rejects invalid reviewer findings before they reach the store", () => {
  const invalid: Finding = makeOpen({ severity: "blocking", requirementIds: [] });
  const bundle: ReviewerFindingsBundle = {
    stage: "review-spec",
    runId: "r-2",
    requirementVersion: 1,
    findings: [invalid],
  };
  assert.throws(() => mergeFindings([], bundle), /Invalid finding emitted by reviewer/);
});

test("mergeFindings appends valid findings and reports what was added", () => {
  const a = makeOpen({ summary: "issue A" });
  const b = makeOpen({ summary: "issue B", ruleId: "rule-b" });
  const bundle: ReviewerFindingsBundle = {
    stage: "review-spec",
    runId: "r-2",
    requirementVersion: 1,
    findings: [a, b],
  };
  const result = mergeFindings([], bundle);
  assert.equal(result.added.length, 2);
  assert.equal(result.findings.length, 2);
});

test("countByStatus tallies the lifecycle states", () => {
  const a = makeOpen();
  const b = resolveFinding(makeOpen(), { revisionId: "rev" });
  const c = dismissFinding(makeOpen(), "x");
  const d = supersedeFinding(makeOpen(), "f-new");
  const counts = countByStatus([a, b, c, d]);
  assert.equal(counts.open, 1);
  assert.equal(counts.resolved, 1);
  assert.equal(counts.dismissed, 1);
  assert.equal(counts.superseded, 1);
});