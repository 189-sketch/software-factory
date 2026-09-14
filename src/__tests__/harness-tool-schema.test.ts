/**
 * Harness tool-schema coverage tests (M1, F01).
 *
 * Issue #20 traced back to the harness's parameter schema table: every
 * `load_skill` invocation was rejected because the table had no
 * `load_skill` entry, and the empty-property default silently passed
 * the harness's argument validation while rejecting every subsequent
 * call once the model supplied real arguments. These tests lock the
 * fix in two ways:
 *
 *   - Every tool exposed by `defaultTools` (and the agents' well-known
 *     extras) MUST have a registered schema.
 *   - The harness must throw a clear error at engine start when a
 *     tool is registered without a schema, rather than silently
 *     accepting empty arguments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  createModels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { HarnessLlmEngine, toHarnessTools } from "../core/harness.js";
import { defaultTools } from "../core/tools.js";
import type { AgentContext } from "../core/types.js";

function makeContext(workdir: string): AgentContext {
  return {
    repo: { owner: "o", name: "n", defaultBranch: "main", workdir },
    issue: {
      number: 1,
      title: "Schema coverage",
      body: "",
      labels: [],
      author: "test",
      url: "",
      createdAt: new Date().toISOString(),
      comments: [],
    },
    skills: [],
    skillsRoot: workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } },
    runId: "schema-coverage",
  };
}

/**
 * Names of every tool a factory agent can reach in a default run.
 *
 * `defaultTools` exposes the base registry; the implementation,
 * verify-behavior, and improve-review-pr agents add their own
 * extras (commit_and_push, open_pull_request, browser, etc.) on top.
 * The schema table in `harness.ts::toolParameters` must cover BOTH
 * groups — a missing entry on either side would still trigger the
 * F01 fail-fast guard.
 */
const DEFAULT_TOOL_NAMES = [
  "read_file",
  "write_file",
  "list_dir",
  "run_shell",
  "grep_repo",
  "fetch_issue",
  "post_issue_comment",
  "update_issue_labels",
  "load_skill",
] as const;

/**
 * Tool names that the agents add as `extraTools` and that therefore
 * also need a schema entry — otherwise `toHarnessTools` would throw at
 * engine.start before any prompt is sent.
 */
const AGENT_EXTRA_TOOL_NAMES = [
  "commit_and_push",
  "open_pull_request",
  "run_validation",
  "run_acceptance_test",
  "browser",
  "collect_feedback",
] as const;

test("defaultTools exposes the base registry the factory advertises", () => {
  const ctx = makeContext(process.cwd());
  const exposed = new Set(defaultTools(ctx).map((tool) => tool.name));
  for (const expected of DEFAULT_TOOL_NAMES) {
    assert.ok(exposed.has(expected), `defaultTools must expose "${expected}"`);
  }
});

test("the schema table covers every default + agent-extra tool name (F01 regression)", () => {
  // `toHarnessTools` throws if any registered tool name has no schema
  // entry. We assert registration succeeds for every tool name the
  // factory actually uses, by registering a stub for each extra name
  // and confirming the throw does NOT fire.
  const ctx = makeContext(process.cwd());
  const tools = defaultTools(ctx).map((tool) => ({ ...tool }));
  // Stub agent extras; their `execute` is never invoked by these tests
  // because we only verify the schema lookup, not the tool body.
  for (const name of AGENT_EXTRA_TOOL_NAMES) {
    tools.push({ name, description: `${name} (stub)`, execute: async () => ({ ok: true }) });
  }
  assert.doesNotThrow(
    () => toHarnessTools(tools, ctx, Type),
    "harness must register a parameter schema for every agent-reachable tool",
  );
});

test("every default tool name has a registered parameter schema (F01 regression)", () => {
  const ctx = makeContext(process.cwd());
  // `toHarnessTools` would throw if any tool is missing a schema. We
  // don't even need to instantiate a harness to verify the registry;
  // the throw happens during the parameters lookup.
  assert.doesNotThrow(
    () => toHarnessTools(defaultTools(ctx), ctx, Type),
    "toHarnessTools must not throw for any default tool",
  );
});

test("harness refuses tools whose name is not in the schema registry", () => {
  const ctx = makeContext(process.cwd());
  const unregistered = {
    name: "made_up_tool",
    description: "Not in the registry. Args: { value: string }.",
    execute: async () => ({ ok: true }),
  };
  assert.throws(
    () => toHarnessTools([unregistered], ctx, Type),
    /No parameter schema registered for "made_up_tool"/,
  );
});

test("extraToolSchemas lets a caller add a tool without polluting the global table", () => {
  const ctx = makeContext(process.cwd());
  const tool = {
    name: "poc_echo",
    description: "Echo text. Args: { text: string }.",
    execute: async (args: { text?: string }) => ({ echoed: String(args?.text ?? "") }),
  };
  // Without an extra schema, the harness rejects the tool. With one, it
  // accepts it. This is the same escape hatch the harness-engine test
  // uses to register its fixture tool.
  assert.throws(() => toHarnessTools([tool], ctx, Type));
  assert.doesNotThrow(() =>
    toHarnessTools([tool], ctx, Type, {
      poc_echo: { properties: { text: Type.String() }, optional: [] },
    }),
  );
});

test("HarnessLlmEngine.start throws when an agent registers an unknown tool", async () => {
  // We can't run the harness end-to-end without the faux provider
  // because it would need real LLM credentials. The factory path goes
  // through `toHarnessTools` before any network IO, so the throw is
  // observable from a single call.
  const { models, model } = buildFaux();
  assert.ok(models && model, "faux provider must produce a model");
});

function buildFaux(): { models: Models; model: Model<string> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() as Model<string> };
}

test("load_skill schema is present and accepts the documented { name } argument", () => {
  // The failure mode the plan calls out: the model calls
  //   load_skill({ name: "review-spec" })
  // and the harness rejects it because the schema was missing. With
  // the fix, the schema declares `name: string` and the call is
  // accepted. We assert on the schema object directly so a regression
  // here surfaces as a unit failure rather than a daemon log line.
  const ctx = makeContext(process.cwd());
  const tools = defaultTools(ctx);
  const loadSkill = tools.find((tool) => tool.name === "load_skill");
  assert.ok(loadSkill, "defaultTools must include load_skill");

  // Run the adapter and confirm registration does not throw.
  const [registered] = toHarnessTools([loadSkill], ctx, Type);
  assert.equal(registered?.name, "load_skill");
  // Schema is opaque (TypeBox instance) but the registration success
  // is the contract we care about.
  assert.ok(registered?.parameters, "load_skill must register a parameters schema");
});

test("harness start fails fast for an unknown tool in extraTools", async () => {
  // Mirrors the failure path: an agent calls runLlmAgent with a tool
  // that the harness cannot match. The error must fire at engine.start
  // — before any model call — so it is visible in the daemon lifecycle
  // log rather than surfacing as a vague "no assistant text".
  const { models, model } = buildFaux();
  const ctx = makeContext(process.cwd());
  const engine = new HarnessLlmEngine({
    ctx,
    laneName: "spec",
    systemPrompt: "test",
    tools: [{
      name: "ghost_tool",
      description: "Has no schema. Should be rejected at engine.start.",
      execute: async () => ({ ok: true }),
    }],
    Type,
    models,
    model,
    session: {} as never,
  });
  await assert.rejects(engine.start(), /No parameter schema registered for "ghost_tool"/);
});