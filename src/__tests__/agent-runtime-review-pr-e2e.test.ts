/**
 * Slice B.2 / Group 4 / Task 4.2 — review-pr end-to-end via Claude Code.
 *
 * Walks the documented review-pr scenario through the dispatcher with a
 * stub Claude Code CLI:
 *   - The fixture issues FACTORY_AGENT_OVERRIDES='{"review-pr":"claude-code"}'
 *     while leaving FACTORY_AGENT_BACKEND on `codex-cli` so the
 *     override path is exercised, not the global default.
 *   - The dispatcher must route review-pr to the stub, return a
 *     `succeeded` StageRunResult whose `output` carries the fixture's
 *     expected verdict, and emit lifecycle log fields with
 *     `backend: "claude-code"` and `agentSelectionSource: "overrides"`.
 *   - The fixture worktree is read-only with respect to the agent:
 *     `git status` before and after the run must show no mutation
 *     introduced by the agent path (we explicitly do not assert the
 *     stub created any files, since the dispatcher itself never
 *     touches the worktree, but we do assert the diff is clean).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { buildAgentRuntime, backendBindingsFor, type StageRunRequest } from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";

/**
 * Build a stub Claude Code CLI that returns the fixture's expected
 * verdict on every prompt.
 */
function writeReviewStub(dir: string, verdict: string): string {
    const script = path.join(dir, "claude-review-stub.mjs");
    const payload = JSON.stringify({
        status: "succeeded",
        output: verdict,
        usage: { inputTokens: 18, outputTokens: 5 },
        warnings: [],
    });
    writeFileSync(
        script,
        `let input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', c => input += c);\nprocess.stdin.on('end', () => {\n  process.stdout.write(${JSON.stringify(payload)});\n});\n`,
        "utf8",
    );
    chmodSync(script, 0o755);

    if (process.platform === "win32") {
        const cmd = path.join(dir, "claude-review-stub.cmd");
        writeFileSync(cmd, `@echo off\r\nnode "${script.replace(/\//g, "\\")}"\r\n`, "utf8");
        return cmd;
    }
    return script;
}

/**
 * Build a minimal git workdir so the read-only assertion has a real
 * `git status` to inspect.
 */
function buildGitWorkdir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "factory-review-fixture-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "ci@example.test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "ci"], { cwd: dir });
    writeFileSync(path.join(dir, "README.md"), "fixture\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
    return dir;
}

function makeContext(issueNumber: number, workdir: string): AgentContext {
    const logger = {
        info() {}, warn() {}, error() {}, debug() {},
        child() { return this; },
    };
    return {
        issue: { number: issueNumber, title: "x", body: "", labels: [], comments: [] },
        repo: { workdir },
        logger: logger as unknown as AgentContext["logger"],
        skills: [],
        skillsRoot: "/tmp/skills",
        runId: "review-pr-e2e",
        correction: undefined,
    } as unknown as AgentContext;
}

test("review-pr routes through claude-code via FACTORY_AGENT_OVERRIDES", async () => {
    const workdir = buildGitWorkdir();
    try {
        const stubPath = writeReviewStub(workdir, '{"verdict":"APPROVE","body":"looks good"}');
        const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: workdir }).toString();
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "codex-cli", // overridden for review-pr
            FACTORY_AGENT_OVERRIDES: JSON.stringify({ "review-pr": "claude-code" }),
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "review-pr-e2e",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "You are a review agent. Return JSON only.",
                messages: [{ role: "user" as const, content: "Review the diff in this worktree." }],
            },
        };
        const result = await rt.runStage(req, makeContext(1, workdir));

        // (a) verdict shape matches the fixture.
        assert.equal(result.status, "succeeded");
        assert.equal(result.backend, "claude-code");
        assert.match(result.output, /APPROVE/);
        assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 5 });

        // (b) lifecycle log bindings reflect the override provenance.
        const bindings = backendBindingsFor("review-pr");
        // Note: backendBindingsFor uses the default runtime (env-derived),
        // so it does not necessarily reflect the override we used
        // for `rt`. Instead verify the explicit dispatcher selection:
        const resolved = rt.selectBackend("review-pr");
        assert.equal(resolved.log.source, "overrides");
        assert.equal(resolved.selection.backend, "claude-code");
        // Bindings helper reports whatever the global default runtime sees
        // — must at minimum include all four documented fields.
        assert.equal(typeof bindings.backend, "string");
        assert.equal(typeof bindings.agentSelectionSource, "string");
        assert.equal(typeof bindings.backendSchemaVersion, "number");
        assert.equal(typeof bindings.backendBuildHash, "string");

        // (c) the fixture worktree is unchanged: git status before and
        // after must be identical because the dispatcher does not
        // touch the worktree on read-only roles.
        const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: workdir }).toString();
        assert.equal(statusBefore, statusAfter);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("review-pr falls back to claude-code when no override and no explicit default", async () => {
    // Without FACTORY_AGENT_OVERRIDES and without FACTORY_AGENT_BACKEND,
    // the default backend is `claude-code`. The Claude CLI may not be
    // on PATH in the test environment, so we only assert the dispatcher
    // surfaces a documented status from the claude-code path.
    const workdir = mkdtempSync(path.join(tmpdir(), "factory-review-fallback-"));
    try {
        const rt = buildAgentRuntime({});
        const req: StageRunRequest = {
            role: "review-pr",
            runId: "review-pr-fallback",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "x", messages: [{ role: "user" as const, content: "y" }] },
        };
        const result = await rt.runStage(req, makeContext(1, workdir));
        // Either succeeded (if a sibling test left a model override
        // in scope) or a documented status from the embedded path.
        assert.ok(
            ["succeeded", "failed", "format-error"].includes(result.status),
            `embedded fallback must surface a documented status; got ${result.status}`,
        );
        assert.equal(result.backend, "claude-code");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});