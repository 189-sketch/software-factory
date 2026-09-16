/**
 * Harness execution engine (Phase 1 of docs/harness-architecture.md).
 *
 * One Session per issue, one Lane per agent role, multi-turn prompts.
 * The session is durable (JsonlSessionRepo under the factory state dir)
 * so every agent that touches an issue shares one continuous transcript
 * and the conversation survives daemon restarts.
 *
 * This module is the factory's only LLM engine. `runLlmAgent`
 * (llm-agent.ts) always drives a `HarnessLlmEngine` through the shared
 * `LlmEngine` contract; the former opt-in `FACTORY_HARNESS` flag and the
 * legacy per-call `Agent` path have been removed.
 *
 * Why harness-only: the legacy per-call `Agent` had no context management.
 * Its only guards were a turn cap and a wall-clock timeout, so input
 * tokens grew until the provider rejected the request (e.g. dashscope
 * `400 Range of input length should be [1, 983616]`). The harness owns a
 * durable session with automatic compaction: once estimated context
 * tokens exceed `model.contextWindow - reserveTokens` it summarizes and
 * trims history (see pi-agent-core `shouldCompact`). We set that window
 * via `getContextWindow()` (default 512k) so compaction fires early.
 */
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type AgentHarness as AgentHarnessType,
  type AgentLane,
} from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Session } from "@earendil-works/pi-agent-core";
import type { Model, Models, TSchema } from "@earendil-works/pi-ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveAdapter } from "./model-adapter.js";
import type { AgentContext } from "./types.js";
import type { HarnessLaneEvent } from "./events.js";

/**
 * Structural type for the TypeBox `Type` namespace exposed by
 * `@earendil-works/pi-ai` (which re-exports from `@sinclair/typebox`).
 * We deliberately use a structural shape rather than importing the
 * concrete namespace so that callers can keep injecting `Type` at run
 * time (avoids a hard pi-ai import at module load) while still giving
 * the harness layer real type checking on the helper surface.
 */
export interface TypeBoxHelpers {
  Object(properties: Record<string, TSchema>, options?: { additionalProperties?: boolean }): TSchema;
  String(options?: unknown): TSchema;
  Optional(schema: TSchema): TSchema;
  Number(options?: unknown): TSchema;
  Array(schema: TSchema, options?: unknown): TSchema;
  Union(schemas: TSchema[], options?: unknown): TSchema;
  Literal(value: string | number | boolean, options?: unknown): TSchema;
}

/** Per-issue durable session plus the model runtime that drives it. */
interface IssueHarness {
  session: Session;
  /** Stable id so reopen-after-restart finds the same on-disk session. */
  sessionId: string;
}

/**
 * The Harness engine contract driven by `runLlmAgent`.
 * Keeping the contract small isolates prompt parsing and retry policy from
 * the SDK lane lifecycle without preserving a second execution engine.
 */
export interface LlmEngine {
  /** Send one user turn and await settlement. */
  prompt(text: string): Promise<void>;
  /** Most recent assistant text across the whole conversation. */
  finalText(): Promise<string>;
  /** Extra diagnostics for the "no assistant text" error path. */
  diagnostics(): Promise<string>;
  /** Release runtime resources. Does NOT close the shared session. */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Model runtime (cached; one per process)                                     */
/* -------------------------------------------------------------------------- */

let cachedModels: { models: Models; model: Model<string> } | null = null;
let modelsOverride: { models: Models; model: Model<string> } | null = null;

/** Test hook: inject a faux Models/Model so the engine runs without creds. */
export function __setHarnessModelsForTest(value: { models: Models; model: Model<string> } | null): void {
  modelsOverride = value;
}

/** Build the Harness runtime through the selected provider adapter. */
export async function buildHarnessModels(): Promise<{ models: Models; model: Model<string> }> {
  if (modelsOverride) return modelsOverride;
  if (cachedModels) return cachedModels;
  cachedModels = await resolveAdapter().buildRuntime();
  return cachedModels;
}

/* -------------------------------------------------------------------------- */
/* Session manager (one durable session per issue)                             */
/* -------------------------------------------------------------------------- */

const sessionCache = new Map<string, IssueHarness>();
const repoCache = new Map<string, JsonlSessionRepo>();

function sessionsRoot(workdir: string, issueNumber: number): string {
  const base = process.env.FACTORY_STATE_DIR || path.join(workdir, ".factory");
  return path.join(base, "sessions", issueSessionId(issueNumber));
}

function getRepo(workdir: string, issueNumber: number): JsonlSessionRepo {
  const root = sessionsRoot(workdir, issueNumber);
  const cached = repoCache.get(root);
  if (cached) return cached;
  const virtualCwd = issueSessionId(issueNumber);
  const fileSystem = new NodeExecutionEnv({ cwd: workdir });
  const absolutePath = fileSystem.absolutePath.bind(fileSystem);
  fileSystem.absolutePath = (input, context) => input === virtualCwd
    ? Promise.resolve({ ok: true, value: virtualCwd })
    : absolutePath(input, context);
  const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: root });
  repoCache.set(root, repo);
  return repo;
}

