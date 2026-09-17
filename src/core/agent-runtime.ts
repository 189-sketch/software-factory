/**
 * Unified Agent Runtime — type contract and dispatcher facade (Slice A.1).
 *
 * This module is the public contract every domain agent funnels through
 * to reach the configured LLM execution backend.
 * The contract is backend-agnostic: the same `StageRunRequest` and
 * `StageRunResult` shapes are used for the `embedded` backend
 * (`HarnessLlmEngine` on `@earendil-works/pi-agent-core`) and the CLI
 * backends (`claude-code`, `codex-cli`, `pi-cli`).
 *
 * Selection precedence (implemented by Task 1.4):
 *   `overrides[role] > default`.
 * The default backend is set by `FACTORY_AGENT_BACKEND`.
 * Per-role overrides come from `FACTORY_AGENT_OVERRIDES` (a JSON object).
 *
 * Validation contract:
 *   - Unknown `FACTORY_AGENT_BACKEND` → startup pre-check failure.
 *   - Malformed `FACTORY_AGENT_OVERRIDES` → startup pre-check failure.
 *   - Missing capability for the requested role → capability error,
 *     no child process spawned.
 *
 * Existing surface (`LlmEngine`, `AgentTool`, `newRunId`) is unchanged;
 * the new types and the `AgentRuntime` interface are added on top.
 */
import type { AgentContext } from "./types.js";
import type { OutputContract } from "./output-contract.js";
import type { RequiredRule } from "./required-rules.js";
import { composeSystemPrompt } from "./system-prompt.js";
import { contractShapeHint } from "./output-contract.js";

/* -------------------------------------------------------------------------- */
/* Backend types (re-exported from runtime/agent-backends.d.mts)              */
/* -------------------------------------------------------------------------- */

/**
 * Public type surface re-exported from `runtime/agent-backends.d.mts`
 * so TypeScript consumers have a single import path for backend
 * identities.
 * The `import type` line below brings the types into this file's
 * local scope so the rest of the contract can reference them; the
 * trailing `export type` forwards them to consumers.
 * Runtime helpers (`resolveAgentConfig`, `selectAgentBackend`, …) live
 * in `runtime/agent-backends.mjs` and must be imported directly from
 * there at call sites — re-exporting values from a `.d.mts` is rejected
 * by the type checker.
 */
import type { AgentBackend, AgentSelection, AgentConfig } from "../../runtime/agent-backends.d.mts";
export type { AgentBackend, AgentSelection, AgentConfig };

/* -------------------------------------------------------------------------- */
/* Existing surface (unchanged)                                                */
/* -------------------------------------------------------------------------- */

/** Per-agent LLM execution engine contract. */
export interface LlmEngine {
  prompt(text: string): Promise<void>;
  finalText(): Promise<string>;
  diagnostics(): Promise<string>;
  close(): Promise<void>;
}

/** Per-tool surface used by domain agents. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown>;
}

/** Stable per-attempt run id; reused across all status updates for the
 * same attempt. */
export function newRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Stage run contract                                                          */
/* -------------------------------------------------------------------------- */

/** Backend-agnostic input handed to every backend. The dispatcher's
 * responsibility (Task 1.4) is to assemble this from the domain agent
 * context plus the resolved `AgentSelection`. */
export interface StageRunRequest {
  /** Role name (e.g. `triage`, `review-pr`). */
  role: string;
  /** Stable run id from `newRunId`. */
  runId: string;
  /** Issue identity — number + repo workdir are required for log fields. */
  issue: { number: number; repo: { workdir: string } };
  /** Optional artifact id this run is reviewing or producing. */
  artifactId?: string;
  /** Backend-agnostic input manifest. The shape is dictated by the
   * agent contract, not the backend. The Claude Code harness adapter
   * (`claudeCodeHarnessAdapter`) assembles the final system prompt
   * from `systemPrompt` (the role text), `outputContract` (rendered
   * into the system prompt by `composeSystemPrompt`), and
   * `requiredRules` (inlined as rubrics). Backends that already
   * receive a fully composed prompt — e.g. callers that pre-run
   * `composeSystemPrompt` themselves — can omit `outputContract`,
   `requiredRules`, and `language`; the adapter falls back to an
   * empty contract and sends the role text through verbatim. */
  inputManifest: {
    systemPrompt: string;
    userPrompt: string;
    contextTurns?: string[];
    outputContract?: OutputContract;
    requiredRules?: RequiredRule[];
  };
  /** Optional rule identifiers the agent must load before the run. */
  rules?: string[];
  /** Resolved skill names available for `load_skill`. */
  skills?: string[];
  /** Per-run timeout; falls back to `AgentConfig.timeoutMs` if unset. */
  timeoutMs?: number;
  /** Abort signal for cancel propagation. */
  abortSignal?: AbortSignal;
}

