/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T9.0.
 *
 * `decisionRouter.apply(action, payload, decisions)` resolves the
 * per-action routing tier for a `decisions.yaml` row given the
 * `confidence` (and `noul_yes`) surfaces the runtime just observed.
 *
 * The router is a thin, pure-function seam: it does no I/O, no
 * logging, no caching. The orchestrator (or per-agent wrappers)
 * call `apply()` with the action key + a payload carrying the
 * observed metrics; the router picks the highest-priority tier
 * whose rule fires and returns `{ mode, target?, prompt? }`.
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
 * Tier resolution order (highest priority first):
 *   1. `escalate`  — fires when `confidence <= escalate.confidence_max`
 *                     or `noul_yes >= escalate.noul_yes_min`.
 *   2. `auto`      — fires when `confidence >= auto.confidence_min`
 *                     AND `noul_yes <= auto.noul_yes_max` (when the
 *                     freshness ceiling is configured).
 *   3. `confirm`   — fallback tier; the gap between `auto` and
 *                     `escalate` (typically `auto.confidence_min <=
 *                     confidence < escalate.confidence_max`) lands
 *                     here. When `confirm` is not configured, the
 *                     router escalates by default (matches the
 *                     "no silent defaults" rule).
 *
 * If the action is unknown or missing from the supplied
 * `DecisionsFile`, `apply()` returns `{ mode: 'escalate', target:
 * 'unknown_action' }` so a misconfiguration surfaces as a routing
 * failure rather than a silent `auto`.
 */
import type { DecisionsFile, DecisionRule } from "./decisions.js";

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

/** Payload the router consumes. Both fields are optional so a
 *  caller that only has `confidence` (most common) does not have to
 *  fabricate a `noul_yes` value. */
export interface DecisionPayload {
    /** Model confidence in the primitive answer, in `[0.0, 1.0]`. */
    confidence?: number;
    /** Freshness `Noul` probability in `[0.0, 1.0]`. */
    noul_yes?: number;
}

/**
 * Resolve the routing decision for `action` against the supplied
 * `decisions.yaml`. See module header for tier resolution rules.
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
 * Tier resolution order is documented in the module header; this
 * helper is split out so unit tests can exercise the math directly
 * without re-constructing a full `DecisionsFile`.
 */
function resolveTier(rule: DecisionRule, payload: DecisionPayload): DecisionRoute {
    const confidence = numberOr(payload.confidence, Number.NaN);
    const noulYes = numberOr(payload.noul_yes, Number.NaN);

    // Tier 1: escalate. Fires on either of:
    //   - confidence <= escalate.confidence_max
    //   - noul_yes   >= escalate.noul_yes_min
    if (rule.escalate) {
        const max = rule.escalate.confidence_max;
        const min = rule.escalate.noul_yes_min;
        if (
            (typeof max === "number" && Number.isFinite(max) && Number.isFinite(confidence) && confidence <= max)
            || (typeof min === "number" && Number.isFinite(min) && Number.isFinite(noulYes) && noulYes >= min)
        ) {
            return {
                mode: "escalate",
                ...(rule.escalate.target ? { target: rule.escalate.target } : {}),
            };
        }
    }

    // Tier 2: auto. Fires when every CONFIGURED gate passes:
    //   - when auto.confidence_min is configured: confidence >= confidence_min
    //     (a missing/NaN confidence never satisfies a configured gate);
    //   - when auto.noul_yes_max is configured: noul_yes <= noul_yes_max
    //     (a missing/NaN noul_yes never satisfies a configured gate);
    //   - an unconfigured gate is vacuously true, so noul-only rules
    //     (`freshness.skip`) and confidence-only rules
    //     (`triage.apply_label`) both resolve correctly.
    if (rule.auto) {
        const min = rule.auto.confidence_min;
        const noulMax = rule.auto.noul_yes_max;
        const confidenceOk = typeof min === "number" && Number.isFinite(min)
            ? (Number.isFinite(confidence) && confidence >= min)
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
    // requires a finite confidence at or above it; an unconfigured
    // one is vacuously true.
    if (rule.confirm) {
        const min = rule.confirm.confidence_min;
        const confidenceOk = typeof min === "number" && Number.isFinite(min)
            ? (Number.isFinite(confidence) && confidence >= min)
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

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Object-form facade for callers that prefer
 * `decisionRouter.apply(...)` over the bare `applyDecision(...)`
 * function. The object's `apply` method is a one-line alias.
 */
export const decisionRouter = Object.freeze({
    apply: applyDecision,
});
