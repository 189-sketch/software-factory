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
    inputManifest: { systemPrompt: string; userPrompt: string; contextTurns?: string[] };
    rules?: string[];
    skills?: string[];
    model?: string;
    timeoutMs?: number;
}

export interface ClaudeCodeStdoutPayload {
    status: "succeeded" | "format-error";
    output: string;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    warnings?: string[];
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
}

export interface ClaudeCodeAdapterOptions {
    executable: string;
    model?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
    stderrLogger?: (line: string) => void;
}

export function runClaudeCodeStage(
    request: ClaudeCodeRequest,
    options: ClaudeCodeAdapterOptions,
): Promise<ClaudeCodeStageResult>;

export function runClaudeCodeStageFromConfig(
    config: AgentConfig,
    executable: string,
    request: ClaudeCodeRequest,
    extra?: { env?: NodeJS.ProcessEnv; abortSignal?: AbortSignal },
): Promise<ClaudeCodeStageResult>;