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
// Contract with the real Claude Code CLI (`claude --print --output-format stream-json --verbose`):
//   stdin:  the composed prompt TEXT (systemPrompt, userPrompt, then
//           contextTurns, separated by blank lines). The real CLI
//           treats piped stdin as the prompt — it does not understand
//           the factory's StageRunRequest JSON, so the adapter composes
//           the prompt itself.
//   stdout: newline-delimited progress events followed by the native result envelope:
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
//
// Content stream (optional): the parsed events are ALSO offered to a
// `streamLogger` as normalized records (assistant text, thinking,
// tool calls, tool results, system events, final result). This is a
// SEPARATE channel from `progressLogger`, which stays metadata-only
// by contract. Without a `streamLogger` the adapter behaves exactly
// as it did before: the stream is parsed and discarded.

import { execFileSync, spawn } from "node:child_process";
import { agentWorkerEnvironment } from "./agent-backends.mjs";

// Bound each stream record and the retained result/diagnostic buffers.
// Intermediate progress records are consumed and discarded immediately.
const MAX_STDIO_BYTES = 1024 * 1024;

// Bound a single content-stream record. A tool result can carry an
// entire file's contents, so the transcript keeps a bounded prefix
// instead of the raw payload.
const MAX_STREAM_RECORD_CHARS = 256 * 1024;

/**
 * Redact credential-shaped values out of any text that leaves this
 * adapter — the failure `logTail`, the warnings, and the optional
 * content stream.
 *
 * Two passes, both idempotent:
 *   1. every environment value whose NAME looks like a credential
 *      (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`) is replaced
 *      verbatim wherever it appears in the text;
 *   2. `Bearer <token>` headers are replaced regardless of the name
 *      of the variable that carried the credential.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {(text: string) => string}
 */
export function createRedactor(env) {
    const secrets = [];
    for (const [key, value] of Object.entries(env ?? {})) {
        if (!/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)) continue;
        if (typeof value !== "string") continue;
        if (value.length < 4) continue;
        secrets.push(value);
    }
    return text => {
        let out = typeof text === "string" ? text : String(text ?? "");
        for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
        return out.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
    };
}

/**
 * Normalize an arbitrary content payload (tool input, tool result,
 * model text) into a bounded string.
 *
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string}
 */
