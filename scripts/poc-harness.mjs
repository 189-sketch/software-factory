/**
 * Phase 0 PoC — prove the AgentHarness wiring the factory will adopt.
 *
 * This script is throwaway validation, NOT production code. It de-risks
 * the four open questions from docs/harness-architecture.md before any
 * agent is migrated:
 *
 *   1. ModelAdapter compatibility — can the harness drive a custom
 *      Anthropic-compatible endpoint (MiniMax etc.) via createProvider?
 *   2. Tool signature adaptation — does our {name,description,execute}
 *      tool shape map cleanly onto AgentHarnessTool?
 *   3. Turn / abort control — does lane.prompt() settle deterministically?
 *   4. Session persistence + recovery — does a JsonlSessionRepo session
 *      survive close/reopen with full transcript intact?
 *
 * Two modes:
 *
 *   - faux (default): deterministic in-process provider. Proves risks
 *     2/3/4 with zero credentials, runnable in CI and here.
 *   - real (FACTORY_POC_REAL=1 + ANTHROPIC_* env): drives the actual
 *     configured endpoint through the harness. Proves risk 1. Must be
 *     run in the target environment (the maintainer's MiniMax setup).
 *
 * Run:  node scripts/poc-harness.mjs
 * Real: FACTORY_POC_REAL=1 ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=... \
 *       ANTHROPIC_MODEL=... node scripts/poc-harness.mjs
 */
import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ctx = BACKGROUND_CONTEXT;
let failures = 0;

function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

/* -------------------------------------------------------------------------- */
/* Model construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Faux mode: deterministic provider. The script drives one tool-call
 * round-trip on turn 1 and a plain answer on turn 2, proving the harness
 * executes harness-tools and feeds results back to the model.
 */
function buildFauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // Turn 1: model calls poc_echo, then (after the tool result) answers.
  // Turn 2: model answers directly.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("poc_echo", { text: "ping" })]),
    fauxAssistantMessage([fauxText('{"verdict":"APPROVE","body":"faux turn 1"}')], { stopReason: "end_turn" }),
    fauxAssistantMessage([fauxText('{"verdict":"REJECT","body":"faux turn 2"}')], { stopReason: "end_turn" }),
  ]);
  return { models, model: faux.getModel(), faux };
}

/**
 * Real mode: wrap the configured Anthropic-compatible endpoint in a
 * custom provider so `models.streamSimple` (which the harness calls
 * internally) hits the same baseUrl/headers our AnthropicAdapter uses
 * today. This is the exact shape Phase 1 will productionize.
 */
