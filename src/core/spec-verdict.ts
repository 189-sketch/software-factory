/**
 * `src/core/spec-verdict.ts` — pure functions that turn `typesafe` batch
 * answers into actionable spec/review verdicts.
 *
 * Replaces the old behaviour where `parseSpecTypesafeAnswer.b1/b2/b3`
 * and `parseReviewSpecTypesafeAnswer.b4/b5` were stored on
 * `SpecPair.typesafeBatch` / `SpecReviewResult.typesafeBatch` as
 * decorative metadata. Now those values are read by `deriveSpecVerdict`
 * and `deriveReviewVerdict` and can VETO the `claude-code` output —
 * which is what the spec `2026-09-20-decision-architecture` phase B/C
 * already paid for via the B1 / B2 / B3 / B4 / B5 primitives.
 *
 * Both functions are pure (no I/O, no LLM call). They take the
 * claude-code-produced artifact plus its `typesafeBatch` (or
 * `undefined` when the batch fell back) and return the verdict the
 * orchestrator should adopt.
 *
 * Issue #36 (PR #37) was caught in a loop because:
 *   - claude-code produced a duplicate spec tree (`specs/issue-36-ui/` +
 *     `specs/issue-36-ui-apple-style/`)
 *   - review-spec claude-code correctly REJECTED it
 *   - but spec claude-code kept producing the same shape on retry
 *   - because nothing in the pipeline consulted `typesafeBatch.b2` /
 *     `b3` to flag "your PRODUCT.md has contradictory acceptance
 *     gates" before commit
 * `deriveSpecVerdict` is the gate that should have caught it.
 */

import type {
    Finding,
    FindingSeverity,
    ReviewSpecTypesafeBatchAnswer,
    SpecPair,
    SpecReviewResult,
    SpecTypesafeBatchAnswer,
} from "./types.js";

/** Spec acceptance-gate completeness threshold (B2 Score primitive). */
const SPEC_COMPLETENESS_THRESHOLD = 0.6;

/** Typesafe review-verdict confidence floor for vetoing the reviewer. */
const REVIEW_VERDICT_CONFIDENCE_FLOOR = 0.6;

export interface SpecVerdict {
    verdict: "pass" | "needs-revision";
    /** Human-readable reasons; surfaced on the spec-revision prompt. */
    reasons: string[];
    /**
     * Which sub-stage the spec agent should re-run when verdict is
     * `needs-revision`. `undefined` for `pass`.
     *   - `spec-product` — PRODUCT.md was the problem (e.g. B1 missing).
     *   - `spec-tech`    — TECH.md was the problem (e.g. B2/B3 trip).
     */
    targetStage?: "spec-product" | "spec-tech";
}

/**
 * Compute the spec verdict from the claude-code output and its
 * `typesafeBatch`. Returns `verdict: "pass"` (with reason
 * `typesafe-unavailable`) when `typesafeBatch` is undefined — in that
 * case the spec agent fell back to the `claude-code` path because
 * TYPESAFE_API_KEY was missing or `FACTORY_TYPESAFE_OFF=1` was set,
 * and we do not have a typesafe answer to apply.
 */
export function deriveSpecVerdict(
    spec: SpecPair,
    batch: SpecTypesafeBatchAnswer | undefined,
): SpecVerdict {
    if (batch === undefined) {
        return { verdict: "pass", reasons: ["typesafe-unavailable"], targetStage: undefined };
    }

    const reasons: string[] = [];
    const b1 = batch.b1;

    // --- B1: PRODUCT-only vs PRODUCT+TECH selection must be a non-empty string
    const b1Missing =
        typeof b1?.value !== "string" || (b1.value as unknown as string).trim() === "";
    if (b1Missing) {
        reasons.push("B1: missing PRODUCT+TECH choice");
    }

    // --- B2: per-AC completeness below 0.60
    const incompleteAcs = batch.b2
        .filter((entry) => typeof entry.value === "number" && entry.value < SPEC_COMPLETENESS_THRESHOLD)
        .map((entry) => entry.acId);
    if (incompleteAcs.length > 0) {
        reasons.push(`B2: incomplete acceptance criteria (${incompleteAcs.join(", ")})`);
    }

    // --- B3: per-AC verifiability (false means not observable)
    const unverifiableAcs = batch.b3
        .filter((entry) => entry.value === false)
        .map((entry) => entry.acId);
    if (unverifiableAcs.length > 0) {
        reasons.push(`B3: unverifiable acceptance criteria (${unverifiableAcs.join(", ")})`);
    }

    if (reasons.length === 0) {
        return { verdict: "pass", reasons: ["all typesafe gates passed"], targetStage: undefined };
    }

    // B1 missing forces a re-run from PRODUCT.md (so the spec agent
    // restates its PRODUCT-only-vs-PRODUCT+TECH choice); otherwise the
    // failure is in the TECH layer.
    const targetStage: "spec-product" | "spec-tech" = b1Missing ? "spec-product" : "spec-tech";
    return { verdict: "needs-revision", reasons, targetStage };
}

