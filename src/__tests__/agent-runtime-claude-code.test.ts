/**
 * Slice B.1 / Group 3 / Task 3.4 — Claude Code CLI adapter tests.
 *
 * The adapter spawns an external CLI binary, pipes the composed
 * prompt text over stdin, and parses JSON from stdout — accepting
 * both the native Claude Code CLI result envelope
 * (`{ type: "result", ... }`) and the legacy factory-stub envelope
 * (`{ status, output, ... }`). To exercise the contract without
 * requiring the real `claude` binary to be installed, every test in
 * this file points `FACTORY_CLAUDE_COMMAND` at a small Node.js
 * stub script (created in a temp dir by `writeStub`/`writeNativeStub`)
 * that echoes a canned response.
 *
 * Coverage:
 *   - happy path: stub returns succeeded → dispatcher returns succeeded
 *   - format-error: stub returns missing `output` → dispatcher
 *     surfaces format-error with logTail containing the bad JSON
 *   - non-zero exit: stub exits 1 with stderr → dispatcher returns
 *     failed with retryable classified from the exit reason
 *   - role allow-list: non-allowed role → dispatcher fails fast
 *     with no child process spawned
 *   - missing executable: FACTORY_CLAUDE_COMMAND points to nothing →
 *     dispatcher returns failed (retryable=false)
 *   - native envelope: result JSON → succeeded with translated usage;
 *     is_error → failed with subtype-based retryability
 *   - prompt composition: stdin carries system + user + context
 *     turns as text, in order
 *   - trusted execution: FACTORY_TRUSTED_EXECUTION=1 adds
 *     --dangerously-skip-permissions to the child argv
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAgentRuntime, type StageRunRequest } from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";

function freshWorkdir(): string {
    return mkdtempSync(path.join(tmpdir(), "factory-rt-claude-"));
}

function makeContext(workdir: string): AgentContext {
    const logger = {
        info() {}, warn() {}, error() {}, debug() {},
        child() { return this; },
    };
    return {
        issue: { number: 1, title: "x", body: "", labels: [], comments: [] },
        repo: { workdir },
        logger: logger as unknown as AgentContext["logger"],
        skills: [],
        skillsRoot: "/tmp/skills",
        runId: "claude-test-run",
        correction: undefined,
    } as unknown as AgentContext;
}

/**
 * Write a tiny Node script that reads one JSON object from stdin and
 * writes a canned response. Used to substitute for the real Claude
 * Code CLI in tests.
 *
 * On POSIX a `.mjs` script with `chmod +x` is enough — `node:child_process`
 * can `execve` it directly. On Windows the spawn layer refuses to
 * execute a file without a recognised executable extension, so we
 * also write a `.cmd` wrapper that calls `node` with the script path.
 */
