import test from "node:test";
import assert from "node:assert/strict";
import {
  containsBlockingFinding,
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
 *   - the public surface (the agent constructor) being callable with
 *     a minimal AgentContext without throwing.
 *
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
      body: "Anchored issue body for spec review.",
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