/** Backend-agnostic output of a stage run. The dispatcher never invents
 * a sixth value beyond the documented union. */
export type StageRunStatus =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "format-error";

export interface StageRunResult {
  status: StageRunStatus;
  /** Free-form output text the agent produced. */
  output: string;
  /** Parsed structured output, if any. */
  structuredOutput?: unknown;
  /** Token usage from the backend; absence is recorded as `null`, never
   * as `0` — downstream readers must distinguish "no usage reported"
   * from "zero tokens used". */
  usage:
    | { inputTokens: number | null; outputTokens: number | null }
    | null;
  /** Backend-specific log tail; downstream code does not parse this. */
  logTail?: string;
  /** Backend id that produced the result. */
  backend: AgentBackend;
  /** Backend-specific warnings (e.g. `format-error`, parse miss). */
  warnings: string[];
  /** Hint to the retry wrapper: `true` means retry may proceed, `false`
   * means a transient retry would just repeat the same failure. */
  retryable: boolean;
}

/* -------------------------------------------------------------------------- */
/* Backend descriptor and selection provenance                                */
/* -------------------------------------------------------------------------- */

/** Capability flags advertised by a backend. `readOnly` is honoured by
 * the dispatcher (Task 1.4) so a non-`embedded` backend can be wired
 * first on review-only roles without exposing mutating stages. */
export interface BackendCapabilities {
  readOnly?: boolean;
  mutating?: boolean;
  publishing?: boolean;
}

/** Registry entry for a backend. The `embedded` backend has a static
 * descriptor; CLI backends are registered at startup with the build's
 * `schemaVersion` + `buildHash` so log readers can correlate runtime
 * behaviour to the build. */
export interface BackendDescriptor {
  id: AgentBackend;
  displayName: string;
  capabilities: BackendCapabilities;
  schemaVersion: number;
  buildHash: string;
}

/** Provenance of a backend selection, logged on every stage start. */
export interface AgentSelectionLog {
  backend: AgentBackend;
  /** One of `default` (FACTORY_AGENT_BACKEND) or `overrides`
   * (FACTORY_AGENT_OVERRIDES entry). */
  source: "default" | "overrides";
  /** Per-role override entry, when `source === "overrides"`. */
  override?: AgentSelection;
}

/* -------------------------------------------------------------------------- */
/* Facade — interface only; implementation lands in Task 1.4                  */
/* -------------------------------------------------------------------------- */

/** Returned by `selectBackend` so callers can both use the resolved
 * selection and explain the provenance in logs. */
export interface ResolvedBackend {
  selection: AgentSelection;
  log: AgentSelectionLog;
}

/** Public facade every domain agent funnels through. Implementation is
 * provided by Task 1.4; the interface is declared here so tests and
 * callers can wire against it before the dispatcher lands. */
