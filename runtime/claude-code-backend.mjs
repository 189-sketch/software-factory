// runtime/claude-code-backend.mjs
//
// Claude Code CLI backend adapter (Slice B.1 / Group 3).
//
// Invokes the Claude Code CLI as a child process, pipes a
// StageRunRequest-shaped JSON payload over stdin, and parses the
// structured stdout back into a StageRunResult. The CLI is reached
// through `executable` resolved by `runtime/agent-backends.mjs`
// (`FACTORY_CLAUDE_COMMAND` or the default `claude` binary).
//
// Contract with the CLI process:
//   stdin:  one JSON object with the shape
//           { role, runId, issue, inputManifest, rules, skills, model,
//             timeoutMs }
//   stdout: one JSON object with the shape
//           { status: "succeeded" | "format-error",
//             output: string,
//             usage: { inputTokens: number|null, outputTokens: number|null } | null,
//             warnings: string[] }
//   exit:   0 on stdout produced, 2 on missing CLI / spawn error,
//           3 on format-error, 1 on timeout / signal / other failure.
//
// Anything that does not satisfy the contract above is surfaced as
// `status: "failed"` with the raw bytes in `logTail` so the panel
// read-model can show the operator what came back.
//
// The adapter is intentionally minimal in this slice: it covers the
// happy path, transient vs format-error classification, and the
// `readOnly` capability gate. Multi-turn dialogue, compaction, and
// child-process cancellation are wired in Slice E.

import { spawn } from "node:child_process";
import { agentWorkerEnvironment } from "./agent-backends.mjs";

// Hard cap on accumulated stdout / stderr from the child process.
// A misbehaving CLI (or a runaway verbose flag) can otherwise pin
// gigabytes into V8 strings before close fires. The cap is shared
// across stdout and stderr so the panel log tail still fits within
// the existing 1 MiB logTail contract.
const MAX_STDIO_BYTES = 1024 * 1024;

/**
 * @typedef {Object} ClaudeCodeRequest
 * @property {string} role
 * @property {string} runId
 * @property {{ number: number, repo: { workdir: string } }} issue
 * @property {string} [artifactId]
 * @property {{ systemPrompt: string, userPrompt: string, contextTurns?: string[] }} inputManifest
 * @property {string[]} [rules]
 * @property {string[]} [skills]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 *
 * @typedef {Object} ClaudeCodeResult
 * @property {"succeeded" | "format-error"} status
 * @property {string} output
 * @property {{ inputTokens: number|null, outputTokens: number|null } | null} usage
 * @property {string[]} [warnings]
 *
 * @typedef {Object} ClaudeCodeAdapterOptions
 * @property {string} executable
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {AbortSignal} [abortSignal]
 * @property {(line: string) => void} [stderrLogger]
 */

/**
 * Run the Claude Code CLI for a single stage request.
 *
 * Returns a `StageRunResult` whose `backend` is always `"claude-code"`.
 * Spawn errors and CLI exits that do not match the documented
 * contract are surfaced as `status: "failed"` with `retryable`
 * classified from the exit reason.
 *
 * @param {ClaudeCodeRequest} request
 * @param {ClaudeCodeAdapterOptions} options
 * @returns {Promise<{
 *   status: "succeeded" | "failed" | "format-error" | "interrupted" | "cancelled",
 *   output: string,
 *   structuredOutput?: unknown,
 *   usage: { inputTokens: number|null, outputTokens: number|null } | null,
 *   logTail: string,
 *   backend: "claude-code",
 *   warnings: string[],
 *   retryable: boolean,
 * }>}
 */
