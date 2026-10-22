/**
 * Agent content stream — operator-local transcript of one stage run.
 *
 * The Claude Code CLI answers a stage with a newline-delimited event
 * stream (`--output-format stream-json --verbose`). The runtime parses
 * that stream for the final result envelope and, through
 * `progressLogger`, reports ONLY metadata about it (tool names, phase
 * transitions, byte counters). That metadata contract is deliberate:
 * progress events reach the control panel and the durable state, so
 * they must never carry prompt text, tool arguments or model output.
 *
 * This module is the OTHER half of the observation story: a transcript
 * of what the agent actually did, written to a per-run file under the
 * runtime state directory and echoed as one bounded summary line per
 * event so an operator watching the daemon console sees the run live.
 *
 * Rules that keep the transcript safe to keep on disk:
 *   - credential-shaped values are redacted before anything is written
 *     (the same redaction the failure tail already uses, applied to
 *     the worker's own environment as well as the child's);
 *   - every record is bounded, and the whole file is bounded by a byte
 *     budget, so one enormous tool result cannot exhaust the disk;
 *   - the summary channel carries a short preview only — the full
 *     payload stays in the file.
 *
 * The stream mode is operator-controlled:
 *   - `off`  — no transcript at all.
 *   - `on`   — model text, tool calls, tool results, system events.
 *   - `full` — `on` plus model thinking blocks and partial deltas.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRedactor } from "../../runtime/claude-code-backend.mjs";
import type { ClaudeCodeStreamRecord } from "../../runtime/claude-code-backend.d.mts";
import type { AgentStreamMode } from "../../runtime/agent-backends.d.mts";

/** Record kinds that only the `full` mode emits. */
const FULL_ONLY_KINDS = new Set<string>(["thinking", "delta-text", "delta-thinking"]);

/** Maximum characters kept for one transcript record payload. */
const MAX_RECORD_CHARS = 256 * 1024;

/** Maximum characters kept in one console summary preview. */
const MAX_PREVIEW_CHARS = 160;

/** Maximum characters kept in one tool-call argument preview. */
const MAX_TOOL_PREVIEW_CHARS = 200;

/**
 * System subtypes that carry no operational signal.
 *
 * The Claude Code CLI emits these as internal ticks — `status` on every
 * turn boundary, `thinking_tokens` while the model reasons. They stay
 * in the transcript (the file is the complete record) but never reach
 * the operator's console, where they would bury the tool calls.
 */
const SILENT_SYSTEM_SUBTYPES = new Set(["status", "thinking_tokens"]);

export type AgentStreamRecord = ClaudeCodeStreamRecord;

export interface AgentStreamSink {
  /** Persist one record and emit its console summary. */
  write(record: AgentStreamRecord): void;
  /** Close the transcript. Writes are synchronous, so this only flushes counters. */
  close(): void;
  /** Absolute path of the transcript file (empty until the first record). */
  readonly file: string;
  /** How many records of each kind were observed. */
  readonly counts: Readonly<Record<string, number>>;
  /** True when the byte budget stopped the transcript from growing. */
  readonly budgetExhausted: boolean;
}

export interface AgentStreamSinkOptions {
  mode: AgentStreamMode;
  /** Transcript directory. */
  dir: string;
  /** Maximum bytes written to one transcript file. */
  maxBytes: number;
  issue: number;
  role: string;
  runId: string;
  /** Where the one-line console summary goes. Defaults to stderr. */
  summary?: (line: string) => void;
}

/**
 * True when `target` is inside `root` (or is `root` itself).
 */
function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve the transcript directory.
 *
 * A configured directory wins. Otherwise the transcript lives beside
 * the runtime state (`<state>/streams`) so it is covered by the same
 * lifecycle as the checkpoints.
 *
 * The transcript MUST NOT land inside the product worktree: the
 * implementation stage stages the worktree with `git add -A -- :!factory/`,
 * which excludes only `factory/`. A transcript written into the
 * checkout would be committed and pushed as product data. When the
 * resolved directory would fall inside the checkout — or when no state
 * directory is available at all — the transcript goes to the OS temp
 * directory instead: outside every checkout, and still readable by the
 * operator for the lifetime of the machine.
 */
export function resolveStreamDirectory(configured: string, stateRoot: string | undefined, workdir?: string): string {
  const candidate = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(stateRoot ?? os.tmpdir(), configured))
    : stateRoot
      ? path.join(stateRoot, "streams")
      : path.join(os.tmpdir(), "factory-streams");
  if (workdir && inside(workdir, candidate)) return path.join(os.tmpdir(), "factory-streams");
  return candidate;
}

/**
 * True when the resolved transcript directory was redirected away from
 * the requested one because it pointed inside the product checkout.
 */
export function streamDirectoryRedirected(configured: string, stateRoot: string | undefined, workdir: string): boolean {
  const requested = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(stateRoot ?? os.tmpdir(), configured))
    : stateRoot
      ? path.join(stateRoot, "streams")
      : path.join(os.tmpdir(), "factory-streams");
  return inside(workdir, requested);
}

/**
 * Build the transcript file name for one stage run.
 *
 * The identity is `issue-role-runId` so a transcript can be correlated
 * with the checkpoint of the same run, and two concurrent runs of the
 * same role never share a file.
 */