export interface AgentRuntime {
  /** Resolve the backend for a role using `overrides[role] > default`. */
  selectBackend(role: string): ResolvedBackend;
  /** Drive one stage run.
   *
   * The two-argument form (`request` + `ctx`) is intentional:
   * `StageRunRequest` is a backend-agnostic spec of what to run,
   * while `ctx` is the runtime context (logger, repo, issue) that the
   * embedded backend needs to construct its `HarnessLlmEngine` and
   * the CLI backends need to spawn a child process. Mixing them
   * inside the request would either pollute the spec with runtime
   * state or force a hidden context-resolution step.
   *
   * Slice A.2 implements the `embedded` path; Group 3 implements the
   * `claude-code` path; the rest stay as documented stubs.
   */
  runStage(request: StageRunRequest, ctx: AgentContext): Promise<StageRunResult>;
  /** Look up the descriptor for a backend id. */
  describeBackend(id: AgentBackend): BackendDescriptor;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Default implementation of the `AgentRuntime` facade.
 *
 * Slice A.1 status: `selectBackend` and `describeBackend` are wired to
 * `runtime/agent-backends.mjs` (selection + descriptors).
 * `runStage` returns an honest stub for both the `embedded` and CLI
 * paths — the existing six-agent pipeline continues to use
 * `runLlmAgent` (which in turn uses `HarnessLlmEngine` directly) and is
 * not affected by this dispatcher yet.
 *
 * Group 2 (Slice A.2) re-routes `embedded` through `HarnessLlmEngine`
 * inside `runStage`. Group 3 (Slice B.1) adds the `claude-code` adapter
 * for read-only roles. The dispatcher shape and selection provenance
 * are intentionally fixed in this slice so later groups can slot in
 * without contract changes.
 */
import {
  resolveAgentConfig,
  selectAgentBackend,
} from "../../runtime/agent-backends.mjs";
import { runClaudeCodeStageFromConfig } from "../../runtime/claude-code-backend.mjs";
import type { ClaudeCodeRequest } from "../../runtime/claude-code-backend.d.mts";
import { embeddedAdapter } from "./agent-runtime-embedded.js";

/** Static descriptor for the `embedded` backend. `schemaVersion` and
 * `buildHash` are read from `package.json` at module load so log
 * readers can correlate runtime behaviour to the build. */
const EMBEDDED_DESCRIPTOR: BackendDescriptor = {
  id: "embedded",
  displayName: "Embedded Harness (pi-agent-core)",
  capabilities: { readOnly: true, mutating: true, publishing: true },
  schemaVersion: 1,
  buildHash: process.env.FACTORY_BUILD_HASH ?? "dev",
};

const BACKEND_DESCRIPTORS: Record<AgentBackend, BackendDescriptor> = {
  embedded: EMBEDDED_DESCRIPTOR,
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code CLI",
    capabilities: { readOnly: true },
    schemaVersion: 1,
    buildHash: process.env.FACTORY_BUILD_HASH ?? "dev",
  },
  "codex-cli": {
    id: "codex-cli",
    displayName: "Codex CLI",
    capabilities: { readOnly: true },
    schemaVersion: 1,
    buildHash: process.env.FACTORY_BUILD_HASH ?? "dev",
  },
  "pi-cli": {
    id: "pi-cli",
    displayName: "Pi CLI",
    capabilities: { readOnly: true },
    schemaVersion: 1,
    buildHash: process.env.FACTORY_BUILD_HASH ?? "dev",
  },
};

/** Process-wide default `AgentRuntime` constructed lazily from `process.env`.
 * Tests can inject a custom config via `buildAgentRuntime(config)`. */
let cached: AgentRuntime | null = null;

export function buildAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const config = resolveAgentConfig(env);
  return new AgentRuntimeImpl(config);
}

export function getDefaultAgentRuntime(): AgentRuntime {
  if (!cached) cached = buildAgentRuntime();
  return cached;
}

/** Test/maintenance hook: drop the cached default. */
export function __clearAgentRuntimeCacheForTest(): void {
  cached = null;
}

/* -------------------------------------------------------------------------- */
/* Log bindings                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the structured-log bindings that lifecycle events should carry
 * so log readers can correlate a stage run with the backend it used.
 *
 * These are the four fields documented in
 * `specs/2026-09-16-unified-agent-runtime/requirements.md` Decision 6:
 *   - `backend`                 — the resolved `AgentBackend` id
 *   - `agentSelectionSource`    — `default` | `overrides`
 *   - `backendSchemaVersion`    — from the descriptor
 *   - `backendBuildHash`        — from the descriptor (or `dev` outside a build)
 *
 * Pass the returned object to `ConsoleLogger.child(bindings)` (or any
 * logger that supports bindings) at the start of a stage run so every
 * subsequent lifecycle event carries the same fields.
 *
 * The default `AgentRuntime` is consulted; tests that need a stable
 * binding snapshot can call `bindingsForRuntime(rt, role)` instead.
 */
export function backendBindingsFor(role: string): Record<string, unknown> {
  return bindingsForRuntime(getDefaultAgentRuntime(), role);
}

