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
   * agent contract, not the backend. */
  inputManifest: {
    systemPrompt: string;
    userPrompt: string;
    contextTurns?: string[];
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
  /** Drive one stage run. Implementation lands in Task 1.4. */
  runStage(request: StageRunRequest): Promise<StageRunResult>;
  /** Look up the descriptor for a backend id. */
  describeBackend(id: AgentBackend): BackendDescriptor;
}