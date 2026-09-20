/**
 * M5: spec review findings must carry real `requirementIds` (AC-N /
 * VP-N / US-N tokens from the spec body) so the next spec
 * iteration can act on them. The pre-M5 path stamped a synthetic
 * `text-extracted:review-spec` placeholder on every finding, which
 * let the spec-review dead loop slide through every retry without
 * the agent ever seeing the actionable fix instructions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractFindingsFromText, extractRequirementIds } from "../agents/review-spec.js";

test("extractRequirementIds picks up AC-1, AC-2, ... from PRODUCT.md", () => {
  const body = [
    "# Title",
    "## Acceptance criteria",
    "- [ ] **AC-1** An 'Archive completed' action appears when at least one task is completed.",
    "- [ ] **AC-2** Archived tasks are listed in an Archive view for 30 days.",
    "## Open questions",
    "- (none)",
  ].join("\n");
  const ids = extractRequirementIds(body, /^\s*Acceptance criteria/i);
  assert.deepEqual(ids.map((i) => i.id), ["AC-1", "AC-2"]);
  assert.ok(ids[0].text.includes("Archive completed"));
});

test("extractRequirementIds ignores sections that don't match the heading regex", () => {
  const body = [
    "## Acceptance criteria",
    "- AC-1 first",
    "## Validation plan",
    "- AC-2 second (this is in validation, not acceptance)",
  ].join("\n");
  const acIds = extractRequirementIds(body, /^\s*Acceptance criteria/i);
  assert.deepEqual(acIds.map((i) => i.id), ["AC-1"]);
  const vpIds = extractRequirementIds(body, /^\s*Validation plan/i);
  assert.deepEqual(vpIds.map((i) => i.id), ["AC-2"]);
});

test("extractFindingsFromText uses real AC ids when given the criteria", () => {
  const body = [
    "- [CRITICAL] spec file lists both issue-29-issue-ktec and issue-29-kanban (AC-5).",
    "- [SUGGESTION] could use US-2 instead of US-3.",
  ].join("\n");
  const ac = [
    { id: "AC-1" }, { id: "AC-2" }, { id: "AC-5" },
  ];
  const findings = extractFindingsFromText(body, "review-spec", "r1", ac, []);
  assert.equal(findings.length, 2);
  const blocking = findings.find((f) => f.severity === "blocking");
  assert.ok(blocking);
  assert.deepEqual(blocking.requirementIds, ["AC-5"]);
  const suggestion = findings.find((f) => f.severity === "suggestion");
  assert.ok(suggestion);
  // US-2 is not in the criteria list — falls back to synthetic.
  assert.deepEqual(suggestion.requirementIds, ["text-extracted:review-spec"]);
});

test("extractFindingsFromText keeps the synthetic fallback when no criteria are passed", () => {
  const body = "- [CRITICAL] something bad (AC-5).";
  const findings = extractFindingsFromText(body, "review-spec", "r1");
  assert.equal(findings.length, 1);
  // AC-5 not recognised because no criteria list provided.
  assert.deepEqual(findings[0].requirementIds, ["text-extracted:review-spec"]);
});

test("extractFindingsFromText can match VP-N from the validation plan", () => {
  const body = "- [IMPORTANT] missing validation step (VP-2).";
  const findings = extractFindingsFromText(
    body,
    "review-spec",
    "r1",
    [{ id: "AC-1" }],
    [{ id: "VP-1" }, { id: "VP-2" }],
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].requirementIds, ["VP-2"]);
});

test("extractFindingsFromText collects multiple AC tokens from one finding", () => {
  const body = "- [CRITICAL] AC-1 and AC-3 are both missing.";
  const findings = extractFindingsFromText(
    body,
    "review-spec",
    "r1",
    [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }],
    [],
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].requirementIds.sort(), ["AC-1", "AC-3"]);
});