export function streamFileName(issue: number, role: string, runId: string): string {
  const safe = (value: string): string =>
    String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96) || "unknown";
  return `issue-${safe(String(issue))}-${safe(role)}-${safe(runId)}.ndjson`;
}

/** Collapse a payload into a single bounded line for the console. */
function preview(text: string | undefined, limit = MAX_PREVIEW_CHARS): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * Create the transcript sink for one stage run.
 *
 * Returns `null` when the mode is `off` — the caller then passes no
 * `streamLogger` at all and the backend keeps its historical
 * parse-and-discard behaviour.
 */
export function createAgentStreamSink(options: AgentStreamSinkOptions): AgentStreamSink | null {
  if (options.mode === "off") return null;

  const redact = createRedactor(process.env);
  const summary = options.summary ?? ((line: string) => process.stderr.write(`${line}\n`));
  const counts: Record<string, number> = {};
  const file = path.join(options.dir, streamFileName(options.issue, options.role, options.runId));
  let written = 0;
  let budgetExhausted = false;
  let created = false;
  let closed = false;

  const ensureFile = (): void => {
    if (created) return;
    mkdirSync(options.dir, { recursive: true });
    created = true;
  };

  /** Append one record to the transcript, honouring the byte budget. */
  const append = (payload: AgentStreamRecord): void => {
    if (budgetExhausted) return;
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      issue: options.issue,
      role: options.role,
      runId: options.runId,
      ...payload,
    })}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (options.maxBytes > 0 && written + size > options.maxBytes) {
      budgetExhausted = true;
      try {
        ensureFile();
        appendFileSync(file, `${JSON.stringify({
          ts: new Date().toISOString(),
          issue: options.issue,
          role: options.role,
          runId: options.runId,
          kind: "budget-exhausted",
          text: `transcript stopped at ${written} bytes (budget ${options.maxBytes})`,
        })}\n`, "utf8");
      } catch { /* a transcript is best-effort */ }
      return;
    }
    try {
      ensureFile();
      appendFileSync(file, line, "utf8");
      written += size;
    } catch { /* a transcript is best-effort */ }
  };

  const write = (record: AgentStreamRecord): void => {
    counts[record.kind] = (counts[record.kind] ?? 0) + 1;
    if (options.mode !== "full" && FULL_ONLY_KINDS.has(record.kind)) {
      // The record still counts as observed, but it stays out of the
      // transcript and out of the console: partial deltas and model
      // reasoning add volume without adding operational signal.
      return;
    }
    const payload = { ...record };
    if (typeof payload.text === "string") payload.text = redact(payload.text).slice(0, MAX_RECORD_CHARS);
    if (typeof payload.input === "string") payload.input = redact(payload.input).slice(0, MAX_RECORD_CHARS);

    append(payload);
    // Partial deltas are per-token: they belong in the transcript, not
    // in the operator's console. `formatSummary` returns null for
    // records that carry no operational signal.
    if (record.kind !== "delta-text" && record.kind !== "delta-thinking") {
      const line = formatSummary(options, payload);
      if (line) summary(line);
    }
  };

  return {
    write,
    close(): void {
      if (closed) return;
      closed = true;
      const tally = Object.entries(counts).map(([kind, count]) => `${kind}=${count}`).join(' ');
      append({ kind: 'run-finished', text: tally });
      summary(`[agent-stream] issue=${options.issue} role=${options.role} run=${options.runId} finished ${tally} file=${file}`);
    },
    get file(): string { return file; },
    get counts(): Readonly<Record<string, number>> { return counts; },
    get budgetExhausted(): boolean { return budgetExhausted; },
  };
}

/**
 * Render one console summary line.
 *
 * The line is intentionally short: the operator needs to see WHAT the
 * agent is doing, not the payload. The payload lives in the transcript.
 *
 * Returns `null` for records that carry no operational signal, so the
 * console stays readable. The Claude Code CLI emits high-frequency
 * internal ticks (`status`, `thinking_tokens`) that would otherwise
 * bury the tool calls and the final answer.
 */
export function formatSummary(
  options: { issue: number; role: string; runId: string },
  record: AgentStreamRecord,
): string | null {
  const head = `[agent-stream] issue=${options.issue} role=${options.role} run=${options.runId}`;
  switch (record.kind) {
    case "tool-call":
      return `${head} tool=${record.tool ?? "unknown"} call ${preview(record.input, MAX_TOOL_PREVIEW_CHARS)}`;
    case "tool-result":
      return `${head} tool=${record.tool ?? "unknown"} ${record.isError ? "error" : "ok"} ${preview(record.text)}`;
    case "system":
      return SILENT_SYSTEM_SUBTYPES.has(record.subtype ?? "")
        ? null
        : `${head} system=${record.subtype ?? "event"}`;
    case "result":
      return `${head} result=${record.subtype ?? "done"} ${preview(record.text)}`;
    case "thinking":
      return `${head} thinking ${preview(record.text)}`;
    case "delta-text":
    case "delta-thinking":
      return `${head} ${record.kind} ${preview(record.text)}`;
    default:
      return `${head} text ${preview(record.text)}`;
  }
}
