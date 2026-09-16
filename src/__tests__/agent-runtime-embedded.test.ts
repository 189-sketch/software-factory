/**
 * Slice A.2 / Group 2 / Task 2.3 — embedded adapter end-to-end tests
 * through the new `AgentRuntime.runStage` contract.
 *
 * The plan calls for re-running the scenarios previously captured in
 * `harness-engine.test.ts` through the dispatcher contract. The
 * adapter is a thin shim over `HarnessLlmEngine`, so the assertions
 * here exercise the dispatcher surface (`runStage(req, ctx)` →
 * `StageRunResult`) and confirm the same multi-turn behaviour
 * (assistant text appears in `output`, abort signal surfaces as
 * `cancelled`, override provenance is preserved).
 *
 * Tests use the faux provider (`__setHarnessModelsForTest`) so no
 * credentials or network are needed. The model override is shared
 * across files within the same `node --test` invocation; per-test
 * responses are reset via `faux.setResponses(...)` and the session
 * cache is cleared between tests so each test starts fresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  createModels,
  Type,
} from "@earendil-works/pi-ai";
import type { Model, Models } from "@earendil-works/pi-ai";

import {
  buildAgentRuntime,
  type StageRunRequest,
} from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";

import {
  classifyError,
  classifyRetryable,
} from "../core/agent-runtime-embedded.js";

import {
  __setHarnessModelsForTest,
  __clearSessionCacheForTest,
  __shutdownHarnessForTest,
} from "../core/harness.js";

function buildFaux(): { models: Models; model: Model<string>; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<string>;
  return { models, model, faux };
}

const shared = buildFaux();
__setHarnessModelsForTest({ models: shared.models, model: shared.model });

function freshWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "factory-rt-embedded-"));
}

function makeContext(issueNumber: number, workdir: string): AgentContext {
  const logger = {
    info() {}, warn() {}, error() {}, debug() {},
    child() { return this; },
  };
  return {
    issue: { number: issueNumber, title: "x", body: "", labels: [], comments: [] },
    repo: { workdir },
    logger: logger as unknown as AgentContext["logger"],
    skills: [],
    skillsRoot: "/tmp/skills",
    runId: "test-run",
    correction: undefined,
  } as unknown as AgentContext;
}

/** Run `runStage` against a freshly-cleared session cache so each
 * test starts from an empty queue. The faux provider's response queue
 * is reset to the given messages. */
async function withFreshSession<T>(
  responses: Parameters<typeof shared.faux.setResponses>[0],
  fn: () => Promise<T>,
): Promise<T> {
  __clearSessionCacheForTest();
  shared.faux.setResponses(responses);
  return fn();
}

test("dispatcher surfaces multi-turn assistant text through StageRunResult.output", async () => {
  const workdir = freshWorkdir();
  try {
    await withFreshSession(
      [
        fauxAssistantMessage([fauxText('{"verdict":"APPROVE","body":"dispatcher turn 1"}')], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText('{"verdict":"REJECT","body":"dispatcher turn 2"}')], { stopReason: "stop" }),
      ],
      async () => {
        const rt = buildAgentRuntime({});
        const ctx = makeContext(1, workdir);
        const req: StageRunRequest = {
          role: "review-pr",
          runId: "dispatcher-multi-turn",
          issue: { number: 1, repo: { workdir } },
          inputManifest: {
            systemPrompt: "Return JSON only.",
            userPrompt: "Review the diff.",
            contextTurns: ["What about turn 2?"],
          },
        };
        const result = await rt.runStage(req, ctx);
        assert.equal(result.status, "succeeded");
        assert.equal(result.backend, "embedded");
        assert.ok(
          /REJECT/.test(result.output),
          `output should include the latest assistant text; got ${result.output.slice(0, 80)}`,
        );
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("abortSignal pre-set returns cancelled status without throwing", async () => {
  const workdir = freshWorkdir();
  try {
    await withFreshSession(
      [
        fauxAssistantMessage([fauxText("ignored")], { stopReason: "stop" }),
      ],
      async () => {
        const rt = buildAgentRuntime({});
        const ctx = makeContext(2, workdir);
        const controller = new AbortController();
        controller.abort();
        const req: StageRunRequest = {
          role: "triage",
          runId: "dispatcher-aborted",
          issue: { number: 2, repo: { workdir } },
          inputManifest: { systemPrompt: "x", userPrompt: "y" },
          abortSignal: controller.signal,
        };
        const result = await rt.runStage(req, ctx);
        assert.equal(result.status, "cancelled");
        assert.equal(result.backend, "embedded");
        assert.ok(result.warnings.some((w) => /aborted/i.test(w)));
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("dispatcher honours FACTORY_AGENT_OVERRIDES and embeds provenance in result", async () => {
  const workdir = freshWorkdir();
  try {
    await withFreshSession(
      [
        fauxAssistantMessage([fauxText('{"verdict":"APPROVE"}')], { stopReason: "stop" }),
      ],
      async () => {
        const rt = buildAgentRuntime({
          FACTORY_AGENT_BACKEND: "codex-cli",
          FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "embedded" }),
        });
        const ctx = makeContext(3, workdir);
        const req: StageRunRequest = {
          role: "review-pr",
          runId: "dispatcher-override",
          issue: { number: 3, repo: { workdir } },
          inputManifest: { systemPrompt: "Return JSON only.", userPrompt: "Review." },
        };
        const result = await rt.runStage(req, ctx);
        assert.equal(result.backend, "embedded");
        assert.equal(result.status, "succeeded");
      },
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await __shutdownHarnessForTest();
});

test("classifyError surfaces harness abort / cancel / kill as interrupted", () => {
  // The harness raises these categories on lane abort, SIGTERM-killed
  // network calls, and supervisor-initiated cancel. triage-supervisor
  // routes `interrupted` differently from `failed` (see
  // orchestrator/index.ts around the failure-recovery branch), so
  // the classification must be reliable end-to-end.
  assert.equal(classifyError("lane aborted: turn cap reached"), "interrupted");
  assert.equal(classifyError("Request cancelled by caller"), "interrupted");
  assert.equal(classifyError("child killed: SIGTERM"), "interrupted");
  // Case-insensitive — the harness logs vary in capitalisation.
  assert.equal(classifyError("Aborted mid-turn"), "interrupted");
  // Anything else stays failed.
  assert.equal(classifyError("network unreachable"), "failed");
  // `no assistant entries` is the canonical parse miss → format-error.
  assert.equal(classifyError("no assistant entries"), "format-error");
});

test("classifyRetryable only retries infrastructure-flavored failures", () => {
  // Aborted / timed-out → retryable (transient).
  assert.equal(classifyRetryable("aborted"), true);
  assert.equal(classifyRetryable("connection timeout after 30s"), true);
  assert.equal(classifyRetryable("connect ETIMEDOUT"), true);
  // Parse miss and content errors → not retryable (a retry would
  // hit the same parse path and fail the same way).
  assert.equal(classifyRetryable("no assistant entries"), false);
  assert.equal(classifyRetryable("invalid JSON"), false);
});

// Suppress unused-import warnings for `Type` (re-exported by pi-ai for
// callers that build tool schemas, kept here for parity with
// harness-engine.test.ts where Type is needed).
void Type;