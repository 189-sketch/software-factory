// test/agent-backends-environment.test.mjs
//
// Verifies that `agentWorkerEnvironment(env, config)` from
// `runtime/agent-backends.mjs` forwards only the documented
// credential whitelist for each selected backend and never leaks
// unrelated secrets (especially GH_TOKEN / GITHUB_TOKEN — see
// commit 48cdd0e for the leak-fix baseline).
//
// Slice B.1 / Group 3 / Task 3.3 acceptance.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    resolveAgentConfig,
    agentWorkerEnvironment,
} from "../runtime/agent-backends.mjs";
import { runClaudeCodeStageFromConfig } from "../runtime/claude-code-backend.mjs";

const FULL_ENV = {
    GH_TOKEN: "ghp_shouldneverleak",
    GITHUB_TOKEN: "ghp_shouldalsoneverleak",
    ANTHROPIC_API_KEY: "sk-anthropic",
    ANTHROPIC_AUTH_TOKEN: "auth-token",
    ANTHROPIC_BASE_URL: "https://example.test",
    CLAUDE_CONFIG_DIR: "/tmp/claude-config",
    CODEX_HOME: "/tmp/codex-home",
    CODEX_API_KEY: "sk-codex",
    OPENAI_API_KEY: "sk-openai",
    OPENAI_BASE_URL: "https://openai.example.test",
    PI_CODING_AGENT_DIR: "/tmp/pi-dir",
    GEMINI_API_KEY: "sk-gemini",
    GOOGLE_API_KEY: "sk-google",
    DEEPSEEK_API_KEY: "sk-deepseek",
    OPENROUTER_API_KEY: "sk-openrouter",
    FACTORY_AGENT_BACKEND: "claude-code",
    FACTORY_AGENT_TIMEOUT_MS: "900000",
    FACTORY_CLAUDE_COMMAND: "claude",
    FACTORY_CODEX_COMMAND: "codex",
    FACTORY_PI_COMMAND: "pi",
    UNRELATED_SECRET: "should-never-appear",
};

function forwardedKeys(env) {
    return new Set(Object.keys(env));
}

test("no CLI backend selected: forwarded set is the baseline only, no upstream creds", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_AGENT_OVERRIDES: JSON.stringify({}),
    });
    const env = {
        ...FULL_ENV,
        FACTORY_AGENT_OVERRIDES: JSON.stringify({}),
    };
    const out = agentWorkerEnvironment(env, config);
    // Baseline keys that are always forwarded when set.
    const keys = forwardedKeys(out);
    assert.ok(keys.has("FACTORY_AGENT_BACKEND"));
    assert.ok(keys.has("FACTORY_AGENT_TIMEOUT_MS"));
    assert.ok(keys.has("FACTORY_CLAUDE_COMMAND"));
    assert.ok(keys.has("FACTORY_CODEX_COMMAND"));
    assert.ok(keys.has("FACTORY_PI_COMMAND"));
    // FACTORY_AGENT_OVERRIDES is forwarded when present.
    assert.ok(keys.has("FACTORY_AGENT_OVERRIDES"));
    // No upstream creds.
    assert.ok(!keys.has("GH_TOKEN"));
    assert.ok(!keys.has("GITHUB_TOKEN"));
    assert.ok(!keys.has("UNRELATED_SECRET"));
});

test("claude-code selected: forwards only Claude whitelist + command keys", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_CLAUDE_COMMAND: "claude",
    });
    const out = agentWorkerEnvironment(FULL_ENV, config);
    const keys = forwardedKeys(out);
    // Baseline keys.
    assert.ok(keys.has("FACTORY_AGENT_BACKEND"));
    assert.ok(keys.has("FACTORY_CLAUDE_COMMAND"));
    // Claude-specific whitelist.
    assert.ok(keys.has("CLAUDE_CONFIG_DIR"));
    assert.ok(keys.has("ANTHROPIC_API_KEY"));
    assert.ok(keys.has("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(keys.has("ANTHROPIC_BASE_URL"));
    // Off-whitelist keys must not appear.
    assert.ok(!keys.has("CODEX_HOME"));
    assert.ok(!keys.has("CODEX_API_KEY"));
    assert.ok(!keys.has("OPENAI_API_KEY"));
    assert.ok(!keys.has("PI_CODING_AGENT_DIR"));
    assert.ok(!keys.has("GEMINI_API_KEY"));
    // Secret leak guard — GH_TOKEN / GITHUB_TOKEN must never appear.
    assert.ok(!keys.has("GH_TOKEN"));
    assert.ok(!keys.has("GITHUB_TOKEN"));
    assert.ok(!keys.has("UNRELATED_SECRET"));
});

test("unsupported CLI backends are rejected before credentials are forwarded", () => {
    for (const backend of ["codex-cli", "pi-cli"]) {
        assert.throws(() => resolveAgentConfig({ FACTORY_AGENT_BACKEND: backend }), /Invalid FACTORY_AGENT backend/);
    }
});

