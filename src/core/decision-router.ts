/**
 * Spec `2026-09-20-decision-architecture` / Phase B+C / T9.0 + T9.1.
 *
 * This module is the single seam where a primitive answer (from
 * `typesafe` or the fallback `claude-code` path) becomes an
 * `auto | confirm | escalate` route the orchestrator can dispatch on.
 *
 * Per Decision 5 (`requirements.md` §"Decision 5 — Routing is
 * configurable, not hard-coded"), every per-action branch that used
 * to live as `if (confidence > X) ... else ...` is now data-driven
 * from `runtime/decisions.yaml`. Callers invoke the pure
 * `applyDecision(action, payload, decisions)` function and act on the returned `DecisionRoute`.
 * No other code in the agent layer inspects raw confidence values
 * for routing.
 *
 * `decisionRouter.apply(...)` remains a frozen alias for existing callers.
 * The caller passes the parsed `DecisionsFile` explicitly.
 *
 * Why a dedicated module:
 *   - Spec Decision 5 says routing is configurable, not hard-coded;
 *     every code path that picks a tier now reads `decisions.yaml`
 *     through this seam so an operator retune does not need a
 *     recompile.
 *   - Tests pin the threshold math (>= vs >, inclusive vs
 *     exclusive) in one place so future threshold tables cannot
 *     silently flip a rule.
 *
 * Safety rules:
 *   - Unknown / missing actions short-circuit to an `escalate`
 *     route so a typo can't silently auto-merge a PR.
 *   - A malformed `confidence` (missing, non-finite, or outside
 *     `[0, 1]`) is normalised to `0`, which every confidence-gated
 *     rule routes down its `escalate` arm. A buggy typesafe answer
 *     of `1.5` must NOT auto-merge a PR just because `1.5 >= 0.90`.
 *   - A malformed `noul_yes` never satisfies a configured noul gate
 *     (NaN semantics), so freshness failures fall through to the
 *     full batch rather than silently skipping.
 *
 * This module does NOT modify `READ_ONLY_ACTIONS` or
 * `validateDecisions`. The closed set / schema lives in
 * `src/core/decisions.ts`; the router only consumes the parsed
 * shape.
 */
import { type DecisionsFile, type DecisionRule } from "./decisions.js";

/** Routing tier the router can return. */
export type DecisionMode = "auto" | "confirm" | "escalate";

/** Routing outcome — the orchestrator's per-tier surface. */
export interface DecisionRoute {
    mode: DecisionMode;
    /** Routing target label (e.g. `needs-info`, `human`, `pager`). */
    target?: string;
    /** Prompt template surfaced to the operator on a `confirm` tier. */
    prompt?: string;
}

