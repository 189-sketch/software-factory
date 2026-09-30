/**
 * `src/core/spec-review-rubric.ts` — R-series structured rubric
 * judgments for the review-spec stage (2026-09-21, issue #39
 * convergence fix).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * daemon.log evidence (issue #39, 2026-09-21): the LLM review-spec
 * pass REJECTED two consecutive revisions with the SAME three
 * important findings (AC-2/US-5 quantifier mismatch, AC-6 qualitative
 * accent clause, grep-based style assertions). The findings were fed
 * back to the spec agent (`findings=19` in the stage manifest), yet
 * the next revision reproduced them verbatim. Two structural gaps:
 *
 *   1. The verdict source was free-form LLM discovery — each round
 *      re-scanned the whole document and re-worded findings, so
 *      "did the revision converge?" was unanswerable.
 *   2. Nothing verified per-finding resolution before paying for a
 *      full re-review.
 *
 * The R-series closes both gaps. Every enumerable rubric item in
 * `skills/review-spec/SKILL.md` becomes a structured Jev judgment
 * point over the ALREADY-PARSED spec fields (`ProductSpec.stories[]`,
 * `acceptanceCriteria[]`, `TechSpec.validationPlan[]`, …). The same
 * point ids are re-judged every round, so convergence is a measurable
 * flip (fail → pass) per point, and a point that fails two rounds in
 * a row escalates deterministically to needs-info instead of burning
 * a third spec cycle.
 *
 * LAYERING
 * --------
 * This module is pure (no I/O, no HTTP, no LLM). The wire builders
 * (state / request / parse) and the batch runner live in
 * `src/agents/spec-review-rubric.ts`, mirroring the split between
 * `core/spec-verdict.ts` (judgment) and the agents' B-series builders.
 *
 * Division of labour follows the factory principle "jev/typesafe for
 * judgment and decision, claude-code for content generation":
 *   - Jev answers the R-series points (verdict source of record).
 *   - The LLM review-spec pass still runs AFTER a rubric pass as an
 *     exploration layer for defects no fixed rubric enumerates; its
 *     free-form findings are downweighted unless Jev's B5 severity
 *     judgment is high-confidence (see `deriveReviewVerdict`'s
 *     `exploreBlockFloor`).
 */

import type {
    AuthorOverride,
    Finding,
    FindingSeverity,
    SpecPair,
    SpecReviewResult,
    SpecRubricAnswerEntry,
    SpecRubricBatchAnswer,
} from "./types.js";
import { makeFinding } from "./findings.js";
import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Rule families                                                              */
/* -------------------------------------------------------------------------- */

/** R-series rule families. One family = one rubric line item. */
export type RubricRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

/**
 * Polarity of a noul rule: `positive` means a HIGH yes-probability is
 * good (R1 "is verifiable"); `negative` means a HIGH yes-probability
 * is the defect (R4 "does block implementation", R6 "does implement
 * the non-goal").
 */
type NoulPolarity = "positive" | "negative";

interface RubricRuleConfig {
    rule: RubricRule;
    kind: "noul" | "score";
    polarity: NoulPolarity;
    /** Finding ruleId emitted when the point fails. */
    ruleId: string;
    /** Fixed severity mapping — NOT a Jev judgment (deterministic policy). */
    severity: FindingSeverity;
}

/**
 * Static rule table. Severity is a code-side policy decision so the
 * same defect always produces the same severity — the oscillation
 * source in issue #39 was severity being re-judged per round.
 */
export const RUBRIC_RULES: ReadonlyArray<RubricRuleConfig> = [
    { rule: "R1", kind: "noul", polarity: "positive", ruleId: "rubric-ac-unobservable", severity: "important" },
    { rule: "R2", kind: "score", polarity: "positive", ruleId: "rubric-story-coverage-gap", severity: "important" },
    { rule: "R3", kind: "noul", polarity: "positive", ruleId: "rubric-validation-not-runnable", severity: "important" },
    { rule: "R4", kind: "noul", polarity: "negative", ruleId: "rubric-blocking-open-question", severity: "important" },
    { rule: "R5", kind: "noul", polarity: "positive", ruleId: "rubric-out-of-scope-story", severity: "important" },
    { rule: "R6", kind: "noul", polarity: "negative", ruleId: "rubric-non-goal-implemented", severity: "blocking" },
    { rule: "R7", kind: "noul", polarity: "positive", ruleId: "rubric-unresolved-finding", severity: "important" },
];

