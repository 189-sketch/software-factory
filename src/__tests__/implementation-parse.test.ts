import test from "node:test";
import assert from "node:assert/strict";
import {
  ImplementationParseError,
  parseImplementationResult,
} from "../agents/implementation.js";
import type { ValidationResult } from "../core/types.js";

/**
 * Unit tests for `parseImplementationResult`.
 *
 * The implementation agent's parser used to throw on any non-JSON
 * LLM response and abort the whole pipeline with "Task requires
 * operator intervention". Three tiers of recovery are now in place:
 *   1. JSON parses with non-empty comment → return as-is.
 *   2. JSON parses but comment is empty / no JSON at all → salvage
 *      the prose into a PR body so the commit + PR steps still run.
 *   3. Truly empty LLM output → throw `ImplementationParseError` so
 *      the orchestrator can route the issue back through triage.
 *
 * These tests pin the three tiers so the recovery contract is
 * unit-testable without standing up the LLM agent loop.
 */

const VALIDATION: ValidationResult[] = [
  { command: "node --test", exitCode: 0, stdout: "ok", stderr: "" },
];
const VALIDATION_FAILED: ValidationResult[] = [
  { command: "node --test", exitCode: 1, stdout: "", stderr: "1 test failed" },
];

test("parseImplementationResult returns JSON-shaped result when LLM complies", () => {
  const text = JSON.stringify({
    filesChanged: ["src/foo.js", "tests/foo.test.js"],
    comment: "Added foo and a regression test.",
  });
  const result = parseImplementationResult(text, VALIDATION, true);
  assert.deepEqual(result.files, ["src/foo.js", "tests/foo.test.js"]);
  assert.equal(result.comment, "Added foo and a regression test.");
  assert.deepEqual(result.warnings, []);
});

test("parseImplementationResult salvages prose when LLM emits only analysis", () => {
  // Mirrors the failure mode that motivated this fix: the LLM produced
  // pure analysis prose ("No autoprefixer. Now I have a clear picture
  // of the issues...") instead of the required JSON shape.
  const prose = [
    "No autoprefixer. Now I have a clear picture of the issues.",
    "Let me also see the pr_description, pr_diff, and review files.",
  ].join("\n");
  const result = parseImplementationResult(prose, VALIDATION, true);
  assert.deepEqual(result.files, [], "salvaged result declares no files; the commit step uses on-disk state");
  assert.match(result.comment, /not valid JSON/i);
  assert.match(result.comment, /--- raw LLM output ---/);
  assert.ok(result.comment.includes("No autoprefixer"));
  assert.ok(result.comment.includes("pr_description, pr_diff, and review files"));
  assert.ok(
    result.warnings.some((w) => /not valid JSON/i.test(w)),
    `expected a JSON-parse warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test("parseImplementationResult salvages when JSON parses but comment is empty", () => {
  // Even when the LLM emits valid JSON, an empty comment field is
  // useless to the review agent — fall through to salvage rather
  // than silently producing a PR with no body.
  const text = JSON.stringify({ filesChanged: ["src/foo.js"], comment: "  " });
  const result = parseImplementationResult(text, VALIDATION, true);
  assert.match(result.comment, /empty `comment` field/);
  assert.match(result.comment, /--- raw LLM output ---/);
  assert.ok(result.warnings.some((w) => /not valid JSON|salvage/i.test(w)));
});

test("parseImplementationResult salvages when JSON parses but filesChanged is malformed", () => {
  // `stringList` throws on non-string-array filesChanged. Catch and
  // fall through to salvage so the pipeline still opens a PR.
  const text = JSON.stringify({ filesChanged: "src/foo.js", comment: "Added foo." });
  const result = parseImplementationResult(text, VALIDATION, true);
  assert.match(result.comment, /not valid JSON/);
});

test("parseImplementationResult truncates over-long salvaged prose", () => {
  // Keeps the PR body sane when the LLM dumps thousands of lines of
  // analysis prose. The truncation marker must appear so reviewers
  // know the salvage was lossy.
  const prose = "x".repeat(8000);
  const result = parseImplementationResult(prose, VALIDATION, true);
  assert.ok(result.comment.length < 8000, "salvaged comment must be truncated");
  assert.match(result.comment, /truncated at \d+ chars/);
});

test("parseImplementationResult throws ImplementationParseError on empty output", () => {
  // Truly empty LLM output cannot be salvaged — the salvage body
  // would itself be empty. Throw so the orchestrator's self-heal
  // routes the issue through triage.
  assert.throws(
    () => parseImplementationResult("", [], false),
    (err: unknown) => err instanceof ImplementationParseError && /empty output/.test((err as Error).message),
  );
  assert.throws(
    () => parseImplementationResult("   \n  \t  ", [], false),
    (err: unknown) => err instanceof ImplementationParseError,
  );
});

test("parseImplementationResult warns on missing validation, failed validation, and empty files", () => {
  // The soft warnings already pinned by the existing implementation
  // pipeline must still surface after the salvage refactor — a
  // salvaged result with no validation history is even more
  // dangerous than a clean result with the same shape.
  const text = JSON.stringify({ filesChanged: [], comment: "Done." });
  const result = parseImplementationResult(text, [], false);
  assert.ok(result.warnings.some((w) => /did not call run_validation/.test(w)));
  assert.ok(result.warnings.some((w) => /declared no file changes/.test(w)));
});

test("parseImplementationResult warns on failed validation", () => {
  const text = JSON.stringify({ filesChanged: ["src/foo.js"], comment: "Done." });
  const result = parseImplementationResult(text, VALIDATION_FAILED, false);
  assert.ok(result.warnings.some((w) => /validation did not pass/.test(w)));
});

test("ImplementationParseError carries raw output for diagnostics", () => {
  // The orchestrator self-heal logs the error; including the raw
  // output makes the log line useful when triaging the issue.
  let captured: ImplementationParseError | undefined;
  try {
    parseImplementationResult("", [], false);
  } catch (err) {
    captured = err as ImplementationParseError;
  }
  assert.ok(captured instanceof ImplementationParseError);
  assert.equal(captured!.rawOutput, "");
  assert.equal(captured!.name, "ImplementationParseError");
});
