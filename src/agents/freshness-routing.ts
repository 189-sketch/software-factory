/**
 * Polling-time "resume stage" judgment.
 *
 * Spec `2026-09-20-decision-architecture` / Phase E / T11.3.
 *
 * `freshnessCheck` (`scripts/freshness-poc.mjs`) hits the deterministic
 * fast path whenever `lastJudgmentHash === stateHash` and previously
 * returned `{ skip: true }` — the daemon then skipped the issue, even
 * when the labels had been reset to a different active stage in the
 * meantime (the `issue #43` bug: label reset to `ready-to-spec` after a
 * crashed pipeline, but `updatedAt` / `comments.length` / `lastReceiptSha`
 * / `lastTriageAt` were all unchanged so the hash never moved).
 *
 * The fix is a single-question `choice` primitive, `C1.resume_stage`,
 * that asks the model: "given the current label set, which pipeline
 * stage should the daemon hand this issue to?" — and a `wait` option
 * that lets the daemon *intentionally* skip when the labels say
 * `needs-info` / `wait-to-implement`.
 *
 * Why this lives here (and not inside `scripts/freshness-poc.mjs`):
 *
 * - Pure build/parse helpers are reusable from tests AND from any
 *   future orchestrator path that wants to ask "should I resume?"
 *   (e.g. on `needs-info-wake` triggers). Keeping them in TS next to
 *   the other agents matches the per-stage primitive convention
 *   (A1..B14 → each agent file owns its own primitive builders).
 * - Pure functions only; the daemon's JS shim
 *   (`scripts/freshness-poc.mjs::decideResumeStage`) is responsible
 *   for the actual HTTP call via `runTypesafeStageFromConfig`. This
 *   module never imports the `runtime/*` adapters — the build step
 *   would otherwise pull Node-only code into unit tests.
 *
 * The primitives this module produces follow the OFFICIAL System One
 * wire contract documented in `runtime/typesafe-backend.d.mts`:
 * `{model, state, questions}` envelope, no `state_hash` on the wire.
 */
import type {
    TypesafeRequest,
    TypesafeStructuredEntry,
} from "../../runtime/typesafe-backend.d.mts";

/**
 * Closed set of stages the polling-time resume path can choose from.
 *
 * `wait` is a daemon-only outcome that means "leave the issue alone
 * for now"; the other six correspond to real `PIPELINE_STAGES` ids
 * (`runtime/pipeline-definition.mjs`).
 *
 * Order matches `PIPELINE_LABELS` priority (`ready-to-implement` →
 * `verified`) so the deterministic fallback in
 * `stageForActiveLabel` lines up with the model's `criteria` text.
 */
export type ResumeStage =
    | "wait"
    | "triage"
    | "spec"
    | "implementation"
    | "review"
    | "verify"
    | "merge";

const RESUME_STAGE_VALUES: ReadonlySet<ResumeStage> = new Set([
    "wait",
    "triage",
    "spec",
    "implementation",
    "review",
    "verify",
    "merge",
]);

/**
 * Normalised resume decision.
 *
 * `ok: false` collapses every failure mode (network, parse miss,
 * invalid value, missing API key, off-toggle) to a single shape so
 * the daemon can branch on `ok` and fall back to `triage`. The
 * `reason` field is a stable enum that the daemon logs verbatim so
 * an operator can grep the daemon log for failure modes.
 */
export interface ResumeDecision {
    ok: boolean;
    /** Always set; defaults to `"triage"` on every failure mode. */
    stage: ResumeStage;
    /** `[0, 1]`; `0` on every failure mode. */
    confidence: number;
    reason:
        | "ok"
        | "off-toggle"
        | "unreachable"
        | "parse-miss"
        | "invalid-stage"
        | "no-answer";
}

/**
 * Build the official System One request for the resume-stage choice.
 *
 * Pure: deterministic on `(model, stateHash, lastJudgmentHash,
 * issue)`. The `state` payload carries every input the model needs
 * to answer the question in a single shot; the question itself is a
 * seven-option `choice` so the response surface is closed.
 *
 * `lastTriageAt` is included so the model can spot the
 * `resetFailedState → ready-to-spec` pattern (issue #43) where the
 * hash is unchanged but the prior triage decision no longer
 * reflects the current label set.
 */
