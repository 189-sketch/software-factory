import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_AGENT_FAILURES,
  appendEvent,
  buildPriorAttempt,
  extractVerdict,
  resolveMaxAgentFailures,
  resolveSpecFallbackRef,
} from "../orchestrator/index.js";
import type { AgentEvent, FactoryIssueState, ImplementationResult } from "../core/types.js";

function makeIssue() {
  return {
    number: 7,
    title: "Add a download button for the edited image",
    body: "Add a download button",
    labels: ["ready-to-implement"] as FactoryIssueState["issue"]["labels"],
    author: "alice",
    url: "https://github.com/acme/widget/issues/7",
    createdAt: "2026-09-10T00:00:00Z",
    comments: [],
  };
}

function makeState(overrides: Partial<FactoryIssueState> = {}): FactoryIssueState {
  return { issue: makeIssue(), merged: false, attempts: 0, ...overrides };
}

test("MAX_AGENT_FAILURES defaults to 50 when no env var is set", () => {
  assert.ok(Number.isInteger(MAX_AGENT_FAILURES) && MAX_AGENT_FAILURES > 0);
});

test("resolveMaxAgentFailures returns the configured value", () => {
  assert.equal(resolveMaxAgentFailures(undefined), 50);
  assert.equal(resolveMaxAgentFailures(""), 50);
  assert.equal(resolveMaxAgentFailures("5"), 5);
  assert.equal(resolveMaxAgentFailures(" 7 "), 7);
});

