/**
 * Slice C / Group 6 / Task 6.3 — per-read-only-agent dispatch tests.
 *
 * Each agent's `run()` builds an `OutputContract` and a parse
 * function; `dispatchAgentStage` hides the `StageRunRequest`
 * assembly and the `StageRunResult`-to-parse plumbing. These tests
 * exercise the wiring through `dispatchAgentStage` so a regression
 * in the adapter surface (missing field, wrong role name, broken
 * parse glue) fails before the agent sees it.
 *
 * Coverage:
 *   - triage readiness path: StageRunRequest.role === "triage",
 *     OutputContract.example is fed to composeSystemPrompt, the
 *     agent's parse function consumes the child's JSON output.
 *   - spec-product: role === "spec-product", contextTurns optional,
 *     parse returns `{ product }`.
 *   - review-pr: role === "review-pr", parse returns `ReviewResult`.
 *   - review-spec: role === "review-spec", parse returns
 *     `SpecReviewResult` with notes.
 *   - verify-behavior: role === "verify-behavior", parse returns a
 *     `BehaviorVerificationResult` shape.
 *
 * Note (2026-09): the previous `triage-supervisor` dispatch test
 * was removed when that role was retired in the issue #36 fix —
 * failure routing is now a deterministic pure function in
 * `src/core/routing-decision.ts`, not an LLM dispatch.
 *
 * Same Node-stub pattern as the harness-adapter tests — each test
 * points `FACTORY_CLAUDE_COMMAND` at a small script that reads the
 * composed prompt text and writes one canned response keyed off a
 * distinctive marker in the role systemPrompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAgentRuntime, dispatchAgentStage, type StageRunRequest } from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";
import type { OutputContract } from "../core/output-contract.js";
import { jsonObject } from "../core/output.js";
import { parseTriageDecision } from "../agents/triage.js";
import { parseReviewerOutput } from "../core/review-parser.js";

function freshWorkdir(): string {
    return mkdtempSync(path.join(tmpdir(), "factory-rt-ro-agents-"));
}

function makeContext(workdir: string): AgentContext {
    const logger = {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() { return this; },
    };
    return {
        issue: { number: 1, title: "x", body: "", labels: [], comments: [] },
        repo: { workdir },
        logger: logger as unknown as AgentContext["logger"],
        skills: [],
        skillsRoot: "/tmp/skills",
        runId: "ro-agents-test-run",
        correction: undefined,
    } as unknown as AgentContext;
}

/**
 * Stub that reads the composed prompt TEXT from stdin and replies
 * with a JSON whose shape matches the role's parse function so the
 * round-trip succeeds.
 *
 * Since the real-CLI integration the child receives a composed prompt
 * (system + user + context turns), not a JSON request, so the stub
 * picks its canned response by matching a distinctive marker string
 * from each role's systemPrompt. A single stub can still serve
 * multiple dispatch tests.
 */
