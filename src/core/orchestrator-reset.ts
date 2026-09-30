/**
 * `src/core/orchestrator-reset.ts` — extracted helper for the
 * orchestrator's early `Orchestrator.runForIssue` reset branch
 * (`orchestrator-resetting-failed-state` log marker).
 *
 * Pre-fix, the reset branch only cleared `status`, `agentFailures` and
 * `error`. It left `state.lastFailure` and `state.failureCounts`
 * intact, which meant a (stage, FailureClass) pair whose counter had
 * already hit its `maxAttempts` budget stayed "exhausted" across the
 * reset, and the very next failure — even after the operator had
 * manually repaired the underlying cause — immediately escalated to
 * `needs-info` / `abort`. This is exactly what happened to issue
 * #36: the supervisor's `claude-code exited with code 1` left
 * `failureCounts.spec.AGENT_REASONING === 2` (== max), and the next
 * spec retry could not escape the dead budget.
 *
 * Extracting the reset into this helper lets us unit-test the field
 * semantics without spinning up a full `FactoryOrchestrator`.
 */

import type { FactoryIssueState } from "./types.js";

export interface ResetResult {
    /** Truncated previous error string, for log emission. */
    previousError?: string;
}

/**
 * Reset an exhausted issue after genuinely new business input. Idempotent.
 * Called for failed states or needs-info after an operator supplies new context.
 */
export function resetFailedState(state: FactoryIssueState): ResetResult {
    const previousError = typeof state.error === "string" ? state.error : undefined;

    state.status = "waiting";
    state.agentFailures = 0;
    delete state.error;
    delete state.lastFailure;
    // failureCounts is replaced with a fresh empty object — not deleted —
    // so downstream readers that expect `failureCounts[stage]` to return
    // a `Record<FailureClass, number>` don't have to handle `undefined`.
    state.failureCounts = {};
    // specTypesafeRevisions resets the budget for typesafe vetoes on the
    // next spec revision cycle (see spec-verdict.ts::deriveSpecVerdict).
    state.specTypesafeRevisions = 0;
    // specRubricFailures is the R-series convergence ratchet
    // (core/spec-review-rubric.ts::updateRubricFailureCounts). Same
    // reasoning as failureCounts: an operator reset means the underlying
    // cause was manually repaired, so per-point consecutive-failure
    // counts must start fresh — otherwise the first post-reset rubric
    // REJECT would immediately trip SpecRubricRepeatedFailureError.
    state.specRubricFailures = {};

    return { previousError };
}