test("resolveMaxAgentFailures rejects malformed values", () => {
  for (const bad of ["0", "-1", "abc", "1.5", "1e3", "  ", "0x10", "null", "1;rm -rf /"]) {
    assert.throws(() => resolveMaxAgentFailures(bad), /FACTORY_MAX_AGENT_FAILURES/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("appendEvent initializes the events array lazily", () => {
  const state = makeState();
  assert.equal(state.events, undefined);
  appendEvent(state, { stage: "spec", startedAt: "2026-09-10T00:00:00Z", status: "running" });
  const events = state.events as unknown as AgentEvent[];
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  appendEvent(state, { stage: "spec", startedAt: "2026-09-10T00:00:00Z", endedAt: "2026-09-10T00:00:05Z", status: "completed" });
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "completed");
});

test("appendEvent preserves pre-existing events on reload", () => {
  const existing: AgentEvent[] = [{ stage: "triage", startedAt: "x", status: "completed" }];
  const state = makeState({ events: existing });
  appendEvent(state, { stage: "spec", startedAt: "y", status: "running" });
  assert.equal(state.events!.length, 2);
  assert.equal(state.events![0].stage, "triage");
  assert.equal(state.events![1].stage, "spec");
});

test("extractVerdict returns verdict string from stage results", () => {
  assert.equal(extractVerdict({ verdict: "APPROVE" }), "APPROVE");
  assert.equal(extractVerdict({ verdict: "REJECT", body: "no" }), "REJECT");
  assert.equal(extractVerdict({}), undefined);
  assert.equal(extractVerdict(null), undefined);
  assert.equal(extractVerdict(undefined), undefined);
  assert.equal(extractVerdict("APPROVE"), undefined);
  assert.equal(extractVerdict({ verdict: 1 }), undefined);
});

test("buildPriorAttempt returns a minimal record when no implementation exists", async () => {
  const state = makeState({ attempts: 1 });
  const prior = await buildPriorAttempt(state, 10, "/nonexistent", "main");
  assert.equal(prior.attemptNumber, 2);
  assert.equal(prior.maxAttempts, 10);
  assert.equal(prior.commitSha, "");
  assert.equal(prior.diff, "");
  assert.deepEqual(prior.filesChanged, []);
  assert.deepEqual(prior.validation, []);
});

test("buildPriorAttempt populates diff, files, validation and review from state", async (t) => {
  // Spin up a real git repo so `git diff origin/main...<sha>` has
  // something to read. We need a configured `origin` remote because
  // the orchestrator diff anchor is `origin/<defaultBranch>`.
  const origin = mkdtempSync(path.join(tmpdir(), "factory-prior-origin-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "factory-prior-"));
  t.after(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  execSync("git init -q --bare", { cwd: origin });
  execSync("git init -q -b main", { cwd });
  execSync("git config user.email t@example.com", { cwd });
  execSync("git config user.name T", { cwd });
  execSync(`git remote add origin "${origin}"`, { cwd });
  writeFileSync(path.join(cwd, "README.md"), "hello\n");
  execSync("git add README.md && git commit -q -m init", { cwd });
  execSync("git push -q origin main", { cwd });
  writeFileSync(path.join(cwd, "feature.js"), "export const x = 1;\n");
  execSync("git add feature.js && git commit -q -m feat", { cwd });
  const commitSha = execSync("git rev-parse HEAD", { cwd }).toString().trim();

  const impl: ImplementationResult = {
    issueNumber: 7,
    branch: "feature/issue-7",
    commitSha,
    prUrl: "https://github.com/acme/widget/pull/42",
    prNumber: 42,
    filesChanged: ["feature.js"],
    validation: [{ command: "node --test", exitCode: 0, stdout: "ok", stderr: "" }],
    comment: "first pass",
  };
  const state = makeState({
    attempts: 1,
    implementation: impl,
    review: { verdict: "REJECT", body: "missing tests", comments: [{ path: "feature.js", line: 1, side: "RIGHT", body: "add types" }] },
  });

  const prior = await buildPriorAttempt(state, 10, cwd, "main");
  assert.equal(prior.attemptNumber, 2);
  assert.equal(prior.maxAttempts, 10);
  assert.equal(prior.commitSha, commitSha);
  assert.equal(prior.branch, "feature/issue-7");
  assert.equal(prior.prUrl, "https://github.com/acme/widget/pull/42");
  assert.deepEqual(prior.filesChanged, ["feature.js"]);
  assert.equal(prior.validation.length, 1);
  assert.equal(prior.review?.verdict, "REJECT");
  assert.ok(prior.diff.includes("+export const x = 1;"), "diff should contain the file change");
});

test("buildPriorAttempt truncates oversized diffs with a fetch hint", async (t) => {
  const origin = mkdtempSync(path.join(tmpdir(), "factory-prior-big-origin-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "factory-prior-big-"));
  t.after(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  execSync("git init -q --bare", { cwd: origin });
  execSync("git init -q -b main", { cwd });
  execSync("git config user.email t@example.com", { cwd });
  execSync("git config user.name T", { cwd });
  execSync(`git remote add origin "${origin}"`, { cwd });
  writeFileSync(path.join(cwd, "README.md"), "hello\n");
  execSync("git add README.md && git commit -q -m init", { cwd });
  execSync("git push -q origin main", { cwd });
  // Add a large file to force the diff over the 64 KiB cap.
  const big = "x".repeat(200 * 1024);
  writeFileSync(path.join(cwd, "big.txt"), big);
  execSync("git add big.txt && git commit -q -m big", { cwd });
  const commitSha = execSync("git rev-parse HEAD", { cwd }).toString().trim();

  const state = makeState({
    implementation: {
      issueNumber: 7, branch: "feat", commitSha, prUrl: "", prNumber: 0,
      filesChanged: ["big.txt"], validation: [], comment: "",
    },
  });

  const prior = await buildPriorAttempt(state, 10, cwd, "main");
  assert.ok(prior.diff.includes("[... diff truncated"), "expected truncation marker");
  assert.ok(prior.diff.includes(commitSha), "truncation hint should mention the commit SHA");
});

test("buildPriorAttempt surfaces a placeholder when git diff fails", async () => {
  const state = makeState({
    attempts: 2,
    implementation: {
      issueNumber: 7, branch: "feat", commitSha: "deadbeef", prUrl: "", prNumber: 0,
      filesChanged: [], validation: [], comment: "",
    },
  });
  const prior = await buildPriorAttempt(state, 10, "/nonexistent-path", "main");
  assert.ok(/Failed to compute prior diff|Failed/.test(prior.diff));
});

// Note: the previous `shouldSelfHealImplAttemptLimit` and
// `shouldSelfHealStaleParseFailure` predicates are intentionally gone.
// Failure-classification is now the triage supervisor's job, not code's.
// Both predicates remain as no-op stubs for back-compat with any
// downstream caller, but the underlying decisions are made by an LLM
// reading the failure envelope rather than by string-matching the error.

/* -------------------------------------------------------------------------- */
/* Bug 1 regression: spec fallback ref when PR was rejected                    */
/* -------------------------------------------------------------------------- */
/* Spec `2026-09-20-decision-architecture` follow-up: when triage decides
 * `ready-to-implement` after a spec-review rejection, the implementation
 * stage MUST be able to read the spec from the spec PR branch
 * (origin/<state.specs.specBranch>) instead of throwing because the
 * spec is not on origin/<defaultBranch>. Issue #34 sat parked at
 * needs-info for 6+ hours because the orchestrator's hard
 * `git cat-file -e origin/main:specs/<slug>/PRODUCT.md` check failed
 * and the supervisor then routed the failure to needs-info. The fix
 * exposes `resolveSpecFallbackRef` as the source of the fallback ref.
 *
 * First-cut bug: the helper read `state.specs.branch` (which is
 * undefined — the field is `specBranch` on `SpecPair`). It silently
 * returned null and the implementation branch still escalated. The
 * tests below pin `specBranch` (and the old `branch` alias for
 * compatibility) so a future rename cannot regress. */

test("resolveSpecFallbackRef returns origin/<specBranch> when spec PR exists", () => {
    const state = makeState({
        specs: {
            product: { slug: "issue-34-ui", body: "PRODUCT.md" },
            tech: { slug: "issue-34-ui", body: "TECH.md" },
            specBranch: "spec/issue-34-ui",
            specPrUrl: "https://github.com/189-sketch/software-factory-demo/pull/35",
            revisions: [],
            reviews: [],
        } as unknown as FactoryIssueState["specs"],
        specReview: { verdict: "REJECT" } as FactoryIssueState["specReview"],
    });
    assert.equal(resolveSpecFallbackRef(state), "origin/spec/issue-34-ui");
});

test("resolveSpecFallbackRef returns null when no spec PR branch is recorded", () => {
    const state = makeState({
        specs: {
            product: { slug: "issue-34-ui", body: "PRODUCT.md" },
            tech: { slug: "issue-34-ui", body: "TECH.md" },
            // specBranch omitted — spec was never opened as a PR (e.g. failed
            // mid-generation). The orchestrator must surface this as a
            // hard error rather than silently using a wrong ref.
            revisions: [],
            reviews: [],
        } as unknown as FactoryIssueState["specs"],
    });
    assert.equal(resolveSpecFallbackRef(state), null);
});

test("resolveSpecFallbackRef returns null when state.specs is absent", () => {
    const state = makeState();
    assert.equal(resolveSpecFallbackRef(state), null);
});

test("resolveSpecFallbackRef treats empty-string specBranch as absent", () => {
    const state = makeState({
        specs: {
            product: { slug: "x", body: "PRODUCT.md" },
            tech: { slug: "x", body: "TECH.md" },
            specBranch: "",
            revisions: [],
            reviews: [],
        } as unknown as FactoryIssueState["specs"],
    });
    assert.equal(resolveSpecFallbackRef(state), null);
});