const RULE_BY_ID = new Map<RubricRule, RubricRuleConfig>(
    RUBRIC_RULES.map((r) => [r.rule, r]),
);

/* -------------------------------------------------------------------------- */
/* Input descriptor                                                           */
/* -------------------------------------------------------------------------- */

/** One item a rubric point judges. `id` is the point target (`AC-2`). */
export interface RubricItem {
    id: string;
    text: string;
}

export interface RubricStoryItem {
    id: string;
    title: string;
    iWant: string;
    checks: ReadonlyArray<string>;
}

export interface RubricPreviousFinding {
    /** Positional point target (`PF-1`); stable within one review round. */
    id: string;
    /** The carried finding's own id (for severity/requirement carry-over). */
    findingId: string;
    severity: FindingSeverity;
    summary: string;
    requirementIds: ReadonlyArray<string>;
    evidence?: Finding['evidence'];
    identityKey?: string;
}

/**
 * Everything the R-series judges, flattened out of the structured
 * `SpecPair`. Positional ids (`AC-n`, `VP-n`, `OQ-P-n`, `OQ-T-n`,
 * `NG-n`, `PF-n`) mirror the B2/B3 convention (`B2-AC-N`); story ids
 * come from `UserStory.id` when present.
 */
export interface ReviewRubricInput {
    acceptanceCriteria: ReadonlyArray<RubricItem>;
    stories: ReadonlyArray<RubricStoryItem>;
    validationPlan: ReadonlyArray<RubricItem>;
    openQuestions: ReadonlyArray<RubricItem>;
    nonGoals: ReadonlyArray<RubricItem>;
    previousFindings: ReadonlyArray<RubricPreviousFinding>;
    /**
     * Author overrides from `ProductSpec.authorOverrides`. The R3 rubric
     * treats each entry with a non-empty rationale as a resolved finding
     * — see issue #46 (2026-09-24): without this signal, the rubric
     * repeats the same rejection across rounds even when the author has
     * explicitly told the factory to retain the flagged item.
     */
    authorOverrides?: ReadonlyArray<AuthorOverride>;
}

/**
 * Derive the rubric input from a parsed spec pair plus the previous
 * review round's findings (the revision signal). Pure projection —
 * no validation; malformed specs surface as empty lists, which
 * `buildReviewRubricRequest` turns into "no questions" (the caller
 * then skips the batch).
 */
export function reviewRubricInputFromSpec(
    spec: SpecPair,
    previousFindings: ReadonlyArray<Finding> | undefined,
): ReviewRubricInput {
    const acceptanceCriteria = (spec.product?.acceptanceCriteria ?? []).map((text, i) => ({
        id: `AC-${i + 1}`,
        text,
    }));
    const stories = (spec.product?.stories ?? []).map((s, i) => ({
        id: s.id?.trim() ? s.id.trim() : `US-${i + 1}`,
        title: s.title ?? "",
        iWant: s.iWant ?? "",
        checks: s.checks ?? [],
    }));
    const validationPlan = (spec.tech?.validationPlan ?? []).map((text, i) => ({
        id: `VP-${i + 1}`,
        text,
    }));
    const openQuestions = [
        ...(spec.product?.openQuestions ?? []).map((text, i) => ({ id: `OQ-P-${i + 1}`, text })),
        ...(spec.tech?.openQuestions ?? []).map((text, i) => ({ id: `OQ-T-${i + 1}`, text })),
    ];
    const nonGoals = (spec.product?.nonGoals ?? []).map((text, i) => ({
        id: `NG-${i + 1}`,
        text,
    }));
    const previous = (previousFindings ?? []).map((f, i) => ({
        id: `PF-${i + 1}`,
        findingId: f.id,
        severity: f.severity,
        summary: f.summary,
        requirementIds: f.requirementIds ?? [],
        evidence: f.evidence,
        identityKey: /identity=(R[1-7]-[0-9a-f]{16})/.exec(f.evidence?.excerpt ?? "")?.[1],
    }));
    // Pass through author overrides; the R3 rubric reads them to skip
    // items the author has explicitly directed us to retain. Rationale
    // must be non-empty — see ProductSpec.authorOverrides semantics.
    const authorOverrides = spec.product?.authorOverrides ?? [];
    return {
        acceptanceCriteria,
        stories,
        validationPlan,
        openQuestions,
        nonGoals,
        previousFindings: previous,
        authorOverrides,
    };
}