/** Stable, filesystem-safe session id for an issue. */
export function issueSessionId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/**
 * Return the durable session for an issue, creating it on first use and
 * reopening the on-disk transcript on later uses (including after a
 * daemon restart). Cached in-process so repeated agents in one run share
 * the exact same Session object.
 */
export async function getIssueSession(ctx: AgentContext): Promise<Session> {
  const sessionId = issueSessionId(ctx.issue.number);
  const cacheKey = `${ctx.repo.workdir}::${sessionId}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    try {
      await cached.session.getStats(BACKGROUND_CONTEXT);
      return cached.session;
    } catch (error) {
      if (!isClosedSessionError(error)) throw error;
      sessionCache.delete(cacheKey);
    }
  }

  const repo = getRepo(ctx.repo.workdir, ctx.issue.number);
  await migrateLegacySession(ctx, sessionId);
  // Look for an existing on-disk session for this issue; reopen it so the
  // transcript continues. Otherwise create a fresh one with the stable id.
  const existing = await repo.list({ cwd: sessionId }, BACKGROUND_CONTEXT).catch(() => []);
  const match = existing.find((m) => m.id === sessionId);
  if (match) {
    const session = await repo.open(match, BACKGROUND_CONTEXT);
    sessionCache.set(cacheKey, { session, sessionId });
    return session;
  }
  // Self-heal orphaned session files. `migrateLegacySession` and
  // `repo.list` both inspect-by-content (read the JSONL header) so a
  // session file from a previous attempt that crashed mid-write can
  // have a truncated header / no header at all — list returns [],
  // migrateLegacySession sees the file name and treats it as
  // "already migrated, leave alone". But `repo.create` calls
  // `assertSessionIdAvailable` which only checks the filename suffix,
  // sees the orphan, and refuses with "Session already exists". That
  // loop blocks every future agent run for this issue.
  //
  // Detect the orphan via direct directory read, rename it out of the
  // way (preserved for forensics — do NOT delete), then create.
  await retireOrphanedSessionFiles(ctx, sessionId);
  const session = await repo.create({ cwd: sessionId, id: sessionId }, BACKGROUND_CONTEXT);
  sessionCache.set(cacheKey, { session, sessionId });
  return session;
}

/**
 * Rename any orphan `_${sessionId}.jsonl` files in the session
 * directory to `<name>.orphaned-<ts>` so a fresh `repo.create` can
 * proceed. The files are kept on disk for forensics — they are not
 * deleted. Issue #24 sat in a tight retry loop because this exact
 * gap (list-by-header vs assertSessionIdAvailable-by-name) blocked
 * every implementation + triage-supervisor attempt on a session
 * file left behind by a daemon SIGKILL.
 */
async function retireOrphanedSessionFiles(ctx: AgentContext, sessionId: string): Promise<void> {
  const targetRoot = sessionsRoot(ctx.repo.workdir, ctx.issue.number);
  const targetDirectory = path.join(targetRoot, `--${sessionId}--`);
  let entries: string[];
  try {
    entries = await fs.readdir(targetDirectory);
  } catch {
    return; // directory doesn't exist yet — nothing to retire
  }
  const suffix = `_${encodeURIComponent(sessionId)}.jsonl`;
  const orphans = entries.filter((name) => name.endsWith(suffix));
  if (orphans.length === 0) return;
  const ts = Date.now();
  for (const name of orphans) {
    const from = path.join(targetDirectory, name);
    const to = path.join(targetDirectory, `${name}.orphaned-${ts}`);
    try {
      await fs.rename(from, to);
    } catch {
      // Best-effort; if rename fails (e.g. permission) the create
      // attempt will surface the original error.
    }
  }
}

async function migrateLegacySession(ctx: AgentContext, sessionId: string): Promise<void> {
  const targetRoot = sessionsRoot(ctx.repo.workdir, ctx.issue.number);
  const targetDirectory = path.join(targetRoot, `--${sessionId}--`);
  try {
    const targetFiles = await fs.readdir(targetDirectory);
    if (targetFiles.some((name) => name.endsWith(`_${encodeURIComponent(sessionId)}.jsonl`))) return;
  } catch {}

  const stateBase = process.env.FACTORY_STATE_DIR || path.join(ctx.repo.workdir, ".factory");
  const legacyRoot = path.join(stateBase, "sessions");
  const legacyFileSystem = new NodeExecutionEnv({ cwd: ctx.repo.workdir });
  const legacyRepo = new JsonlSessionRepo({ fileSystem: legacyFileSystem, sessionsRoot: legacyRoot });
  try {
    const candidates = (await legacyRepo.list(undefined, BACKGROUND_CONTEXT))
      .filter((metadata) => metadata.id === sessionId)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const legacy = candidates[0];
    if (!legacy) return;
    const content = await fs.readFile(legacy.path, "utf8");
    const lineEnd = content.indexOf("\n");
    const headerText = lineEnd >= 0 ? content.slice(0, lineEnd).replace(/\r$/, "") : content;
    const header = JSON.parse(headerText) as Record<string, unknown>;
    if (header.kind !== "header" || header.id !== sessionId) return;
    header.cwd = sessionId;
    const remainder = lineEnd >= 0 ? content.slice(lineEnd + 1) : "";
    await fs.mkdir(targetDirectory, { recursive: true });
    const destination = path.join(targetDirectory, path.basename(legacy.path));
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(header)}\n${remainder}`, { flag: "wx" });
    await fs.rename(temporary, destination);
    ctx.logger.info(`issue #${ctx.issue.number} migrated durable session to ${path.relative(stateBase, destination)}`);
  } catch (error) {
    ctx.logger.warn(`issue #${ctx.issue.number} legacy session migration skipped: ${String(error)}`);
  } finally {
    await legacyRepo.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}

