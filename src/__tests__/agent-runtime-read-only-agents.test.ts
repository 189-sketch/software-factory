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
 *   - triage-supervisor: same wiring with role === "triage-supervisor".
 *   - spec-product: role === "spec-product", contextTurns optional,
 *     parse returns `{ product }`.
 *   - review-pr: role === "review-pr", parse returns `ReviewResult`.
 *   - review-spec: role === "review-spec", parse returns
 *     `SpecReviewResult` with notes.
 *   - verify-behavior: role === "verify-behavior", parse returns a
 *     `BehaviorVerificationResult` shape.
 *
 * Same Node-stub pattern as the harness-adapter tests — each test
 * points `FACTORY_CLAUDE_COMMAND` at a small script that reads one
 * JSON request and writes one canned response keyed off the
 * request's `role` field.
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
 * Stub that reads one JSON request and replies with a JSON whose
 * shape matches the role's parse function so the round-trip succeeds.
 *
 * The script picks `output` based on the request's `role` so a single
 * stub can serve multiple dispatch tests — it avoids writing one
 * script per role while keeping the per-role output shape honest.
 */
function writeRoleStub(
    dir: string,
    responsesByRole: Record<string, { output: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }>,
): string {
    const script = path.join(dir, "role-stub.mjs");
    const responsesJson = JSON.stringify(responsesByRole);
    const body =
        "let input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + "  try {\n"
        + "    const req = JSON.parse(input);\n"
        + `    const responses = ${responsesJson};\n`
        + "    const cfg = responses[req.role];\n"
        + "    if (!cfg) { process.stderr.write('no response for role ' + req.role); process.exit(2); }\n"
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
    writeFileSync(script, body, "utf8");
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
            triage: {
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
            userPrompt: "Inspect issue #1.",
            outputContract: TRIAGE_CONTRACT,
            parse: parseTriageDecision,
        }, rt);
        // parseTriageDecision returns a TriageResult with the same
        // state/label/comment as the contract example.
        assert.equal(result.state, "Ready to implement");
        assert.equal(result.label, "ready-to-implement");
        assert.ok(result.comment.length > 0);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("triage-supervisor: dispatchAgentStage passes the supervisor role", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "triage-supervisor": {
                output: JSON.stringify({
                    action: "retry",
                    targetStage: "spec",
                    correction: ["Tighten AC"],
                    comment: "Spec review rejected; retrying.",
                }),
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const result = await dispatchAgentStage("triage-supervisor", makeContext(workdir), {
            systemPrompt: "You are the supervisor.",
            userPrompt: "Failure envelope follows.",
            outputContract: {
                requirements: [
                    "`action` is exactly one of: \"retry\", \"reroute\", \"needs-info\", \"abort\".",
                ],
                example: {
                    action: "retry",
                    targetStage: "spec",
                    correction: [],
                    comment: "ok",
                },
            },
            parse: (text: string) => {
                const value = jsonObject(text);
                return {
                    action: String(value.action ?? ""),
                    targetStage: String(value.targetStage ?? ""),
                    correction: Array.isArray(value.correction)
                        ? (value.correction as unknown[]).map((c) => String(c ?? ""))
                        : [],
                    comment: String(value.comment ?? ""),
                };
            },
        }, rt);
        assert.equal(result.action, "retry");
        assert.equal(result.targetStage, "spec");
        assert.deepEqual(result.correction, ["Tighten AC"]);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("spec-product: dispatchAgentStage routes under role=spec-product with contextTurns", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "spec-product": {
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
                userPrompt: "Design the product spec.",
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
                contextTurns: ["Revision feedback: tighten AC."],
                parse: (text: string) => {
                    const value = jsonObject(text);
                    const product = value.product as { title: string; slug: string };
                    return { product };
                },
            },
            rt,
        );
        assert.equal(result.product.title, "Demo");
        assert.equal(result.product.slug, "issue-1-demo");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("review-pr: dispatchAgentStage parses a ReviewResult shape", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "review-pr": {
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
            userPrompt: "PR #1.",
            outputContract: {
                requirements: [
                    "`verdict` is exactly \"APPROVE\" or \"REJECT\".",
                    "`body` is a non-empty string.",
                ],
                example: { verdict: "APPROVE", body: "ok", comments: [] },
            },
            parse: (text: string) => parseReviewerOutput(text, { stage: "review-pr", sourceRunId: "test" }),
        }, rt);
        assert.equal(result.verdict, "APPROVE");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("review-spec: dispatchAgentStage parses a SpecReviewResult shape with notes", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "review-spec": {
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
            userPrompt: "Spec PR follows.",
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
        assert.equal(result.verdict, "APPROVE");
        assert.equal(result.notes, "Spec is implementation-ready.");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("verify-behavior: dispatchAgentStage parses a BehaviorVerificationResult", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeRoleStub(workdir, {
            "verify-behavior": {
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
            userPrompt: "Run checks.",
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
        assert.equal(result.status, "verified");
        assert.equal(result.channel, "browser");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});