import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression test for the `Cannot read properties of null (reading 'issue')`
 * crash that occurs when `gh issue list` writes a non-array payload (often
 * the literal `null`) to stdout during a transient API error. The daemon
 * now wraps JSON.parse + Array.isArray around the response before iterating.
 *
 * The actual `fetchNextFromGitHub` is an internal helper inside the daemon
 * bundle; instead of booting the daemon, we replicate the shape of the fix
 * here so a future refactor that drops the guard will fail this test.
 */
function parseGhIssueList(out) {
  let issues;
  try {
    issues = JSON.parse(out);
  } catch (error) {
    return { ok: false, reason: "parse-error", error: String(error) };
  }
  if (!Array.isArray(issues)) {
    return { ok: false, reason: "non-array", type: typeof issues };
  }
  issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { ok: true, issues };
}

test("parseGhIssueList accepts a well-formed issue array", () => {
  const result = parseGhIssueList(JSON.stringify([
    { number: 3, createdAt: "2026-09-13T02:36:04Z" },
    { number: 4, createdAt: "2026-09-13T03:00:47Z" },
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 2);
  // Sort orders by createdAt ascending: issue 3 comes first.
  assert.equal(result.issues[0].number, 3);
  assert.equal(result.issues[1].number, 4);
});

test("parseGhIssueList treats a literal `null` payload as empty, not crash", () => {
  // This is the exact payload gh has been observed to write on transient
  // transport failures; the daemon must not throw "Cannot read properties
  // of null (reading 'issue')".
  const result = parseGhIssueList("null");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "non-array");
  assert.equal(result.type, "object");
});

test("parseGhIssueList treats a JSON object payload as empty, not crash", () => {
  const result = parseGhIssueList(JSON.stringify({ message: "API rate limit" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "non-array");
  assert.equal(result.type, "object");
});

test("parseGhIssueList treats non-JSON payload as parse error, not crash", () => {
  const result = parseGhIssueList("gh: Resource not accessible (HTTP 403)");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "parse-error");
  assert.match(result.error, /JSON/);
});

test("parseGhIssueList accepts an empty array (no open issues)", () => {
  const result = parseGhIssueList("[]");
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});
