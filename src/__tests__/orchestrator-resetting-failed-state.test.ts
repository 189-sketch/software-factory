/**
 * Acceptance test for `src/core/orchestrator-reset.ts::resetFailedState`.
 *
 * The orchestrator's `runForIssue` early branch (the
 * `orchestrator-resetting-failed-state` log marker) clears the
 * following state when the persisted state is `status === "failed"`:
 *
 *   - `status`                → "waiting"
 *   - `agentFailures`         → 0
 *   - `error`                 → deleted
 *   - `lastFailure`           → deleted (NEW — was missing in pre-fix code)
 *   - `failureCounts`         → empty object (NEW — was missing in pre-fix code)
 *   - `specTypesafeRevisions` → 0 (NEW — was missing in pre-fix code)
 *
 * The reset is extracted into a pure helper so it can be unit-tested
 * without spinning up a full `FactoryOrchestrator`. The orchestrator
 * invokes the helper after reading `state.status === "failed"`.
 *
 * This test fails until `src/core/orchestrator-reset.ts` is implemented
 * (TDD red). The fix for the source bug is in the orchestrator's call
 * site (`src/orchestrator/index.ts:761`); the helper itself is new.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resetFailedState } from "../core/orchestrator-reset.js";
import type { FactoryIssueState } from "../core/types.js";

function makeFailedState(): FactoryIssueState {
    return {
        issue: {
            number: 36,
            title: "ui调整",
            body: "",
            labels: [],
            author: "charlie",
            url: "https://github.com/189-sketch/software-factory-demo/issues/36",
            createdAt: "2026-09-20T09:32:19.000Z",
            comments: [],
        },
        number: 36,
        status: "failed",
        merged: false,
        agentFailures: 3,
        error: "triage-supervisor dispatcher run failed: claude-code exited with code 1",
        lastFailure: {
            stage: "spec",
            class: "AGENT_REASONING",
            message: "Spec review REJECTED: 1 critical",
            at: "2026-09-20T17:38:58.338Z",
        },
        failureCounts: {
            spec: { AGENT_REASONING: 2, CONTRACT_VIOLATION: 1 },
            implementation: { EXECUTOR_CRASH: 1 },
        },
        specTypesafeRevisions: 1,
    } as unknown as FactoryIssueState;
}

test("resetFailedState: clears state.lastFailure", () => {
    const state = makeFailedState();
    resetFailedState(state);
    assert.equal(state.lastFailure, undefined, "expected lastFailure to be cleared");
});

test("resetFailedState: clears state.failureCounts to {}", () => {
    const state = makeFailedState();
    resetFailedState(state);
    assert.deepEqual(state.failureCounts, {}, "expected failureCounts to be empty");
});

test("resetFailedState: resets state.specTypesafeRevisions to 0", () => {
    const state = makeFailedState();
    resetFailedState(state);
    assert.equal(state.specTypesafeRevisions, 0);
});

test("resetFailedState: clears status, agentFailures, error", () => {
    const state = makeFailedState();
    resetFailedState(state);
    assert.equal(state.status, "waiting");
    assert.equal(state.agentFailures, 0);
    assert.equal(state.error, undefined);
});

test("resetFailedState: returns the previous error for log emission", () => {
    const state = makeFailedState();
    const result = resetFailedState(state);
    assert.ok(result !== undefined, "expected previous error to be returned for logging");
    assert.ok(typeof result.previousError === "string");
    assert.ok(result.previousError.includes("claude-code exited with code 1"));
});

test("resetFailedState: idempotent — calling twice does not throw and stays waiting", () => {
    const state = makeFailedState();
    resetFailedState(state);
    resetFailedState(state);
    assert.equal(state.status, "waiting");
});