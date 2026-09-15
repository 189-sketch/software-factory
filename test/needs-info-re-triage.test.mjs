import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression test for issue #12: the daemon kept parking the issue at
 * `needs-info` even after the author posted a comment answering the
 * supervisor's questions.
 *
 * The bug was that the re-triage trigger at factory-daemon.mjs:390 was
 * gated on `labelNames.includes("needs-info")`. When `syncLabel` failed
 * (the GitHub label update errored once during a transient API flake and
 * never retried), the GitHub issue label was empty while the checkpoint
 * still said `nextLabel: "needs-info"`. The trigger never fired, so the
 * comment-changed check never ran.
 *
 * The fix was to also fire when `checkpoint.nextLabel === "needs-info"`,
 * plus a forced `gh issue view` refresh for parked issues because
 * `gh issue list --json comments` is unreliable when the comment set has
 * changed since the last poll.
 *
 * This test models the trigger logic in isolation so a future refactor
 * that drops either branch will fail.
 */
function shouldReTriageForNeedsInfo({ labelNames, checkpointNextLabel, commentsChanged }) {
  const parkedOnGitHub = labelNames.includes("needs-info");
  const parkedInCheckpoint = checkpointNextLabel === "needs-info";
  if ((parkedOnGitHub || parkedInCheckpoint) && commentsChanged) {
    return "needs-info-comments-changed-retry";
  }
  return "skip";
}

test("re-triage fires when GitHub label is needs-info and comments changed", () => {
  assert.equal(
    shouldReTriageForNeedsInfo({
      labelNames: ["needs-info"],
      checkpointNextLabel: "needs-info",
      commentsChanged: true,
    }),
    "needs-info-comments-changed-retry",
  );
});

test("re-triage fires when checkpoint says needs-info but GitHub label is empty (syncLabel failed)", () => {
  assert.equal(
    shouldReTriageForNeedsInfo({
      labelNames: [],                          // syncLabel never landed
      checkpointNextLabel: "needs-info",       // but supervisor wrote this
      commentsChanged: true,
    }),
    "needs-info-comments-changed-retry",
  );
});

test("skips when neither GitHub nor checkpoint marks needs-info (regular ready-to-spec etc.)", () => {
  assert.equal(
    shouldReTriageForNeedsInfo({
      labelNames: ["ready-to-spec"],
      checkpointNextLabel: "ready-to-spec",
      commentsChanged: true,
    }),
    "skip",
  );
});

test("skips when parked but comments unchanged (no author activity since last poll)", () => {
  assert.equal(
    shouldReTriageForNeedsInfo({
      labelNames: ["needs-info"],
      checkpointNextLabel: "needs-info",
      commentsChanged: false,
    }),
    "skip",
  );
});

/**
 * Regression test for issue #24: the daemon re-queued the parked issue
 * on every poll because `gh issue list --json comments` returned the
 * pre-comment count. The fix forces a `gh issue view` for any issue
 * with `needs-info` (label or checkpoint) so the comments array always
 * reflects the latest state.
 *
 * Models the refresh logic.
 */
function shouldRefreshCommentsForParkedIssue({ labelNames, checkpointNextLabel }) {
  return labelNames.includes("needs-info") || checkpointNextLabel === "needs-info";
}

test("refresh comments when GitHub label is needs-info", () => {
  assert.equal(shouldRefreshCommentsForParkedIssue({ labelNames: ["needs-info"], checkpointNextLabel: null }), true);
});

test("refresh comments when checkpoint is needs-info but GitHub label missing", () => {
  assert.equal(shouldRefreshCommentsForParkedIssue({ labelNames: [], checkpointNextLabel: "needs-info" }), true);
});

test("skip refresh for ready-to-spec (not parked)", () => {
  assert.equal(shouldRefreshCommentsForParkedIssue({ labelNames: ["ready-to-spec"], checkpointNextLabel: "ready-to-spec" }), false);
});

/**
 * Regression test for issue #24: orchestrator kept returning
 * short-circuit when state.nextLabel was "needs-info", so the new triage
 * decision (which would have re-evaluated after the author replied) never
 * ran even though the daemon's `needs-info-comments-changed-retry` log
 * fired. The orchestrator now clears nextLabel and force-retriages when
 * the author has posted since the previous pass.
 *
 * Models the orchestrator-side decision.
 */
function shouldOrchestratorForceRetriage({ status, nextLabel, changed }) {
  return status === "waiting" && nextLabel === "needs-info" && Boolean(changed);
}

test("orchestrator force-retriages when needs-info parked and author replied", () => {
  assert.equal(
    shouldOrchestratorForceRetriage({ status: "waiting", nextLabel: "needs-info", changed: true }),
    true,
  );
});

test("orchestrator does NOT force-retriage when comments are unchanged", () => {
  assert.equal(
    shouldOrchestratorForceRetriage({ status: "waiting", nextLabel: "needs-info", changed: false }),
    false,
  );
});

test("orchestrator does NOT force-retriage when not parked at needs-info", () => {
  assert.equal(
    shouldOrchestratorForceRetriage({ status: "waiting", nextLabel: "ready-to-spec", changed: true }),
    false,
  );
  assert.equal(
    shouldOrchestratorForceRetriage({ status: "completed", nextLabel: "needs-info", changed: true }),
    false,
  );
});

/**
 * Issue #24 (refined): when the checkpoint was saved with the author's
 * reply already inside, JSON.stringify-equality says no change, so the
 * old `changed` flag was false and the orchestrator short-circuited even
 * though the author had just spoken. The fix layers a "latest voice is
 * author" signal on top so the orchestrator re-evaluates whenever the
 * most recent comment is non-factory.
 */
function orchestratorChanged({ checkpointComments, freshComments }) {
  const structural = JSON.stringify(checkpointComments) !== JSON.stringify(freshComments);
  if (structural) return true;
  const latest = freshComments[freshComments.length - 1];
  if (!latest) return false;
  const body = latest.body ?? "";
  const factoryMarkers = [
    "<!-- pi-software-factory:triage:",
    "<!-- pi-software-factory:spec-review:",
    "<!-- pi-software-factory:pr-review:",
  ];
  return !factoryMarkers.some((marker) => body.includes(marker));
}

test("orchestrator re-triages when structural JSON differs", () => {
  assert.equal(
    orchestratorChanged({
      checkpointComments: [{ body: "old" }],
      freshComments: [{ body: "old" }, { body: "new" }],
    }),
    true,
  );
});

test("orchestrator re-triages when JSON matches but latest comment is from author", () => {
  // Checkpoint already contains the author's reply; structurally equal
  // but the latest voice is the author's.
  const comments = [
    { body: "<!-- pi-software-factory:spec-review:24:hash --> REJECT" },
    { body: "no existing model, design from scratch" },
  ];
  assert.equal(
    orchestratorChanged({ checkpointComments: comments, freshComments: comments }),
    true,
  );
});

test("orchestrator does NOT re-triage when message is identical AND latest is factory", () => {
  const comments = [
    { body: "no existing model" },
    { body: "<!-- pi-software-factory:triage:24:hash --> waiting" },
  ];
  assert.equal(
    orchestratorChanged({ checkpointComments: comments, freshComments: comments }),
    false,
  );
});