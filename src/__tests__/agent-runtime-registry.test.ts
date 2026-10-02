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

test("default backend is `claude-code` when FACTORY_AGENT_BACKEND is unset", () => {
  const rt = runtimeWith({});
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "claude-code");
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
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": { backend: "claude-code", model: "override-model" } }),
  });
  const resolved = rt.selectBackend("review-pr");
  assert.equal(resolved.selection.backend, "claude-code");
  assert.equal(resolved.selection.model, "override-model");
  assert.equal(resolved.log.source, "overrides");
  assert.deepEqual(resolved.log.override, { backend: "claude-code", model: "override-model" });
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

test("unsupported backend selections fail before stage dispatch", () => {
  for (const backend of ["codex-cli", "pi-cli", "typesafe", "embedded"]) {
    assert.throws(() => runtimeWith({ FACTORY_AGENT_BACKEND: backend }), /Invalid FACTORY_AGENT backend/);
    assert.throws(() => runtimeWith({ FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: backend }) }), /Invalid FACTORY_AGENT backend/);
  }
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
    () => runtimeWith({ FACTORY_AGENT_OVERRIDES: JSON.stringify({ "made-up-role": "claude-code" }) }),
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
  const ids = ["claude-code"] as const;
  for (const id of ids) {
    const descriptor = rt.describeBackend(id);
    assert.equal(descriptor.id, id);
    assert.equal(typeof descriptor.displayName, "string");
    assert.ok(descriptor.displayName.length > 0);
    assert.equal(typeof descriptor.schemaVersion, "number");
    assert.equal(typeof descriptor.buildHash, "string");
    assert.ok(descriptor.buildHash.length > 0);
  }
  // Slice C removed the embedded backend; claude-code is the only
  // registered backend that serves every role.
  assert.equal(rt.describeBackend("claude-code").capabilities.readOnly, true);
  assert.equal(rt.describeBackend("claude-code").capabilities.mutating, undefined);
});

test("describeBackend rejects unknown ids", () => {
  const rt = runtimeWith({});
  assert.throws(
    () => rt.describeBackend("bogus" as unknown as "claude-code"),
    /Unknown agent backend/,
  );
});

test("runStage routes the default backend through the dispatcher", async () => {
  const rt = runtimeWith({ FACTORY_CLAUDE_COMMAND: 'factory-test-missing-claude-cli' });
  const minimalCtx = {
    issue: { number: 1, title: "x", body: "", labels: [], comments: [] },
    repo: { workdir: "/tmp" },
    logger: {
      info() {}, warn() {}, error() {}, debug() {}, child() { return this; },
    },
    correction: undefined,
    skills: [],
  } as unknown as import("../core/types.js").AgentContext;
  const result = await rt.runStage({
    role: "review-pr",
    runId: "test-run",
    issue: { number: 1, repo: { workdir: "/tmp" } },
    inputManifest: { systemPrompt: "you are a test agent", messages: [{ role: "user" as const, content: "say ok" }] },
  }, minimalCtx);
  assert.equal(result.status, 'failed', 'Missing CLI must surface a failed dispatch without using a real model');
  assert.equal(result.backend, "claude-code");
  assert.equal(typeof result.warnings, "object");
  assert.ok(Array.isArray(result.warnings));
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
    FACTORY_AGENT_OVERRIDES: JSON.stringify({ triage: { backend: "claude-code", model: "override-model" } }),
  });
  const bindings = bindingsForRuntime(rt, "triage");
  assert.equal(bindings.backend, "claude-code");
  assert.equal(bindings.agentSelectionSource, "overrides");
});
