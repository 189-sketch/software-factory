/**
 * Acceptance test for `src/core/spec-verdict.ts::deriveReviewVerdict`.
 *
 * Covers the review-spec typesafe veto contract:
 *
 *   - batch undefined                          → passthrough reviewer verdict
 *   - b4 REJECT vs reviewer APPROVE            → finalVerdict REJECT (record dissent)
 *   - b4 APPROVE vs reviewer REJECT + blocking → keep reviewer REJECT (record dissent)
 *   - b4.confidence < 0.6 + APPROVE            → fall back to reviewer verdict
 *   - B5 escalates non-blocking → blocking     → REJECT + severityOverride recorded
 *   - B5 downgrades blocking → nit + no other blocking → APPROVE
 *   - B5 missing for a findingId               → severity unchanged
 *
 * These tests fail until `src/core/spec-verdict.ts` is implemented (TDD red).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveReviewVerdict } from "../core/spec-verdict.js";
import type {
    ReviewSpecTypesafeBatchAnswer,
    SpecReviewResult,
    Finding,
} from "../core/types.js";

function makeReview(overrides: Partial<SpecReviewResult> = {}): SpecReviewResult {
    return {
        verdict: "APPROVE",
        body: "",
        comments: [],
        findings: [],
        ...overrides,
    } as SpecReviewResult;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
        id: "F-1",
        ruleId: "R-1",
        severity: "suggestion",
        summary: "Test finding",
        requirementIds: [],
        evidence: {},
        ...overrides,
    } as Finding;
}

for (const confidence of [0.62, 0.99]) test(`spec gate: B4 rejection at ${confidence} cannot block a nit-only review`, () => {
    const review = makeReview({ findings: [makeFinding({ severity: 'nit' })] });
    const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'REJECT', confidence },
        b5: [], meanConfidence: confidence };
    const out = deriveReviewVerdict(review, batch, { requireBlockingEvidence: true });
    assert.equal(out.verdict, 'APPROVE');
    assert.match(out.reasons.join(' '), /no.*blocking/i);
});

test('spec gate: important findings remain blocking even when B4 approves', () => {
    const review = makeReview({ verdict: 'REJECT', findings: [makeFinding({ severity: 'important' })] });
    const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'APPROVE', confidence: 0.99 }, b5: [], meanConfidence: 0.99 };
    assert.equal(deriveReviewVerdict(review, batch, { requireBlockingEvidence: true }).verdict, 'REJECT');
});

test('spec gate: B5 cannot silently erase a reviewer blocker', () => {
    const review = makeReview({ verdict: 'REJECT', findings: [makeFinding({ severity: 'blocking' })] });
    const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'APPROVE', confidence: 0.99 },
        b5: [{ id: 'B5-F-1', findingId: 'F-1', value: 'nit', confidence: 0.99 }], meanConfidence: 0.99 };
    const out = deriveReviewVerdict(review, batch, { requireBlockingEvidence: true });
    assert.equal(out.verdict, 'REJECT');
    assert.equal(out.severityOverrides.has('F-1'), false);
});

test('spec gate: a located but low-confidence B5 promotion stays advisory', () => {
    const review = makeReview({ findings: [makeFinding({ severity: 'nit', evidence: { path: 'TECH.md', line: 60 } })] });
    const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'REJECT', confidence: 0.62 },
        b5: [{ id: 'B5-F-1', findingId: 'F-1', value: 'important', confidence: 0.62 }], meanConfidence: 0.62 };
    const out = deriveReviewVerdict(review, batch, { requireBlockingEvidence: true, exploreBlockFloor: 0.9 });
    assert.equal(out.verdict, 'APPROVE');
    assert.equal(out.severityOverrides.size, 0);
});

test('spec gate: resolved findings cannot support a B4 veto', () => {
    const review = makeReview({ findings: [makeFinding({ severity: 'blocking', status: 'resolved' })] });
    const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'REJECT', confidence: 0.99 }, b5: [], meanConfidence: 0.99 };
    assert.equal(deriveReviewVerdict(review, batch, { requireBlockingEvidence: true }).verdict, 'APPROVE');
});

for (const evidence of [{}, { path: 'specs/issue-72/TECH.md', line: 60 }]) {
    test(`spec gate: B5 escalation requires a located current finding (${Boolean(evidence.line)})`, () => {
        const review = makeReview({ findings: [makeFinding({ severity: 'nit', evidence })] });
        const batch: ReviewSpecTypesafeBatchAnswer = { b4: { id: 'B4', value: 'APPROVE', confidence: 0.99 },
            b5: [{ id: 'B5-F-1', findingId: 'F-1', value: 'important', confidence: 0.99 }], meanConfidence: 0.99 };
        assert.equal(deriveReviewVerdict(review, batch, { requireBlockingEvidence: true }).verdict,
            evidence.line ? 'REJECT' : 'APPROVE');
    });
}

test("deriveReviewVerdict: batch undefined → passthrough reviewer verdict with reason typesafe-unavailable", () => {
    const review = makeReview({ verdict: "REJECT" });
    const out = deriveReviewVerdict(review, undefined);
    assert.equal(out.verdict, "REJECT");
    assert.deepEqual(out.reasons, ["typesafe-unavailable"]);
    assert.deepEqual([...out.severityOverrides.entries()], []);
});

test("deriveReviewVerdict: b4 REJECT vs reviewer APPROVE, conf ≥ 0.6 → REJECT + dissent recorded", () => {
    const review = makeReview({ verdict: "APPROVE" });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "REJECT", confidence: 0.85 },
        b5: [],
        meanConfidence: 0.85,
    };
    const out = deriveReviewVerdict(review, batch);
    assert.equal(out.verdict, "REJECT");
    assert.ok(
        out.reasons.some((r) => r.includes("B4") && r.includes("typesafe REJECT") && r.includes("reviewer APPROVE")),
        `expected B4 dissent reason; got ${JSON.stringify(out.reasons)}`
    );
});

test("deriveReviewVerdict: b4 APPROVE vs reviewer REJECT + blocking finding → keep REJECT + record dissent", () => {
    const review = makeReview({
        verdict: "REJECT",
        findings: [makeFinding({ id: "F-1", severity: "blocking" })],
    });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "APPROVE", confidence: 0.7 },
        b5: [{ id: "B5-F-1", findingId: "F-1", value: "blocking", confidence: 0.9 }],
        meanConfidence: 0.8,
    };
    const out = deriveReviewVerdict(review, batch);
    assert.equal(out.verdict, "REJECT");
    assert.ok(
        out.reasons.some((r) => r.includes("typesafe APPROVE") && r.includes("reviewer REJECT")),
        `expected B4 dissent reason; got ${JSON.stringify(out.reasons)}`
    );
});

test("deriveReviewVerdict: B5 escalates suggestion → blocking → REJECT + severityOverride", () => {
    const review = makeReview({
        verdict: "APPROVE",
        findings: [makeFinding({ id: "F-1", severity: "suggestion" })],
    });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "APPROVE", confidence: 0.9 },
        b5: [{ id: "B5-F-1", findingId: "F-1", value: "blocking", confidence: 0.85 }],
        meanConfidence: 0.88,
    };
    const out = deriveReviewVerdict(review, batch);
    assert.equal(out.verdict, "REJECT");
    assert.equal(out.severityOverrides.get("F-1"), "blocking");
    assert.ok(
        out.reasons.some((r) => r.includes("escalated to blocking")),
        `expected escalation reason; got ${JSON.stringify(out.reasons)}`
    );
});

test("deriveReviewVerdict: B5 downgrades blocking → nit + no other blocking → APPROVE", () => {
    const review = makeReview({
        verdict: "REJECT",
        findings: [makeFinding({ id: "F-1", severity: "blocking" })],
    });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "APPROVE", confidence: 0.85 },
        b5: [{ id: "B5-F-1", findingId: "F-1", value: "nit", confidence: 0.8 }],
        meanConfidence: 0.83,
    };
    const out = deriveReviewVerdict(review, batch);
    assert.equal(out.verdict, "APPROVE");
    assert.equal(out.severityOverrides.get("F-1"), "nit");
});

test("deriveReviewVerdict: b4.confidence < 0.6 + APPROVE → fall back to reviewer verdict", () => {
    const review = makeReview({ verdict: "REJECT" });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "APPROVE", confidence: 0.4 },
        b5: [],
        meanConfidence: 0.4,
    };
    const out = deriveReviewVerdict(review, batch);
    // low confidence → trust reviewer; reviewer said REJECT → final is REJECT
    assert.equal(out.verdict, "REJECT");
    assert.ok(
        out.reasons.some((r) => r.includes("confidence") && r.includes("falling back")),
        `expected fallback reason; got ${JSON.stringify(out.reasons)}`
    );
});

test("deriveReviewVerdict: B5 missing for a findingId → severity unchanged", () => {
    const review = makeReview({
        verdict: "APPROVE",
        findings: [makeFinding({ id: "F-1", severity: "important" })],
    });
    const batch: ReviewSpecTypesafeBatchAnswer = {
        b4: { id: "B4", value: "APPROVE", confidence: 0.9 },
        b5: [], // no entry for F-1
        meanConfidence: 0.9,
    };
    const out = deriveReviewVerdict(review, batch);
    assert.equal(out.verdict, "APPROVE");
    assert.equal(out.severityOverrides.has("F-1"), false);
});
