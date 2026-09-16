/**
 * Slice A.1 / Group 1 / Task 1.5 — agent-runtime registry contract tests.
 *
 * The dispatcher (`src/core/agent-runtime.ts`) must:
 *   - resolve `embedded` by default (FACTORY_AGENT_BACKEND unset);
 *   - surface FACTORY_AGENT_OVERRIDES provenance as `source: "overrides"`
 *     and keep FACTORY_AGENT_BACKEND out of the picture for overridden
 *     roles;
 *   - reject unknown FACTORY_AGENT_BACKEND values with a startup
 *     pre-check error (same severity as the F01 `load_skill` lesson);
 *   - reject malformed FACTORY_AGENT_OVERRIDES JSON at startup;
 *   - surface all four registered backends with stable descriptors
 *     and the documented capability flags.
 *
 * The test reaches the runtime helpers via the public facade so the
 * public contract — not the internals — is locked in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  backendBindingsFor,
  bindingsForRuntime,
  buildAgentRuntime,
  __clearAgentRuntimeCacheForTest,
  type AgentRuntime,
} from "../core/agent-runtime.js";

function runtimeWith(env: Record<string, string | undefined>): AgentRuntime {
  return buildAgentRuntime(env as NodeJS.ProcessEnv);
}

test("default backend is `embedded` when FACTORY_AGENT_BACKEND is unset", () => {
  const rt = runtimeWith({});
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "embedded");
  assert.equal(resolved.log.source, "default");
  assert.equal(resolved.log.override, undefined);
});

test("FACTORY_AGENT_BACKEND=claude-code is honoured for non-overridden roles", () => {
  const rt = runtimeWith({ FACTORY_AGENT_BACKEND: "claude-code" });
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "claude-code");
  assert.equal(resolved.log.source, "default");
});

test("FACTORY_AGENT_OVERRIDES takes precedence over FACTORY_AGENT_BACKEND", () => {
  const rt = runtimeWith({
    FACTORY_AGENT_BACKEND: "claude-code",
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "embedded" }),
  });
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "embedded");
  assert.equal(resolved.log.source, "overrides");
  assert.deepEqual(resolved.log.override, { backend: "embedded" });
});

test("FACTORY_AGENT_OVERRIDES carries the optional model field", () => {
  const rt = runtimeWith({
    FACTORY_AGENT_OVERRIDES: JSON.stringify({
      "review-pr": { backend: "claude-code", model: "claude-sonnet-test" },
    }),
  });
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "claude-code");
  assert.equal(resolved.selection.model, "claude-sonnet-test");
  assert.equal(resolved.log.source, "overrides");
});

test("overridden roles do not leak the FACTORY_AGENT_BACKEND default", () => {
  const rt = runtimeWith({
    FACTORY_AGENT_BACKEND: "codex-cli",
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: "embedded" }),
  });
  assert.equal(rt.selectBackend("triage").selection.backend, "embedded");
  assert.equal(rt.selectBackend("implementation").selection.backend, "codex-cli");
});

test("unknown FACTORY_AGENT_BACKEND values fail at startup", () => {
  assert.throws(
    () => runtimeWith({ FACTORY_AGENT_BACKEND: "bogus-backend" }),
    /Invalid FACTORY_AGENT backend/,
  );
});

test("malformed FACTORY_AGENT_OVERRIDES JSON fails at startup", () => {
  assert.throws(
    () => runtimeWith({ FACTORY_AGENT_OVERRIDES: "not-json{" }),
    /Invalid FACTORY_AGENT_OVERRIDES/,
  );
});

test("FACTORY_AGENT_OVERRIDES with an unknown role fails at startup", () => {
  assert.throws(
    () => runtimeWith({ FACTORY_AGENT_OVERRIDES: JSON.stringify({ "made-up-role": "embedded" }) }),
    /Invalid FACTORY_AGENT_OVERRIDES role/,
  );
});

test("FACTORY_AGENT_OVERRIDES with an unknown backend value fails at startup", () => {
  assert.throws(
    () => runtimeWith({ FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: "bogus" }) }),
    /Invalid FACTORY_AGENT backend/,
  );
});

test("descriptors cover every registered backend with stable capabilities", () => {
  const rt = runtimeWith({});
  const ids = ["embedded", "claude-code", "codex-cli", "pi-cli"] as const;
  for (const id of ids) {
    const descriptor = rt.describeBackend(id);
    assert.equal(descriptor.id, id);
    assert.equal(typeof descriptor.displayName, "string");
    assert.ok(descriptor.displayName.length > 0);
    assert.equal(typeof descriptor.schemaVersion, "number");
    assert.equal(typeof descriptor.buildHash, "string");
    assert.ok(descriptor.buildHash.length > 0);
  }
  // embedded is the only backend that may advertise mutating/publishing
  // capabilities in this slice; CLI backends are read-only-first.
  assert.equal(rt.describeBackend("embedded").capabilities.readOnly, true);
  assert.equal(rt.describeBackend("embedded").capabilities.mutating, true);
  assert.equal(rt.describeBackend("claude-code").capabilities.readOnly, true);
  assert.equal(rt.describeBackend("claude-code").capabilities.mutating, undefined);
  assert.equal(rt.describeBackend("codex-cli").capabilities.readOnly, true);
  assert.equal(rt.describeBackend("pi-cli").capabilities.readOnly, true);
});

test("describeBackend rejects unknown ids", () => {
  const rt = runtimeWith({});
  assert.throws(
    () => rt.describeBackend("bogus" as unknown as "embedded"),
    /Unknown agent backend/,
  );
});

test("runStage is an honest stub in Slice A.1 (embedded lands in Group 2)", async () => {
  const rt = runtimeWith({});
  const result = await rt.runStage({
    role: "review-pr",
    runId: "test-run",
    issue: { number: 1, repo: { workdir: "/tmp" } },
    inputManifest: { systemPrompt: "x", userPrompt: "y" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.backend, "embedded");
  assert.equal(result.usage, null);
  assert.ok(
    result.warnings.some((w) => /HarnessLlmEngine/.test(w)),
    "embedded stub must point the caller at the HarnessLlmEngine wiring",
  );
});

test("runStage returns the documented stub for unimplemented backends", async () => {
  const rt = runtimeWith({ FACTORY_AGENT_BACKEND: "codex-cli" });
  const result = await rt.runStage({
    role: "review-pr",
    runId: "test-run",
    issue: { number: 1, repo: { workdir: "/tmp" } },
    inputManifest: { systemPrompt: "x", userPrompt: "y" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.backend, "codex-cli");
  assert.ok(
    result.warnings.some((w) => /not implemented in this slice/.test(w)),
    "non-embedded backends must report that the slice does not implement them",
  );
});

test("backendBindingsFor surfaces the four documented lifecycle fields", () => {
  // Use a fresh runtime per test so the default cache does not leak.
  __clearAgentRuntimeCacheForTest();
  const previousEnv = process.env.FACTORY_AGENT_BACKEND;
  const previousOverrides = process.env.FACTORY_AGENT_OVERRIDES;
  try {
    process.env.FACTORY_AGENT_BACKEND = "claude-code";
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

test("bindingsForRuntime marks overrides provenance when an override is in play", () => {
  const rt = runtimeWith({
    FACTORY_AGENT_BACKEND: "claude-code",
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: "embedded" }),
  });
  const bindings = bindingsForRuntime(rt, "triage");
  assert.equal(bindings.backend, "embedded");
  assert.equal(bindings.agentSelectionSource, "overrides");
});