export function buildResumeStageRequest(input: {
    model: string;
    stateHash: string;
    lastJudgmentHash: string;
    lastTriageAt?: string;
    issue: {
        labels: string[];
        updatedAt?: string;
        commentsCount: number;
    };
}): TypesafeRequest {
    return {
        model: input.model,
        state: {
            stateHash: input.stateHash,
            // `lastJudgmentHash` is required by the type signature;
            // `?? null` guards against an absent value at runtime
            // (mirrors `scripts/freshness-poc.mjs::buildResumeStageRequest`).
            lastJudgmentHash: input.lastJudgmentHash ?? null,
            lastTriageAt: input.lastTriageAt ?? null,
            labels: input.issue.labels,
            updatedAt: input.issue.updatedAt ?? null,
            commentsCount: input.issue.commentsCount,
        },
        questions: {
            resume_stage: {
                type: "choice",
                instructions:
                    "The issue's hash is unchanged since the last triage " +
                    "(state.stateHash == state.lastJudgmentHash). The label " +
                    "set may still indicate the pipeline should resume, or it " +
                    "may signal that the operator needs to act first. Pick the " +
                    "single next action based on the labels in state.labels " +
                    "and the most recent triage timestamp in state.lastTriageAt.",
                criteria: {
                    wait:
                        "labels include needs-info or wait-to-implement — let " +
                        "the operator respond before re-engaging the pipeline",
                    triage:
                        "no active pipeline label, or an ambiguous / " +
                        "conflicting set of active labels — let the triage " +
                        "stage re-decide the label",
                    spec:
                        "labels include ready-to-spec and no later-stage " +
                        "active label is present",
                    implementation:
                        "labels include ready-to-implement, verify-failed, " +
                        "or changes-requested, and no later-stage active " +
                        "label is present",
                    review:
                        "labels include review-needed and no later-stage " +
                        "active label is present",
                    verify:
                        "labels include ready-to-merge and no later-stage " +
                        "active label is present",
                    merge:
                        "labels include verified and no later-stage active " +
                        "label is present",
                },
            },
        },
    };
}

/**
 * Parse a typesafe structured-output array into a `ResumeDecision`.
 *
 * `structuredOutput` is the array form returned by
 * `runtime/typesafe-backend.mjs::mapAnswersToStructuredOutput`. The
 * parser looks for the `resume_stage` entry, normalises its value
 * through the closed `ResumeStage` whitelist, and clamps the
 * confidence to `[0, 1]`.
 *
 * Any failure mode collapses to `{ ok: false, stage: "triage",
 * confidence: 0 }` so the daemon can always `enqueueIssue` instead
 * of silently skipping the issue.
 */
export function parseResumeStageDecision(
    primitives: ReadonlyArray<TypesafeStructuredEntry>,
): ResumeDecision {
    const fail = (reason: ResumeDecision["reason"]): ResumeDecision => ({
        ok: false,
        stage: "triage",
        confidence: 0,
        reason,
    });

    if (!Array.isArray(primitives) || primitives.length === 0) {
        return fail("parse-miss");
    }
    const entry = primitives.find((p) => p?.id === "resume_stage");
    if (!entry) {
        return fail("parse-miss");
    }
    if (typeof entry.value !== "string") {
        return fail("no-answer");
    }
    if (!RESUME_STAGE_VALUES.has(entry.value as ResumeStage)) {
        return fail("invalid-stage");
    }
    const confidence =
        typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
            ? Math.min(1, Math.max(0, entry.confidence))
            : 0;
    return {
        ok: true,
        stage: entry.value as ResumeStage,
        confidence,
        reason: "ok",
    };
}

/**
 * Exposed for tests that want to assert the closed set without
 * re-importing the literal in every fixture.
 */
export const RESUME_STAGE_WHITELIST: ReadonlyArray<ResumeStage> = Object.freeze([
    "wait",
    "triage",
    "spec",
    "implementation",
    "review",
    "verify",
    "merge",
]);