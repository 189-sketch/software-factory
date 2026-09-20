/**
 * provider-session ledger tests (M6).
 *
 * `src/core/provider-session.ts` is the single writer for
 * `state.providerSessions`. The orchestrator reads through
 * `getProviderSession` (which guards backend / model compatibility)
 * before every stage run and writes through `bindProviderSession`
 * after. Failure to honour the guards would let a session minted by
 * `claude-code` leak into a `codex-cli` run, wasting a spawn.
 *
 * Coverage:
 *   - bindProviderSession creates a fresh binding on first touch
 *   - bindProviderSession replaces on subsequent binds
 *   - getProviderSession returns undefined when no binding exists
 *   - getProviderSession refuses a backend mismatch
 *   - getProviderSession refuses a model mismatch inside the same backend
 *   - clearProviderSession drops the binding
 *   - attachResumeSessionId copies the binding onto ctx (or clears it)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachResumeSessionId,
  bindProviderSession,
  clearProviderSession,
  getProviderSession,
} from "../core/provider-session.js";
import type { FactoryIssueState, SessionBinding } from "../core/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function emptyState(): FactoryIssueState {
    return {
        issue: {
            number: 1,
            title: "t",
            body: "",
            labels: [],
            comments: [],
            author: "tester",
            url: "https://example.com/issues/1",
            createdAt: "2026-01-01T00:00:00Z",
        },
        merged: false,
    };
}

test("bindProviderSession creates a binding on first call", () => {
    const state = emptyState();
    const binding = bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "claude-sonnet-4-6",
    });
    assert.equal(binding.providerSessionId, "uuid-1");
    assert.equal(binding.backend, "claude-code");
    assert.equal(binding.model, "claude-sonnet-4-6");
    assert.equal(binding.attempt, 1);
    assert.equal(state.providerSessions?.["implementation"]?.providerSessionId, "uuid-1");
});

test("bindProviderSession replaces the binding on subsequent calls (attempt counter increments)", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "claude-sonnet-4-6",
        boundAt: "2026-09-18T00:00:00Z",
    });
    const next = bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-2",
        backend: "claude-code",
        model: "claude-sonnet-4-6",
        boundAt: "2026-09-18T00:01:00Z",
    });
    assert.equal(next.providerSessionId, "uuid-2");
    assert.equal(next.attempt, 2);
    assert.equal(state.providerSessions?.["implementation"]?.providerSessionId, "uuid-2");
});

test("bindProviderSession keeps separate bindings per role", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-impl",
        backend: "claude-code",
        model: "m",
    });
    bindProviderSession(state, "review-pr", {
        providerSessionId: "uuid-review",
        backend: "claude-code",
        model: "m",
    });
    assert.equal(state.providerSessions?.["implementation"]?.providerSessionId, "uuid-impl");
    assert.equal(state.providerSessions?.["review-pr"]?.providerSessionId, "uuid-review");
});

test("getProviderSession returns undefined when no binding exists", () => {
    const state = emptyState();
    assert.equal(getProviderSession(state, "implementation", "claude-code", "m"), undefined);
});

test("getProviderSession returns the binding when backend + model match", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "m",
    });
    const got = getProviderSession(state, "implementation", "claude-code", "m");
    assert.ok(got);
    assert.equal(got?.providerSessionId, "uuid-1");
});

test("getProviderSession refuses a backend mismatch (cross-provider reuse guard)", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "m",
    });
    // Operator flipped FACTORY_AGENT_BACKEND to codex-cli for this issue.
    // The previous session cannot be resumed; cold start is required.
    assert.equal(getProviderSession(state, "implementation", "codex-cli", "m"), undefined);
});

test("getProviderSession refuses a model mismatch inside the same backend", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "claude-sonnet-4-6",
    });
    // Operator changed FACTORY_CLAUDE_MODEL. The CLI itself rejects
    // --resume when the session's original model differs from the
    // requested one — getProviderSession mirrors that refusal.
    assert.equal(getProviderSession(state, "implementation", "claude-code", "claude-opus-4-8"), undefined);
});

test("clearProviderSession drops the binding; missing role is a no-op", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "m",
    });
    clearProviderSession(state, "implementation");
    assert.equal(state.providerSessions?.["implementation"], undefined);
    // No-op paths:
    clearProviderSession(state, "implementation");
    clearProviderSession(state, "never-bound");
    assert.equal(state.providerSessions?.["implementation"], undefined);
});

test("attachResumeSessionId sets ctx.resumeSessionId from a live binding", () => {
    const state = emptyState();
    bindProviderSession(state, "implementation", {
        providerSessionId: "uuid-1",
        backend: "claude-code",
        model: "m",
    });
    const ctx: { resumeSessionId?: string } = {};
    attachResumeSessionId(ctx, getProviderSession(state, "implementation", "claude-code", "m"));
    assert.equal(ctx.resumeSessionId, "uuid-1");
});

test("attachResumeSessionId clears ctx.resumeSessionId when no binding (cold start)", () => {
    const state = emptyState();
    const ctx: { resumeSessionId?: string } = { resumeSessionId: "stale" };
    attachResumeSessionId(ctx, getProviderSession(state, "implementation", "claude-code", "m"));
    assert.equal(ctx.resumeSessionId, undefined);
    // delete, not just undefined, so a JSON-serialised ctx does not
    // leak the stale id to a child process.
    assert.ok(!("resumeSessionId" in ctx));
});

test("session id is a UUID format from a real CLI envelope fixture", () => {
    // Sanity: confirm the fixture captured for parser tests uses the
    // field name `session_id` (snake_case) and is a UUID. This guards
    // against drift if someone renames the field in a CLI upgrade
    // without updating parseClaudeCodeStdout.
    const fixturePath = join(__dirname, "..", "..", "fixtures", "claude-cli", "result-success.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { session_id?: string };
    assert.ok(fixture.session_id, "fixture must carry session_id");
    assert.match(fixture.session_id, /^[0-9a-f-]{36}$/i, "session_id must be a UUID");
});
