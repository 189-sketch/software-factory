/**
 * Claude Code CLI backend adapter — TypeScript declarations.
 * See `claude-code-backend.mjs` for the runtime contract and
 * `specs/2026-09-16-unified-agent-runtime/requirements.md` for the
 * StageRunResult status union semantics.
 */
import type { AgentConfig } from "./agent-backends.d.mts";

export interface ClaudeCodeRequest {
    role: string;
    runId: string;
    issue: { number: number; repo: { workdir: string } };
    artifactId?: string;
    inputManifest: { systemPrompt: string; messages: string[] };
    rules?: string[];
    skills?: string[];
    model?: string;
    timeoutMs?: number;
    /** M6: UUID passed to `claude --resume` to continue a prior session. */
    resumeSessionId?: string;
    sessionId?: string;
    agents?: string;
    /** Per-run factory MCP configuration; never persisted in public state. */
    mcpConfig?: string;
    nativeTools?: string;
    compactSession?: boolean;
}

export interface ClaudeCodeStdoutPayload {
    status: "succeeded" | "format-error";
    output: string;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    warnings?: string[];
    /** M6: CLI session UUID, present when the envelope reported one. */
    providerSessionId?: string;
}

export type ClaudeCodeStageStatus =
    | "succeeded"
    | "failed"
    | "format-error"
    | "interrupted"
    | "cancelled";

export interface ClaudeCodeStageResult {
    status: ClaudeCodeStageStatus;
    output: string;
    // Optional: error / format-error / cancelled branches surface
    // diagnostics in `warnings` + `logTail` rather than a structured
    // payload. The succeeded branch carries the parsed CLI output
    // object so callers can pull typed fields without re-parsing.
    structuredOutput?: unknown;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    logTail: string;
    backend: "claude-code";
    warnings: string[];
    retryable: boolean;
    failureCode?: string;
    contextCompacted?: boolean;
    contextUsage?: {tokens:number;window:number};
    /** M6: CLI session UUID; captured from the envelope's `session_id`. */
    providerSessionId?: string | null;
}

export interface ClaudeCodeAdapterOptions {
    executable: string;
    model?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
    /** M6: forwarded to `claude --resume`; undefined = new session. */
    resumeSessionId?: string;
    stderrLogger?: (line: string) => void;
    progressLogger?: (event: ClaudeCodeProgress) => void;
    /**
     * Content stream sink. Separate from `progressLogger`, which stays
     * metadata-only by contract. Omit to keep the historical behaviour
     * (the parsed stream is discarded).
     */
    streamLogger?: (record: ClaudeCodeStreamRecord) => void;
}

export interface ClaudeCodeProgress {
    event: string;
    elapsedMs: number;
    idleMs: number;
    phase: string;
    timeoutMs: number;
    tool?: string;
    durationMs?: number;
    isError?: boolean;
    status?: ClaudeCodeStageStatus;
    retryable?: boolean;
    tools?: string[];
    mcpServers?: Array<{name:string;status:string}>;
}

/**
 * Normalized content-stream record. Carries the agent's own output —
 * model text, thinking blocks, tool calls and tool results — with
 * credential-shaped values already redacted by the adapter.
 */
export type ClaudeCodeStreamKind =
    | "system"
    | "text"
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "delta-text"
    | "delta-thinking"
    | "result"
    /** Emitted by the transcript sink when the run ends. */
    | "run-finished"
    /** Emitted by the transcript sink when the byte budget is spent. */
    | "budget-exhausted";

export interface ClaudeCodeStreamRecord {
    kind: ClaudeCodeStreamKind;
    /** Text payload: model text, tool output, or the final result. */
    text?: string;
    /** Tool name for `tool-call` / `tool-result` records. */
    tool?: string;
    /** Serialized tool arguments for `tool-call` records. */
    input?: string;
    /** True when the tool reported an error. */
    isError?: boolean;
    /** System event subtype (`init`, `compact_boundary`, …). */
    subtype?: string;
}

export function runClaudeCodeStage(
    request: ClaudeCodeRequest,
    options: ClaudeCodeAdapterOptions,
): Promise<ClaudeCodeStageResult>;

export function runClaudeCodeStageFromConfig(
    config: AgentConfig,
    executable: string,
    request: ClaudeCodeRequest,
    extra?: {
        env?: NodeJS.ProcessEnv;
        abortSignal?: AbortSignal;
        progressLogger?: (event: ClaudeCodeProgress) => void;
        streamLogger?: (record: ClaudeCodeStreamRecord) => void;
    },
): Promise<ClaudeCodeStageResult>;

/** Credential redactor shared by the failure tail, warnings and the content stream. */
export function createRedactor(env?: NodeJS.ProcessEnv): (text: string) => string;
