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

import {
    resolveAgentConfig,
    agentWorkerEnvironment,
} from "../runtime/agent-backends.mjs";

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
    FACTORY_AGENT_BACKEND: "embedded",
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
        FACTORY_AGENT_BACKEND: "embedded",
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

test("codex-cli selected: forwards only Codex whitelist", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "codex-cli",
    });
    const out = agentWorkerEnvironment(FULL_ENV, config);
    const keys = forwardedKeys(out);
    assert.ok(keys.has("CODEX_HOME"));
    assert.ok(keys.has("CODEX_API_KEY"));
    assert.ok(keys.has("OPENAI_API_KEY"));
    assert.ok(keys.has("OPENAI_BASE_URL"));
    assert.ok(!keys.has("CLAUDE_CONFIG_DIR"));
    assert.ok(!keys.has("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(!keys.has("GH_TOKEN"));
});

test("pi-cli selected: forwards the multi-provider whitelist", () => {
    const config = resolveAgentConfig({
        FACTORY_AGENT_BACKEND: "pi-cli",
    });
    const out = agentWorkerEnvironment(FULL_ENV, config);
    const keys = forwardedKeys(out);
    assert.ok(keys.has("PI_CODING_AGENT_DIR"));
    assert.ok(keys.has("ANTHROPIC_API_KEY"));
    assert.ok(keys.has("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(keys.has("OPENAI_API_KEY"));
    assert.ok(keys.has("GEMINI_API_KEY"));
    assert.ok(keys.has("GOOGLE_API_KEY"));
    assert.ok(keys.has("DEEPSEEK_API_KEY"));
    assert.ok(keys.has("OPENROUTER_API_KEY"));
    // Codex-specific keys must not appear under pi-cli.
    assert.ok(!keys.has("CODEX_HOME"));
    assert.ok(!keys.has("CODEX_API_KEY"));
    assert.ok(!keys.has("GH_TOKEN"));
});

test("GH_TOKEN / GITHUB_TOKEN leak fix from 48cdd0e is preserved under every backend", () => {
    for (const backend of ["embedded", "claude-code", "codex-cli", "pi-cli"]) {
        const config = resolveAgentConfig({
            FACTORY_AGENT_BACKEND: backend,
            FACTORY_AGENT_OVERRIDES: JSON.stringify({}),
        });
        const out = agentWorkerEnvironment(FULL_ENV, config);
        assert.ok(!("GH_TOKEN" in out), `${backend} forwarded GH_TOKEN — leak regressed`);
        assert.ok(!("GITHUB_TOKEN" in out), `${backend} forwarded GITHUB_TOKEN — leak regressed`);
    }
});