function streamText(value, limit = MAX_STREAM_RECORD_CHARS) {
    let text;
    if (typeof value === "string") text = value;
    else if (value === undefined || value === null) return "";
    else {
        try { text = JSON.stringify(value); } catch { text = String(value); }
    }
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

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
    if (request.compactSession) return '/compact Preserve approved requirements, reviewed revision, executed evidence, unresolved obligations and important file paths. Do not approve anything or execute product work.\n';
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
 * @property {string} [sessionId] Durably reserved UUID for `claude --session-id` on a first invocation.
 * @property {string} [agents] JSON file defining the stage's bounded child agent.
 * @property {boolean} [compactSession] Compact the resumed conversation without executing product work.
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
 * @property {(event: object) => void} [progressLogger] Metadata only; never prompt, tool arguments or model text.
 * @property {(record: object) => void} [streamLogger] Content stream: the agent's own
 *   text, tool calls and tool results. Separate from `progressLogger` so the
 *   metadata-only progress contract stays intact. Omit to keep the historical
 *   behaviour (the stream is parsed and discarded).
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
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        } else {
            process.kill(-child.pid, 'SIGTERM');
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
    if (request.agents) {
        // Factory children inherit this stage's MCP capabilities and finish before its bridge closes.
        env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
        env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
    }

    const args = ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
    else if (request.sessionId) args.push('--session-id', request.sessionId);
    if (request.agents) args.push('--agents', process.platform === 'win32' ? `"${request.agents}"` : request.agents);
    if (request.mcpConfig !== undefined || request.nativeTools !== undefined) args.push('--strict-mcp-config');
    if (request.mcpConfig !== undefined) args.push('--mcp-config', process.platform === 'win32' ? `"${request.mcpConfig}"` : request.mcpConfig);
    if (request.nativeTools !== undefined) args.push('--tools', request.nativeTools === '' && process.platform === 'win32' ? '""' : request.nativeTools);
    if (trustedExecutionEnabled(env)) args.push("--dangerously-skip-permissions");

    return new Promise((resolvePromise) => {
        const startedAt = Date.now();
        let lastActivityAt = startedAt, phase = 'awaiting-response';
        let stdoutBytes = 0, textChars = 0, thinkingChars = 0;
        let timer, heartbeat, cleanupTimer, onAbort, settled = false;
        let contextTokens = 0, contextWindow;
        const redact = createRedactor(env);
        const report = (event, fields = {}) => {
            if (settled) return;
            try { options.progressLogger?.({ event, elapsedMs: Date.now() - startedAt,
                idleMs: Date.now() - lastActivityAt, phase, timeoutMs, stdoutBytes, textChars, thinkingChars, ...fields }); } catch {}
        };
        // Content stream: a SEPARATE channel from `progressLogger`.
        // `progressLogger` stays metadata-only by contract (the panel
        // and the durable state must never carry prompt text, tool
        // arguments or model reasoning); the content stream is an
        // operator-local transcript. It is opt-in: without a
        // `streamLogger` the adapter behaves exactly as before.
        const emitStream = record => {
            if (!options.streamLogger) return;
            try {
                const safe = { ...record };
                if (typeof safe.text === 'string') safe.text = redact(safe.text);
                if (typeof safe.input === 'string') safe.input = redact(safe.input);
                options.streamLogger(safe);
            } catch { /* an observer must never break the run */ }
        };
        const resolve = result => {
            if (settled) return;
            if (!request.compactSession && contextTokens > 0 && Number.isSafeInteger(contextWindow) && contextWindow > 0) {
                result.contextUsage = {tokens:contextTokens,window:contextWindow};
            }
            if (result.status === 'failed') {
                result.logTail = redact(result.logTail ?? '');
                result.warnings = result.warnings.map(redact);
                result.failureCode ??= /prompt is too long|context (?:window|length).*exceed|maximum context length|context_length_exceeded/i.test(result.logTail)
                    ? 'FACTORY_AGENT_CONTEXT_EXHAUSTED' : 'FACTORY_AGENT_EXECUTION_FAILED';
            }
            clearTimeout(timer);
            clearTimeout(cleanupTimer);
            clearInterval(heartbeat);
            if (onAbort) options.abortSignal?.removeEventListener('abort', onAbort);
            report('finished', { status: result.status, retryable: result.retryable });
            settled = true;
            resolvePromise(result);
        };
        report('started');
        let child;
        try {
            const spawnOptions = {
                stdio: ["pipe", "pipe", "pipe"],
                env,
                cwd: request.issue.repo.workdir,
                // Windows: `spawn` refuses .cmd / .bat files without
                // a shell, and operators sometimes ship Claude Code
                // behind a thin .cmd wrapper. `shell: true` is safe
                // here because the executable is operator-controlled
                // (FACTORY_CLAUDE_COMMAND or default) and the args
                // are hardcoded by the adapter; the user-controlled
                // payload flows over stdin, not argv.
                shell: process.platform === "win32",
                detached: process.platform !== 'win32',
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
        let stderrBytes = 0;
        let timedOut = false, contextCompacted = false;
        let pending = '', rawStdout = '', streaming = false, discardLine = false;
        const tools = new Map();
        const observeUsage = usage => {
            if (!usage || typeof usage !== 'object') return;
            const counts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
            if (counts.some(count => count !== undefined && (!Number.isSafeInteger(count) || count < 0))) return;
            const total = counts.reduce((sum, count) => sum + (count ?? 0), 0);
            if (total > 0) contextTokens = total;
        };
        const consumeLine = line => {
            if (!line.trim()) return;
            let value;
            try { value = JSON.parse(line); } catch { return; }
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            if (value.type === 'result' || !value.type) {
                const windows = Object.values(value.modelUsage ?? {}).map(model => model?.contextWindow)
                    .filter(window => Number.isSafeInteger(window) && window > 0);
                if (windows.length) contextWindow = Math.min(...windows);
                stdout = line;
                phase = 'awaiting-exit';
                report('response-complete');
                emitStream({ kind: 'result', text: streamText(value.result), subtype: typeof value.subtype === 'string' ? value.subtype : undefined });
            } else if (value.type === 'assistant') {
                observeUsage(value.message?.usage);
                phase = tools.size ? 'tool-running' : 'receiving-response';
                for (const block of value.message?.content ?? []) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        emitStream({ kind: 'text', text: streamText(block.text) });
                        continue;
                    }
                    if (block.type === 'thinking' && typeof block.thinking === 'string') {
                        emitStream({ kind: 'thinking', text: streamText(block.thinking) });
                        continue;
                    }
                    if (block.type !== 'tool_use' || typeof block.id !== 'string' || tools.has(block.id)) continue;
                    const name = typeof block.name === 'string' && /^[\w.-]{1,96}$/.test(block.name) ? block.name : 'unknown';
                    if (tools.size >= 128) tools.delete(tools.keys().next().value);
                    tools.set(block.id, { name, startedAt: Date.now() });
                    phase = 'tool-running';
                    report('tool-started', { tool: name });
                    emitStream({ kind: 'tool-call', tool: name, input: streamText(block.input) });
                }
            } else if (value.type === 'user') {
                for (const block of value.message?.content ?? []) {
                    if (block.type !== 'tool_result') continue;
                    const tool = tools.get(block.tool_use_id);
                    tools.delete(block.tool_use_id);
                    phase = tools.size ? 'tool-running' : 'awaiting-response';
                    report('tool-finished', { tool: tool?.name ?? 'unknown', isError: block.is_error === true,
                        ...(tool ? { durationMs: Date.now() - tool.startedAt } : {}) });
                    emitStream({ kind: 'tool-result', tool: tool?.name ?? 'unknown', isError: block.is_error === true,
                        text: streamText(block.content) });
                }
            } else if (value.type === 'stream_event') {
                if (value.event?.type === 'message_start') observeUsage(value.event.message?.usage);
                const delta = value.event?.delta;
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    textChars += delta.text.length;
                    emitStream({ kind: 'delta-text', text: delta.text });
                }
                if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                    thinkingChars += delta.thinking.length;
                    emitStream({ kind: 'delta-thinking', text: delta.thinking });
                }
                phase = tools.size ? 'tool-running' : 'receiving-response';
                if (value.event?.type === 'message_start') report('response-started');
            } else if (value.type === 'system' && value.subtype === 'init') {
                report('session-started', {tools:Array.isArray(value.tools) ? value.tools.filter(name=>typeof name==='string' && /^[\w.-]{1,128}$/.test(name)).slice(0,128) : [],
                    mcpServers:Array.isArray(value.mcp_servers) ? value.mcp_servers.slice(0,32).map(server=>({
                        name:typeof server.name === 'string' && /^[\w.-]{1,96}$/.test(server.name) ? server.name : 'unknown',
                        status:['connected','failed','needs-auth','pending','disabled'].includes(server.status) ? server.status : 'unknown'})) : []});
                emitStream({ kind: 'system', subtype: 'init' });
            } else if (value.type === 'system' && value.subtype === 'compact_boundary') {
                contextCompacted = true;
                report('context-compacted');
                emitStream({ kind: 'system', subtype: 'compact_boundary' });
            } else if (value.type === 'system') {
                // Other system subtypes (status, hook_started, hook_response)
                // carry arbitrary payloads — record the subtype only.
                emitStream({ kind: 'system', subtype: typeof value.subtype === 'string' ? value.subtype : 'system' });
            }
            streaming = true;
            rawStdout = '';
        };
        const timeoutResult = () => ({ status: 'failed', output: '', usage: null,
            logTail: `timed out after ${timeoutMs}ms\n${stderr}`, backend: 'claude-code',
            warnings: [`timeout after ${timeoutMs}ms`], retryable: true, failureCode: 'ETIMEDOUT' });
        timer = setTimeout(() => {
            timedOut = true;
            report('timeout', { retryable: true });
            killChildTree(child);
            // Escalation for POSIX children that ignore SIGTERM (some
            // wrappers or hung network calls). On win32 taskkill /F is
            // already unconditional; the repeat call is a harmless
            // no-op if the tree is gone. 5 s is long enough for a
            // cooperative shutdown, short enough not to extend the
            // timeout window noticeably.
            cleanupTimer = setTimeout(() => {
                killChildTree(child);
                try {
                    if (process.platform === 'win32') child.kill('SIGKILL');
                    else process.kill(-child.pid, 'SIGKILL');
                } catch { /* already dead */ }
                // An inherited pipe must not keep recovery waiting forever.
                child.stdout.destroy();
                child.stderr.destroy();
                resolve(timeoutResult());
            }, 5000).unref?.();
        }, timeoutMs);
        timer.unref?.();
        heartbeat = setInterval(() => report('heartbeat'), 30000);
        heartbeat.unref?.();

        // Same orphan-tree hazard on operator cancel: the spawn-level
        // `signal` option only terminates the direct child (the cmd.exe
        // wrapper on Windows), so mirror the abort into a tree kill.
        if (options.abortSignal) {
            onAbort = () => {
                report('cancelled');
                killChildTree(child);
                child.stdout.destroy();
                child.stderr.destroy();
                resolve({ status: 'cancelled', output: '', usage: null, logTail: 'aborted',
                    backend: 'claude-code', warnings: ['aborted before close'], retryable: false });
            };
            if (options.abortSignal.aborted) onAbort();
            else options.abortSignal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk) => {
            if (settled) return;
            stdoutBytes += Buffer.byteLength(chunk, 'utf8');
            lastActivityAt = Date.now();
            if (!streaming && rawStdout.length + chunk.length <= MAX_STDIO_BYTES) rawStdout += chunk;
            for (const part of chunk.split(/(?<=\n)/)) {
                if (!discardLine) pending += part;
                if (pending.length > MAX_STDIO_BYTES) {
                    pending = '';
                    discardLine = true;
                    report('output-truncated');
                }
                if (part.endsWith('\n')) {
                    if (!discardLine) consumeLine(pending);
                    pending = '';
                    discardLine = false;
                }
            }
        });
        child.stderr.on("data", (chunk) => {
            if (settled) return;
            stderrBytes += chunk.length;
            if (stderrBytes <= MAX_STDIO_BYTES) {
                stderr += chunk;
                if (options.stderrLogger) options.stderrLogger(chunk);
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
            if (settled) return;
            if (!discardLine) consumeLine(pending);
            if (!stdout && !streaming) stdout = rawStdout;

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
                resolve(timeoutResult());
                return;
            }

            if (code !== 0) {
                const parsedError = parseClaudeCodeStdout(stdout);
                const diagnostic = parsedError.ok === 'cli-error' ? `${parsedError.subtype}: ${parsedError.resultText}` : stdout.slice(-4000);
                resolve({
                    status: "failed",
                    output: "",
                    usage: null,
                    logTail: `exit=${code} signal=${signalName}\n${diagnostic}\n${stderr}`,
                    backend: "claude-code",
                    warnings: [code === 2 ? 'claude-code executable missing or refused to start' : `claude-code exited with code ${code}`],
                    retryable: code === 1,
                });
                return;
            }

            if (request.compactSession) {
                resolve({ status: contextCompacted ? 'succeeded' : 'failed', output: '', usage: null,
                    logTail: contextCompacted ? '' : `CLI did not confirm a compact_boundary\n${stdout}\n${stderr}`,
                    backend: 'claude-code', warnings: contextCompacted ? [] : ['Session compaction unconfirmed'],
                    retryable: false, contextCompacted, providerSessionId: options.resumeSessionId,
                    ...(!contextCompacted ? { failureCode: 'FACTORY_AGENT_CONTEXT_RECOVERY_FAILED' } : {}) });
                return;
            }

            const parsed = parseClaudeCodeStdout(stdout);
            if (parsed.ok === "cli-error") {
                // The CLI ran but reported an execution-level failure
                // (max turns exhausted, internal error, ...). The
                // partial `result` text (when any) goes to logTail for
                // post-mortem. error_max_turns / error_during_execution
                // are eligible for an immediate retry. Other CLI faults
                // retain their diagnostic code for the runtime recovery scheduler.
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
            killChildTree(child);
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
                resultText: [resultText, ...(Array.isArray(value.errors) ? value.errors.filter(item => typeof item === 'string') : [])].filter(Boolean).join('\n'),
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
        timeoutMs: request.timeoutMs ?? config.timeoutMs,
        env,
        abortSignal: extra.abortSignal,
        resumeSessionId: request.resumeSessionId ?? extra.resumeSessionId,
        progressLogger: extra.progressLogger,
        streamLogger: extra.streamLogger,
    });
}