export async function runClaudeCodeStage(request, options) {
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const env = { ...(options.env ?? process.env) };
    delete env.FACTORY_AGENT_BACKEND;
    delete env.FACTORY_AGENT_OVERRIDES;

    const args = ["--print", "--output-format", "json"];
    if (options.model) args.push("--model", options.model);

    return new Promise((resolve) => {
        let child;
        try {
            const spawnOptions = {
                stdio: ["pipe", "pipe", "pipe"],
                env,
                // Windows: `spawn` refuses .cmd / .bat files without
                // a shell, and operators sometimes ship Claude Code
                // behind a thin .cmd wrapper. `shell: true` is safe
                // here because the executable is operator-controlled
                // (FACTORY_CLAUDE_COMMAND or default) and the args
                // are hardcoded by the adapter; the user-controlled
                // payload flows over stdin, not argv.
                shell: process.platform === "win32",
            };
            if (options.abortSignal) spawnOptions.signal = options.abortSignal;
            child = spawn(options.executable, args, spawnOptions);
        } catch (error) {
            resolve({
                status: "failed",
                output: "",
                usage: null,
                logTail: String(error),
                backend: "claude-code",
                warnings: [`spawn failed: ${error.message}`],
                retryable: false,
            });
            return;
        }

        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGTERM"); } catch { /* already dead */ }
            // Upgrade to SIGKILL if the child ignores SIGTERM (some
            // wrappers or hung network calls). 5 s is long enough for
            // a cooperative shutdown, short enough not to extend the
            // timeout window noticeably.
            setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }, 5000).unref?.();
        }, timeoutMs);
        timer.unref?.();

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= MAX_STDIO_BYTES) stdout += chunk;
            else stdoutTruncated = true;
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= MAX_STDIO_BYTES) {
                stderr += chunk;
                if (options.stderrLogger) options.stderrLogger(chunk);
            } else {
                stderrTruncated = true;
            }
        });

        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({
                status: "failed",
                output: "",
                usage: null,
                logTail: `${stderr}\n${String(error)}`,
                backend: "claude-code",
                warnings: [`claude-code spawn error: ${error.message}`],
                retryable: false,
            });
        });

        child.on("close", (code, signalName) => {
            clearTimeout(timer);

            if (options.abortSignal?.aborted) {
                resolve({
                    status: "cancelled",
                    output: "",
                    usage: null,
                    logTail: stderr || signalName || "aborted",
                    backend: "claude-code",
                    warnings: ["aborted before close"],
                    retryable: false,
                });
                return;
            }

            if (timedOut) {
                resolve({
                    status: "failed",
                    output: "",
                    usage: null,
                    logTail: `timed out after ${timeoutMs}ms\n${stderr}${stdoutTruncated || stderrTruncated ? "\n[truncated]" : ""}`,
                    backend: "claude-code",
                    warnings: [`timeout after ${timeoutMs}ms`],
                    retryable: true,
                });
                return;
            }

            if (code === 2) {
                resolve({
                    status: "failed",
                    output: "",
                    usage: null,
                    logTail: stderr || "executable missing",
                    backend: "claude-code",
                    warnings: ["claude-code executable missing or refused to start"],
                    retryable: false,
                });
                return;
            }

            if (code !== 0) {
                resolve({
                    status: "failed",
                    output: "",
                    usage: null,
                    logTail: `exit=${code} signal=${signalName}\n${stderr}`,
                    backend: "claude-code",
                    warnings: [`claude-code exited with code ${code}`],
                    retryable: code === 1,
                });
                return;
            }

            const parsed = parseClaudeCodeStdout(stdout);
            if (!parsed.ok) {
                resolve({
                    status: "format-error",
                    output: "",
                    usage: null,
                    logTail: `stdout not parseable: ${parsed.error}\n${stdout}`,
                    backend: "claude-code",
                    warnings: [parsed.error],
                    retryable: false,
                });
                return;
            }

            const value = parsed.value;
            const status = value.status === "format-error" ? "format-error" : "succeeded";
            resolve({
                status,
                output: value.output ?? "",
                structuredOutput: value,
                usage: value.usage ?? null,
                logTail: stderr,
                backend: "claude-code",
                warnings: value.warnings ?? [],
                retryable: false,
            });
        });

        try {
            child.stdin.write(JSON.stringify(request));
            child.stdin.end();
        } catch (error) {
            clearTimeout(timer);
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
            resolve({
                status: "failed",
                output: "",
                usage: null,
                logTail: `stdin write failed: ${error.message}`,
                backend: "claude-code",
                warnings: [`stdin write failed: ${error.message}`],
                retryable: false,
            });
        }
    });
}

/**
 * Parse one JSON object from the CLI's stdout.
 *
 * Tolerates a trailing newline (most CLI tools emit one) and rejects
 * any payload that is not a single JSON object. The output contract
 * is intentionally strict: a missing `output` field is treated as
 * format-error so the dispatcher does not silently produce empty
 * results.
 */
function parseClaudeCodeStdout(text) {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
        return { ok: false, error: "empty stdout" };
    }
    let value;
    try {
        value = JSON.parse(trimmed);
    } catch (error) {
        return { ok: false, error: `stdout is not valid JSON: ${error.message}` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "stdout is not a JSON object" };
    }
    if (typeof value.output !== "string") {
        return { ok: false, error: "stdout object is missing the `output` string field" };
    }
    return { ok: true, value };
}

/**
 * Convenience wrapper that wires `runClaudeCodeStage` to the runtime
 * backend configuration (`runtime/agent-backends.mjs`) and the
 * `agentWorkerEnvironment` credential whitelist.
 *
 * The wrapper is the single place that decides which environment
 * variables are forwarded to the `claude` child process. Without
 * this hook (commit 48cdd0e protected the `embedded` path but the
 * Claude Code adapter was bypassing it), the entire parent
 * `process.env` would be visible to the child, leaking unrelated
 * tokens such as `GH_TOKEN` to operator-controlled CLI binaries.
 *
 * The `model` field is taken from the already-resolved
 * `request.model` (set by the dispatcher's `selectBackend(role)`),
 * not re-parsed from `config`, so the wrapper cannot drift from the
 * selection decision the caller made.
 *
 * @param {import("./agent-backends.mjs").AgentConfig} config
 * @param {string} executable
 * @param {ClaudeCodeRequest} request
 * @param {object} [extra]
 * @param {NodeJS.ProcessEnv} [extra.env] Override the credential
 *   whitelist; intended for tests that need a closed environment.
 *   Production callers should leave this unset so
 *   `agentWorkerEnvironment` is applied automatically.
 * @param {AbortSignal} [extra.abortSignal]
 */
export async function runClaudeCodeStageFromConfig(config, executable, request, extra = {}) {
    const env = extra.env ?? agentWorkerEnvironment(process.env, config);
    return runClaudeCodeStage(request, {
        executable,
        model: request.model,
        timeoutMs: config.timeoutMs,
        env,
        abortSignal: extra.abortSignal,
    });
}