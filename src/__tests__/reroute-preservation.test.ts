/**
 * Spec plan §3.4 / F02: "reroute 按目标阶段保留修订所需产物与反馈,
 * 只使受影响的下游结果失效". The previous implementation wiped every
 * stage-specific field — including the supervisor's `correction` —
 * which silently lost the feedback the rerouted stage needed to do
 * better next time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRerouteInvalidatedFields,
  rerouteInvalidatedFields,
  reroutePreservedFields,
} from "../orchestrator/index.js";

function makeState(): Record<string, unknown> {
  return {
    specs: { product: { body: "PRODUCT" }, tech: { body: "TECH" } },
    specReview: { verdict: "REJECT", body: "scope creep" },
    specReviewedKey: "spec-key-1",
    implementation: { commitSha: "deadbeef", branch: "factory/issue-7" },
    review: { verdict: "APPROVE", body: "looks good" },
    reviewedSha: "abc123",
    reviewedBaseSha: "base123",
    verifiedSha: "ver456",
    correction: { targetStage: "spec", turns: ["please trim scope"] },
  };
}

test("reroute to triage clears all downstream stage outputs but keeps correction", () => {
  const invalidated = rerouteInvalidatedFields("triage");
  assert.ok(invalidated.includes("specs"));
  assert.ok(invalidated.includes("implementation"));
  assert.ok(invalidated.includes("verifiedSha"));
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "triage");
  for (const field of invalidated) assert.equal(state[field], undefined, `${field} must be cleared`);
  assert.ok(state.correction, "correction must survive every reroute");
});

test("reroute to spec preserves the previous spec body so the next spec agent can amend (P0 fix)", () => {
  // P0 fix (2026-09-18): reroute-to-spec used to clear state.specs
  // and state.specReview, which made the spec-review dead loop
  // structurally unrecoverable. The next spec agent had no
  // previousProductBody / previousTechBody / specReviewFindings
  // to act on, so the LLM re-derived the spec from the issue body
  // and produced a near-identical commit each retry. The fix:
  // preserve state.specs and state.specReview across reroute-to-spec;
  // drop only specReviewedKey (the cache key binds to a commit SHA
  // that the next spec agent is about to change).
  const invalidated = rerouteInvalidatedFields("spec");
  assert.ok(!invalidated.includes("specs"), "P0: specs must NOT be invalidated on reroute-to-spec");
  assert.ok(!invalidated.includes("specReview"), "P0: specReview must NOT be invalidated on reroute-to-spec");
  assert.ok(invalidated.includes("specReviewedKey"), "specReviewedKey must drop because next spec commit changes the SHA");
  assert.ok(invalidated.includes("implementation"), "implementation is downstream of spec, must be cleared");
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "spec");
  assert.ok(state.specs, "P0: specs preserved — the next spec agent reads previousProductBody/previousTechBody from it");
  assert.ok(state.specReview, "P0: specReview preserved — the next spec agent reads specReviewFindings from it");
  assert.equal(state.implementation, undefined, "downstream of spec is cleared");
  assert.ok(state.correction, "F02: correction must survive the reroute");
});

test("reroute to review-spec keeps specs, specReview, specReviewedKey, and correction", () => {
  const invalidated = rerouteInvalidatedFields("review-spec");
  assert.deepEqual(
    invalidated,
    ["implementation", "review", "reviewedSha", "reviewedBaseSha", "verifiedSha"],
    "review-spec only invalidates downstream of itself",
  );
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "review-spec");
  assert.ok(state.specs, "specs preserved — review-spec needs them as input");
  assert.ok(state.specReview, "specReview preserved");
  assert.equal(state.specReviewedKey, "spec-key-1", "cache key preserved");
  assert.equal(state.implementation, undefined, "implementation cleared — downstream of review-spec");
  assert.equal(state.reviewedSha, undefined, "reviewedSha cleared");
  assert.ok(state.correction, "correction preserved");
});

test("reroute to implementation keeps specs, specReview, and correction", () => {
  const invalidated = rerouteInvalidatedFields("implementation");
  assert.deepEqual(invalidated, ["review", "reviewedSha", "reviewedBaseSha", "verifiedSha"]);
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "implementation");
  assert.ok(state.specs, "implementation needs specs as input");
  assert.ok(state.specReview, "implementation needs specReview as input");
  assert.equal(state.review, undefined, "review is downstream of implementation");
  assert.equal(state.verifiedSha, undefined, "verifiedSha is downstream");
});

test("reroute to review-pr keeps implementation and reviewedSha but drops verifiedSha", () => {
  const invalidated = rerouteInvalidatedFields("review-pr");
  assert.deepEqual(invalidated, ["verifiedSha"]);
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "review-pr");
  assert.ok(state.implementation, "review-pr needs implementation as input");
  assert.equal(state.implementation, state.implementation, "unchanged");
  assert.equal(state.verifiedSha, undefined, "verify is downstream of review-pr");
});

test("reroute to verify-behavior keeps everything", () => {
  const invalidated = rerouteInvalidatedFields("verify-behavior");
  assert.deepEqual(invalidated, []);
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, "verify-behavior");
  for (const key of [
    "specs",
    "specReview",
    "specReviewedKey",
    "implementation",
    "review",
    "reviewedSha",
    "reviewedBaseSha",
    "verifiedSha",
  ]) {
    assert.ok(state[key], `${key} must survive reroute to verify-behavior`);
  }
});

test("reroutePreservedFields is the complement of rerouteInvalidatedFields for review-spec", () => {
  const preserved = reroutePreservedFields("review-spec");
  assert.deepEqual(preserved, ["specs", "specReview", "specReviewedKey"]);
});

test("reroutePreservedFields is empty for triage reroute", () => {
  assert.deepEqual(reroutePreservedFields("triage"), []);
});

test("unknown reroute target falls back to a conservative invalidation set, correction survives", () => {
  const invalidated = rerouteInvalidatedFields(undefined);
  assert.ok(invalidated.includes("specs"));
  assert.ok(invalidated.includes("implementation"));
  const state = makeState();
  clearRerouteInvalidatedFields(state as never, undefined);
  for (const field of invalidated) assert.equal(state[field], undefined, `${field} cleared`);
  assert.ok(state.correction, "correction must survive even unknown reroute targets");
});