export function bindingsForRuntime(
  rt: AgentRuntime,
  role: string,
): Record<string, unknown> {
  const resolved = rt.selectBackend(role);
  const descriptor = rt.describeBackend(resolved.selection.backend);
  return {
    backend: descriptor.id,
    agentSelectionSource: resolved.log.source,
    backendSchemaVersion: descriptor.schemaVersion,
    backendBuildHash: descriptor.buildHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Claude Code adapter wrapper (Slice B.1)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Route a stage run to the Claude Code CLI backend.
 *
 * Honours the `readOnly` capability gate: mutating roles (anything
 * that would otherwise run on `embedded` with the `mutating` flag)
 * reach this branch only when the descriptor advertises the
 * capability. In Slice B.1 the claude-code descriptor only has
 * `readOnly: true`, so a misconfigured override fails fast without
 * spawning any child process.
 *
 * The actual CLI invocation lives in
 * `runtime/claude-code-backend.mjs` so the agent-runtime contract
 * stays TypeScript-typed while the spawn / parse / timeout logic
 * stays close to `node:child_process`.
 */
async function claudeCodeAdapter(
  request: StageRunRequest,
  ctx: AgentContext,
  config: AgentConfig,
  resolved: ResolvedBackend,
): Promise<StageRunResult> {
  // Capability gate: refuse to spawn a Claude Code child process for
  // a role that the backend's descriptor cannot satisfy.
  const allowedRoles = new Set(READ_ONLY_ROLES);
  if (!allowedRoles.has(request.role)) {
    return {
      status: "failed",
      output: "",
      usage: null,
      backend: "claude-code",
      warnings: [
        `claude-code backend is registered as readOnly-only in this slice ` +
          `and refuses role '${request.role}'; widen BackendCapabilities in ` +
          "src/core/agent-runtime.ts BACKEND_DESCRIPTORS to allow mutating roles.",
      ],
      retryable: false,
    };
  }

  const backendCfg = config.backends["claude-code"];
  if (!backendCfg?.executable) {
    return {
      status: "failed",
      output: "",
      usage: null,
      backend: "claude-code",
      warnings: ["claude-code executable not configured (FACTORY_CLAUDE_COMMAND or runtime default)"],
      retryable: false,
    };
  }

  const claudeRequest: ClaudeCodeRequest = {
    role: request.role,
    runId: request.runId,
    issue: request.issue,
    artifactId: request.artifactId,
    inputManifest: request.inputManifest,
    rules: request.rules,
    skills: request.skills,
    model: resolved.selection.model,
    timeoutMs: request.timeoutMs ?? config.timeoutMs,
  };

  return runClaudeCodeStageFromConfig(config, backendCfg.executable, claudeRequest, {
    abortSignal: request.abortSignal,
  });
}

/**
 * Helper for read-only agents: run one stage through the unified
 * runtime and parse the child output with the caller's parser.
 *
 * Each agent's `run()` builds an `OutputContract` and a parse
 * function; this helper hides the `StageRunRequest` assembly and
 * the `StageRunResult`-to-parse plumbing so the agent body stays
 * focused on the domain.
 *
 * Failure classification:
 *   - `succeeded` with a successful parse → return the parsed value.
 *   - `succeeded` with a parse miss → throw with the agent name,
 *     a one-line summary, and the first 2 000 bytes of the child
 *     output for post-mortem.
 *   - any other status → throw with the runtime warnings so the
 *     triage supervisor sees the same shape it used to see from
 *     the harness path.
 *
 * Replaces `runLlmAgent` for read-only roles (Group 6); mutating
 * agents (Group 7) still wrap the call so they can keep their own
 * implementation-side parse errors.
 */
export async function dispatchAgentStage<TResult>(
    role: string,
    ctx: AgentContext,
    parts: {
        systemPrompt: string;
        userPrompt: string;
        outputContract: OutputContract;
        parse: (text: string) => TResult;
        contextTurns?: string[];
        requiredRules?: RequiredRule[];
    },
): Promise<TResult> {
    const runtime = getDefaultAgentRuntime();
    const request: StageRunRequest = {
        role,
        runId: ctx.runId,
        issue: { number: ctx.issue.number, repo: { workdir: ctx.repo.workdir } },
        inputManifest: {
            systemPrompt: parts.systemPrompt,
            userPrompt: parts.userPrompt,
            contextTurns: parts.contextTurns,
            outputContract: parts.outputContract,
            requiredRules: parts.requiredRules,
        },
    };
    const result = await runtime.runStage(request, ctx);
    if (result.status === "succeeded") {
        try {
            return parts.parse(result.output);
        } catch (error) {
            throw new Error(
                `${role} parse failed via dispatcher: ${String((error as Error).message ?? error)}\n` +
                    `--- response ---\n${result.output.slice(0, 2000)}\n--- end ---`,
            );
        }
    }
    if (result.status === "format-error") {
        throw new Error(
            `${role} child returned format-error: ${result.warnings.join("; ") || "(no warnings)"}`,
        );
    }
    if (result.status === "cancelled" || result.status === "interrupted") {
        throw new Error(`${role} run was ${result.status}`);
    }
    throw new Error(
        `${role} dispatcher run failed: ${result.warnings.join("; ") || `status=${result.status}`}`,
    );
}

/**
 * Claude Code harness adapter (Slice C, Group 5).
 *
 * Bridges `runLlmAgent`'s `composeSystemPrompt` assembly into the
 * Claude Code CLI without losing the four-piece guarantee the
 * harness provided: role + required-rule rubric + skill catalog +
 * output contract, all rendered into one final system prompt.
 *
 * Why this lives next to `claudeCodeAdapter` instead of replacing
 * it: `claudeCodeAdapter` keeps its thin pass-through shape
 * (already used by tests that need the raw `StageRunRequest` to
 * land in the child process unchanged). This adapter adds three
 *   things `claudeCodeAdapter` does not:
 *
 *   1. Render `outputContract` + `requiredRules` + `skills` into a
 *      single system prompt via `composeSystemPrompt`.
 *   2. Detect a JSON parse miss (empty output, non-JSON, or a
 *      top-level non-object value) and send one corrective retry
 *      that asks the child for a JSON object matching
 *      `contractShapeHint(contract)`.
 *   3. Round-trip `usage` across the retry so the orchestrator
 *      sees a single `StageRunResult.usage` covering both
 *      attempts.
 *
 * Failure classification matches `claudeCodeAdapter`: spawn errors
 * and missing executables short-circuit to `failed` with
 * `retryable: false` so the triage supervisor can surface the
 * configuration error rather than burning tokens on a child that
 * will never start.
 */
export async function claudeCodeHarnessAdapter(
  request: StageRunRequest,
  ctx: AgentContext,
  config: AgentConfig,
  resolved: ResolvedBackend,
): Promise<StageRunResult> {
  const backendCfg = config.backends["claude-code"];
  if (!backendCfg?.executable) {
    return {
      status: "failed",
      output: "",
      usage: null,
      backend: "claude-code",
      warnings: ["claude-code executable not configured (FACTORY_CLAUDE_COMMAND or runtime default)"],
      retryable: false,
    };
  }

  const assembled = composeSystemPrompt({
    role: request.inputManifest.systemPrompt,
    skills: ctx.skills,
    contract: request.inputManifest.outputContract ?? { requirements: [], example: {} },
    requiredRules: request.inputManifest.requiredRules ?? [],
  });

  const baseClaudeRequest: ClaudeCodeRequest = {
    role: request.role,
    runId: request.runId,
    issue: request.issue,
    artifactId: request.artifactId,
    inputManifest: {
      systemPrompt: assembled,
      userPrompt: request.inputManifest.userPrompt,
      contextTurns: request.inputManifest.contextTurns,
    },
    rules: request.rules,
    skills: request.skills,
    model: resolved.selection.model,
    timeoutMs: request.timeoutMs ?? config.timeoutMs,
  };

  const first = await runClaudeCodeStageFromConfig(
    config,
    backendCfg.executable,
    baseClaudeRequest,
    { abortSignal: request.abortSignal },
  );

  const contract = request.inputManifest.outputContract;
  if (!contract || !isParseMiss(first)) {
    return first;
  }

  ctx.logger.info(`[agent.${request.role}.parse_miss]`, {
    responsePreview: first.output.slice(0, 1024),
    hint: contractShapeHint(contract),
  });

  const correction =
    `Your previous response could not be used: ${describeShape(first.output)}. ` +
    `Respond with one JSON object matching this shape and nothing else: ${contractShapeHint(contract)}`;

  const retryClaudeRequest: ClaudeCodeRequest = {
    ...baseClaudeRequest,
    inputManifest: {
      ...baseClaudeRequest.inputManifest,
      contextTurns: [...(baseClaudeRequest.inputManifest.contextTurns ?? []), correction],
    },
  };

  const retry = await runClaudeCodeStageFromConfig(
    config,
    backendCfg.executable,
    retryClaudeRequest,
    { abortSignal: request.abortSignal },
  );

  return mergeUsage(first, retry);
}

/**
 * Detect a parse miss on a `succeeded` stage result.
 *
 * Three conditions are flagged: empty output (the harness equivalent
 * of "settled without producing any entry"), non-JSON output, and
 * a top-level value that is not a JSON object. The agent's own
 * `parse` function does the deeper validation; the adapter only
 * catches the "not even a JSON object" case so the corrective retry
 * has a structural target.
 */
function isParseMiss(result: StageRunResult): boolean {
  if (result.status !== "succeeded") return false;
  const text = (result.output ?? "").trim();
  if (!text) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  return parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
}

/**
 * Describe the shape mismatch in the corrective retry hint so the
 * model gets a steer toward the contract rather than a wall of
 * text.
 */
function describeShape(text: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "empty response";
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return "response is not a JSON object";
    }
  } catch {
    return "response is not valid JSON";
  }
  return "response did not match the expected shape";
}