function isClosedSessionError(error: unknown): boolean {
  return error instanceof Error && error.message === "Session is closed";
}

/** Test/maintenance hook: drop cached sessions (e.g. between test cases). */
export function __clearSessionCacheForTest(): void {
  sessionCache.clear();
}

/**
 * Test/maintenance hook: close the cached JSONL repo (releasing its open
 * file handles) and drop all caches. Without this, a lingering repo keeps
 * the Node event loop alive and `node --test` never exits.
 */
export async function __shutdownHarnessForTest(): Promise<void> {
  sessionCache.clear();
  await Promise.all([...repoCache.values()].map((repo) => repo.close(BACKGROUND_CONTEXT).catch(() => {})));
  repoCache.clear();
}

/* -------------------------------------------------------------------------- */
/* Tool adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Convert the factory's internal tool shape into AgentHarnessTool. The
 * harness calls `execute(toolCallId, params, onUpdate, toolContext,
 * invocation, context)`; our tools expect `(args, ctx)`. We capture the
 * AgentContext at registration time (the harness is created per agent
 * run, so the captured ctx is always the right one for this lane).
 *
 * `extraToolSchemas` lets a caller attach schemas for tools that are
 * not part of the global registry — the test harness uses this to
 * register fixtures. Production callers should add new tools to the
 * global schema table in `toolParameters` instead.
 */
export function toHarnessTools(
  tools: Array<{ name: string; description: string; execute: (args: Record<string, unknown>, ctx: AgentContext) => Promise<unknown> }>,
  ctx: AgentContext,
  Type: TypeBoxHelpers,
  extraToolSchemas?: Record<string, { properties: Record<string, TSchema>; optional: string[] }>,
) {
  return tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: toolParameters(t.name, Type, extraToolSchemas),
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await t.execute(params, ctx);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text" as const, text }], details: result };
    },
  }));
}