export interface ReviewVerdict {
    /** Final review verdict the orchestrator should publish. */
    verdict: "APPROVE" | "REJECT";
    /** Audit-trail reasons (logged + appended to review.notes). */
    reasons: string[];
    /**
     * Per-finding severity overrides keyed by `Finding.id`. Empty when
     * `typesafeBatch` is undefined (passthrough) or when every B5
     * entry agrees with the reviewer.
     */
    severityOverrides: Map<string, FindingSeverity>;
}

/** Options for `deriveReviewVerdict`. All optional — the two-argument call keeps the pre-rubric behaviour byte-for-byte. */
export interface ReviewVerdictOptions {
    /**
     * LLM-exploration downweight floor (2026-09-21, issue #39).
     *
     * When set, a B5 severity of `blocking`/`important` only keeps its
     * blocking power if Jev answered with `confidence >= floor`; below
     * the floor the finding is downgraded to `suggestion` (advisory).
     * Rationale: the R-series rubric batch is now the verdict source of
     * record for every enumerable defect class; the LLM review pass is
     * an exploration layer for defects no fixed rubric enumerates, and
     * a low-confidence free-form "important" is exactly the oscillation
     * source that kept issue #39 rejecting. High-confidence exploratory
     * findings (≥ floor) still block.
     */
    exploreBlockFloor?: number;
}

/**
 * Parse `FACTORY_REVIEW_EXPLORE_BLOCK_CONF` into the
 * `exploreBlockFloor` option. Pure (env passed in) so it is unit-
 * testable. Default `0.9`; `"0"` / `"off"` disable the downweight
 * (returns `undefined`); values are clamped to `[0, 1]`; garbage
 * falls back to the default.
 */
export function resolveExploreBlockFloor(
    env: Record<string, string | undefined>,
): number | undefined {
    const raw = (env.FACTORY_REVIEW_EXPLORE_BLOCK_CONF ?? "").trim();
    if (raw === "") return 0.9;
    if (raw === "0" || raw.toLowerCase() === "off") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 0.9;
    return Math.min(1, Math.max(0, parsed));
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
    blocking: 0,
    important: 1,
    suggestion: 2,
    nit: 3,
};

/**
 * Compute the review verdict from the claude-code output and its
 * `typesafeBatch`. Returns the reviewer's verdict untouched when
 * `typesafeBatch` is undefined (claude-code fallback).
 *
 * Veto rules (in order):
 *   1. Per-finding severity overrides from B5.
 *   2. B4 verdict comparison: typesafe REJECT vs reviewer APPROVE → REJECT.
 *   3. B4 verdict comparison: typesafe APPROVE vs reviewer REJECT with a
 *      blocking finding → keep REJECT (record dials).
 *   4. B4.confidence < floor + APPROVE → trust reviewer.
 *   5. Any B5 escalation to blocking → REJECT.
 */
