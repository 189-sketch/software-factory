/**
 * T8.0 acceptance — Register `typesafe` in BACKEND_DESCRIPTORS + agent-backends.mjs.
 *
 * Asserts:
 *   - BACKEND_DESCRIPTORS.typesafe exists with the documented fields.
 *   - resolveAgentConfig({ FACTORY_AGENT_BACKEND: "typesafe" }) succeeds.
 *   - agentWorkerEnvironment forwards TYPESAFE_API_KEY + FACTORY_TYPESAFE_OFF
 *     when typesafe is selected, and never leaks GH_TOKEN.
 *   - unknown FACTORY_AGENT_BACKEND values still fail at startup
 *     (the pre-check is unchanged for unknown backends).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    buildAgentRuntime,
} from "../core/agent-runtime.js";
import {
    resolveAgentConfig,
    agentWorkerEnvironment,
} from "../../runtime/agent-backends.mjs";

function runtimeWith(env: Record<string, string | undefined>) {
    return buildAgentRuntime(env as NodeJS.ProcessEnv);
}

test("BACKEND_DESCRIPTORS registers the typesafe backend with documented fields", () => {
    const rt = runtimeWith({});
    const descriptor = rt.describeBackend("typesafe");
    assert.equal(descriptor.id, "typesafe");
    assert.equal(descriptor.displayName, "typesafe.ai Jev");
    assert.equal(descriptor.capabilities.readOnly, true);
    assert.equal(descriptor.capabilities.mutating, undefined);
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(typeof descriptor.buildHash, "string");
    assert.ok(descriptor.buildHash.length > 0);
});

test("resolveAgentConfig accepts FACTORY_AGENT_BACKEND=typesafe and exposes the typesafe backend row", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
    });
    assert.equal(config.defaultBackend, "typesafe");
    assert.ok(config.backends.typesafe, "typesafe backend row must exist in resolveAgentConfig output");
    assert.equal(typeof config.backends.typesafe.executable, "string");
    assert.ok(config.backends.typesafe.executable.length > 0);
});

test("FACTORY_TYPESAFE_COMMAND overrides the default 'typesafe' executable", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "/opt/typesafe/bin/jev",
    });
    assert.equal(config.backends.typesafe.executable, "/opt/typesafe/bin/jev");
});

test("empty FACTORY_TYPESAFE_COMMAND falls back to the default 'typesafe' executable (matches other CLIs)", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "",
    });
    assert.equal(config.backends.typesafe.executable, "typesafe");
});

test("FACTORY_TYPESAFE_MODEL surfaces on the typesafe backend row", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-fast",
    });
    assert.equal(config.backends.typesafe.model, "jev-fast");
});

test("resolveAgentConfig rejects unknown FACTORY_AGENT_BACKEND values (startup pre-check)", () => {
    assert.throws(
        () => resolveAgentConfig({ FACTORY_AGENT_BACKEND: "typesafe-without-registration" }),
        /Invalid FACTORY_AGENT backend/,
    );
});

test("agentWorkerEnvironment forwards TYPESAFE_API_KEY + FACTORY_TYPESAFE_OFF when typesafe is selected", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "typesafe",
    });
    const env = {
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_TYPESAFE_COMMAND: "typesafe",
        FACTORY_TYPESAFE_MODEL: "jev-fast",
        FACTORY_TYPESAFE_OFF: "1",
        TYPESAFE_API_KEY: "tk_test_secret",
        UNRELATED_OPERATOR_SECRET: "operator-only-token",
        GH_TOKEN: "ghp_should_not_leak",
    };
    const out = agentWorkerEnvironment(env, config);
    assert.equal(out.FACTORY_TYPESAFE_OFF, "1");
    assert.equal(out.FACTORY_TYPESAFE_COMMAND, "typesafe");
    assert.equal(out.FACTORY_TYPESAFE_MODEL, "jev-fast");
    assert.equal(out.TYPESAFE_API_KEY, "tk_test_secret");
    // Secret-leak guard.
    assert.ok(!("GH_TOKEN" in out), "GH_TOKEN leaked to typesafe worker — H-1 regressed");
    assert.ok(!("UNRELATED_OPERATOR_SECRET" in out));
});

test("agentWorkerEnvironment forwards TYPESAFE_API_KEY even when typesafe is not the selected backend (bypass verdict layer)", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "claude-code",
    });
    const env = {
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_verdict_layer",
        GH_TOKEN: "ghp_should_not_leak",
    };
    const out = agentWorkerEnvironment(env, config);
    // Spec 2026-09-21 (issue #36 follow-up): the typesafe verdict layer
    // is an independent judgment bypass, not a per-role backend — the
    // key must reach every worker so triage/spec/review-spec batches
    // can run alongside a claude-code primary backend.
    assert.equal(out.TYPESAFE_API_KEY, "tk_verdict_layer");
    assert.ok(!("GH_TOKEN" in out), "GH_TOKEN leaked — H-1 regressed");
});