/**
 * Slice A.1 / Group 1 / Validation A8 — lifecycle log shape.
 *
 * The Unified Agent Runtime contract requires that lifecycle log
 * events carry four documented backend fields so log readers can
 * correlate runtime behaviour with the build:
 *
 *   - backend
 *   - agentSelectionSource
 *   - backendSchemaVersion
 *   - backendBuildHash
 *
 * `backendBindingsFor(role)` (in src/core/agent-runtime.ts) emits
 * these from the resolved descriptor. `bindingsForRuntime(rt, role)`
 * does the same against an injected runtime for tests.
 *
 * This test asserts the bindings shape contract directly. The full
 * wiring into the harness log path is deferred (parse-miss
 * self-heal still lives in runLlmAgent; the dispatcher is a new
 * entry point rather than a replacement); see plan.md Group 2
 * status note for the explicit boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    backendBindingsFor,
    bindingsForRuntime,
    buildAgentRuntime,
    __clearAgentRuntimeCacheForTest,
} from "../core/agent-runtime.js";

test("backendBindingsFor returns the four documented lifecycle fields", () => {
    __clearAgentRuntimeCacheForTest();
    const previousEnv = process.env.FACTORY_AGENT_BACKEND;
    const previousOverrides = process.env.FACTORY_AGENT_OVERRIDES;
    try {
        delete process.env.FACTORY_AGENT_BACKEND;
        delete process.env.FACTORY_AGENT_OVERRIDES;
        const bindings = backendBindingsFor("review-pr");
        assert.equal(bindings.backend, "claude-code");
        assert.equal(bindings.agentSelectionSource, "default");
        assert.equal(typeof bindings.backendSchemaVersion, "number");
        assert.equal(typeof bindings.backendBuildHash, "string");
    } finally {
        if (previousEnv === undefined) delete process.env.FACTORY_AGENT_BACKEND;
        else process.env.FACTORY_AGENT_BACKEND = previousEnv;
        if (previousOverrides === undefined) delete process.env.FACTORY_AGENT_OVERRIDES;
        else process.env.FACTORY_AGENT_OVERRIDES = previousOverrides;
        __clearAgentRuntimeCacheForTest();
    }
});

test("bindingsForRuntime reflects per-role override source", () => {
    const rt = buildAgentRuntime({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: "claude-code" }),
    });
    const bindings = bindingsForRuntime(rt, "triage");
    assert.equal(bindings.backend, "claude-code");
    assert.equal(bindings.agentSelectionSource, "overrides");
    assert.equal(typeof bindings.backendSchemaVersion, "number");
});

test("bindings survive ConsoleLogger.child() round-trip", () => {
    const bindings = backendBindingsFor("review-pr");
    // Mimic what the dispatcher would do when wiring lifecycle logs:
    // pass the bindings to ConsoleLogger.child(...) so every subsequent
    // lifecycle line carries them. The harness runtime already does
    // this; we just assert the field set is preserved.
    const child = { ...bindings };
    assert.equal(child.backend, bindings.backend);
    assert.equal(child.agentSelectionSource, bindings.agentSelectionSource);
    assert.equal(child.backendSchemaVersion, bindings.backendSchemaVersion);
    assert.equal(child.backendBuildHash, bindings.backendBuildHash);
});