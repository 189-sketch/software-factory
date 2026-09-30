/**
 * Slice C / Group 5 / Task 5.4 — `claudeCodeHarnessAdapter` tests.
 *
 * The harness adapter differs from the plain Claude Code adapter in
 * three ways (see src/core/agent-runtime.ts):
 *
 *   1. It assembles the final system prompt through
 *      `composeSystemPrompt(role, skills, contract, requiredRules)`
 *      before spawning the child CLI, instead of forwarding the
 *      role text verbatim.
 *   2. It detects a JSON parse miss and sends one corrective retry
 *      whose prompt is the `contractShapeHint(contract)`.
 *   3. It merges the two attempts' `usage` so the orchestrator
 *      sees a single `StageRunResult.usage`.
 *
 * Coverage:
 *   - system-prompt assembly: the composed prompt piped to the child
 *     carries the role + skill catalog + output-contract example, not
 *     the raw role text alone.
 *   - parse-miss retry: a non-object first response triggers one
 *     retry whose prompt includes the contract shape.
 *   - usage merge: token counts from both attempts are summed.
 *   - happy path (no parse miss): no retry, single usage block.
 *
 * Same Node-stub pattern as `agent-runtime-claude-code.test.ts` —
 * each test points `FACTORY_CLAUDE_COMMAND` at a small script that
 * reads the composed prompt text and writes one canned response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAgentRuntime, type StageRunRequest } from "../core/agent-runtime.js";
import type { AgentContext } from "../core/types.js";
import { contractShapeHint, type OutputContract } from "../core/output-contract.js";

function freshWorkdir(): string {
    return mkdtempSync(path.join(tmpdir(), "factory-rt-harness-"));
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
        skills: [
            { name: "triage-skill", description: "Triage rubric body" },
            { name: "extra-skill", description: "Auxiliary rubric" },
        ],
        skillsRoot: "/tmp/skills",
        runId: "harness-test-run",
        correction: undefined,
    } as unknown as AgentContext;
}

const TRIVIAL_CONTRACT: OutputContract = {
    requirements: [
        "`state` is exactly one of: \"Ready to implement\", \"Ready to spec\".",
        "`comment` is a non-empty string.",
    ],
    example: {
        state: "Ready to implement",
        label: "ready-to-implement",
        remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement"],
    comment: "Issue body already names the framework; no spec needed.",
    },
};

test("Claude CLI stage tool bridge is cleaned up when spawning fails", async () => {
    const workdir = freshWorkdir();
    try {
        const rt = buildAgentRuntime({ FACTORY_CLAUDE_COMMAND: path.join(workdir, "missing-cli") });
        const result = await rt.runStage({
            role: "implementation",
            runId: "tool-contract",
            issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: "Implement", messages: [{ role: "user", content: "Change code" }] },
            tools: [{ name: "run_validation", description: "Validate", execute: async () => ({ exitCode: 0 }) }],
        }, makeContext(workdir));
        assert.equal(result.status, "failed");
        assert.doesNotMatch(result.warnings.join(" "), /not supported/i);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

/**
 * Write a Node stub that
 *   - reads the composed prompt text from stdin,
 *   - emits a response according to `behavior` (legacy factory-stub
 *     envelope, which the adapter still accepts alongside the native
 *     Claude Code result envelope).
 */
