/**
 * Severity unification (M4): reviewers emit textual markers like
 * `[CRITICAL]` / `**IMPORTANT**` / `NIT:`; the parser now translates
 * those into the structured `FindingSeverity` vocabulary so the
 * orchestrator can grade severity from a typed table instead of
 * re-running a regex over prose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  containsBlockingFinding,
  containsBlockingFindingFromList,
  extractFindingsFromText,
  parseSpecReviewResult,
} from "../agents/review-spec.js";
import { parseReviewResult } from "../agents/review-pr.js";

test("extractFindingsFromText maps [CRITICAL] to severity='blocking'", () => {
  const findings = extractFindingsFromText(
    "- **[CRITICAL]** — Acceptance Criteria section is missing.\n- more text",
    "review-spec",
    "run-1",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "blocking");
  assert.match(findings[0].summary, /Acceptance Criteria/);
  assert.equal(findings[0].sourceStage, "review-spec");
  assert.equal(findings[0].sourceRunId, "run-1");
  assert.equal(findings[0].status, "open");
});

test("extractFindingsFromText handles the bold and colon variants", () => {
  const findings = extractFindingsFromText(
    "[SUGGESTION] tighten wording\n**IMPORTANT**: missing export check\nNIT: stray whitespace",
    "review-pr",
    "run-2",
  );
  const byLabel = findings.map((f) => f.severity).sort();
  assert.deepEqual(byLabel, ["important", "nit", "suggestion"]);
});

test("extractFindingsFromText skips unknown markers (no false positives)", () => {
  const findings = extractFindingsFromText(
    "**POLICY**: this is not a severity marker\nSome prose.",
    "review-spec",
    "run-3",
  );
  assert.equal(findings.length, 0);
});

test("containsBlockingFindingFromList returns true only when a blocking severity is present", () => {
  assert.equal(containsBlockingFindingFromList([
    { severity: "nit" } as never,
  ]), false);
  assert.equal(containsBlockingFindingFromList([
    { severity: "suggestion" } as never,
  ]), false);
  assert.equal(containsBlockingFindingFromList([
    { severity: "blocking" } as never,
  ]), true);
  assert.equal(containsBlockingFindingFromList(undefined), false);
});

test("legacy containsBlockingFinding still recognizes the textual markers", () => {
  assert.equal(containsBlockingFinding("[CRITICAL] text"), true);
  assert.equal(containsBlockingFinding("**IMPORTANT** text"), true);
  assert.equal(containsBlockingFinding("SUGGESTION: text"), false, "SUGGESTION alone is not blocking");
  assert.equal(containsBlockingFinding("nothing here"), false);
});

test("parseSpecReviewResult populates the findings array and uses it for the APPROVE→REJECT downgrade", () => {
  const text = JSON.stringify({
    verdict: "APPROVE",
    body: "Found: 1 critical, 0 important.\n\n- **[CRITICAL]** — Missing acceptance criteria.",
    comments: [
      {
        path: "specs/issue-7/PRODUCT.md",
        line: 1,
        side: "RIGHT",
        body: "🚨 [CRITICAL] no acceptance criteria section",
      },
    ],
    notes: "",
  });
  const result = parseSpecReviewResult(text, "run-1");
  assert.equal(result.verdict, "REJECT", "blocking finding must downgrade APPROVE to REJECT");
  assert.ok(result.findings && result.findings.length >= 2, "must capture findings from body and comments");
  assert.ok(result.findings!.some((f) => f.severity === "blocking"), "at least one finding must be blocking");
});

test("parseSpecReviewResult preserves APPROVE when no blocking findings are present", () => {
  const text = JSON.stringify({
    verdict: "APPROVE",
    body: "Looks good.\n\n- [NIT] — typo on line 12",
    comments: [],
    notes: "",
  });
  const result = parseSpecReviewResult(text, "run-2");
  assert.equal(result.verdict, "APPROVE");
  assert.ok(result.findings && result.findings.length === 1);
  assert.equal(result.findings![0].severity, "nit");
});

test("parseReviewResult mirrors the spec-review severity handling for code review", () => {
  const text = JSON.stringify({
    verdict: "APPROVE",
    body: "[IMPORTANT] dangerouslySetInnerHTML on user input.",
    comments: [],
  });
  const result = parseReviewResult(text, "run-3");
  assert.equal(result.verdict, "REJECT");
  assert.ok(result.findings && result.findings[0].severity === "important");
});