async function buildRealModels() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const modelId = process.env.ANTHROPIC_MODEL || process.env.FACTORY_MODEL_NAME;
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error("real mode requires ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN/_API_KEY, ANTHROPIC_MODEL");
  }
  const [{ getModels }, { anthropicMessagesApi }] = await Promise.all([
    import("@earendil-works/pi-ai/compat"),
    import("@earendil-works/pi-ai/api/anthropic-messages.lazy"),
  ]);
  const base = getModels("anthropic").find((c) => c.api === "anthropic-messages");
  if (!base) throw new Error("pi-ai has no anthropic-messages capability schema");
  const model = {
    ...base,
    id: modelId,
    name: modelId,
    baseUrl,
    maxTokens: base.maxTokens,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  };
  const provider = createProvider({
    id: "factory-anthropic",
    name: "Factory Anthropic-compatible",
    baseUrl,
    auth: { apiKey: envApiKeyAuth("anthropic", ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) },
    models: [model],
    api: anthropicMessagesApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

/* -------------------------------------------------------------------------- */
/* Tool adapter — the shape Phase 1 will generalize into toHarnessTools()      */
/* -------------------------------------------------------------------------- */

function pocTools() {
  return [
    {
      name: "poc_echo",
      label: "poc_echo",
      description: "Echo text back. Args: {text:string}.",
      parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      // AgentHarnessTool.execute(toolCallId, params, onUpdate, toolContext, invocation, context)
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: `echo:${params.text}` }],
        details: { echoed: params.text },
      }),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Session helpers                                                             */
/* -------------------------------------------------------------------------- */

function countJsonlBytes(sessionDir) {
  let total = 0;
  for (const entry of readdirSync(sessionDir, { recursive: true })) {
    const abs = path.join(sessionDir, entry);
    if (statSync(abs).isFile() && abs.endsWith(".jsonl")) total += statSync(abs).size;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const real = process.env.FACTORY_POC_REAL === "1";
  console.log(`\n=== Harness PoC (${real ? "REAL endpoint" : "faux provider"}) ===\n`);

  const { models, model } = real ? await buildRealModels() : buildFauxModels();

  const sessionsRoot = mkdtempSync(path.join(tmpdir(), "factory-poc-sessions-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "factory-poc-cwd-"));
  const fileSystem = new NodeExecutionEnv({ cwd });
  const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });

  try {
    // --- Create a session (one per issue in production) ---
    const session = await repo.create({ cwd }, ctx);
    check("session created", session && session.metadata && session.metadata.id, `id=${session?.metadata?.id}`);

    // --- Create the harness ---
    const { harness, open } = await AgentHarness.create(
      {
        session,
        models,
        model,
        tools: pocTools(),
        toolContext: { poc: true },
        systemPrompt: "You are the triage agent. Decide readiness and return JSON only.",
      },
      ctx,
    );
    check("harness created", Boolean(harness));
    check("no open operations on fresh session", Array.isArray(open) && open.length === 0, `open=${open?.length}`);

    // --- Acquire a lane (one per agent role in production) ---
    const lane = await harness.lane("triage", ctx);
    check("lane acquired", lane && lane.name === "triage", `name=${lane?.name}`);

    // --- Turn 1: multi-turn prompt (faux scripts a tool call round-trip) ---
    const run1 = await lane.prompt("Inspect issue #1 and decide.", undefined, ctx);
    check("turn 1 settled ok", run1 && run1.ok === true, run1?.ok ? "" : `error=${JSON.stringify(run1?.error)}`);
    if (run1?.ok) {
      const rec = run1.value;
      check("turn 1 completed", rec && rec.status === "completed", `status=${rec?.status}`);
    }

    // --- Turn 2: a second prompt on the SAME lane (proves multi-turn continuity) ---
    if (!real) {
      const run2 = await lane.prompt("Re-evaluate after new evidence.", undefined, ctx);
      check("turn 2 settled ok", run2 && run2.ok === true, run2?.ok ? "" : `error=${JSON.stringify(run2?.error)}`);
    }

    // --- Session transcript captured entries ---
    const entries = await lane.findEntries(undefined, ctx);
    check("lane transcript has entries", entries.length > 0, `count=${entries.length}`);
    const hasToolResult = entries.some((e) => e.type === "message" && e.message?.role === "toolResult");
    if (!real) check("tool round-trip recorded (toolResult entry)", hasToolResult);

    // --- Persistence: JSONL bytes on disk ---
    const bytes = countJsonlBytes(sessionsRoot);
    check("session persisted to JSONL on disk", bytes > 0, `${bytes} bytes under ${sessionsRoot}`);

    // --- Recovery: close, reopen the SAME session, verify transcript survives ---
    const metadata = session.metadata;
    await harness.close(ctx);
    const reopened = await repo.open(metadata, ctx);
    const { harness: harness2 } = await AgentHarness.create(
      { session: reopened, models, model, tools: pocTools(), systemPrompt: "You are the triage agent." },
      ctx,
    );
    const lane2 = await harness2.lane("triage", ctx);
    const entries2 = await lane2.findEntries(undefined, ctx);
    check(
      "recovered session preserves transcript",
      entries2.length === entries.length,
      `before=${entries.length} after=${entries2.length}`,
    );
    await harness2.close(ctx);

    console.log(`\n=== PoC ${failures === 0 ? "PASSED" : `FAILED (${failures})`} ===\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await repo.close(ctx).catch(() => {});
    rmSync(sessionsRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nPoC threw:", err);
  process.exitCode = 1;
});
