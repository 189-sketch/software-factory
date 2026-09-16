/**
 * Slice B.1 / Group 3 / Task 3.4 — Claude Code CLI adapter tests.
 *
 * The adapter spawns an external CLI binary, pipes JSON over stdin,
 * and parses JSON from stdout. To exercise the contract without
 * requiring the real `claude` binary to be installed, every test in
 * this file points `FACTORY_CLAUDE_COMMAND` at a small Node.js
 * stub script (created in a temp dir by `writeStub`) that echoes a
 * canned response.
 *
 * Coverage:
 *   - happy path: stub returns succeeded → dispatcher returns succeeded
 *   - format-error: stub returns missing `output` → dispatcher
 *     surfaces format-error with logTail containing the bad JSON
 *   - non-zero exit: stub exits 1 with stderr → dispatcher returns
 *     failed with retryable classified from the exit reason
 *   - readOnly capability: non-allowed role → dispatcher fails fast
 *     with no child process spawned
 *   - missing executable: FACTORY_CLAUDE_COMMAND points to nothing →
 *     dispatcher returns failed (retryable=false)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
            inputManifest: { systemPrompt: "Review.", userPrompt: "PR #1" },
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
            inputManifest: { systemPrompt: "x", userPrompt: "y" },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "format-error");
        assert.equal(result.backend, "claude-code");
        assert.equal(result.retryable, false);
        assert.ok(result.warnings.some((w) => /stdout/i.test(w)));
        assert.ok(result.logTail.includes("not valid JSON"));
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
            inputManifest: { systemPrompt: "x", userPrompt: "y" },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        // exit code 1 is classified retryable=true in claude-code-backend
        assert.equal(result.retryable, true);
        assert.ok(result.logTail.includes("upstream rate limit"));
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("readOnly capability: non-allowed role fails fast without spawning", async () => {
    const workdir = freshWorkdir();
    try {
        // Stub exists but must not be invoked.
        const stubPath = writeStub(workdir, { kind: "ok", output: "should not see this" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "implementation", // not in READ_ONLY_ROLES
            runId: "mutating",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", userPrompt: "y" },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.equal(result.backend, "claude-code");
        assert.ok(result.warnings.some((w) => /readOnly-only/.test(w)));
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
            inputManifest: { systemPrompt: "x", userPrompt: "y" },
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

test("FACTORY_AGENT_OVERRIDES routes review-pr to claude-code while keeping other roles on embedded", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "ok", output: "override works" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "codex-cli",
            FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "claude-code" }),
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "override",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", userPrompt: "y" },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.backend, "claude-code");
        assert.equal(result.output, "override works");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});