/** Observed routing inputs. */
export interface DecisionPayload {
    /** Model confidence in the primitive answer, in `[0.0, 1.0]`. */
    confidence?: number;
    /** Freshness `Noul` probability in `[0.0, 1.0]`. */
    noul_yes?: number;
    /** Number of findings that block a PR merge. */
    blockingFindings?: number;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Normalise a confidence value into the `[0, 1]` band used by every
 * rule, substituting `0` when the input is missing, non-finite, or
 * out of range.
 *
 * The fallback to `0` is intentional: the `escalate` arm of every
 * decision rule covers `confidence <= confidence_max`, so a
 * malformed confidence is a safe default-fail rather than a fatal
 * error that crashes the agent. Out-of-range numerics (`< 0`, `> 1`)
 * collapse to `0` for the same reason — a buggy typesafe answer of
 * `1.5` must NOT auto-merge a PR just because `1.5 >= 0.90`.
 */
function normalizeConfidence(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    if (raw < 0 || raw > 1) return 0;
    return raw;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Shared decision routing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the routing decision for `action` against the supplied
 * `decisions.yaml`.
 *
 * Tier resolution order (highest priority first):
 *   1. `escalate`  — fires when `confidence <= escalate.confidence_max`
 *                     or `noul_yes >= escalate.noul_yes_min`.
 *   2. Hard veto  — exceeds `auto.blocking_findings_max`.
 *   3. `auto`      — fires when every CONFIGURED gate passes:
 *                     `confidence >= auto.confidence_min` and
 *                     `noul_yes <= auto.noul_yes_max`. An
 *                     unconfigured gate is vacuously true, so
 *                     noul-only rules (`freshness.skip`) and
 *                     confidence-only rules (`triage.apply_label`)
 *                     both resolve correctly.
 *   4. `confirm`   — fallback tier; the gap between `auto` and
 *                     `escalate` lands here. When `confirm` is not
 *                     configured, the router escalates by default
 *                     (matches the "no silent defaults" rule).
 *
 * If the action is unknown or missing from the supplied
 * `DecisionsFile`, returns `{ mode: 'escalate', target:
 * 'unknown_action' }` so a misconfiguration surfaces as a routing
 * failure rather than a silent `auto`.
 *
 * Pure function: same inputs -> same output. No I/O, no logging.
 * The orchestrator decides what to do with the returned tier.
 *
 * @param action `decisions.yaml` action key (must be in `READ_ONLY_ACTIONS`).
 * @param payload Observed metrics (confidence + optional noul_yes).
 * @param decisions The parsed `decisions.yaml`. When `undefined`,
 *  the router cannot resolve the action and returns the
 *  `unknown_action` escalate.
 */
export function applyDecision(
    action: string,
    payload: DecisionPayload,
    decisions: DecisionsFile | undefined,
): DecisionRoute {
    if (!decisions || !Array.isArray(decisions.decisions)) {
        return { mode: "escalate", target: "unknown_action" };
    }
    const rule = decisions.decisions.find((r) => r?.action === action);
    if (!rule) {
        return { mode: "escalate", target: "unknown_action" };
    }
    return resolveTier(rule, payload);
}

/**
 * Pick the highest-priority tier whose rule fires against `payload`.
 * Tier resolution order is documented on `applyDecision`; this
 * helper is split out so unit tests can exercise the math directly
 * without re-constructing a full `DecisionsFile`.
 */
function resolveTier(rule: DecisionRule, payload: DecisionPayload): DecisionRoute {
    // Malformed confidence collapses to 0 -> the escalate arm of any
    // confidence-gated rule fires (T9.1 normalise fix). Malformed
    // noul_yes stays NaN so it never satisfies a configured noul
    // gate (conservative: fall through to the full batch).
    const confidence = normalizeConfidence(payload.confidence);
    const noulYes = numberOr(payload.noul_yes, Number.NaN);

    // Tier 1: escalate. Fires on either of:
    //   - confidence <= escalate.confidence_max
    //   - noul_yes   >= escalate.noul_yes_min
    if (rule.escalate) {
        const max = rule.escalate.confidence_max;
        const min = rule.escalate.noul_yes_min;
        if (
            (typeof max === "number" && Number.isFinite(max) && confidence <= max)
            || (typeof min === "number" && Number.isFinite(min) && Number.isFinite(noulYes) && noulYes >= min)
        ) {
            return {
                mode: "escalate",
                ...(rule.escalate.target ? { target: rule.escalate.target } : {}),
            };
        }
    }

    // A blocking finding is a hard veto, not a score that confidence can offset.
    const blockingMax = rule.auto?.blocking_findings_max;
    const blocking = Math.max(0, Math.floor(numberOr(payload.blockingFindings, 0)));
    if (typeof blockingMax === "number" && blocking > blockingMax) {
        return { mode: "escalate", target: rule.escalate?.target ?? "no_route" };
    }

    // Tier 2: auto. Fires when every CONFIGURED gate passes:
    //   - when auto.confidence_min is configured: confidence >= confidence_min;
    //   - when auto.noul_yes_max is configured: noul_yes <= noul_yes_max
    //     (a missing/NaN noul_yes never satisfies a configured gate);
    //   - an unconfigured gate is vacuously true.
    if (rule.auto) {
        const min = rule.auto.confidence_min;
        const noulMax = rule.auto.noul_yes_max;
        const confidenceOk = typeof min === "number" && Number.isFinite(min)
            ? confidence >= min
            : true;
        const noulOk = typeof noulMax === "number" && Number.isFinite(noulMax)
            ? (Number.isFinite(noulYes) && noulYes <= noulMax)
            : true;
        if (confidenceOk && noulOk) {
            return { mode: "auto" };
        }
    }

    // Tier 3: confirm. Fires in the gap between auto and escalate.
    // Same gate semantics as auto: a configured `confidence_min`
    // requires a confidence at or above it; an unconfigured one is
    // vacuously true.
    if (rule.confirm) {
        const min = rule.confirm.confidence_min;
        const confidenceOk = typeof min === "number" && Number.isFinite(min)
            ? confidence >= min
            : true;
        if (confidenceOk) {
            return {
                mode: "confirm",
                ...(rule.confirm.prompt ? { prompt: rule.confirm.prompt } : {}),
                ...(rule.confirm.target ? { target: rule.confirm.target } : {}),
            };
        }
    }

    // Gap with no `confirm` tier configured -> escalate as a safe
    // default. Matches the "no silent defaults" rule from the spec.
    return { mode: "escalate", target: rule.escalate?.target ?? "no_route" };
}

/**
 * Object-form facade for callers that prefer
 * `decisionRouter.apply(...)` over the bare `applyDecision(...)`
 * function. The object's `apply` method is a one-line alias.
 */
export const decisionRouter = Object.freeze({
    apply: applyDecision,
});
