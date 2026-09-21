/**
 * Acceptance test for `src/core/routing-decision.ts::decideRouting`.
 *
 * Covers the deterministic failure routing contract that replaces the
 * `triage-supervisor` LLM stage:
 *
 *   - Each of the 9 `FailureClass` values routes to its expected action
 *   - comment always contains the `classified.reason` text
 *   - retry produces a `correction` array
 *   - needs-info / abort do NOT produce a `targetStage`
 *   - counter hits max → needs-info / abort per `defaultAction`
 *
 * These tests fail until `src/core/routing-decision.ts` is implemented (TDD red).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideRouting } from "../core/routing-decision.js";
import type { ClassifiedFailure } from "../core/failure-classifier.js";
import type { FailureClass, PipelineFailure } from "../core/types.js";

function classified(
    cls: FailureClass,
    overrides: Partial<ClassifiedFailure> = {},
): ClassifiedFailure {
    return {
        class: cls,
        confident: true,
        maxAttempts: 1,
        defaultAction: "retry",
        reason: `synthetic reason: ${cls}`,
        ...overrides,
    };
}

function failure(stage: string, message: string = "boom"): PipelineFailure {
    return {
        stage,
        agentName: stage,
        attempt: 1,
        error: message,
        priorEvents: [],
    };
}

test("decideRouting: TRANSIENT → retry with target = lastStage", () => {
    const c = classified("TRANSIENT", { defaultAction: "retry", maxAttempts: 3 });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "retry");
    assert.equal(out.targetStage, "spec");
    assert.ok(out.correction !== undefined && out.correction.length > 0, "expected correction turns");
    assert.ok(out.comment?.includes("attempt"), `comment missing attempt info; got ${out.comment}`);
});

test("decideRouting: AGENT_REASONING (not confident) → retry target = lastStage", () => {
    const c = classified("AGENT_REASONING", { confident: false, defaultAction: "retry", maxAttempts: 2 });
    const out = decideRouting(c, failure("spec"), { spec: { AGENT_REASONING: 1 } } as Record<string, Partial<Record<FailureClass, number>>>, "spec", {
        nextLabel: undefined,
        correction: undefined,
    });
    assert.equal(out.action, "retry");
    assert.equal(out.targetStage, "spec");
});

test("decideRouting: AGENT_REASONING + counter hit max → needs-info", () => {
    const c = classified("AGENT_REASONING", { confident: false, defaultAction: "needs-info", maxAttempts: 2 });
    const out = decideRouting(c, failure("spec"), { spec: { AGENT_REASONING: 2 } } as Record<string, Partial<Record<FailureClass, number>>>, "spec", {
        nextLabel: undefined,
        correction: undefined,
    });
    assert.equal(out.action, "needs-info");
    assert.ok(out.comment?.includes("budget exhausted"), `expected budget message; got ${out.comment}`);
});

test("decideRouting: POLICY_BLOCK (maxAttempts = 0) → needs-info immediately", () => {
    const c = classified("POLICY_BLOCK", { maxAttempts: 0, defaultAction: "needs-info" });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "needs-info");
});

test("decideRouting: PERMANENT → abort, comment mentions operator intervention", () => {
    const c = classified("PERMANENT", { maxAttempts: 0, defaultAction: "abort" });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "abort");
    assert.ok(out.comment?.toLowerCase().includes("operator"), `expected operator msg; got ${out.comment}`);
    assert.equal(out.targetStage, undefined);
});

test("decideRouting: EXECUTOR_CRASH → abort", () => {
    const c = classified("EXECUTOR_CRASH", { defaultAction: "abort", maxAttempts: 2 });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "abort");
});

test("decideRouting: AGENT_FORMAT_ERROR → reroute target = lastStage", () => {
    const c = classified("AGENT_FORMAT_ERROR", { defaultAction: "reroute", maxAttempts: 2 });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "reroute");
    assert.equal(out.targetStage, "spec");
});

test("decideRouting: ENVIRONMENT → abort", () => {
    const c = classified("ENVIRONMENT", { defaultAction: "abort", maxAttempts: 2 });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "abort");
});

test("decideRouting: USER_INPUT_REQUIRED (maxAttempts = 0) → needs-info immediately", () => {
    const c = classified("USER_INPUT_REQUIRED", { maxAttempts: 0, defaultAction: "needs-info" });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.equal(out.action, "needs-info");
});

test("decideRouting: comment always contains classified.reason", () => {
    const c = classified("CONTRACT_VIOLATION", {
        reason: "SpecHashMismatchError: hash differs",
        defaultAction: "needs-info",
        maxAttempts: 2,
    });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.ok(out.comment?.includes("SpecHashMismatchError"), `reason not in comment; got ${out.comment}`);
});

test("decideRouting: retry produces correction array with multiple ordered turns", () => {
    const c = classified("TRANSIENT", { defaultAction: "retry", maxAttempts: 3 });
    const out = decideRouting(c, failure("spec"), {}, "spec", { nextLabel: undefined, correction: undefined });
    assert.ok(Array.isArray(out.correction), "expected correction to be array");
    assert.ok(out.correction!.length >= 2, `expected ≥2 correction turns; got ${out.correction!.length}`);
});