function writeStub(
    dir: string,
    behavior:
        | { kind: "ok"; output: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
        | { kind: "format-error" }
        | { kind: "exit-non-zero"; code: number; stderr?: string },
): string {
    const script = path.join(dir, "claude-stub.mjs");
    let body = "let input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', c => input += c);\nprocess.stdin.on('end', () => {\n";
    if (behavior.kind === "ok") {
        const payload = {
            status: "succeeded",
            output: behavior.output,
            usage: behavior.usage ?? { inputTokens: 12, outputTokens: 7 },
            warnings: [],
        };
        body += `  process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));\n`;
    } else if (behavior.kind === "format-error") {
        body += `  process.stdout.write("this is not valid JSON: {");\n`;
    } else {
        const stderr = behavior.stderr ?? "";
        body += `  process.stderr.write(${JSON.stringify(stderr)});\n  process.exit(${behavior.code});\n`;
    }
    body += "});\n";
    writeFileSync(script, body, "utf8");
    chmodSync(script, 0o755);

    if (process.platform === "win32") {
        // Windows: spawn refuses files without an executable extension,
        // so we hand back a `.cmd` wrapper that invokes the script via node.
        const cmd = path.join(dir, "claude-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(
            cmd,
            `@echo off\r\nnode "${scriptWindowsPath}"\r\n`,
            "utf8",
        );
        return cmd;
    }
    return script;
}

test("happy path: claude-code returns succeeded with structured output", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, {
            kind: "ok",
            output: "claude-code says APPROVE",
            usage: { inputTokens: 12, outputTokens: 7 },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "happy",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "Review.", messages: [{ role: "user" as const, content: "PR #1" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        if (result.status !== "succeeded") {
            // eslint-disable-next-line no-console
            console.error("DEBUG happy-path result:", JSON.stringify(result, null, 2));
        }
        assert.equal(result.status, "succeeded");
        assert.equal(result.backend, "claude-code");
        assert.equal(result.output, "claude-code says APPROVE");
        assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
        assert.equal(result.retryable, false);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("format-error: malformed stdout surfaces as format-error with retryable=false", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "format-error" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "fmt",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "format-error");
        assert.equal(result.backend, "claude-code");
        assert.equal(result.retryable, false);
        assert.ok(result.warnings.some((w) => /stdout/i.test(w)));
        assert.ok((result.logTail ?? "").includes("not valid JSON"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("non-zero exit: stub exits 1 → failed with retryable hint from exit code", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, {
            kind: "exit-non-zero",
            code: 1,
            stderr: "upstream rate limit",
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "exit1",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        // exit code 1 is classified retryable=true in claude-code-backend
        assert.equal(result.retryable, true);
        assert.ok((result.logTail ?? "").includes("upstream rate limit"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("role allow-list: unknown role fails fast without spawning", async () => {
    const workdir = freshWorkdir();
    try {
        // Stub exists but must not be invoked.
        const stubPath = writeStub(workdir, { kind: "ok", output: "should not see this" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "unknown-future-role", // not in READ_ONLY_ROLES
            runId: "unknown-role",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        assert.ok(result.warnings.some((w) => /refuses role/.test(w)));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("missing executable: dispatcher returns failed", async () => {
    const workdir = freshWorkdir();
    try {
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            // Point at a path that does not exist.
            FACTORY_CLAUDE_COMMAND: path.join(workdir, "does-not-exist.mjs"),
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "missing",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        // Windows reports a missing executable as cmd.exe exit 1
        // (retryable=true) or a synchronous spawn ENOENT (retryable=false);
        // both are acceptable failure modes for a missing binary.
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        assert.ok(typeof result.retryable === "boolean");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("FACTORY_AGENT_OVERRIDES permits claude-code for a role", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "ok", output: "override works" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "claude-code" }),
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "override",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.backend, "claude-code");
        assert.equal(result.output, "override works");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Native Claude Code CLI envelope (real-CLI integration)                      */
/* -------------------------------------------------------------------------- */

/**
 * Stub that emits the NATIVE Claude Code CLI result envelope
 * (`{ type: "result", ... }`) and optionally captures the stdin
 * prompt text and argv to files so tests can assert on what the
 * adapter actually piped / flagged.
 */
function writeNativeStub(
    dir: string,
    envelope: Record<string, unknown>,
    capture?: { stdinFile?: string; argvFile?: string },
): string {
    const script = path.join(dir, "claude-native-stub.mjs");
    const body =
        "import { writeFileSync } from 'node:fs';\n"
        + "let input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + (capture?.stdinFile
            ? `  writeFileSync(${JSON.stringify(capture.stdinFile)}, input);\n`
            : "")
        + (capture?.argvFile
            ? `  writeFileSync(${JSON.stringify(capture.argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
            : "")
        + `  process.stdout.write(JSON.stringify(${JSON.stringify(envelope)}));\n`
        + "  process.exit(0);\n"
        + "});\n";
    writeFileSync(script, body, "utf8");
    chmodSync(script, 0o755);
    if (process.platform === "win32") {
        const cmd = path.join(dir, "claude-native-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(cmd, `@echo off\r\nnode "${scriptWindowsPath}" %*\r\n`, "utf8");
        return cmd;
    }
    return script;
}

test("native envelope: claude result JSON maps to succeeded with translated usage", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(workdir, {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1234,
            result: '{"verdict":"APPROVE","body":"ok"}',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7 },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "native-happy",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        assert.equal(result.output, '{"verdict":"APPROVE","body":"ok"}');
        assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("native envelope: is_error result maps to failed with subtype-based retryability", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(workdir, {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "partial text before the error",
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "native-err",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.retryable, true);
        assert.ok(result.warnings.some((w) => /error_during_execution/.test(w)));
        assert.ok((result.logTail ?? "").includes("partial text before the error"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("prompt composition: stdin carries system + user + context turns as text", async () => {
    const workdir = freshWorkdir();
    try {
        const stdinFile = path.join(workdir, "stdin.txt");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { stdinFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "compose",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "SYSTEM-SECTION-MARKER",
                messages: [
                    { role: "user" as const, content: "USER-SECTION-MARKER" },
                    ...["CONTEXT-TURN-MARKER"].map((t) => ({ role: "user" as const, content: t })),
                ],
            },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        const piped = readFileSync(stdinFile, "utf8");
        // The child receives prompt TEXT, not the raw request JSON.
        assert.ok(!piped.trimStart().startsWith("{"), "stdin must not be the raw JSON request");
        const sysIdx = piped.indexOf("SYSTEM-SECTION-MARKER");
        const userIdx = piped.indexOf("USER-SECTION-MARKER");
        const ctxIdx = piped.indexOf("CONTEXT-TURN-MARKER");
        assert.ok(sysIdx >= 0 && userIdx >= 0 && ctxIdx >= 0, "all sections must be present");
        assert.ok(sysIdx < userIdx, "system prompt precedes user prompt");
        assert.ok(userIdx < ctxIdx, "context turns follow the user prompt");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("trusted execution: child argv carries --dangerously-skip-permissions", async () => {
    const workdir = freshWorkdir();
    const previous = process.env.FACTORY_TRUSTED_EXECUTION;
    process.env.FACTORY_TRUSTED_EXECUTION = "1";
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "trusted",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        assert.ok(argv.includes("--print"), `expected --print in argv: ${JSON.stringify(argv)}`);
        assert.ok(argv.includes("--output-format"), `expected --output-format in argv: ${JSON.stringify(argv)}`);
        assert.ok(
            argv.includes("--dangerously-skip-permissions"),
            `expected permission flag in argv: ${JSON.stringify(argv)}`,
        );
    } finally {
        if (previous === undefined) delete process.env.FACTORY_TRUSTED_EXECUTION;
        else process.env.FACTORY_TRUSTED_EXECUTION = previous;
        rmSync(workdir, { recursive: true, force: true });
    }
});

// --- M6 multi-turn session --------------------------------------------------

test("M6: resumeSessionId in StageRunRequest injects --resume <id> into argv", async () => {
    const workdir = freshWorkdir();
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: "stubbed-uuid-1",
                result: "ok",
                usage: { input_tokens: 10, output_tokens: 5 },
            },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "resume-1",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
            resumeSessionId: "f26a7dd7-d516-4167-bb86-1da452ded518",
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        // session_id must surface on the result envelope so the
        // orchestrator can persist it on state.providerSessions.
        assert.equal(result.providerSessionId, "stubbed-uuid-1");
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        const resumeIdx = argv.indexOf("--resume");
        assert.ok(resumeIdx >= 0, `expected --resume in argv: ${JSON.stringify(argv)}`);
        assert.equal(argv[resumeIdx + 1], "f26a7dd7-d516-4167-bb86-1da452ded518");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: absence of resumeSessionId keeps argv free of --resume", async () => {
    const workdir = freshWorkdir();
    try {
        const argvFile = path.join(workdir, "argv.json");
        const stubPath = writeNativeStub(
            workdir,
            {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: "stubbed-uuid-2",
                result: "ok",
                usage: { input_tokens: 10, output_tokens: 5 },
            },
            { argvFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "cold",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        await rt.runStage(req, makeContext(workdir));
        const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        assert.ok(!argv.includes("--resume"), `did not expect --resume in argv: ${JSON.stringify(argv)}`);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: envelope without session_id leaves providerSessionId null on result", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "no-sid",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        assert.equal(result.providerSessionId, null);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("M6: composeCliPrompt emits only system + incremental messages (no concatenated history)", async () => {
    const workdir = freshWorkdir();
    try {
        const stdinFile = path.join(workdir, "stdin.txt");
        const stubPath = writeNativeStub(
            workdir,
            { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} },
            { stdinFile },
        );
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation",
            runId: "incr",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "SYSTEM-MARKER",
                messages: [
                    { role: "user", content: "TURN-ONE-MARKER" },
                    { role: "user", content: "TURN-TWO-INCREMENT-MARKER" },
                ],
            },
        };
        await rt.runStage(req, makeContext(workdir));
        const stdin = readFileSync(stdinFile, "utf8");
        // Pre-M6 the adapter concatenated userPrompt + contextTurns into
        // a wall of text. M6 keeps the system prompt separate (rendered
        // by composeSystemPrompt upstream) and writes only the
        // incremental user turns to stdin.
        assert.ok(stdin.includes("SYSTEM-MARKER"), "system prompt must reach the CLI");
        assert.ok(stdin.includes("TURN-ONE-MARKER"), "first user turn must reach the CLI");
        assert.ok(stdin.includes("TURN-TWO-INCREMENT-MARKER"), "second user turn must reach the CLI");
        // No double-system, no explicit role label like "user:".
        assert.ok(!stdin.includes("SYSTEM-MARKER\nSYSTEM-MARKER"), "system prompt must not be duplicated");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});