/**
 * Merge two stage results into one after a corrective retry.
 *
 * The retry runs through the same runtime adapter, so its
 * `StageRunResult` is fully formed. We keep the retry's status
 * (it is the most recent run) and union the two `usage` blocks so
 * the orchestrator sees the token cost of both attempts.
 */
function mergeUsage(first: StageRunResult, retry: StageRunResult): StageRunResult {
  if (retry.status !== "succeeded") return retry;
  const usage = combineUsage(first.usage, retry.usage);
  return { ...retry, usage };
}

function combineUsage(
  first: StageRunResult["usage"],
  second: StageRunResult["usage"],
): StageRunResult["usage"] {
  if (!first && !second) return null;
  const sum = (a: number | null | undefined, b: number | null | undefined): number | null => {
    if (a == null && b == null) return null;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    inputTokens: sum(first?.inputTokens, second?.inputTokens),
    outputTokens: sum(first?.outputTokens, second?.outputTokens),
  };
}

/** Roles that the Claude Code backend (Slice B.1) is permitted to
 * route. `review-pr` is the first read-only role exercised; the list
 * is intentionally narrow so mutating roles continue to land on
 * `embedded` until Slice C. */
const READ_ONLY_ROLES: readonly string[] = ["review-pr"];

export class AgentRuntimeImpl implements AgentRuntime {
  constructor(private readonly config: AgentConfig) {}