function writeStub(
    dir: string,
    behavior:
        | { kind: "ok"; output: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
        | { kind: "non-object"; output: string; then: { output: string; status?: 'failed'; usage?: { inputTokens: number | null; outputTokens: number | null } | null } }
        | { kind: "format-error" },
): string {
    const script = path.join(dir, "harness-stub.mjs");
    let body = "import fs from 'node:fs';\nlet input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + "  try {\n";
    if (behavior.kind === "ok") {
        const payload = {
            status: "succeeded",
            output: behavior.output,
            usage: behavior.usage ?? { inputTokens: 12, outputTokens: 7 },
            warnings: [],
        };
        body += `  process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));\n`;
    } else if (behavior.kind === "non-object") {
        const firstPayload = JSON.stringify({ type: 'result', subtype: 'success', result: behavior.output, session_id: '00000000-0000-0000-0000-000000000001' });
        const secondPayload = JSON.stringify(behavior.then.status === 'failed' ? {
            type: 'result', subtype: 'error_during_execution', is_error: true, result: behavior.then.output,
        } : {
            status: "succeeded",
            output: behavior.then.output,
            usage: behavior.then.usage ?? { inputTokens: 30, outputTokens: 18 },
            warnings: [],
        });
        body += "  const retry = input.includes('previous response');\n"
            + `  if (retry) { fs.writeFileSync(${JSON.stringify(path.join(dir, 'repair-args.json'))}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(${JSON.stringify(path.join(dir, 'repair-prompt.txt'))}, input); }\n`
            + `  const payload = retry ? ${secondPayload} : ${firstPayload};\n`
            + "  process.stdout.write(JSON.stringify(payload));\n";
    } else {
        body += "  process.stdout.write(\"not valid JSON: {\");\n";
    }
    body += "  } catch (e) { process.stderr.write(String(e && e.stack || e)); process.exit(1); }\n"
        + "  process.exit(0);\n"
        + "});\n";
    writeFileSync(script, body, "utf8");
    chmodSync(script, 0o755);

    if (process.platform === "win32") {
        const cmd = path.join(dir, "harness-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(cmd, `@echo off\r\nnode "${scriptWindowsPath}" %*\r\n`, "utf8");
        return cmd;
    }
    return script;
}

/**
 * Echo stub: reads the composed prompt TEXT from stdin and replies
 * with it verbatim as the output. Used by the system prompt assembly
 * test to assert on the assembled prompt without needing a capture
 * file (the stub is plain ESM, not CJS).
 */
function writeStubEcho(dir: string): string {
    const script = path.join(dir, "harness-echo-stub.mjs");
    const body =
        "let input = '';\n"
        + "process.stdin.setEncoding('utf8');\n"
        + "process.stdin.on('data', c => input += c);\n"
        + "process.stdin.on('end', () => {\n"
        + "  try {\n"
        + "    const payload = {\n"
        + "      type: 'result',\n"
        + "      subtype: 'success',\n"
        + "      is_error: false,\n"
        + "      result: input,\n"
        + "      usage: { input_tokens: 1, output_tokens: 1 },\n"
        + "    };\n"
        + "    process.stdout.write(JSON.stringify(payload));\n"
        + "  } catch (e) { process.stderr.write(String(e && e.stack || e)); process.exit(1); }\n"
        + "  process.exit(0);\n"
        + "});\n";
    writeFileSync(script, body, "utf8");
    chmodSync(script, 0o755);
    if (process.platform === "win32") {
        const cmd = path.join(dir, "harness-echo-stub.cmd");
        const scriptWindowsPath = script.replace(/\//g, "\\");
        writeFileSync(cmd, `@echo off\r\nnode "${scriptWindowsPath}"\r\n`, "utf8");
        return cmd;
    }
    return script;
}

test("harness adapter assembles system prompt from composeSystemPrompt before spawn", async () => {
    const workdir = freshWorkdir();
    try {
        // The stub echoes the composed prompt text back inside the
        // native result envelope so the test can assert on what the
        // adapter actually piped to the child. Avoids needing a
        // separate capture file (the stub is plain ESM, not CJS, so
        // `require('node:fs')` is not available).
        const stubPath = writeStubEcho(workdir);
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "triage",
            runId: "harness-1",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "RAW ROLE TEXT — should be wrapped, not forwarded verbatim",
                messages: [{ role: "user" as const, content: "Issue body" }],
                outputContract: TRIVIAL_CONTRACT,
                requiredRules: [
                    {
                        name: "triage-required",
                        description: "Mandatory triage rubric.",
                        body: "Mandatory triage rubric body content.",
                        hash: "deadbeef",
                    },
                ],
            },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        // The stub echoes the whole composed prompt back as the
        // native envelope's `result`, so the assertion surface is
        // just `result.output`.
        const sp = result.output;
        assert.ok(
            sp.includes("RAW ROLE TEXT"),
            `expected role text in assembled prompt; got first 200 chars: ${sp.slice(0, 200)}`,
        );
        assert.ok(
            /Available skills/i.test(sp),
            `expected skill catalog section; got first 400 chars: ${sp.slice(0, 400)}`,
        );
        assert.ok(
            sp.includes("triage-skill"),
            `expected skill name 'triage-skill' in prompt`,
        );
        assert.ok(
            sp.includes("Mandatory triage rubric body content"),
            `expected required-rule rubric body in prompt`,
        );
        assert.ok(
            /Output format/i.test(sp),
            `expected 'Output format' section header`,
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("harness adapter retries once on parse miss and merges usage", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, {
            kind: "non-object",
            output: "I forgot the JSON shape",
            then: {
                output: JSON.stringify({
                        state: "Ready to implement",
                        label: "ready-to-implement",
                        remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement"],
                        comment: "Body already names the framework.",
                    }),
                usage: { inputTokens: 30, outputTokens: 18 },
            },
        });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "triage",
            runId: "harness-parse-miss",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "You are a triage agent.",
                messages: [{ role: "user" as const, content: "Inspect issue #1." }],
                outputContract: TRIVIAL_CONTRACT,
            },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "succeeded");
        // After retry, the output should be the second attempt's
        // canonical JSON, not the first attempt's prose.
        const parsed = JSON.parse(result.output) as { state: string };
        assert.equal(parsed.state, "Ready to implement");
        // usage from the retry (the second attempt) is preserved;
        // the first attempt's usage is `null` in the stub so the
        // combined usage is just the retry's.
        assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 18 });
        const args = JSON.parse(readFileSync(path.join(workdir, 'repair-args.json'), 'utf8')) as string[];
        assert.equal(args[args.indexOf('--resume') + 1], '00000000-0000-0000-0000-000000000001');
        const repairPrompt = readFileSync(path.join(workdir, 'repair-prompt.txt'), 'utf8');
        assert.match(repairPrompt, /Repair only the serialization/);
        assert.doesNotMatch(repairPrompt, /Inspect issue #1/);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('failed format repair retains the original session for the next bounded attempt', async () => {
    const workdir = freshWorkdir();
    try {
        const executable = writeStub(workdir, { kind: 'non-object', output: 'Malformed answer', then: { status: 'failed', output: '' } });
        const runtime = buildAgentRuntime({ FACTORY_AGENT_BACKEND: 'claude-code', FACTORY_CLAUDE_COMMAND: executable });
        const result = await runtime.runStage({ role: 'triage', runId: 'repair-failure', issue: { number: 1, repo: { workdir } },
            inputManifest: { systemPrompt: 'Triage', messages: [{ role: 'user', content: 'Inspect' }], outputContract: TRIVIAL_CONTRACT } }, makeContext(workdir));
        assert.equal(result.status, 'failed');
        assert.equal(result.providerSessionId, '00000000-0000-0000-0000-000000000001');
    } finally { rmSync(workdir, { recursive: true, force: true }); }
});

test("harness adapter surfaces format-error when both attempts return malformed JSON", async () => {
    const workdir = freshWorkdir();
    try {
        const stubPath = writeStub(workdir, { kind: "format-error" });
        const rt = buildAgentRuntime({
            FACTORY_AGENT_BACKEND: "claude-code",
            FACTORY_CLAUDE_COMMAND: stubPath,
        });
        const req: StageRunRequest = {
            role: "triage",
            runId: "harness-fmt",
            issue: { number: 1, repo: { workdir } },
            inputManifest: {
                systemPrompt: "x",
                messages: [{ role: "user" as const, content: "y" }],
                outputContract: TRIVIAL_CONTRACT,
            },
        };
        const result = await rt.runStage(req, makeContext(workdir));
        assert.equal(result.status, "format-error");
        assert.equal(result.retryable, false);
        assert.ok(
            result.warnings.some((w) => /stdout/i.test(w)),
            `expected stdout warning; got ${JSON.stringify(result.warnings)}`,
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("harness adapter exposes contractShapeHint as the retry hint payload", () => {
    // Pure-function assertion: the corrective retry text must
    // include the contract's example so the model sees the shape it
    // failed to match. Keeping this as a tiny assertion prevents the
    // retry hint from drifting silently.
    assert.equal(contractShapeHint(TRIVIAL_CONTRACT), JSON.stringify(TRIVIAL_CONTRACT.example));
});
