/**
 * M5: spec agent must receive a typed revision prompt that includes
 * the structured findings the reviewer emitted. This is the surface
 * that breaks the spec-review dead loop: previously the spec agent
 * only saw the reviewer's verdict via issue-comment regex parsing,
 * which silently dropped the actionable fix instructions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatSpecRevisionPrompt, type SpecRevisionInput } from "../agents/spec.js";

test("structured findings path renders the fix instructions", () => {
  const input: SpecRevisionInput = {
    feedback: "(fallback text, not used when findings present)",
    previousProductBody: "old product body",
    previousTechBody: "old tech body",
    previousCommitSha: "abc1234",
    previousVerdict: "REJECT",
    revisionId: "rev-uuid-1",
    specReviewFindings: [
      {
        id: "F-1",
        ruleId: "duplicate-spec-directory",
        severity: "blocking",
        requirementIds: ["AC-5"],
        summary: "two spec directories committed",
        evidence: { path: "specs/issue-29-issue-ktec/PRODUCT.md", excerpt: "duplicate" },
      },
      {
        id: "F-2",
        ruleId: "missing-validation-plan",
        severity: "important",
        summary: "no validation plan",
      },
    ],
  };
  const out = formatSpecRevisionPrompt(input, "product");
  assert.ok(out.includes("Previous spec commit: abc1234"));
  assert.ok(out.includes("Previous review verdict: REJECT"));
  assert.ok(out.includes("revision rev-uuid-1"));
  assert.ok(out.includes("F-1 [blocking] ruleId=duplicate-spec-directory"));
  assert.ok(out.includes("req: AC-5"));
  assert.ok(out.includes("specs/issue-29-issue-ktec/PRODUCT.md"));
  assert.ok(out.includes("F-2 [important]"));
  assert.ok(out.includes("old product body"));
  // The fallback text should NOT be present when findings carry the signal.
  assert.ok(!out.includes("fallback text"));
});

test("legacy path (no findings) falls back to feedback text", () => {
  const input: SpecRevisionInput = {
    feedback: "this is the legacy reviewer body",
    previousProductBody: "old",
    previousTechBody: "old",
  };
  const out = formatSpecRevisionPrompt(input, "product");
  assert.ok(out.includes("this is the legacy reviewer body"));
  assert.ok(!out.includes("Blocking findings to address"));
});

test("empty findings array is treated as no findings (use feedback)", () => {
  const input: SpecRevisionInput = {
    feedback: "feedback",
    previousProductBody: "old",
    previousTechBody: "old",
    specReviewFindings: [],
  };
  const out = formatSpecRevisionPrompt(input, "product");
  // Empty array → no blocking findings block; falls back to feedback.
  assert.ok(out.includes("feedback"));
  assert.ok(!out.includes("Blocking findings to address"));
});

test("commit sha / verdict are omitted when undefined", () => {
  const input: SpecRevisionInput = {
    feedback: "x",
    previousProductBody: "old",
    previousTechBody: "old",
  };
  const out = formatSpecRevisionPrompt(input, "product");
  assert.ok(!out.includes("Previous spec commit:"));
  assert.ok(!out.includes("Previous review verdict:"));
  assert.ok(!out.includes("This is revision"));
});