/**
 * Per-tool TypeBox parameter schema. The agent loop validates each
 * tool-call's arguments against this before executing the tool, so the
 * model is constrained to the declared field set. `Type` is injected
 * (rather than imported) to avoid a hard pi-ai import at module load —
 * the harness lazily imports pi-ai only when a run actually starts.
 *
 * Tools that are not in the global table are looked up in
 * `extraToolSchemas` (used by tests to register fixtures). Any tool
 * that is neither registered globally nor passed in as an extra throws
 * — that is the F01 fix: an empty-property fallback silently passed
 * argument validation and rejected every subsequent call once the
 * model supplied real arguments.
 */
function toolParameters(
  name: string,
  Type: TypeBoxHelpers,
  extraToolSchemas?: Record<string, { properties: Record<string, TSchema>; optional: string[] }>,
): TSchema {
  const definitions: Record<string, { properties: Record<string, TSchema>; optional: string[] }> = {
    read_file: { properties: { path: Type.String() }, optional: [] },
    write_file: { properties: { path: Type.String(), content: Type.String() }, optional: [] },
    list_dir: { properties: { path: Type.String() }, optional: ["path"] },
    load_skill: { properties: { name: Type.String() }, optional: [] },
    grep_repo: { properties: { pattern: Type.String(), glob: Type.String(), max: Type.Number() }, optional: ["glob", "max"] },
    fetch_issue: { properties: { issueNumber: Type.Number() }, optional: [] },
    run_shell: { properties: { command: Type.String(), cwd: Type.String(), timeoutMs: Type.Number() }, optional: ["cwd", "timeoutMs"] },
    run_validation: { properties: { command: Type.String() }, optional: [] },
    run_acceptance_test: { properties: { command: Type.String() }, optional: [] },
    browser: {
      properties: {
        action: Type.Union([
          Type.Literal("open"), Type.Literal("click"), Type.Literal("fill"),
          Type.Literal("assert_text"), Type.Literal("assert_visible"), Type.Literal("screenshot"),
        ]),
        selector: Type.String(), value: Type.String(),
      },
      optional: ["selector", "value"],
    },
    collect_feedback: { properties: {}, optional: [] },
    post_issue_comment: { properties: { body: Type.String() }, optional: [] },
    update_issue_labels: { properties: { add: Type.Array(Type.String()), remove: Type.Array(Type.String()) }, optional: ["add", "remove"] },
    commit_and_push: { properties: { branch: Type.String(), message: Type.String(), files: Type.Array(Type.String()) }, optional: [] },
    open_pull_request: { properties: { branch: Type.String(), baseBranch: Type.String(), title: Type.String(), body: Type.String() }, optional: ["baseBranch"] },
  };
  let definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  if (!definition && extraToolSchemas && Object.hasOwn(extraToolSchemas, name)) {
    definition = extraToolSchemas[name];
  }
  if (!definition) {
    throw new Error(`No parameter schema registered for "${name}" in harness toolParameters`);
  }
  const properties: Record<string, TSchema> = {};
  for (const [key, schema] of Object.entries(definition.properties)) {
    properties[key] = definition.optional.includes(key) ? Type.Optional(schema) : schema;
  }
  return Type.Object(properties, { additionalProperties: false });
}

/* -------------------------------------------------------------------------- */
/* Harness lane engine                                                         */
/* -------------------------------------------------------------------------- */

const MAX_TURNS = 100;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface HarnessEngineParams {
  ctx: AgentContext;
  /**
   * Logical lane name (e.g. "triage", "spec", "implementation"). The
   * actual lane used in the harness is suffixed with a unique token so
   * each stage run gets a fresh lane. Reusing a lane across runs caused
   * LaneBusy aborts when a previous run left an in-flight operation.
   */
  laneName: string;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; execute: (args: Record<string, unknown>, ctx: AgentContext) => Promise<unknown> }>;
  /** Injected TypeBox `Type` (pi-ai) so we don't hard-import at load. */
  Type: TypeBoxHelpers;
  models: Models;
  model: Model<string>;
  session: Session;
  /**
   * Optional schema map for tools that are not part of the global
   * registry. Production callers should add new tools to the global
   * table in `toolParameters`; this escape hatch is for tests and
   * for plugin-style tools that want to bring their own schema.
   */
  extraToolSchemas?: Record<string, { properties: Record<string, TSchema>; optional: string[] }>;
}