test("GH_TOKEN / GITHUB_TOKEN leak fix is preserved under the supported backend", () => {
    for (const backend of ["claude-code"]) {
        const config = resolveAgentConfig({
            FACTORY_AGENT_BACKEND: backend,
            FACTORY_AGENT_OVERRIDES: JSON.stringify({}),
        });
        const out = agentWorkerEnvironment(FULL_ENV, config);
        assert.ok(!("GH_TOKEN" in out), `${backend} forwarded GH_TOKEN — leak regressed`);
        assert.ok(!("GITHUB_TOKEN" in out), `${backend} forwarded GITHUB_TOKEN — leak regressed`);
    }
});

// H-1 regression: drive the production path end-to-end through a
// real spawn to assert the wrapper actually applies the credential
// whitelist (rather than blindly forwarding `process.env` to the
// `claude` child process).
//
// The stub is a tiny Node.js script that:
//   1. dumps its own environment to a side file
//   2. writes a minimal valid Claude Code result to stdout
// We invoke it via `node <stub-path>` (Windows-safe shell form).
// The wrapper passes the executable string and its hardcoded
// `--print --output-format json` args; the stub ignores those and
// just reads stdin / writes stdout.
//
// We mutate `process.env` for the duration of the test so the
// wrapper's default-path call to
// `agentWorkerEnvironment(process.env, config)` sees a polluted
// parent environment, then restore it in `finally`.
test("runClaudeCodeStageFromConfig applies agentWorkerEnvironment on the production path (H-1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-claude-env-"));
    const dumpPath = join(dir, "child-env.json");
    const stubPath = join(dir, "stub.js");
    // The stub uses `__dirname` to find its dump path so it does not
    // depend on any env variable being forwarded (the whole point of
    // the H-1 fix is that only the whitelist reaches the child).
    const stubBody =
        `#!${process.execPath}\n` +
        "const fs = require('node:fs');" +
        "const path = require('node:path');" +
        `fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'child-env.json'), JSON.stringify(process.env));` +
        "process.stdout.write(JSON.stringify({ status: 'succeeded', output: 'ok', usage: null, warnings: [] }));";
    writeFileSync(stubPath, stubBody, { mode: 0o755 });
    const executable = process.platform === "win32" ? join(dir, "stub.cmd") : stubPath;
    if (process.platform === "win32") {
        writeFileSync(executable, `@"${process.execPath}" "${stubPath}" %*\r\n`);
    }

    const savedEnv = { ...process.env };
    // Pollute the parent env with secrets that the whitelist must filter.
    process.env.GH_TOKEN = "ghp_parent_should_not_leak";
    process.env.GITHUB_TOKEN = "ghp_parent_should_also_not_leak";
    process.env.UNRELATED_OPERATOR_SECRET = "operator-only-token";
    process.env.FACTORY_AGENT_BACKEND = "claude-code";
    // Pass one executable path on both platforms.
    process.env.FACTORY_CLAUDE_COMMAND = executable;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
    process.env.ANTHROPIC_BASE_URL = "https://example.test";

    try {
        const config = resolveAgentConfig({ ...process.env });
        const request = {
            role: "review-pr",
            runId: "run-h1-test",
            issue: { number: 1, repo: { workdir: dir } },
            inputManifest: { systemPrompt: "", userPrompt: "noop" },
            model: "",
            timeoutMs: 5000,
        };

        // resolveAgentConfig passes one executable path to spawn.
        const executableFromCfg = config.backends["claude-code"].executable;
        const result = await runClaudeCodeStageFromConfig(
            config,
            executableFromCfg,
            request,
        );

        assert.equal(result.status, "succeeded", `stub should have succeeded (got ${result.status}, warnings=${JSON.stringify(result.warnings)}, logTail=${result.logTail})`);

        const fsPromises = await import("node:fs/promises");
        const childEnvRaw = JSON.parse(await fsPromises.readFile(dumpPath, "utf8"));
        const childKeys = new Set(Object.keys(childEnvRaw));

        // Whitelist keys should be present.
        assert.ok(childKeys.has("FACTORY_CLAUDE_COMMAND"), "FACTORY_CLAUDE_COMMAND missing in child env");
        assert.ok(childKeys.has("CLAUDE_CONFIG_DIR"), "CLAUDE_CONFIG_DIR missing in child env");
        assert.ok(childKeys.has("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY missing in child env");
        assert.ok(childKeys.has("ANTHROPIC_AUTH_TOKEN"), "ANTHROPIC_AUTH_TOKEN missing in child env");

        // Secret-leak guard: parent env had GH_TOKEN + UNRELATED_OPERATOR_SECRET.
        // The wrapper must filter them via agentWorkerEnvironment.
        assert.ok(!childKeys.has("GH_TOKEN"), "GH_TOKEN leaked to claude child — H-1 regressed");
        assert.ok(!childKeys.has("GITHUB_TOKEN"), "GITHUB_TOKEN leaked to claude child — H-1 regressed");
        assert.ok(!childKeys.has("UNRELATED_OPERATOR_SECRET"), "UNRELATED_OPERATOR_SECRET leaked to claude child — H-1 regressed");
    } finally {
        // Restore parent env exactly as it was before the test.
        for (const key of Object.keys(process.env)) {
            if (!(key in savedEnv)) delete process.env[key];
        }
        for (const [key, value] of Object.entries(savedEnv)) {
            process.env[key] = value;
        }
    }
});