export function deriveReviewVerdict(
    review: SpecReviewResult,
    batch: ReviewSpecTypesafeBatchAnswer | undefined,
    opts: ReviewVerdictOptions = {},
): ReviewVerdict {
    if (batch === undefined) {
        return {
            verdict: review.verdict,
            reasons: ["typesafe-unavailable"],
            severityOverrides: new Map(),
        };
    }

    const reasons: string[] = [];
    const severityOverrides = new Map<string, FindingSeverity>();
    const findings: Finding[] = (review.findings ?? []) as Finding[];

    // --- 1. B5 per-finding severity overrides
    let escalatedToBlocking = 0;
    for (const finding of findings) {
        const b5 = batch.b5.find((entry) => entry.findingId === finding.id);
        if (b5 === undefined) continue;

        const reviewerSeverity: FindingSeverity = finding.severity;
        let typesafeSeverity: FindingSeverity = b5.value;

        // --- 1a. LLM-exploration downweight (issue #39): a blocking-class
        // B5 severity only keeps its blocking power at high confidence.
        // Below the floor the finding becomes advisory — the enumerable
        // defect classes are already judged by the R-series rubric batch,
        // so a low-confidence free-form "important" must not flip the
        // verdict and restart the whole spec cycle.
        if (
            opts.exploreBlockFloor !== undefined &&
            (typesafeSeverity === "blocking" || typesafeSeverity === "important") &&
            b5.confidence < opts.exploreBlockFloor
        ) {
            typesafeSeverity = "suggestion";
            reasons.push(
                `B5: downgraded ${finding.id} to suggestion (blocking-class severity at confidence ${b5.confidence.toFixed(2)} < explore floor ${opts.exploreBlockFloor.toFixed(2)})`,
            );
        }

        if (typesafeSeverity === reviewerSeverity) continue;

        if (
            typesafeSeverity === "blocking" &&
            SEVERITY_ORDER[reviewerSeverity] > SEVERITY_ORDER.blocking
        ) {
            severityOverrides.set(finding.id, "blocking");
            reasons.push(
                `B5: upgraded ${finding.id} to blocking (was ${reviewerSeverity})`,
            );
            escalatedToBlocking += 1;
        } else if (
            typesafeSeverity === "nit" &&
            (reviewerSeverity === "blocking" || reviewerSeverity === "important")
        ) {
            severityOverrides.set(finding.id, "nit");
            reasons.push(
                `B5: downgraded ${finding.id} to nit (was ${reviewerSeverity})`,
            );
        } else {
            severityOverrides.set(finding.id, typesafeSeverity);
            reasons.push(
                `B5: severity ${finding.id} → ${typesafeSeverity} (was ${reviewerSeverity})`,
            );
        }
    }

    // --- 2. B4 verdict vs reviewer verdict.
    // For the "APPROVE vs REJECT" case, we must check whether the
    // reviewer's REJECT survives the B5 overrides — i.e. whether
    // *after* applying severity changes, any blocking finding remains.
    const effectiveSeverities = new Map<string, FindingSeverity>();
    for (const finding of findings) {
        effectiveSeverities.set(finding.id, finding.severity);
    }
    for (const [findingId, severity] of severityOverrides.entries()) {
        effectiveSeverities.set(findingId, severity);
    }
    const hasBlockingFinding = [...effectiveSeverities.values()].some(
        (s) => s === "blocking",
    );

    const typesafeB4 = batch.b4.value;
    const typesafeConf = batch.b4.confidence;
    let finalVerdict: "APPROVE" | "REJECT" = review.verdict;

    if (typesafeB4 === "REJECT" && review.verdict === "APPROVE") {
        if (typesafeConf >= REVIEW_VERDICT_CONFIDENCE_FLOOR) {
            finalVerdict = "REJECT";
            reasons.push(
                `B4: typesafe REJECT vs reviewer APPROVE (conf=${typesafeConf.toFixed(2)})`,
            );
        }
        // low confidence → trust the reviewer; don't append a dissent reason
    } else if (typesafeB4 === "APPROVE" && review.verdict === "REJECT") {
        // Keep the reviewer's REJECT when, after applying B5 overrides,
        // any blocking finding remains. If the only blocker was
        // downgraded to nit by B5, the REJECT no longer holds.
        if (hasBlockingFinding) {
            finalVerdict = "REJECT";
            reasons.push(
                "B4: typesafe APPROVE vs reviewer REJECT — keeping REJECT (reviewer blocking findings preserved)",
            );
        } else {
            finalVerdict = "APPROVE";
            reasons.push(
                `B4: typesafe APPROVE vs reviewer REJECT (conf=${typesafeConf.toFixed(2)}) — overriding`,
            );
        }
    } else {
        finalVerdict = typesafeB4;
    }

    // --- 3. Escalations override APPROVE → REJECT
    if (escalatedToBlocking > 0 && finalVerdict !== "REJECT") {
        finalVerdict = "REJECT";
        reasons.push(`B5: ${escalatedToBlocking} finding(s) escalated to blocking`);
    }

    // --- 4. Low confidence on typesafe APPROVE → fall back to reviewer
    if (
        typesafeB4 === "APPROVE" &&
        typesafeConf < REVIEW_VERDICT_CONFIDENCE_FLOOR &&
        finalVerdict === "APPROVE" &&
        review.verdict !== "APPROVE"
    ) {
        finalVerdict = review.verdict;
        reasons.push(
            `B4.confidence ${typesafeConf.toFixed(2)} < ${REVIEW_VERDICT_CONFIDENCE_FLOOR} — falling back to reviewer verdict`,
        );
    }

    return { verdict: finalVerdict, reasons, severityOverrides };
}