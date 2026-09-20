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
// Contract with the real Claude Code CLI (`claude --print --output-format json`):
//   stdin:  the composed prompt TEXT (systemPrompt, userPrompt, then
//           contextTurns, separated by blank lines). The real CLI
//           treats piped stdin as the prompt — it does not understand
//           the factory's StageRunRequest JSON, so the adapter composes
//           the prompt itself.
//   stdout: one JSON object — the native result envelope:
//           { type: "result", subtype: "success" | "error_max_turns" | ...,
//             is_error: boolean, result: string,
//             usage: { input_tokens, output_tokens, ... } }
//           The legacy factory-stub envelope ({ status, output, usage,
//           warnings }) is still accepted so test stubs and any
//           operator-provided wrapper implementing the old contract
//           keep working.
//   exit:   0 on stdout produced, 2 on missing CLI / spawn error,
//           1 on timeout / signal / other failure.
//
// Tool permissions: when the worker runs under FACTORY_TRUSTED_EXECUTION
// (the daemon's sandboxed-worktree model), the child is spawned with
// --dangerously-skip-permissions so mutating roles (implementation) can
// actually edit files and run validation commands inside the disposable
// issue worktree. Without trusted execution no permission flag is added
// and the CLI auto-denies tool use (read-only Q&A still works).
//
// Anything that does not satisfy the contract above is surfaced as
// `status: "failed"` with the raw bytes in `logTail` so the panel
// read-model can show the operator what came back.

import { execFileSync, spawn } from "node:child_process";
import { agentWorkerEnvironment } from "./agent-backends.mjs";

// Hard cap on accumulated stdout / stderr from the child process.
// A misbehaving CLI (or a runaway verbose flag) can otherwise pin
// gigabytes into V8 strings before close fires. The cap is shared
// across stdout and stderr so the panel log tail still fits within
// the existing 1 MiB logTail contract.
const MAX_STDIO_BYTES = 1024 * 1024;

/**
 * Compose the prompt text piped to the real Claude Code CLI.
 *
 * The real `claude --print` treats stdin as the prompt, so the adapter
 * renders the StageRunRequest into one text block in conversation
 * order: system prompt first (already assembled upstream by
 * `claudeCodeHarnessAdapter` — role + required rules + skill catalog +
 * output contract), then the incremental user turns (the agent's
 * `messages[]` for this stage call only — NOT the full conversation
 * history, because the CLI's own session keeps that when `--resume`
 * is used). Sections are separated by blank lines so the model can
 * tell the role instructions from the task.
 *
 * Pre-M6 callers passed `userPrompt + contextTurns`; the dispatcher
 * now folds both into `messages: string[]` (one entry per turn) before
 * the request reaches this adapter, so there is nothing to concatenate
 * here other than the system prompt.
 */
function composeCliPrompt(request) {
    const manifest = request?.inputManifest ?? {};
    const sections = [];
    if (typeof manifest.systemPrompt === "string" && manifest.systemPrompt.trim()) {
        sections.push(manifest.systemPrompt.trim());
    }
    const turns = Array.isArray(manifest.messages) ? manifest.messages : [];
    for (const turn of turns) {
        if (typeof turn === "string" && turn.trim()) sections.push(turn.trim());
    }
    return sections.join("\n\n") + "\n";
}

/**
 * True when the factory worker runs under the daemon's trusted
 * execution model (FACTORY_TRUSTED_EXECUTION=1, required for the
 * local execution adapter). In that mode the issue worktree is a
 * disposable sandbox, so the Claude Code child may run with
 * `--dangerously-skip-permissions` and actually use its tools
 * (Write/Edit/Bash) — mutating roles like `implementation` depend on
 * it. Outside trusted execution no permission flag is passed and the
 * CLI auto-denies tool use.
 */
function trustedExecutionEnabled(env) {
    // The child-env whitelist (agentWorkerEnvironment) does not carry
    // FACTORY_TRUSTED_EXECUTION — it is a spawn decision input, not a
    // credential the CLI needs. Fall back to the worker's own env,
    // which the daemon sets (FACTORY_TRUSTED_EXECUTION=1 gates the
    // local execution adapter).
    const raw = String(
        env?.FACTORY_TRUSTED_EXECUTION
            ?? process.env.FACTORY_TRUSTED_EXECUTION
            ?? "",
    ).trim().toLowerCase();
    return raw === "1" || raw === "true";
}

/**
 * @typedef {Object} ClaudeCodeRequest
 * @property {string} role
 * @property {string} runId
 * @property {{ number: number, repo: { workdir: string } }} issue
 * @property {string} [artifactId]
 * @property {{ systemPrompt: string, messages: string[] }} inputManifest
 * @property {string[]} [rules]
 * @property {string[]} [skills]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {string} [resumeSessionId] UUID handed to `claude --resume` to continue a prior session.
 *
 * @typedef {Object} ClaudeCodeResult
 * @property {"succeeded" | "format-error"} status
 * @property {string} output
 * @property {{ inputTokens: number|null, outputTokens: number|null } | null} usage
 * @property {string} [providerSessionId] CLI session UUID; present when the envelope reported one.
 * @property {string[]} [warnings]
 *
 * @typedef {Object} ClaudeCodeAdapterOptions
 * @property {string} executable
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {AbortSignal} [abortSignal]
 * @property {string} [resumeSessionId] Forwarded to `claude --resume`; undefined = new session.
 * @property {(line: string) => void} [stderrLogger]
 */