/** Total judgment points this input would produce. `0` → skip the batch. */
export function countRubricPoints(input: ReviewRubricInput): number {
    return (
        input.acceptanceCriteria.length + // R1
        input.stories.length + // R2
        input.validationPlan.length + // R3
        input.openQuestions.length + // R4
        input.stories.length + // R5
        input.nonGoals.length + // R6
        input.previousFindings.length // R7
    );
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                 */
/* -------------------------------------------------------------------------- */

export interface RubricThresholds {
    /**
     * Minimum yes-probability for a positive-polarity noul to pass.
     * Negative-polarity nouls fail at `p >= 1 - noulMin`. At the
     * default 0.5 both collapse to the adapter's boolean `value`.
     * Raise during calibration if 0.5 proves too lenient.
     */
    noulMin?: number;
    /** R2 score below this → important (none / weak-partial coverage). */
    r2ImportantBelow?: number;
    /** R2 score in [r2ImportantBelow, this) → suggestion (strong partial). */
    r2SuggestionBelow?: number;
}

export const DEFAULT_RUBRIC_THRESHOLDS: Required<RubricThresholds> = {
    noulMin: 0.5,
    // 4-level score positions are ≈ 0 / 0.33 / 0.67 / 1.0:
    // none + weak-partial → important; strong-partial → suggestion.
    r2ImportantBelow: 0.5,
    r2SuggestionBelow: 0.84,
};

/* -------------------------------------------------------------------------- */
/* Verdict derivation                                                         */
/* -------------------------------------------------------------------------- */

/** One rubric-derived finding draft (pre-`makeFinding`). */
export interface RubricFindingDraft {
    /** Primitive id that failed, e.g. `R1-AC-3`. Stable across rounds. */
    pointId: string;
    rule: RubricRule;
    ruleId: string;
    severity: FindingSeverity;
    summary: string;
    requirementIds: string[];
    /** R7 only: the previous finding that stayed unresolved. */
    carriedFindingId?: string;
    /** Raw probability / score — kept for the audit trail. */
    measured: number;
    identityKey?: string;
}

export interface SpecRubricVerdict {
    verdict: "pass" | "reject";
    findings: RubricFindingDraft[];
    /** Human-readable audit lines (one per failed point). */
    reasons: string[];
    /** Failed point ids — the ratchet input (`updateRubricFailureCounts`). */
    failedPoints: string[];
}

/**
 * Compose the review verdict from R-series answers. PURE and
 * deterministic: same answers + same input ⇒ same verdict, findings
 * and severities. No LLM, no re-wording — this is the convergence
 * anchor the free-form review loop lacked.
 *
 * Verdict policy (code-owned, per the typesafe composition guidance
 * "keep policy explicit and raw judgments reusable"):
 *   - any `blocking` or `important` draft → REJECT
 *   - suggestions / nits are reported but never block
 */
export function deriveRubricVerdict(
    answer: SpecRubricBatchAnswer,
    input: ReviewRubricInput,
    opts: RubricThresholds = {},
): SpecRubricVerdict {
    const t = { ...DEFAULT_RUBRIC_THRESHOLDS, ...opts };
    const findings: RubricFindingDraft[] = [];
    const reasons: string[] = [];
    const failedPoints: string[] = [];

    const previousById = new Map(input.previousFindings.map((p) => [p.id, p]));

    // Author overrides (issue #46, 2026-09-24): the rubric treats
    // items in `input.authorOverrides` with non-empty rationale as
    // resolved. We expose them as a Set for O(1) lookup keyed by
    // requirement id; the parser already drops empty rationales so
    // what remains here is by construction non-empty.
    const overriddenRequirementIds = new Set(
        (input.authorOverrides ?? [])
            .filter((o) => o.rationale && o.rationale.trim().length > 0)
            .map((o) => o.requirementId),
    );

    for (const entry of answer.entries) {
        const parsed = parsePointId(entry.id);
        if (!parsed) continue;
        const config = RULE_BY_ID.get(parsed.rule);
        if (!config) continue;
        // Value shape must match the rule kind (adapter already
        // normalised; a mismatch means a malformed entry — skip).
        if (config.kind === "noul" && typeof entry.value !== "boolean") continue;
        if (config.kind === "score" && typeof entry.value !== "number") continue;

        // Author-override exit for R3: the rubric refuses to reject an
        // item the author has explicitly directed us to retain. We do
        // NOT apply this to R1/R2/R4/R5/R6/R7 because those rules
        // check different invariants (acceptance criteria, story
        // coverage, blocking questions, scope, non-goal leaks,
        // previous-round resolution) and an author override for any
        // of them would silently relax the rubric.
        if (config.rule === "R3" && overriddenRequirementIds.has(parsed.target)) {
            continue;
        }

        if (config.rule === "R2") {
            const score = entry.value as number;
            const story = input.stories.find((s) => s.id === parsed.target);
            if (score >= t.r2SuggestionBelow) continue;
            const severity: FindingSeverity =
                score < t.r2ImportantBelow ? "important" : "suggestion";
            // Ratchet key is content-hashed (issue #46, 2026-09-24) so
            // that reordering or paraphrasing the story checks across
            // rounds does NOT reset the per-point failure counter. The
            // hash is over the joined story checks text only — same
            // checks ⇒ same key ⇒ ratchet continues to fire when the
            // same coverage gap survives a revision. `failedPoints`
            // carries the identity-only form (no positional prefix);
            // `pointId` keeps the positional context for human logs.
            const storyChecks = story?.checks?.join("|") ?? "";
            const identityKey = `R2-${shortHash(`R2|${storyChecks}`)}`;
            failedPoints.push(identityKey);
            const pointId = `R2-${parsed.target}-${shortHash(`R2|${storyChecks}`)}`;
            findings.push({
                pointId,
                rule: "R2",
                ruleId: config.ruleId,
                severity,
                summary:
                    `Acceptance criteria do not fully cover story ${parsed.target}` +
                    (story?.title ? ` ("${story.title}")` : "") +
                    ` — every check the story promises must have an AC with matching quantifiers and scope` +
                    ` (coverage score ${score.toFixed(2)}).`,
                requirementIds: [parsed.target],
                measured: score,
            });
            reasons.push(`R2: ${parsed.target} coverage ${score.toFixed(2)} → ${severity}`);
            continue;
        }

        // noul rules
        const p = entry.confidence; // adapter routes the raw probability here
        const failed =
            config.polarity === "positive" ? p < t.noulMin : p >= 1 - t.noulMin;
        if (!failed) continue;

        // Identity-hash the point id so the ratchet tracks the same
        // defect across rounds regardless of positional reordering.
        // The hash is over (rule, natural-language content) only — NOT
        // the positional target — so VP-1 and VP-2 with the same text
        // collapse to the same ratchet key. Two surfaces:
        //
        //   - `failedPoints` carries just the identity hash. The
        //     ratchet (`updateRubricFailureCounts`) keys off this so
        //     positional renumbering does NOT reset the counter.
        //   - `findings[].pointId` keeps the positional context
        //     (`R3-VP-2-<hash>`) so logs and external grep on
        //     `R3-VP-N` still find the current row.
        const targetText = targetTextForRule(config.rule, parsed.target, input, previousById);
        const previous = config.rule === "R7" ? previousById.get(parsed.target) : undefined;
        const identityKey = previous?.identityKey ?? `${config.rule}-${shortHash(`${config.rule}|${targetText}`)}`;
        failedPoints.push(identityKey);
        const pointId = `${config.rule}-${parsed.target}-${shortHash(`${config.rule}|${targetText}`)}`;

        if (config.rule === "R7") {
            const prev = previousById.get(parsed.target);
            const severity = prev?.severity ?? config.severity;
            // validateFinding contract: a blocking finding must carry at
            // least one requirementId. Carried requirementIds are usually
            // non-empty, but synthesised veto findings (orchestrator
            // `TYPESAFE-N`) are blocking with `requirementIds: []` — fall
            // back to the rubric target id so the carried finding stays
            // valid.
            const carried = prev ? [...prev.requirementIds] : [];
            const requirementIds =
                severity === "blocking" && carried.length === 0
                    ? [parsed.target]
                    : carried;
            findings.push({
                pointId,
                rule: "R7",
                ruleId: config.ruleId,
                severity,
                summary:
                    `Unresolved from the previous review round: ${prev?.summary ?? parsed.target}` +
                    ` (resolution probability ${p.toFixed(2)}). The revision must demonstrably remove this defect.`,
                requirementIds,
                carriedFindingId: prev?.findingId,
                measured: p,
                identityKey,
            });
            reasons.push(`R7: ${parsed.target} unresolved (p=${p.toFixed(2)}, severity ${severity})`);
            continue;
        }

        findings.push({
            pointId,
            rule: config.rule,
            ruleId: config.ruleId,
            severity: config.severity,
            summary: rubricSummary(config.rule, parsed.target, p, input),
            requirementIds: [parsed.target],
            measured: p,
            identityKey,
        });
        reasons.push(`${config.rule}: ${parsed.target} failed (p=${p.toFixed(2)})`);
    }

    const blocking = findings.some(
        (f) => f.severity === "blocking" || f.severity === "important",
    );
    return {
        verdict: blocking ? "reject" : "pass",
        findings,
        reasons,
        failedPoints: uniqueStable(failedPoints),
    };
}

/**
 * Stable 16-hex-char content hash used in the ratchet point id.
 * 16 hex chars = 64 bits — more than enough collision resistance for
 * the ratchet's bounded per-issue counter map (<< 100 entries per
 * round, << 10⁴ rounds).
 */
function shortHash(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Deduplicate `failedPoints` while preserving order. Two positions
 * that hash to the same identity key (issue #46, 2026-09-24) would
 * otherwise double-count under `updateRubricFailureCounts`.
 */
function uniqueStable<T>(items: ReadonlyArray<T>): T[] {
    const seen = new Set<T>();
    const out: T[] = [];
    for (const item of items) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

/**
 * Pull the natural-language content for a given rubric target so the
 * ratchet point id tracks the same defect across rounds. Falls back
 * to the target id when no text is associated (e.g. R4/R5/R6 don't
 * have meaningful identity beyond the requirement itself, which is
 * already positional — content-hashing those would only add an id-
 * stable suffix without semantic gain).
 */
function targetTextForRule(
    rule: RubricRule,
    target: string,
    input: ReviewRubricInput,
    previousById: Map<string, RubricPreviousFinding>,
): string {
    switch (rule) {
        case "R1":
            return input.acceptanceCriteria.find((x) => x.id === target)?.text ?? target;
        case "R2":
            return input.stories.find((s) => s.id === target)?.checks?.join("|") ?? target;
        case "R3":
            return input.validationPlan.find((x) => x.id === target)?.text ?? target;
        case "R7":
            return previousById.get(target)?.summary ?? target;
        default:
            // R4 / R5 / R6 use the requirement id as identity — the
            // natural-language content for an open question / story /
            // non-goal is the requirement text itself.
            return target;
    }
}

/** Deterministic, code-authored finding summaries (content generation stays mechanical here). */
function rubricSummary(
    rule: RubricRule,
    target: string,
    p: number,
    input: ReviewRubricInput,
): string {
    const itemText = (list: ReadonlyArray<RubricItem>) =>
        list.find((x) => x.id === target)?.text ?? "";
    switch (rule) {
        case "R1":
            return (
                `Acceptance criterion ${target} is not machine-verifiable as written` +
                ` (verifiability p=${p.toFixed(2)}): "${itemText(input.acceptanceCriteria)}".` +
                ` Pin every qualitative term to a concrete value or named token and name the automated check that proves it.`
            );
        case "R3":
            return (
                `Validation plan item ${target} is not a robust CI-runnable check` +
                ` (runnability p=${p.toFixed(2)}): "${itemText(input.validationPlan)}".` +
                ` Name a test file/command whose pass-fail signal cannot false-positive on comments or string literals.`
            );
        case "R4":
            return (
                `Open question ${target} blocks implementation (blocking p=${p.toFixed(2)}):` +
                ` "${itemText(input.openQuestions)}". Either answer it in the spec with a pinned default` +
                ` or surface it to the issue author — it cannot ride along unresolved.`
            );
        case "R5":
            return (
                `Story ${target} is outside the scope the issue asks for (in-scope p=${p.toFixed(2)}).` +
                ` Remove it or record it as a follow-up issue; silent scope additions reject the spec.`
            );
        case "R6":
            return (
                `PRODUCT.md non-goal ${target} is quietly implemented by TECH.md (leak p=${p.toFixed(2)}):` +
                ` "${itemText(input.nonGoals)}". Remove it from the approach or move it into goals via the issue author.`
            );
        default:
            return `Rubric point ${rule}-${target} failed (p=${p.toFixed(2)}).`;
    }
}

/** Split a primitive id (`R1-AC-3`) into rule + target. Null when malformed. */
export function parsePointId(id: string): { rule: RubricRule; target: string } | null {
    const m = /^(R[1-7])-(.+)$/.exec(id);
    if (!m) return null;
    return { rule: m[1] as RubricRule, target: m[2] };
}

/* -------------------------------------------------------------------------- */
/* Convergence ratchet                                                        */
/* -------------------------------------------------------------------------- */

/** Default consecutive-failure limit before deterministic escalation. */
export const RUBRIC_RATCHET_LIMIT = 2;

/**
 * Update per-point consecutive-failure counts and report the points
 * that hit the ratchet limit. Points that passed this round are
 * dropped from the map (a fresh fail later starts at 1 again), so a
 * count of N means exactly "failed N consecutive rounds".
 *
 * Pure; the caller persists the returned `counts` on
 * `state.specRubricFailures`.
 */
export function updateRubricFailureCounts(
    prev: Record<string, number> | undefined,
    failedPoints: ReadonlyArray<string>,
    limit: number = RUBRIC_RATCHET_LIMIT,
): { counts: Record<string, number>; repeated: string[] } {
    const counts: Record<string, number> = {};
    for (const point of failedPoints) {
        counts[point] = (prev?.[point] ?? 0) + 1;
    }
    const repeated = Object.entries(counts)
        .filter(([, count]) => count >= limit)
        .map(([point]) => point)
        .sort();
    return { counts, repeated };
}

/* -------------------------------------------------------------------------- */
/* Review-result synthesis                                                    */
/* -------------------------------------------------------------------------- */

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
    blocking: "CRITICAL",
    important: "IMPORTANT",
    suggestion: "SUGGESTION",
    nit: "NIT",
};

/**
 * Build the `SpecReviewResult` published when the rubric rejects —
 * the LLM review pass is skipped entirely for that round. Shape
 * mirrors the existing typesafe-veto synthesis in the orchestrator
 * (`comments: []`, findings with mechanical summaries) so
 * `publishSpecReviewDecision`, `buildSpecFeedback` and the triage
 * hand-back path all work unchanged.
 */
export function synthesizeRubricReview(
    verdict: SpecRubricVerdict,
    answer: SpecRubricBatchAnswer,
    sourceRunId: string,
    revisionId?: string,
): SpecReviewResult {
    const counts = { CRITICAL: 0, IMPORTANT: 0, SUGGESTION: 0, NIT: 0 };
    for (const draft of verdict.findings) {
        counts[SEVERITY_LABEL[draft.severity] as keyof typeof counts] += 1;
    }
    const body = [
        `Found: ${counts.CRITICAL} critical, ${counts.IMPORTANT} important, ${counts.SUGGESTION} suggestions, ${counts.NIT} nits.`,
        ``,
        ...verdict.findings.map(
            (f) => `- **[${SEVERITY_LABEL[f.severity]}]** — ${f.summary}`,
        ),
        ``,
        `_Verdict produced by the R-series spec-review rubric batch (structured Jev judgment points over the parsed spec); the LLM review pass was skipped for this round._`,
    ].join("\n");

    const findings: Finding[] = verdict.findings.map((draft) =>
        makeFinding({
            ruleId: draft.ruleId,
            severity: draft.severity,
            summary: draft.summary,
            requirementIds: draft.requirementIds,
            evidence: { excerpt: `${draft.pointId} identity=${draft.identityKey ?? draft.pointId} measured=${draft.measured.toFixed(2)}` },
            sourceStage: "review-spec",
            sourceRunId,
        }),
    );

    const review: SpecReviewResult = {
        verdict: "REJECT",
        body,
        comments: [],
        notes: verdict.reasons.length
            ? `rubric reasons:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`
            : "",
        findings,
        confidence: answer.meanConfidence,
        rubricBatch: answer,
    };
    if (revisionId) review.revisionId = revisionId;
    return review;
}

/* -------------------------------------------------------------------------- */
/* Parser (wire → answers)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map the adapter's `structuredOutput` (`[{id, value, confidence}]`)
 * into a `SpecRubricBatchAnswer`. Tolerant like the B-series parsers:
 * a malformed entry is dropped, never fatal; `null` only when nothing
 * usable came back (the caller then falls back to the LLM-only path).
 *
 * Value contract per rule kind:
 *   - noul  → boolean value + raw yes-probability on the confidence channel
 *   - score → numeric 0..1 value + distribution confidence
 */
export function parseRubricAnswer(structuredOutput: unknown, expectedIds?: ReadonlyArray<string>): SpecRubricBatchAnswer | null {
    if (!Array.isArray(structuredOutput) || structuredOutput.length === 0) {
        return null;
    }
    const entries: SpecRubricAnswerEntry[] = [];
    let confidenceSum = 0;
    for (const raw of structuredOutput) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        if (typeof row.id !== "string") continue;
        const parsed = parsePointId(row.id);
        if (!parsed) continue;
        const config = RULE_BY_ID.get(parsed.rule);
        if (!config) continue;
        if (typeof row.confidence !== "number") continue;
        if (config.kind === "noul") {
            if (typeof row.value !== "boolean") continue;
            entries.push({
                id: row.id,
                rule: parsed.rule,
                target: parsed.target,
                value: row.value,
                confidence: row.confidence,
            });
        } else {
            if (typeof row.value !== "number") continue;
            entries.push({
                id: row.id,
                rule: parsed.rule,
                target: parsed.target,
                value: row.value,
                confidence: row.confidence,
            });
        }
        confidenceSum += row.confidence;
    }
    if (entries.length === 0) return null;
    if (expectedIds) {
        const received = new Set(entries.map((entry) => entry.id));
        if (received.size !== entries.length || received.size !== expectedIds.length
            || expectedIds.some((id) => !received.has(id))) return null;
    }
    return { entries, meanConfidence: confidenceSum / entries.length };
}