/**
 * Drives one agent lane on the issue's shared session. Each `prompt()`
 * is a full harness run (the loop continues through tool calls until the
 * model settles). `finalText()` reads the latest assistant message from
 * the lane transcript.
 */
export class HarnessLlmEngine implements LlmEngine {
  private harness: AgentHarnessType | null = null;
  private lane: AgentLane | null = null;
  private turnCount = 0;
  private abortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offTurnEnd: (() => void) | null = null;
  private offMessage: (() => void) | null = null;
  private offUsage: (() => void) | null = null;
  /** Track the last assistant-text length we already logged so each `message`
   * event only contributes its NEW bytes (response.js streams a message
   * entry incrementally; otherwise we'd duplicate the same payload many times). */
  private lastMessageSeenBytes = 0;

  constructor(private readonly params: HarnessEngineParams) {}

  async start(): Promise<void> {
    const { ctx, laneName, systemPrompt, tools, Type, models, model, session } = this.params;
    // Lifecycle: announce the lane is starting with the prompts that drive it.
    // Truncating to 4 KB keeps daemon.log scannable while preserving enough
    // context to diagnose drift between system intent and model behavior.
    ctx.logger.info(`[agent.${laneName}.start]`, {
      lane: laneName,
      model: model.id,
      systemPromptBytes: systemPrompt.length,
      systemPromptPreview: truncate(systemPrompt, 4096),
      tools: tools.map((t) => t.name),
    });
    const harnessTools = toHarnessTools(tools, ctx, Type, this.params.extraToolSchemas);
    const { harness, open } = await AgentHarness.create(
      {
        session,
        models,
        model,
        tools: harnessTools,
        toolContext: ctx,
        systemPrompt,
        // Auto-compaction is on by default in pi-agent-core; we pass it
        // explicitly so the policy is self-documenting and immune to a
        // future change in the library default. Combined with the model's
        // contextWindow (default 512k) this summarizes + trims history
        // before the provider rejects an oversized input.
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      },
      BACKGROUND_CONTEXT,
    );
    this.harness = harness;
    // A reopened session may carry an unfinished operation from a prior
    // crash. We don't resume it here (the orchestrator's checkpoint owns
    // recovery semantics); we just note it. The lane starts a fresh run.
    void open;
    // Enforce the turn cap: abort once the lane exceeds MAX_TURNS.
    this.offTurnEnd = harness.events.on("turn_end", (event) => {
      if ((event as HarnessLaneEvent).lane === laneName && ++this.turnCount >= MAX_TURNS) {
        this.abortController.abort();
      }
    });
    // Lifecycle: log every assistant message the lane emits so the operator
    // can see what the model actually produced. `message_update` events
    // carry incremental updates to the message buffer; we deduplicate by
    // tracking the last length we have already logged.
    this.offMessage = harness.events.on("message_update", (event) => {
      const payload = event as HarnessLaneEvent;
      if (payload.lane !== laneName) return;
      const entry = payload.entry as
        | { type?: string; message?: { role?: string; content?: unknown; stopReason?: string } }
        | undefined;
      if (!entry || entry.type !== "message") return;
      const msg = entry.message;
      if (!msg) return;
      const text = collectText(msg.content);
      if (text.length <= this.lastMessageSeenBytes) return;
      const newChunk = text.slice(this.lastMessageSeenBytes);
      this.lastMessageSeenBytes = text.length;
      ctx.logger.info(`[agent.${laneName}.llm_response]`, {
        lane: laneName,
        role: msg.role,
        stopReason: msg.stopReason,
        newBytes: newChunk.length,
        preview: truncate(newChunk, 4096),
      });
    });
    // Lifecycle: log token usage so the operator can spot runaway prompts.
    this.offUsage = harness.events.on("usage", (event) => {
      const payload = event as HarnessLaneEvent;
      if (payload.lane !== laneName) return;
      ctx.logger.info(`[agent.${laneName}.usage]`, {
        lane: laneName,
        ...payload.usage,
      });
    });
    // Force a fresh lane per run by suffixing the logical lane name with
    // a timestamp + random token. Reusing the same lane across runs
    // risks "LaneBusy" aborts when a prior run left an in-flight
    // operation registered in the lane state. The unique suffix makes
    // every run land on a brand-new lane; the per-issue session still
    // keeps the conversation transcript continuous.
    const freshLaneName = `${laneName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.lane = await harness.lane(freshLaneName, BACKGROUND_CONTEXT);
    // All event subscriptions and lifecycle log lines below key off
    // `laneName` (the logical name). Replace the logical name with the
    // fresh-lane name everywhere so event filtering keeps matching.
    this.params.laneName = freshLaneName;
    this.timer = setTimeout(() => this.abortController.abort(), RUN_TIMEOUT_MS);
    // Never let the watchdog timer hold the event loop open on its own;
    // it only needs to fire if the process is otherwise alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  async prompt(text: string): Promise<void> {
    if (!this.lane) throw new Error("harness engine not started");
    const ctx = withAbortSignal(this.abortController.signal, BACKGROUND_CONTEXT);
    const result = await this.lane.prompt(text, undefined, ctx);
    if (!result.ok) {
      const err = result.error as { message?: string; _tag?: string };
      throw new Error(`harness lane run failed: ${err?._tag ?? ""} ${err?.message ?? JSON.stringify(result.error)}`);
    }
    // pi-agent-core returns `result.ok = true` for "settled" runs even when
    // the operation itself failed (e.g. the model is not registered in the
    // Models collection — `error.code = "model_unavailable"`). The actual
    // failure is in `result.value.status === "failed"` plus
    // `result.value.error`. Propagate it explicitly so the caller sees the
    // real reason instead of a downstream "no assistant text" symptom.
    const value = result.value as
      | { status?: string; tipId?: string | null; error?: { code?: string; message?: string } }
      | undefined;
    if (value && value.status === "failed") {
      const errCode = value.error?.code ?? "unknown";
      const errMsg = value.error?.message ?? "unknown error";
      throw new Error(
        `harness lane operation failed (${errCode}): ${errMsg}; lane=${this.params.laneName}`,
      );
    }
    // Some Anthropic-compatible endpoints accept the request, return 200,
    // and emit a body that pi-agent-core parses as "ok with no assistant
    // message". The user prompt entry is written so `tipId` is non-null,
    // but the lane has no assistant text to give the caller — and
    // `finalText()` then returns "". Detect by scanning for any assistant
    // entry after the prompt; if none, raise the transient-empty-response
    // error so the retry wrapper can decide what to do.
    const entries = await this.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const hasAssistant = entries.some((entry) => {
        if (entry.type !== "message") return false;
        const message = (entry as { message?: { role?: string } }).message;
        return message?.role === "assistant";
    });
    if (!hasAssistant) {
      throw new Error(
        `harness lane produced no assistant entries (model returned empty response); ` +
        `lane=${this.params.laneName}`,
      );
    }
  }

  async finalText(): Promise<string> {
    if (!this.lane) throw new Error("harness engine not started");
    // `oldestFirst` so the transcript is chronological — collectLatest…
    // walks backwards from the newest entry. The default (newestFirst)
    // would make the backward walk return the OLDEST assistant text.
    const entries = await this.lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const messages = entries
      .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
      .map((e) => e.message);
    return collectLatestAssistantText(messages);
  }

  async diagnostics(): Promise<string> {
    return `lane=${this.params.laneName} turns=${this.turnCount} aborted=${this.abortController.signal.aborted}`;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.offTurnEnd) this.offTurnEnd();
    if (this.offMessage) this.offMessage();
    if (this.offUsage) this.offUsage();
    if (this.harness) await this.harness.close(BACKGROUND_CONTEXT).catch(() => {});
    this.harness = null;
    this.lane = null;
  }
}

/**
 * Latest assistant text from a transcript: walk backwards and return the
 * newest assistant message's concatenated text blocks, skipping older
 * intermediate reasoning so the parser only sees the final answer.
 */
export function collectLatestAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      if (m.content.trim()) return m.content;
      continue;
    }
    if (Array.isArray(m.content)) {
      let text = "";
      for (const part of m.content) {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
      if (text.trim()) return text;
    }
  }
  return "";
}

/**
 * Concatenate the text parts of a message's content array (or return the
 * raw string when content is a plain string). Used by the lifecycle
 * observer to project both legacy string-content and structured-content
 * Anthropic responses into a single text string for logging.
 */
export function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text" && typeof p.text === "string") out += p.text;
    }
    return out;
  }
  return "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