/**
 * Kill the CLI child AND its descendants.
 *
 * On Windows the direct child is usually a cmd.exe wrapper (spawn
 * uses shell:true so `.cmd` shims like claude.cmd can execute).
 * `child.kill()` terminates only the wrapper — the real CLI (and its
 * own Bash-tool children) survive as orphans holding the inherited
 * stdio pipes, so the `close` event never fires and the stage promise
 * hangs forever even though the timeout "fired". `taskkill /T /F`
 * walks the whole tree. Observed live: implementation stage timed out
 * at 900s, cmd.exe died, claude.exe + 5 descendants kept running.
 */
function killChildTree(child) {
    try {
        if (process.platform === "win32") {
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
            child.kill("SIGTERM");
        }
    } catch { /* already dead */ }
}

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
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
    if (trustedExecutionEnabled(env)) args.push("--dangerously-skip-permissions");

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
            killChildTree(child);
            // Escalation for POSIX children that ignore SIGTERM (some
            // wrappers or hung network calls). On win32 taskkill /F is
            // already unconditional; the repeat call is a harmless
            // no-op if the tree is gone. 5 s is long enough for a
            // cooperative shutdown, short enough not to extend the
            // timeout window noticeably.
            setTimeout(() => {
                killChildTree(child);
                try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }, 5000).unref?.();
        }, timeoutMs);
        timer.unref?.();

        // Same orphan-tree hazard on operator cancel: the spawn-level
        // `signal` option only terminates the direct child (the cmd.exe
        // wrapper on Windows), so mirror the abort into a tree kill.
        if (options.abortSignal) {
            const onAbort = () => killChildTree(child);
            if (options.abortSignal.aborted) onAbort();
            else options.abortSignal.addEventListener("abort", onAbort, { once: true });
        }

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
            if (parsed.ok === "cli-error") {
                // The CLI ran but reported an execution-level failure
                // (max turns exhausted, internal error, ...). The
                // partial `result` text (when any) goes to logTail for
                // post-mortem. error_max_turns / error_during_execution
                // are transient in practice (model ran out of budget or
                // hit a flaky tool call) → retryable; anything else is
                // treated as permanent.
                const retryableSubtypes = new Set(["error_max_turns", "error_during_execution"]);
                resolve({
                    status: "failed",
                    output: "",
                    usage: null,
                    logTail: `claude CLI reported ${parsed.subtype}\n${parsed.resultText}\n${stderr}`.slice(0, MAX_STDIO_BYTES),
                    backend: "claude-code",
                    warnings: [`claude CLI reported ${parsed.subtype}`],
                    retryable: retryableSubtypes.has(parsed.subtype),
                });
                return;
            }
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
                providerSessionId: value.providerSessionId ?? null,
            });
        });

        try {
            // The real Claude Code CLI reads the prompt from stdin in
            // --print mode; pipe the composed prompt text (NOT the raw
            // StageRunRequest JSON, which the CLI would treat as prompt
            // text verbatim and answer with a format-error-worthy
            // non-contract response).
            child.stdin.write(composeCliPrompt(request));
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
 * Accepts two envelope shapes:
 *
 *   1. Native Claude Code CLI (`--output-format json`):
 *      `{ type: "result", subtype, is_error, result, usage }`.
 *      Success maps to `{ status: "succeeded", output: result }` with
 *      usage translated from snake_case token counts. Error subtypes
 *      (`error_max_turns`, `error_during_execution`, ...) map to a
 *      `cli-error` verdict so the caller can classify retryability.
 *   2. Legacy factory-stub envelope: `{ status, output, usage, warnings }`
 *      — kept so test stubs and operator wrappers written against the
 *      original Slice B.1 contract continue to work.
 *
 * Tolerates a trailing newline (most CLI tools emit one) and rejects
 * any payload that is not a single JSON object. The output contract
 * is intentionally strict: a missing `output`/`result` field is
 * treated as format-error so the dispatcher does not silently produce
 * empty results.
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
    // Native Claude Code CLI result envelope.
    if (value.type === "result") {
        const resultText = typeof value.result === "string" ? value.result : "";
        const errored = value.is_error === true
            || (typeof value.subtype === "string" && value.subtype !== "success");
        if (errored) {
            return {
                ok: "cli-error",
                subtype: typeof value.subtype === "string" ? value.subtype : "error",
                resultText,
            };
        }
        if (typeof value.result !== "string") {
            return { ok: false, error: `claude result envelope has no string \`result\` (subtype=${String(value.subtype)})` };
        }
        // `session_id` is a UUID emitted by the CLI in every result
        // envelope (verified against claude 2.1.201). Captured so the
        // dispatcher can persist it on the issue state for the next
        // `--resume`. Field is optional — older CLIs / envelopes that
        // omit it fall back to cold-start on next call.
        const sessionId = typeof value.session_id === "string" && value.session_id.trim()
            ? value.session_id.trim()
            : null;
        return {
            ok: true,
            value: {
                status: "succeeded",
                output: resultText,
                usage: {
                    inputTokens: value.usage?.input_tokens ?? null,
                    outputTokens: value.usage?.output_tokens ?? null,
                },
                warnings: [],
                providerSessionId: sessionId ?? undefined,
            },
        };
    }
    // Legacy factory-stub envelope.
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
        resumeSessionId: request.resumeSessionId ?? extra.resumeSessionId,
    });
}