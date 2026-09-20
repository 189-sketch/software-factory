/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.3.
 *
 * Composite scoring formula from Decision 6.
 *
 * `health = clamp(0.30·spec + 0.25·impl + 0.20·review + 0.25·verify, 0, 1)`.
 *
 * Weights are loaded lazily from `runtime/decisions.yaml` so operators
 * can retune the rubric without code changes (the spec calls this out
 * under §"Composite Scoring Rubric"). Callers may also pass an explicit
 * `weights` argument to override — useful for tests, A/B experiments,
 * and the calibration gate in T9.3.
 *
 * Bands:
 * - `< 0.5`           -> `alert`        (operator escalation)
 * - `[0.5, 0.7]`      -> `banner`       (dashboard banner)
 * - `> 0.7`           -> `log_only`     (operator quiet log)
 *
 * Scope (additive helper only):
 * - This module is purely additive. No existing caller is modified.
 * - The score clamping is part of the contract: even if a future
 *   rubric re-weights above 1.0, the returned health stays in [0, 1].
 */
import { loadDecisions, type CompositeWeights, type DecisionsFile } from "../core/decisions.js";

/** The four dimensions the composite rubric aggregates. */
export type Dimension = "spec" | "impl" | "review" | "verify";

/** Score per dimension. Each dimension MUST be a finite number in `[0, 1]`. */
export type DimensionScores = Record<Dimension, number>;

/** Operator-visible band the dashboard badge / alert threshold reads. */
export type HealthBand = "alert" | "banner" | "log_only";

/**
 * Default weights loaded from `runtime/decisions.yaml`. Computed lazily
 * on first read so the module stays side-effect-free at import time;
 * tests can warm it via `primeDefaultWeightsSync(decisions)` to skip
 * the async load. The shape matches Decision 6 / §"Composite Scoring
 * Rubric" verbatim.
 */
let CACHED_DEFAULT_WEIGHTS: CompositeWeights | null = null;
let CACHED_DEFAULT_DECISIONS: DecisionsFile | null = null;

/**
 * Prime the default-weight cache synchronously. Production callers
 * (the orchestrator) prime it during the `runDecisionsPreCheck()` call
 * so subsequent `computeHealth()` invocations skip the async re-read.
 * Tests can call this directly to avoid touching the filesystem.
 */
export function primeDefaultWeights(decisions: DecisionsFile): void {
    CACHED_DEFAULT_DECISIONS = decisions;
    CACHED_DEFAULT_WEIGHTS = { ...decisions.composite };
}

/** Drop the cache (test-only). */
export function __clearDefaultWeightsCacheForTest(): void {
    CACHED_DEFAULT_WEIGHTS = null;
    CACHED_DEFAULT_DECISIONS = null;
}

/**
 * Load the default weights from `decisions.yaml` on demand. Async so
 * the first call hits the filesystem; subsequent calls return the
 * cached value synchronously.
 */
async function loadDefaultWeightsAsync(): Promise<CompositeWeights> {
    if (CACHED_DEFAULT_WEIGHTS !== null) return CACHED_DEFAULT_WEIGHTS;
    const decisions = await loadDecisions();
    const weights: CompositeWeights = { ...decisions.composite };
    primeDefaultWeights(decisions);
    return weights;
}

/**
 * Compute the composite health value per Decision 6.
 *
 * `health = clamp(sum(weight_i * score_i), 0, 1)`.
 *
 * The caller may pass a `weights` override (per-dimension, per-A/B
 * experiment, or per-calibration-gate); when omitted, the function
 * uses the weights loaded from `decisions.yaml` (cached after the
 * first call). The `score` argument is the dimension-to-score map
 * produced by the upstream primitives; each score MUST lie in
 * `[0, 1]`. Out-of-range scores are clamped so a buggy upstream
 * primitive cannot blow past the contract envelope.
 *
 * Throws when a required dimension is missing or non-finite, so a
 * silent default never hides a wiring bug.
 */
export function computeHealth(scores: DimensionScores, weights?: CompositeWeights): number {
    if (!scores || typeof scores !== "object") {
        throw new Error("computeHealth: scores must be an object");
    }
    const dims: readonly Dimension[] = ["spec", "impl", "review", "verify"];
    let total = 0;
    let weightSum = 0;
    const effectiveWeights = weights ?? CACHED_DEFAULT_WEIGHTS;
    if (effectiveWeights === null) {
        throw new Error(
            "computeHealth: default weights not loaded; call primeDefaultWeights(decisions) or pass weights explicitly",
        );
    }
    for (const dim of dims) {
        const score = scores[dim];
        if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new Error(`computeHealth: score for "${dim}" must be a finite number (got ${String(score)})`);
        }
        const weight = effectiveWeights[dim];
        if (typeof weight !== "number" || !Number.isFinite(weight)) {
            throw new Error(`computeHealth: weight for "${dim}" must be a finite number (got ${String(weight)})`);
        }
        total += weight * clamp(score, 0, 1);
        weightSum += weight;
    }
    if (weightSum <= 0) {
        throw new Error("computeHealth: weight sum must be positive");
    }
    return clamp(total / weightSum, 0, 1);
}

/**
 * Map a composite health score to the operator-visible band documented
 * in Decision 6 / §"Composite Scoring Rubric":
 *
 * - `< 0.5`         -> `alert`
 * - `[0.5, 0.7]`    -> `banner`
 * - `> 0.7`         -> `log_only`
 *
 * Throws on a non-finite input so a wiring bug does not silently land
 * on a default band.
 */
export function healthBand(score: number): HealthBand {
    if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(`healthBand: score must be a finite number (got ${String(score)})`);
    }
    if (score < 0.5) return "alert";
    if (score <= 0.7) return "banner";
    return "log_only";
}

/**
 * Async wrapper that primes the default-weight cache and returns
 * `computeHealth(scores)`. Production callers (the orchestrator's
 * per-cycle health log) call this exactly once per daemon tick after
 * `runDecisionsPreCheck()` has loaded the YAML.
 */
export async function computeHealthFromDecisions(scores: DimensionScores): Promise<number> {
    await loadDefaultWeightsAsync();
    return computeHealth(scores);
}

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}