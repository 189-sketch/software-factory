import test from "node:test";
import assert from "node:assert/strict";
import {
  containsBlockingFinding,
  heuristicSpecReview,
  ReviewSpecAgent,
} from "../agents/review-spec.js";
import type { AgentContext } from "../core/types.js";

/**
 * ReviewSpecAgent unit tests.
 *
 * Mirrors `src/__tests__/review-policy.test.ts` so the two review
 * agents share one vocabulary. Heavy LLM-path coverage is intentionally
 * out of scope — these tests focus on:
 *
 *   - the blocking-finding body detector (severity prefix matches),
 *   - the deterministic `heuristicSpecReview` helper that the
 *     plan/act/finalize scaffold also calls when the LLM path is
 *     bypassed,
 *   - the public surface (the agent constructor) being callable with
 *     a minimal AgentContext without throwing.
 *
 * The heuristic is exercised through its exported pure helper so the test
 * stays independent from the Harness-backed agent execution lifecycle.
 */

test("review-spec recognizes CRITICAL/IMPORTANT body markers", () => {
  assert.ok(containsBlockingFinding("**CRITICAL** validation plan is unfalsifiable"));
  assert.ok(containsBlockingFinding("[IMPORTANT] scope creep detected in TECH.md"));
  assert.ok(containsBlockingFinding("CRITICAL: the spec promises a migration with no migration plan"));
  assert.ok(containsBlockingFinding("IMPORTANT : acceptance criterion not traceable"));
  assert.ok(!containsBlockingFinding("[SUGGESTION] rename for clarity"));
  assert.ok(!containsBlockingFinding("[NIT] wording nit on line 3"));
  assert.ok(!containsBlockingFinding("All clear, no blocking findings"));
});

function makeContext(): AgentContext {
  return {
    repo: { owner: "o", name: "n", defaultBranch: "main", workdir: process.cwd() },
    issue: {
      number: 1,
      title: "Test spec review",
      body: "Anchored issue body for spec review heuristics.",
      labels: [],
      author: "tester",
      url: "https://example/issues/1",
      createdAt: new Date().toISOString(),
      comments: [],
    },
    skills: [],
    skillsRoot: "/tmp",
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => makeContext().logger,
    },
    runId: "test",
  };
}

test("ReviewSpecAgent constructs without throwing", () => {
  const agent = new ReviewSpecAgent(makeContext());
  assert.equal(agent.name, "review-spec");
});

test("ReviewSpecAgent name matches the orchestrator dispatch key", () => {
  // runForIssue dispatches `await context('review-spec')` to load this
  // skill and `new ReviewSpecAgent(reviewCtx)` to construct the agent.
  // Both depend on `name === 'review-spec'`.
  const agent = new ReviewSpecAgent(makeContext());
  assert.equal(agent.name, "review-spec");
});

test("heuristicSpecReview flags PRODUCT.md missing Acceptance Criteria section", () => {
  // The heuristic fallback path MUST REJECT any spec whose PRODUCT.md
  // body lacks an `## Acceptance Criteria` heading. Merely mentioning
  // "acceptance criteria" in prose is not a substitute for a section.
  const result = heuristicSpecReview(
    "",
    "Some intro text but no acceptance criteria section.\n\n## Goals\n- do the thing",
    "## Validation Plan\n- run unit tests",
  );
  assert.equal(result.verdict, "REJECT");
  assert.ok(result.body.toLowerCase().includes("critical"));
});

test("heuristicSpecReview flags vague TECH.md validation items in annotated diff", () => {
  // Matches the "verify manually" / "test manually" patterns in the
  // annotated diff lines (the format `prepareSpecReviewArtifacts`
  // writes via `annotateDiff`). The validation plan must be concrete.
  const annotatedDiff = [
    "+++ b/specs/x/TECH.md",
    "[NEW:1] ## Validation Plan",
    "[NEW:2] - verify manually with PM",
  ].join("\n");
  const result = heuristicSpecReview(
    annotatedDiff,
    "## Acceptance Criteria\n- works",
    "## Validation Plan\n- verify manually with PM",
  );
  assert.equal(result.verdict, "REJECT");
  assert.ok(result.comments.some((c) => c.body.includes("vague")));
});

test("heuristicSpecReview returns APPROVE for a clean spec", () => {
  const result = heuristicSpecReview(
    "",
    "## Acceptance Criteria\n- runs unit tests\n- observable in UI",
    "## Validation Plan\n- npm test\n- run dev server and click button",
  );
  assert.equal(result.verdict, "APPROVE");
  assert.equal(result.comments.length, 0);
});
