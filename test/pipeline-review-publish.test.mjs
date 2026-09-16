/**
 * Contract tests for the review-decision publish pipeline.
 *
 * The factory should post every review agent's verdict (both APPROVE
 * and REJECT) to the issue as a comment so the trail is auditable
 * without scrolling through PR review threads. These tests pin the
 * source-level contracts that downstream code (orchestrator, control
 * panel, daemon) rely on:
 *
 *   - the spec-review verdict is published regardless of verdict;
 *   - the implementation-PR review verdict is published with its own
 *     marker namespace so it doesn't collide with the spec-review or
 *     triage streams;
 *   - both publishers short-circuit on FACTORY_SYNC_LABELS=0 and on
 *     missing GH_TOKEN / FACTORY_GH_REPO.
 *
 * If any of these regress, this test fails fast — preventing silent
 * reintroduction of "review verdict only on REJECT" or
 * "PR review never published to the issue".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

test("orchestrator publishes spec-review verdict outside the REJECT-only branch", async () => {
  // Before this change `publishSpecReviewDecision` was called inside
  // the `if (state.specReview.verdict === 'REJECT')` branch, so an
  // APPROVE verdict never reached the issue. The call must now sit
  // BEFORE the verdict check so every spec review — APPROVE or
  // REJECT — is mirrored to the issue thread.
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  // The publish call must exist and reference the function name.
  assert.ok(
    orchestrator.includes("publishSpecReviewDecision(issue, state.specReview)"),
    "publishSpecReviewDecision is no longer called on every spec-review verdict",
  );
  // It must appear BEFORE the REJECT branch (line numbers are brittle,
  // so we look at the surrounding context instead).
  const publishIdx = orchestrator.indexOf("publishSpecReviewDecision(issue, state.specReview)");
  const rejectIdx = orchestrator.indexOf("state.specReview.verdict === 'REJECT'");
  assert.ok(publishIdx > 0 && rejectIdx > 0, "expected both call sites to exist");
  assert.ok(
    publishIdx < rejectIdx,
    "publishSpecReviewDecision must be called BEFORE the REJECT branch so APPROVE verdicts are also published",
  );
});

test("orchestrator publishes PR-review verdict after ReviewPrAgent runs", async () => {
  // Implementation PR reviews (`ReviewPrAgent`) must publish their
  // verdict to the issue as well. The call lives inside the cache-miss
  // block so the dedup-on-body-hash keeps it silent on retries.
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  assert.ok(
    /new ReviewPrAgent\([\s\S]*?\)\.run\(\)/.test(orchestrator),
    "ReviewPrAgent instantiation no longer found",
  );
  assert.ok(
    /state\.review\s*=\s*await this\.stage\(state,\s*'review'/.test(orchestrator),
    "state.review assignment no longer found",
  );
  assert.ok(
    /publishReviewDecision\(issue,\s*state\.review\)/.test(orchestrator),
    "publishReviewDecision is not called after ReviewPrAgent.run()",
  );
});

test("publishReviewDecision uses its own pr-review marker namespace", async () => {
  // The marker hash lets each publisher dedupe its own posts. The
  // spec-review and pr-review streams MUST use different marker tags
  // so a re-post on one doesn't suppress the other.
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  assert.ok(
    /pi-software-factory:pr-review:/.test(orchestrator),
    "publishReviewDecision is missing the pi-software-factory:pr-review marker namespace",
  );
  assert.ok(
    /pi-software-factory:spec-review:/.test(orchestrator),
    "publishSpecReviewDecision is missing the pi-software-factory:spec-review marker namespace",
  );
  assert.ok(
    /pi-software-factory:triage:/.test(orchestrator),
    "publishTriageDecision is missing the pi-software-factory:triage marker namespace",
  );
});

test("publishReviewDecision guards on FACTORY_SYNC_LABELS=0", async () => {
  // Operators can disable GitHub writes with FACTORY_SYNC_LABELS=0;
  // the publish path must respect the same flag as publishLabel so
  // disabling labels also disables comment writes (one switch for
  // "no outbound GitHub traffic").
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  const fnMatch = orchestrator.match(/async function publishReviewDecision\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "publishReviewDecision function not found");
  const fn = fnMatch[0];
  assert.ok(
    /FACTORY_SYNC_LABELS\s*===\s*'0'/.test(fn),
    "publishReviewDecision does not check FACTORY_SYNC_LABELS=0",
  );
  assert.ok(
    /GH_TOKEN/.test(fn) && /FACTORY_GH_REPO/.test(fn),
    "publishReviewDecision does not check GH_TOKEN / FACTORY_GH_REPO",
  );
});

test("publishReviewDecision body contains the verdict and review body", async () => {
  // Operator-visible output must include both the verdict (APPROVE /
  // REJECT) and the review body so an issue reader can decide without
  // opening the PR review thread.
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  const fnMatch = orchestrator.match(/async function publishReviewDecision\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "publishReviewDecision function not found");
  const fn = fnMatch[0];
  assert.ok(/PR review:\s*\$\{review\.verdict\}/.test(fn), "verdict missing from published body");
  assert.ok(/review\.body/.test(fn), "review body not included in published comment");
});

test("publishSpecReviewDecision still guards on FACTORY_SYNC_LABELS=0", async () => {
  // The refactor moved the call site but did not change the gating
  // semantics. Pin this so a future cleanup doesn't break the operator
  // off-switch.
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  const fnMatch = orchestrator.match(/async function publishSpecReviewDecision\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "publishSpecReviewDecision function not found");
  const fn = fnMatch[0];
  assert.ok(/FACTORY_SYNC_LABELS\s*===\s*'0'/.test(fn), "publishSpecReviewDecision lost its FACTORY_SYNC_LABELS=0 guard");
});
