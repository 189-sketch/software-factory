import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  createModels,
  Type,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  HarnessLlmEngine,
  getIssueSession,
  issueSessionId,
  collectLatestAssistantText,
  __setHarnessModelsForTest,
  __clearSessionCacheForTest,
  __shutdownHarnessForTest,
} from "../core/harness.js";
import type { AgentContext } from "../core/types.js";

/**
 * Phase 1 harness-engine tests.
 *
 * These drive the PRODUCTION harness path (`HarnessLlmEngine` +
 * `getIssueSession`) with the deterministic faux provider — no
 * credentials, no network. They prove the four risks the PoC retired
 * are also retired in the real module the factory will use:
 *
 *   - tool adaptation: a factory-shaped tool runs through the harness
 *     and its result feeds back to the model;
 *   - multi-turn: a second prompt on the same lane continues the
 *     conversation;
 *   - persistence: the issue session is written to JSONL on disk;
 *   - recovery: reopening the session preserves the transcript.
 *
 * Cross-agent context sharing (custom entries + EntryProjector) is
 * Phase 2 and intentionally not asserted here.
 */

function makeContext(issueNumber: number, workdir: string): AgentContext {
  return {
    repo: { owner: "o", name: "n", defaultBranch: "main", workdir },
    issue: {
      number: issueNumber,
      title: "Test issue",
      body: "Body for harness engine test.",
      labels: [],
      author: "tester",
      url: `https://example/issues/${issueNumber}`,
      createdAt: new Date().toISOString(),
      comments: [],
    },
    skills: [],
    skillsRoot: workdir,
    logger: { info: () => {}, warn: () => {}, error: () => {}, child: () => makeContext(issueNumber, workdir).logger },
    runId: "test-run",
  };
}

/** A factory-shaped tool: {name, description, execute(args, ctx)}. */
function echoTool() {
  return {
    name: "poc_echo",
    description: "Echo text. Args: {text:string}.",
    execute: async (args: Record<string, unknown>) => ({ echoed: String(args.text ?? "") }),
  };
}

function buildFaux(): { models: Models; model: Model<string>; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider();
  // The engine hands `models` to AgentHarness.create, which calls
  // models.streamSimple. Register the faux provider on a real Models
  // collection so streamSimple resolves to the scripted responses.
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() as Model<string>, faux };
}

function countJsonlBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isFile() && abs.endsWith(".jsonl")) total += statSync(abs).size;
  }
  return total;
}

test("collectLatestAssistantText picks the newest assistant text block", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "text", text: "second" }] },
  ];
  assert.equal(collectLatestAssistantText(messages), "second");
  assert.equal(collectLatestAssistantText([{ role: "user", content: "only user" }]), "");
});

test("issueSessionId is stable and filesystem-safe", () => {
  assert.equal(issueSessionId(42), "issue-42");
});