function writeRoleStub(
    dir: string,
    responsesByMarker: Record<string, { output: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }>,
): string {
    const script = path.join(dir, "role-stub.mjs");
    const responsesJson = JSON.stringify(responsesByMarker);
    const body =
        "let input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + "  try {\n"
        + `    const responses = ${responsesJson};\n`
        + "    let cfg = null;\n"
        + "    for (const [marker, value] of Object.entries(responses)) {\n"
        + "      if (input.includes(marker)) { cfg = value; break; }\n"
        + "    }\n"
        + "    if (!cfg) { process.stderr.write('no canned response matched the prompt'); process.exit(2); }\n"
        + "    const payload = {\n"
        + "      status: 'succeeded',\n"
        + "      output: cfg.output,\n"
        + "      usage: cfg.usage ?? { inputTokens: 1, outputTokens: 1 },\n"
        + "      warnings: [],\n"
        + "    };\n"
        + "    process.stdout.write(JSON.stringify(payload));\n"
        + "  } catch (e) { process.stderr.write(String(e && e.stack || e)); process.exit(1); }\n"
        + "  process.exit(0);\n"
        + "});\n";
    writeFileSync(script, `#!${process.execPath}\n${body}`, "utf8");
    chmodSync(script, 0o755);
    if (process.platform === "win32") {
        const cmd = path.join(dir, "role-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(cmd, `@echo off\r\nnode "${scriptWindowsPath}"\r\n`, "utf8");
        return cmd;
    }
    return script;
}

const TRIAGE_CONTRACT: OutputContract = {
    requirements: [
        "`state` is exactly one of: \"Ready to implement\", \"Ready to spec\", \"Needs info\", \"Wait to implement\".",
        "`comment` is a non-empty string.",
    ],
    example: {
        state: "Ready to implement",
        label: "ready-to-implement",
        remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement"],
        comment: "Body already names the framework.",
    },
};

test("triage: dispatchAgentStage wires role + contract + parse end-to-end", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "You are a triage agent.": {
                output: JSON.stringify(TRIAGE_CONTRACT.example),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const ctx = makeContext(workdir);
        const result = await dispatchAgentStage("triage", ctx, {
            systemPrompt: "You are a triage agent.",
            messages: [{ role: "user" as const, content: "Inspect issue #1." }],
            outputContract: TRIAGE_CONTRACT,
            parse: parseTriageDecision,
        }, rt);
        // parseTriageDecision returns a TriageResult with the same
        // state/label/comment as the contract example.
        assert.equal(result.value.state, "Ready to implement");
        assert.equal(result.value.label, "ready-to-implement");
        assert.ok(result.value.comment.length > 0);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("dispatchAgentStage: unknown role names are rejected (not silently routed)", async () => {
    // The previous `triage-supervisor` role was removed in 2026-09
    // (issue #36 fix). This test pins the runtime contract that an
    // unknown role name — including the deleted one — fails fast at
    // the role-allow-list gate instead of spawning a child process
    // for a non-existent hat.
    const workdir = freshWorkdir();
    try {
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: "noop",
        });
        await assert.rejects(
            () => dispatchAgentStage("triage-supervisor" as never, makeContext(workdir), {
                systemPrompt: "you should not be invoked",
                messages: [{ role: "user" as const, content: "x" }],
                outputContract: { requirements: [], example: {} },
                parse: (text: string) => ({ value: text }),
            }, rt),
            /role allow-list/,
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("spec-product: dispatchAgentStage routes under role=spec-product with contextTurns", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "You write PRODUCT.md.": {
                output: JSON.stringify({
                    product: {
                        title: "Demo",
                        slug: "issue-1-demo",
                        problem: "p",
                        goals: [],
                        nonGoals: [],
                        stories: [
                            {
                                id: "US-1",
                                title: "t",
                                asA: "a",
                                iWant: "w",
                                soThat: "s",
                                checks: ["c"],
                            },
                        ],
                        acceptanceCriteria: ["a"],
                        openQuestions: [],
                        body: "# PRODUCT.md",
                    },
                }),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const result = await dispatchAgentStage<{ product: { title: string; slug: string } }>(
            "spec-product",
            makeContext(workdir),
            {
                systemPrompt: "You write PRODUCT.md.",
                messages: [
                    { role: "user" as const, content: "Design the product spec." },
                    { role: "user" as const, content: "Revision feedback: tighten AC." },
                ],
                outputContract: {
                    requirements: [
                        "`title` and `problem` are non-empty strings.",
                        "`body` is the complete PRODUCT.md as markdown.",
                    ],
                    example: {
                        title: "Demo",
                        slug: "issue-1-demo",
                        problem: "p",
                        goals: [],
                        nonGoals: [],
                        stories: [],
                        acceptanceCriteria: [],
                        openQuestions: [],
                        body: "# PRODUCT.md",
                    },
                },
                parse: (text: string) => {
                    const value = jsonObject(text);
                    const product = value.product as { title: string; slug: string };
                    return { product };
                },
            },
            rt,
        );
        assert.equal(result.value.product.title, "Demo");
        assert.equal(result.value.product.slug, "issue-1-demo");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("review-pr: dispatchAgentStage parses a ReviewResult shape", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "You are a code review agent.": {
                output: JSON.stringify({
                    verdict: "APPROVE",
                    body: "No findings.",
                    comments: [],
                }),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const result = await dispatchAgentStage("review-pr", makeContext(workdir), {
            systemPrompt: "You are a code review agent.",
            messages: [{ role: "user" as const, content: "PR #1." }],
            outputContract: {
                requirements: [
                    "`verdict` is exactly \"APPROVE\" or \"REJECT\".",
                    "`body` is a non-empty string.",
                ],
                example: { verdict: "APPROVE", body: "ok", comments: [] },
            },
            parse: (text: string) => parseReviewerOutput(text, { stage: "review-pr", sourceRunId: "test" }),
        }, rt);
        assert.equal(result.value.verdict, "APPROVE");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("review-spec: dispatchAgentStage parses a SpecReviewResult shape with notes", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "You are a spec review agent.": {
                output: JSON.stringify({
                    verdict: "APPROVE",
                    body: "No findings.",
                    notes: "Spec is implementation-ready.",
                    comments: [],
                }),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const result = await dispatchAgentStage("review-spec", makeContext(workdir), {
            systemPrompt: "You are a spec review agent.",
            messages: [{ role: "user" as const, content: "Spec PR follows." }],
            outputContract: {
                requirements: [
                    "`verdict` is exactly \"APPROVE\" or \"REJECT\".",
                    "`notes` is a free-form string.",
                ],
                example: { verdict: "APPROVE", body: "ok", notes: "", comments: [] },
            },
            parse: (text: string) => parseReviewerOutput(text, {
                stage: "review-spec",
                sourceRunId: "test",
                includeNotes: true,
            }) as { verdict: "APPROVE" | "REJECT"; body: string; notes?: string; comments: unknown[] },
        }, rt);
        assert.equal(result.value.verdict, "APPROVE");
        assert.equal(result.value.notes, "Spec is implementation-ready.");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("verify-behavior: dispatchAgentStage parses a BehaviorVerificationResult", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "You verify behavior.": {
                output: JSON.stringify({
                    mode: "verify",
                    status: "verified",
                    channel: "browser",
                    evidence: [],
                }),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const result = await dispatchAgentStage("verify-behavior", makeContext(workdir), {
            systemPrompt: "You verify behavior.",
            messages: [{ role: "user" as const, content: "Run checks." }],
            outputContract: {
                requirements: [
                    "`status` is exactly \"verified\" | \"failed\" | \"blocked\".",
                ],
                example: {
                    mode: "verify",
                    status: "verified",
                    channel: "browser",
                    evidence: [],
                },
            },
            parse: (text: string) => {
                const value = jsonObject(text);
                return {
                    mode: String(value.mode ?? "verify"),
                    status: value.status === "verified" || value.status === "failed" || value.status === "blocked"
                        ? value.status
                        : "failed",
                    channel: typeof value.channel === "string" ? value.channel : "browser",
                    evidence: Array.isArray(value.evidence) ? value.evidence : [],
                };
            },
        }, rt);
        assert.equal(result.value.status, "verified");
        assert.equal(result.value.channel, "browser");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});
