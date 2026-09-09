import test from "node:test";
import assert from "node:assert/strict";
import { containsBlockingFinding } from "../agents/review-pr.js";

test("blocking review findings are recognized in body prose", () => {
  for (const body of [
    "IMPORTANT: reset breaks the paused state",
    "CRITICAL: credentials are exposed",
    "**IMPORTANT** - tests do not execute",
    "⚠️ [IMPORTANT] build is broken",
  ]) {
    assert.equal(containsBlockingFinding(body), true, body);
  }
  assert.equal(containsBlockingFinding("SUGGESTION: rename this helper"), false);
});
