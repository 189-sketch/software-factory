/**
 * Acceptance test for `src/core/spec-verdict.ts::deriveSpecVerdict`.
 *
 * Covers the spec typesafe veto contract:
 *
 *   - typesafe unavailable (batch undefined)  → pass-through (claude-code verdict)
 *   - all gates pass                           → "pass"
 *   - B2 completeness below 0.60 on any AC     → "needs-revision" target "spec-tech"
 *   - B3 unverifiable (value === false) on any AC → "needs-revision" target "spec-tech"
 *   - B1 missing/empty/non-string             → "needs-revision" target "spec-product"
 *   - multiple triggers                       → all reasons aggregated, B1 wins targetStage
 *
 * These tests fail until `src/core/spec-verdict.ts` is implemented (TDD red).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveSpecVerdict } from "../core/spec-verdict.js";
import type { SpecPair, SpecTypesafeBatchAnswer } from "../core/types.js";

/** Minimal SpecPair factory — only fields the function reads. */
function makeSpec(overrides: Partial<SpecPair> = {}): SpecPair {
    return {
        product: { body: "PRODUCT body", acceptanceCriteria: ["AC-1", "AC-2"] } as SpecPair["product"],
        tech: { body: "TECH body" } as SpecPair["tech"],
        specBranch: "spec/issue-1-foo",
        specPrUrl: "",
        ...overrides,
    } as SpecPair;
}

/** Build a passing typesafe batch (all gates green). */
function passingBatch(): SpecTypesafeBatchAnswer {
    return {
        b1: { id: "B1", value: "PRODUCT+TECH", confidence: 0.95 },
        b2: [
            { id: "B2-AC-1", acId: "AC-1", value: 0.9, confidence: 0.9 },
            { id: "B2-AC-2", acId: "AC-2", value: 0.85, confidence: 0.85 },
        ],
        b3: [
            { id: "B3-AC-1", acId: "AC-1", value: true, confidence: 0.9 },
            { id: "B3-AC-2", acId: "AC-2", value: true, confidence: 0.85 },
        ],
        meanConfidence: 0.9,
    };
}

test("deriveSpecVerdict: typesafe unavailable → passthrough pass with reason typesafe-unavailable", () => {
    const spec = makeSpec(); // no typesafeBatch
    const out = deriveSpecVerdict(spec, undefined);
    assert.equal(out.verdict, "pass");
    assert.deepEqual(out.reasons, ["typesafe-unavailable"]);
    assert.equal(out.targetStage, undefined);
});

test("deriveSpecVerdict: all primitives above thresholds → pass with reason all typesafe gates passed", () => {
    const spec = makeSpec({ typesafeBatch: passingBatch() });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "pass");
    assert.deepEqual(out.reasons, ["all typesafe gates passed"]);
    assert.equal(out.targetStage, undefined);
});

test("deriveSpecVerdict: B2 below threshold for one AC → needs-revision target spec-tech", () => {
    const batch = passingBatch();
    batch.b2[0] = { id: "B2-AC-1", acId: "AC-1", value: 0.4, confidence: 0.85 };
    const spec = makeSpec({ typesafeBatch: batch });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "needs-revision");
    assert.ok(
        out.reasons.some((r) => r.includes("B2") && r.includes("AC-1")),
        `expected a B2 reason naming AC-1; got ${JSON.stringify(out.reasons)}`
    );
    assert.equal(out.targetStage, "spec-tech");
});

test("deriveSpecVerdict: B3 unverifiable (value === false) → needs-revision target spec-tech", () => {
    const batch = passingBatch();
    batch.b3[0] = { id: "B3-AC-1", acId: "AC-1", value: false, confidence: 0.85 };
    const spec = makeSpec({ typesafeBatch: batch });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "needs-revision");
    assert.ok(
        out.reasons.some((r) => r.includes("B3") && r.includes("AC-1")),
        `expected a B3 reason naming AC-1; got ${JSON.stringify(out.reasons)}`
    );
    assert.equal(out.targetStage, "spec-tech");
});

test("deriveSpecVerdict: B1 missing/empty value → needs-revision target spec-product", () => {
    const batch = passingBatch();
    batch.b1 = { id: "B1", value: "", confidence: 0.9 };
    const spec = makeSpec({ typesafeBatch: batch });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "needs-revision");
    assert.ok(
        out.reasons[0]?.startsWith("B1"),
        `expected first reason to start with B1; got ${JSON.stringify(out.reasons)}`
    );
    assert.equal(out.targetStage, "spec-product");
});

test("deriveSpecVerdict: multiple triggers → all reasons aggregated, B1 wins targetStage", () => {
    const batch = passingBatch();
    batch.b1 = { id: "B1", value: "", confidence: 0.9 };
    batch.b2[0] = { id: "B2-AC-1", acId: "AC-1", value: 0.3, confidence: 0.85 };
    batch.b3[1] = { id: "B3-AC-2", acId: "AC-2", value: false, confidence: 0.85 };
    const spec = makeSpec({ typesafeBatch: batch });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "needs-revision");
    // three triggers → three reasons
    assert.equal(out.reasons.length, 3, `expected 3 reasons; got ${JSON.stringify(out.reasons)}`);
    assert.ok(out.reasons.some((r) => r.startsWith("B1")));
    assert.ok(out.reasons.some((r) => r.startsWith("B2")));
    assert.ok(out.reasons.some((r) => r.startsWith("B3")));
    // B1 trigger forces targetStage === "spec-product"
    assert.equal(out.targetStage, "spec-product");
});

test("deriveSpecVerdict: batch present with malformed b1 (value undefined) → needs-revision target spec-product", () => {
    const batch = passingBatch();
    // @ts-expect-error — intentionally malformed to test validator behavior
    batch.b1 = { id: "B1", confidence: 0.9 };
    const spec = makeSpec({ typesafeBatch: batch });
    const out = deriveSpecVerdict(spec, spec.typesafeBatch);
    assert.equal(out.verdict, "needs-revision");
    assert.equal(out.targetStage, "spec-product");
});