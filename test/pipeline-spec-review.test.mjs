/**
 * Contract tests for the agent-driven spec pipeline.
 *
 * These tests pin the shape of the change that eliminated the
 * `spec-ready-for-review` manual gate. They do NOT spin up the full
 * factory daemon (which needs LLM credentials + a real GitHub repo);
 * instead they assert the surface contracts that downstream code
 * (orchestrator, control panel, daemon) rely on:
 *
 *   - the label `spec-ready-for-review` is cleanup-only: it cannot
 *     dispatch work, but upgraded installations still remove it.
 *   - `ReviewSpecAgent` is a registered agent whose name matches what
 *     `runForIssue` dispatches against.
 *   - `SpecReviewResult` carries the contract the orchestrator needs
 *     (`verdict`, `body`, `comments`, `notes`).
 *   - the dist bundle was rebuilt with the new agent included.
 *
 * If any of these regress, this test fails fast — preventing silent
 *   reintroduction of the human gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RETIRED_PIPELINE_LABELS, ACTIVE_PIPELINE_LABELS, PIPELINE_LABELS_TO_CLEAR } from "../runtime/pipeline-definition.mjs";
import { resolveFactoryConfig } from "../runtime/factory-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

test("src/core/types.ts keeps spec-ready-for-review cleanup-only", async () => {
  const types = await readFile(path.join(root, "src/core/types.ts"), "utf8");
  assert.ok(types.includes("RETIRED_FACTORY_LABELS = RETIRED_PIPELINE_LABELS"));
  assert.ok(RETIRED_PIPELINE_LABELS.includes("spec-ready-for-review"));
  assert.ok(!ACTIVE_PIPELINE_LABELS.includes("spec-ready-for-review"));
  assert.ok(PIPELINE_LABELS_TO_CLEAR.includes("spec-ready-for-review"));
  assert.ok(types.includes("FACTORY_LABELS_TO_CLEAR"));
  // Sanity: SpecReviewResult must be declared.
  assert.ok(types.includes("export interface SpecReviewResult"));
  assert.ok(types.includes("specReview?:"));
  assert.ok(types.includes("specAttempts?:"));
  assert.ok(types.includes("specReviewedKey?:"));
  assert.ok(types.includes("commitSha?:"));
});

test("src/agents/triage.ts remove_labels no longer reference spec-ready-for-review", async () => {
  const triage = await readFile(path.join(root, "src/agents/triage.ts"), "utf8");
  assert.equal(
    triage.includes("spec-ready-for-review"),
    false,
    "triage.ts still references the removed label in a remove_labels array",
  );
});

test("scripts/factory-daemon.mjs wakes only to clean spec-ready-for-review", async () => {
  const daemon = await readFile(path.join(root, "scripts/factory-daemon.mjs"), "utf8");
  assert.ok(daemon.includes("RETIRED_FACTORY_LABELS = new Set(RETIRED_PIPELINE_LABELS)"));
  assert.ok(daemon.includes("retiredLabels,"));
});

test("templates/github/workflows/triage-issues.yml removes the retired label", async () => {
  const yml = await readFile(
    path.join(root, "templates/github/workflows/triage-issues.yml"),
    "utf8",
  );
  assert.ok(yml.includes("PIPELINE_LABELS_TO_CLEAR"));
});

test("control-panel label→stage mapping no longer maps spec-ready-for-review", async () => {
  const api = await readFile(
    path.join(root, "control-panel/src/data/api.ts"),
    "utf8",
  );
  assert.equal(
    api.includes("spec-ready-for-review"),
    false,
    "control-panel still maps the removed label",
  );
});

test("ReviewSpecAgent is registered with the expected name and contract", async () => {
  // We can't dynamic-import the .ts file from plain Node — review-spec
  // pulls from .ts source via the tsx loader that unit tests use. The
  // companion unit tests (`src/__tests__/review-spec.test.ts`) cover
  // the runtime shape; here we pin the source-level contract so a
  // future refactor can't silently rename the agent.
  const agent = await readFile(
    path.join(root, "src/agents/review-spec.ts"),
    "utf8",
  );
  assert.ok(agent.includes("readonly name = \"review-spec\""), "agent name not 'review-spec'");
  assert.ok(agent.includes("SpecReviewResult"), "agent does not declare SpecReviewResult");
  assert.ok(agent.includes("containsBlockingFinding"), "agent does not export containsBlockingFinding");
  assert.ok(agent.includes("verdict"), "agent does not emit verdict");
  assert.ok(agent.includes("ALLOWED_PREFIXES"), "agent does not declare severity prefixes");
});

test("orchestrator dispatches ReviewSpecAgent (not the old spec-ready-for-review label)", async () => {
  const orchestrator = await readFile(
    path.join(root, "src/orchestrator/index.ts"),
    "utf8",
  );
  const specPhase = await readFile(path.join(root, "src/orchestrator/spec-phase.ts"), "utf8");
  // The old silent gate has been replaced with a self-resolving chain.
  assert.equal(
    orchestrator.includes("'spec-ready-for-review'"),
    false,
    "orchestrator still references the removed label as a destination",
  );
  assert.ok(
    specPhase.includes("new ReviewSpecAgent("),
    "orchestrator never instantiates ReviewSpecAgent",
  );
  // runSpecPhase is the new self-resolving chain.
  assert.ok(orchestrator.includes("private async runSpecPhase("));
  // Spec PR auto-merge reuses the existing merge helper.
  assert.ok(
    orchestrator.includes("mergePullRequest"),
    "orchestrator no longer calls mergePullRequest at all",
  );
  // Final code merge requires the configured opt-in.
  assert.ok(
    orchestrator.includes("if (!this.config.autoMerge)"),
    "orchestrator no longer respects the auto-merge setting",
  );
  assert.equal(resolveFactoryConfig({ env: {} }).autoMerge, false);
});

test("dist/factory bundle includes the new spec-review skill", async () => {
  const bundle = await readFile(
    path.join(root, "dist/factory/run-issue.js"),
    "utf8",
  );
  // The bundle embeds all skill bodies; the new review-spec rubric
  // must appear so the agent has something to read at runtime.
  assert.ok(
    bundle.includes("review-spec") || bundle.includes("ReviewSpec"),
    "dist bundle does not include the new ReviewSpecAgent wiring",
  );
});

test("ImproveReviewPrAgent pre-flights collect_feedback before invoking the LLM", async () => {
  // Pins the daily-improvement ghost-loop fix: the agent must
  // synchronously run collect_feedback and short-circuit to
  // no_changes when there is no recent human feedback, so the daemon
  // writes its 24h marker instead of retrying the failing call on
  // every poll.
  const source = await readFile(
    path.join(root, "src/agents/improve-review-pr.ts"),
    "utf8",
  );
  assert.ok(
    /private async collectFeedback\(\)/.test(source),
    "improve-review-pr.ts is missing the collectFeedback() pre-flight helper",
  );
  assert.ok(
    /const collected = await this\.collectFeedback\(\)/.test(source),
    "ImproveReviewPrAgent.run() does not call collectFeedback() before runLlmAgent",
  );
  assert.ok(
    /if \(!collected\.ok\)/.test(source) && /corpus\.items\.length === 0/.test(source),
    "ImproveReviewPrAgent.run() does not handle the no-feedback short-circuit",
  );
  // The collect_feedback tool must NOT be in the LLM's tool list any
  // more — otherwise the old ghost loop returns when an LLM skips it.
  assert.ok(
    !/extraTools: \[\.\.\.readOnlyTools\(this\.ctx\), \{[\s\S]*?name: 'collect_feedback'/.test(source),
    "collect_feedback is still exposed as an LLM tool; remove it so the agent can't be bypassed",
  );
});
