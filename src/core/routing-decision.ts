/**
 * `src/core/routing-decision.ts` — deterministic failure routing that
 * replaces the `triage-supervisor` LLM stage.
 *
 * The previous architecture called `TriageAgent.supervise()` after every
 * failed stage run; the supervisor then dispatched
 * `dispatchAgentStage("triage-supervisor", ...)` which loaded
 * `TRIAGE_SUPERVISOR_CONTRACT` and asked Claude to pick one of four
 * actions (`retry | reroute | needs-info | abort`). That path
 *   (a) duplicated work — typesafe's B12 primitive already computed a
 *       `supervisor_action` value the `mapTriagePrimitivesToResult`
 *       parser already extracted into `supervisorAction`,
 *   (b) introduced a second-order LLM failure mode: when Claude
 *       returned exit code 1 (which happened to issue #36), the
 *       supervisor path itself errored, so the pipeline gave up instead
 *       of self-healing.
 *
 * `decideRouting` is a pure function: given the already-classified
 * failure (`ClassifiedFailure`) and the (stage, FailureClass) attempt
 * counter, it returns the same four actions the supervisor did, plus
 * an audit-trail `comment` and an ordered `correction` array for
 * retries. It is cheaper, deterministic, and never raises.
 */

import type {
    ClassifiedFailure,
} from "./failure-classifier.js";
import type {
    FactoryIssueState,
    FailureClass,
    PipelineFailure,
} from "./types.js";

export type RoutingAction = "retry" | "reroute" | "needs-info" | "abort";

export interface RoutingDecision {
    action: RoutingAction;
    /** Stage the orchestrator should run next. Undefined for `needs-info` / `abort`. */
    targetStage?: string;
    /**
     * Ordered corrective turns delivered to the next stage. Only set
     * for `retry` so the next run has the prior error envelope in its
     * context. Empty for other actions.
     */
    correction?: string[];
    /** Human-readable explanation; posted to the issue thread. */
    comment: string;
}

export interface RoutingContext {
    nextLabel: FactoryIssueState["nextLabel"];
    correction: FactoryIssueState["correction"];
}

export type FailureCounts = Record<string, Partial<Record<FailureClass, number>>>;

/**
 * Map a classified failure + attempt counter into a routing decision.
 *
 * Rules (in evaluation order):
 *   1. If `policy[class].maxAttempts === 0` → apply `defaultAction`
 *      immediately, no further attempts (POLICY_BLOCK, USER_INPUT_REQUIRED,
 *      PERMANENT).
 *   2. If the (stage, class) counter has hit `maxAttempts` →
 *      `defaultAction` with a "budget exhausted" comment.
 *   3. Otherwise → retry correctable failures; needs-info applies only after exhaustion.
 *
 * The returned `targetStage` is always `lastStage` for `retry` /
 * `reroute`; `needs-info` / `abort` have no target.
 */
export function decideRouting(
    classified: ClassifiedFailure,
    failure: PipelineFailure,
    failureCounts: FailureCounts,
    lastStage: string | undefined,
    context: RoutingContext,
): RoutingDecision {
    const stage = lastStage ?? "unknown";
    const counter = failureCounts[stage]?.[classified.class] ?? 0;
    const max = classified.maxAttempts;
    const reason = classified.reason;

    // Rule 1: maxAttempts === 0 → terminal default action, no retry budget.
    if (max === 0) {
        return terminalDecision(classified, reason, failure);
    }

    // Rule 2: budget exhausted.
    if (counter >= max) {
        return terminalDecision(classified, reason, failure, counter, max);
    }

    // The counter already includes this failure; this router never increments it.
    // Rule 3: budget remaining — carry concrete correction into the retry.
    // needs-info is an exhausted-budget action, not the first-failure action.
    const action: RoutingAction = classified.defaultAction === 'needs-info' ? 'retry' : classified.defaultAction;
    switch (action) {
        case "retry":
            return {
                action: "retry",
                targetStage: stage,
                correction: buildCorrectionTurns(failure, classified, counter, max, context),
                comment: `[failure-classifier] ${classified.class}: ${reason} (attempt ${counter}/${max}) — retrying ${stage}`,
            };
        case "reroute":
            return {
                action: "reroute",
                targetStage: stage,
                correction: buildCorrectionTurns(failure, classified, counter, max, context),
                comment: `[failure-classifier] ${classified.class}: ${reason} — rerouting to ${stage}`,
            };
        case "abort":
            return {
                action: "abort",
                comment: `[failure-classifier] ${classified.class}: ${reason} — unrecoverable. Operator intervention required.`,
            };
    }
    // exhaustive: classified.defaultAction is a closed union
    throw new Error(`decideRouting: unreachable defaultAction ${classified.defaultAction as string}`);
}

function terminalDecision(
    classified: ClassifiedFailure,
    reason: string,
    failure: PipelineFailure,
    counter: number = 0,
    max: number = 0,
): RoutingDecision {
    const details = `\n\n本次失败详情（${failure.stage}）：\n\n${failure.error.slice(0, 6000)}`;
    switch (classified.defaultAction) {
        case "needs-info":
            return {
                action: "needs-info",
                comment:
                    counter >= max
                        ? `[failure-classifier] ${classified.class}: ${reason} — budget exhausted (${counter}/${max}). Needs author input.${details}`
                        : `[failure-classifier] ${classified.class}: ${reason} — escalating to needs-info${details}`,
            };
        case "abort":
            return {
                action: "abort",
                comment: `[failure-classifier] ${classified.class}: ${reason} — unrecoverable. Operator intervention required.${details}`,
            };
        case "retry":
        case "reroute":
            return {
                action: "needs-info",
                comment: `[failure-classifier] ${classified.class}: ${reason} — budget exhausted (${counter}/${max}). Operator intervention required.${details}`,
            };
    }
    // exhaustive: FailureClass action is a closed union
    throw new Error(`terminalDecision: unreachable defaultAction ${classified.defaultAction as string}`);
}

/**
 * Build the ordered corrective turns the next stage receives. Mirrors
 * the `correction.turns` array the supervisor used to produce via
 * LLM. The four turns are:
 *   1. failure summary (truncated to 200 chars)
 *   2. failing stage
 *   3. retry budget remaining
 *   4. prior-correction presence flag
 */
function buildCorrectionTurns(
    failure: PipelineFailure,
    classified: ClassifiedFailure,
    counter: number,
    max: number,
    context: RoutingContext,
): string[] {
    const summary = (failure.error ?? "").slice(0, 200);
    return [
        `Failure summary: ${summary}`,
        `Failing stage: ${failure.stage}`,
        `Failures: ${counter}/${max}; remaining budget: ${max - counter} (class=${classified.class})`,
        `Prior correction: ${context.correction ? "had prior correction" : "none"}`,
    ];
}
