/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1.
 *
 * `DecisionRouter` is the single seam where a primitive answer (from
 * `typesafe` or the fallback `claude-code` path) becomes an
 * `auto | confirm | escalate` route the orchestrator can dispatch on.
 *
 * Per Decision 5 (`requirements.md` §"Decision 5 — Routing is
 * configurable, not hard-coded"), every per-action branch that used
 * to live as `if (confidence > X) ... else ...` is now data-driven
 * from `runtime/decisions.yaml`. The orchestrator / agent calls
 * `decisionRouter.apply(action, result)` once per action and acts on
 * the returned `DecisionRoute`; no other code in the agent layer
 * inspects raw confidence values for routing.
 *
 * Resolution rules (per `decisions.yaml` schema):
 *
 *   1. The `action` MUST resolve to a member of `READ_ONLY_ACTIONS`;
 *      unknown / missing actions short-circuit to
 *      `{ mode: "escalate", target: "needs-info" }` so a typo can't
 *      silently auto-merge a PR.
 *   2. The supplied `result.confidence` MUST be a finite number in
 *      `[0, 1]`. Anything else is treated as `confidence = 0` so a
 *      malformed typesafe answer is forced down the `escalate` arm.
 *   3. Tiers are evaluated in declared order — `auto`, then
 *      `escalate`, then `confirm`. The first tier whose `confidence_min`
 *      / `confidence_max` includes the input wins; ties (rare — the
 *      YAML author can overlap bands by design) resolve to the more
 *      conservative route.
 *
 * Scope (additive helper):
 * - `DecisionRouter` is a pure function over `(decisions, action,
 *   result)`; no I/O. Callers either instantiate with
 *   `DecisionRouter.fromDecisionsFile(...)` (testable) or
 *   `DecisionRouter.fromDefaultFile()` (production — loads
 *   `runtime/decisions.yaml` via `loadDecisionsSync`).
 * - This module does NOT modify `READ_ONLY_ACTIONS` or
 *   `validateDecisions`. The closed set / schema lives in
 *   `src/core/decisions.ts`; the router only consumes the parsed
 *   shape.
 */
import {
    loadDecisionsSync,
    type DecisionsFile,
    type DecisionRule,
} from "./decisions.js";

/** Per-action route the router hands back to the caller. */
export type DecisionMode = "auto" | "confirm" | "escalate";

/** Decision output. `mode` is always set; `prompt` / `target` are
 * populated from the matching tier rule when the YAML defines them. */
export interface DecisionRoute {
    mode: DecisionMode;
    /** Operator-facing prompt template (confirm tier only). */
    prompt?: string;
    /** Routing target (escalate tier usually; some confirm tiers
     * carry a dashboard banner target). */
    target?: string;
}

/** Minimal input shape `apply()` accepts. Callers may pass more; the
 * router reads only `confidence` so an enriched typesafe envelope can
 * be forwarded without a re-shape. */
export interface DecisionResult {
    confidence?: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalise a confidence value into the `[0, 1]` band used by every
 * rule, substituting `0` when the input is missing, non-finite, or
 * out of range.
 *
 * The fallback to `0` is intentional: the router's caller is the
 * production agent and the `escalate` arm of every decision rule
 * covers `confidence <= confidence_max`, so a malformed confidence
 * is a safe default-fail rather than a fatal error that crashes
 * the agent. Out-of-range numerics (`< 0`, `> 1`) collapse to `0`
 * for the same reason — a buggy typesafe answer of `1.5` must NOT
 * auto-merge a PR just because `1.5 >= 0.90`.
 */
function normalizeConfidence(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    if (raw < 0 || raw > 1) return 0;
    return raw;
}

/* -------------------------------------------------------------------------- */
/* DecisionRouter                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pure, data-driven router over a parsed `DecisionsFile`.
 *
 * Construction is via the two factory helpers (`fromDecisionsFile`,
 * `fromDefaultFile`); `apply` is the only public method callers
 * need. Tests instantiate with their own `DecisionsFile` so the
 * thresholds under test are decoupled from `runtime/decisions.yaml`.
 */
export class DecisionRouter {
    private readonly decisions: DecisionsFile;

    constructor(decisions: DecisionsFile) {
        this.decisions = decisions;
    }

    /** Build a router from an explicit, parsed `DecisionsFile` (test
     * path). The file is held verbatim; the router does not mutate
     * it. */
    static fromDecisionsFile(decisions: DecisionsFile): DecisionRouter {
        return new DecisionRouter(decisions);
    }

    /** Build a router from the default `runtime/decisions.yaml` file
     * via `loadDecisionsSync`. Production call site. */
    static fromDefaultFile(): DecisionRouter {
        return new DecisionRouter(loadDecisionsSync());
    }

    /**
     * Resolve `action` against `result.confidence` and return the
     * matched route.
     *
     * Resolution order:
     *   1. Find the `DecisionRule` whose `action === action`.
     *      Missing / unknown action → `{ mode: "escalate", target: "needs-info" }`.
     *   2. Try `auto` tier: confidence >= auto.confidence_min (when present).
     *   3. Try `escalate` tier: confidence <= escalate.confidence_max (when present).
     *   4. Try `confirm` tier: confidence >= confirm.confidence_min (when present).
     *   5. No tier matched → fall back to `{ mode: "escalate" }`,
     *      preferring the rule's own `escalate.target` so a
     *      mis-configured rule still routes somewhere safe.
     */
    apply(action: string, result: DecisionResult): DecisionRoute {
        const rule = this.findRule(action);
        if (!rule) {
            return { mode: "escalate", target: "needs-info" };
        }
        const confidence = normalizeConfidence(result.confidence);
        const autoMatch = this.matchAuto(rule, confidence);
        if (autoMatch) return autoMatch;
        const escalateMatch = this.matchEscalate(rule, confidence);
        if (escalateMatch) return escalateMatch;
        const confirmMatch = this.matchConfirm(rule, confidence);
        if (confirmMatch) return confirmMatch;
        // No tier matched (rule defined but every threshold excluded
        // the input). Defer to the rule's `escalate` tier for the
        // target so the operator sees the same channel the YAML
        // author curated.
        return {
            mode: "escalate",
            ...(rule.escalate?.target ? { target: rule.escalate.target } : {}),
        };
    }

    /** Lookup helper; returns `undefined` when `action` is missing. */
    private findRule(action: string): DecisionRule | undefined {
        if (typeof action !== "string" || action === "") return undefined;
        return this.decisions.decisions.find((d) => d?.action === action);
    }

    private matchAuto(rule: DecisionRule, confidence: number): DecisionRoute | undefined {
        const auto = rule.auto;
        if (!auto || typeof auto.confidence_min !== "number") return undefined;
        if (confidence >= auto.confidence_min) {
            return { mode: "auto" };
        }
        return undefined;
    }

    private matchEscalate(rule: DecisionRule, confidence: number): DecisionRoute | undefined {
        const tier = rule.escalate;
        if (!tier || typeof tier.confidence_max !== "number") return undefined;
        if (confidence <= tier.confidence_max) {
            const out: DecisionRoute = { mode: "escalate" };
            if (typeof tier.target === "string" && tier.target) out.target = tier.target;
            return out;
        }
        return undefined;
    }

    private matchConfirm(rule: DecisionRule, confidence: number): DecisionRoute | undefined {
        const confirm = rule.confirm;
        if (!confirm || typeof confirm.confidence_min !== "number") return undefined;
        if (confidence >= confirm.confidence_min) {
            const out: DecisionRoute = { mode: "confirm" };
            if (typeof confirm.prompt === "string" && confirm.prompt) out.prompt = confirm.prompt;
            if (typeof confirm.target === "string" && confirm.target) out.target = confirm.target;
            return out;
        }
        return undefined;
    }
}