test("HarnessLlmEngine runs a tool round-trip and multi-turn on a durable session", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "factory-harness-state-"));
  const workdir = mkdtempSync(path.join(tmpdir(), "factory-harness-wd-"));
  const prevStateDir = process.env.FACTORY_STATE_DIR;
  process.env.FACTORY_STATE_DIR = stateDir;
  t.after(async () => {
    __setHarnessModelsForTest(null);
    await __shutdownHarnessForTest();
    if (prevStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });

  const { models, model, faux } = buildFaux();
  // Turn 1: model calls poc_echo, then answers. Turn 2: model answers.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("poc_echo", { text: "ping" })]),
    fauxAssistantMessage([fauxText('{"verdict":"APPROVE","body":"turn 1"}')], { stopReason: "stop" }),
    fauxAssistantMessage([fauxText('{"verdict":"REJECT","body":"turn 2"}')], { stopReason: "stop" }),
  ]);
  __setHarnessModelsForTest({ models, model });
  __clearSessionCacheForTest();

  const ctx = makeContext(7, workdir);
  const session = await getIssueSession(ctx);
  assert.ok(session, "session should be created");

  const engine = new HarnessLlmEngine({
    ctx,
    laneName: "review-pr",
    systemPrompt: "You are a review agent. Return JSON only.",
    tools: [echoTool()],
    Type,
    models,
    model,
    session,
    // The factory-shaped harness refuses to register a tool without a
    // parameter schema (F01 fix). Tests that exercise custom tools
    // must declare a schema here so the production registry stays the
    // single source of truth for shipped tools.
    extraToolSchemas: {
      poc_echo: { properties: { text: Type.String() }, optional: [] },
    },
  });
  await engine.start();

  // Turn 1 (consumes the tool-call + final responses).
  await engine.prompt("Review the diff.");
  const text1 = await engine.finalText();
  assert.match(text1, /APPROVE/, "turn 1 final text should be the post-tool answer");

  // Turn 2 on the SAME lane (multi-turn continuity).
  await engine.prompt("Re-review after changes.");
  const text2 = await engine.finalText();
  assert.match(text2, /REJECT/, "turn 2 final text should be the latest answer");

  const diag = await engine.diagnostics();
  assert.match(diag, /lane=review-pr/);

  await engine.close();

  // Persistence: the issue session wrote JSONL under the state dir.
  const sessionsRoot = path.join(stateDir, "sessions");
  assert.ok(countJsonlBytes(sessionsRoot) > 0, "session should persist to JSONL on disk");
  assert.deepEqual(readdirSync(sessionsRoot), ["issue-7"], "session namespace must start with the issue, not an encoded drive path");

  // Recovery: engine.close() also closes its session. The cache must detect
  // that closed handle and reopen the same durable session without a manual
  // cache reset before the next agent run.
  const reopened = await getIssueSession(ctx);
  assert.equal(reopened.metadata.id, issueSessionId(7));
  assert.notEqual(reopened, session, "closed cached session must not be handed to the next agent");
  const reopenedEntries = await reopened.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
  assert.ok(reopenedEntries.length > 0, "reopened session must preserve its transcript");
});

test("getIssueSession reuses the same in-process session for one issue", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "factory-harness-reuse-"));
  const workdir = mkdtempSync(path.join(tmpdir(), "factory-harness-reuse-wd-"));
  const prev = process.env.FACTORY_STATE_DIR;
  process.env.FACTORY_STATE_DIR = stateDir;
  t.after(async () => {
    __setHarnessModelsForTest(null);
    await __shutdownHarnessForTest();
    if (prev === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = prev;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });

  const { models, model, faux } = buildFaux();
  faux.setResponses([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })]);
  __setHarnessModelsForTest({ models, model });
  __clearSessionCacheForTest();

  const ctx = makeContext(99, workdir);
  const a = await getIssueSession(ctx);
  const b = await getIssueSession(ctx);
  assert.equal(a.metadata.id, b.metadata.id, "same issue must reuse one session");
});

test("legacy drive-encoded session is migrated under the issue namespace", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "factory-harness-migrate-"));
  const workdir = mkdtempSync(path.join(tmpdir(), "factory-harness-migrate-wd-"));
  const previous = process.env.FACTORY_STATE_DIR;
  process.env.FACTORY_STATE_DIR = stateDir;
  t.after(async () => {
    await __shutdownHarnessForTest();
    if (previous === undefined) delete process.env.FACTORY_STATE_DIR;
    else process.env.FACTORY_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });

  const legacyRepo = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: workdir }),
    sessionsRoot: path.join(stateDir, "sessions"),
  });
  const legacy = await legacyRepo.create({ cwd: workdir, id: issueSessionId(55) }, BACKGROUND_CONTEXT);
  await legacy.setName("legacy transcript marker", BACKGROUND_CONTEXT);
  await legacy.close(BACKGROUND_CONTEXT);
  await legacyRepo.close(BACKGROUND_CONTEXT);

  const reopened = await getIssueSession(makeContext(55, workdir));
  assert.equal(await reopened.getName(BACKGROUND_CONTEXT), "legacy transcript marker");
  assert.ok(readdirSync(path.join(stateDir, "sessions")).includes("issue-55"));
});