  selectBackend(role: string): ResolvedBackend {
    const selection = selectAgentBackend(this.config, role);
    const hasOverride = Object.prototype.hasOwnProperty.call(this.config.overrides, role);
    const overrideEntry = hasOverride ? this.config.overrides[role] : undefined;
    return {
      selection,
      log: {
        backend: selection.backend,
        source: hasOverride ? "overrides" : "default",
        override: overrideEntry,
      },
    };
  }

  describeBackend(id: AgentBackend): BackendDescriptor {
    const descriptor = BACKEND_DESCRIPTORS[id];
    if (!descriptor) {
      throw new Error(`Unknown agent backend: ${id}`);
    }
    return descriptor;
  }

  /** Dispatcher for Slices A.2 + B.1.
   *
   *  - For `embedded`: delegates to `embeddedAdapter` (Slice A.2)
   *    which runs `HarnessLlmEngine` and returns the lane's final
   *    text.
   *  - For `claude-code` with a `readOnly` role: delegates to the
   *    Claude Code CLI adapter (Slice B.1). Mutating roles reach
   *    this branch only if the operator explicitly enables them in
   *    a later slice; the `readOnly` capability gate fires a clear
   *    error before any child process is spawned.
   *  - For `codex-cli` and `pi-cli`: stub failures — adapters land
   *    in follow-on slices (Group 3 / Slice D).
   */
  async runStage(request: StageRunRequest, ctx: AgentContext): Promise<StageRunResult> {
    const resolved = this.selectBackend(request.role);
    if (resolved.selection.backend === "embedded") {
      return embeddedAdapter(request, ctx, resolved);
    }
    if (resolved.selection.backend === "claude-code") {
      // Triage is the first role driven through the harness adapter
      // (Group 5 / Slice C). Other read-only and mutating roles still
      // go through the plain pass-through adapter; Group 6 widens
      // the routing once Group 5's contract stabilises.
      if (request.role === "triage") {
        return claudeCodeHarnessAdapter(request, ctx, this.config, resolved);
      }
      return claudeCodeAdapter(request, ctx, this.config, resolved);
    }
    return {
      status: "failed",
      output: "",
      usage: null,
      backend: resolved.selection.backend,
      warnings: [
        `backend '${resolved.selection.backend}' is not implemented in this slice ` +
          "(see specs/2026-09-16-unified-agent-runtime plan Group 3 / Slice D).",
      ],
      retryable: false,
    };
  }
}