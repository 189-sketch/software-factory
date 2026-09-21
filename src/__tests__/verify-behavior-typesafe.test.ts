/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1 acceptance tests
 * (verify-behavior half — B9 + B10 + B11).
 *
 * Covers the T9.1 acceptance bullets for `src/agents/verify-behavior.ts`:
 *
 *   1. typesafe batch returns valid JSON → produces a
 *      `BehaviorVerificationResult` carrying B9 (5-way `Choice`
 *      status), B10 (3-way `Choice` channel) and B11 (`Noul` × N per
 *      AC) answers on ONE shared `JudgmentState` (specBody +
 *      implementationDiff populated).
 *   2. B11's `Noul` is the semantic judgement; the receipt registry
 *      is the ground truth. On disagreement the result surfaces a
 *      low-confidence note for the calling stage to handle.
 *   3. typesafe returns `format-error` (parse miss) → falls back to
 *      the claude-code `dispatchAgentStage` envelope with the
 *      existing `parseVerifyBehavior` parser preserved.
 *   4. typesafe unreachable (mock fetch → 500) → returns a synthetic
 *      fallback shape (`status: "blocked"`, reason in `notes`).
 *
 * The typesafe path is gated on the runtime resolving
 * `verify-behavior` to the `typesafe` backend; claude-code
 * deployments keep their pre-T9.1 behaviour (asserted at the end).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { __clearAgentRuntimeCacheForTest } from "../core/agent-runtime.js";
import {
    VerifyBehaviorAgent,
    consumeReceiptRegistry,
    setVerifyBehaviorFetchImpl,
} from "../agents/verify-behavior.js";
import type { AgentContext, Issue } from "../core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function fixtureIssue(): Issue {
    return {
        number: 77,
        title: "Archive completed tasks",
        body: "AC-1: the Archive button appears. AC-2: completed tasks disappear.",
        labels: ["ready-to-merge"],
        author: "operator",
        url: "https://example.com/77",
        createdAt: "2026-09-20T10:00:00Z",
        comments: [],
    };
}

function fixtureContext(workdir: string): AgentContext {
    return {
        repo: {
            owner: "acme",
            name: "factory",
            defaultBranch: "main",
            workdir,
        },
        issue: fixtureIssue(),
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {},
            child() {
                return this;
            },
        },
        skills: [],
        skillsRoot: workdir,
        runId: "run-test-77",
    } as unknown as AgentContext;
}

/** Set process.env keys for one test; returns a teardown restoring the
 * previous values and clearing the cached default agent runtime.
 * `FACTORY_CLAUDE_COMMAND` points at a missing binary so an accidental
 * claude-code fallback dispatch fails fast instead of spawning the
 * real CLI. */
function useEnv(vars: Record<string, string>): () => void {
    const saved: Record<string, string | undefined> = {};
    const merged: Record<string, string> = {
        FACTORY_CLAUDE_COMMAND: "factory-test-missing-claude-binary",
        ...vars,
    };
    for (const [key, value] of Object.entries(merged)) {
        saved[key] = process.env[key];
        process.env[key] = value;
    }
    __clearAgentRuntimeCacheForTest();
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        __clearAgentRuntimeCacheForTest();
    };
}

/** Capture fetch calls so tests can assert the batch envelope. */
function captureFetch(
    impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = (init ?? {}) as RequestInit;
        let parsedBody: unknown = req.body;
        if (typeof req.body === "string") {
            try {
                parsedBody = JSON.parse(req.body);
            } catch {
                /* keep as string */
            }
        }
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            body: parsedBody,
        });
        return impl(input, init);
    };
    return { fetch: wrapped as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** A full happy-path primitives array: B9 + B10 + B11 slots. */
function okPrimitives(overrides: Record<string, unknown> = {}) {
    const base = [
        { id: "B9", value: "verified", confidence: 0.93 },
        { id: "B10", value: "browser", confidence: 0.9 },
        { id: "B11-0", value: true, confidence: 0.9 },
        { id: "B11-1", value: true, confidence: 0.9 },
        { id: "B11-2", value: null, confidence: 0.9 },
    ];
    return base.map((p) =>
        p.id in overrides ? { ...p, value: overrides[p.id] } : p,
    );
}

/* -------------------------------------------------------------------------- */
/* Success path — B9 + B10 + B11 on one shared state                          */
/* -------------------------------------------------------------------------- */

test("typesafe batch success: maps B9/B10/B11 into BehaviorVerificationResult and sends one shared-state batch", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { primitives: okPrimitives(), session_id: "ts-vb-1" }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(workdir);
            const agent = new VerifyBehaviorAgent(ctx, "verify");
            const result = await agent.run();
            assert.equal(result.status, "verified");
            assert.equal(result.channel, "browser");
            assert.equal(result.mode, "verify");
            assert.equal(result.ozRunUrl, "https://oz.warp.dev/runs/run-test-77");
            assert.equal(typeof result.notes, "string");

            // ONE batch request carrying B9 + B10 + B11 × N.
            assert.equal(calls.length, 1, "exactly one typesafe batch call");
            const body = calls[0].body as {
                state_hash: string;
                primitives: Array<{ id: string; type: string; state: unknown }>;
            };
            const ids = body.primitives.map((p) => p.id);
            assert.ok(ids.includes("B9"));
            assert.ok(ids.includes("B10"));
            assert.ok(ids.includes("B11-0"), "batch must carry per-AC B11 Noul primitives");
            const b9 = body.primitives.find((p) => p.id === "B9")!;
            const b10 = body.primitives.find((p) => p.id === "B10")!;
            const b11 = body.primitives.find((p) => p.id === "B11-0")!;
            assert.equal(b9.type, "Choice");
            assert.equal(b10.type, "Choice");
            assert.equal(b11.type, "Noul");
            // Shared state: identical across primitives; specBody +
            // implementationDiff populated per the task contract.
            const first = JSON.stringify(b9.state);
            assert.equal(JSON.stringify(b10.state), first);
            assert.equal(JSON.stringify(b11.state), first);
            assert.ok(first.includes("AC-1"), "state must carry the spec body (issue body)");
            assert.match(body.state_hash, /^[0-9a-f]{64}$/);

            // The receipt registry is still published for the orchestrator.
            const registry = consumeReceiptRegistry();
            assert.ok(registry, "registry must be published after run()");
            assert.equal(registry?.mode, "verify");
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("B9 out-of-vocabulary value normalises to blocked (never an out-of-enum status)", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, { primitives: okPrimitives({ B9: "kinda-verified" }) }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.equal(result.status, "blocked");
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("B10 out-of-vocabulary value normalises to a valid channel", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, { primitives: okPrimitives({ B10: "carrier-pigeon" }) }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.ok(["browser", "desktop", "hybrid"].includes(result.channel));
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* B11 Noul vs receipt ground truth                                            */
/* -------------------------------------------------------------------------- */

test("B11 Noul disagreeing with a passed receipt surfaces a low-confidence note", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
        // The operator regression command produces a passed:true
        // receipt BEFORE the batch runs — the ground-truth half of
        // the B11 comparison.
        FACTORY_TRUSTED_EXECUTION: "1",
        FACTORY_VERIFY_COMMAND: 'node -e "process.exit(0)"',
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, { primitives: okPrimitives({ "B11-0": false }) }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.match(result.notes, /low-confidence/, "disagreement must be surfaced in notes");
            assert.match(result.notes, /1 receipts passed/, "notes carry the receipt ground truth summary");
            // The registry still exposes the passed receipt so the
            // calling stage can adjudicate with full evidence.
            const registry = consumeReceiptRegistry();
            assert.equal(registry?.receipts.length, 1);
            assert.equal(registry?.receipts[0].passed, true);
            assert.equal(registry?.operatorReceiptId, registry?.receipts[0].id);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("B11 Noul agreeing with receipts (all true, none passed) produces no low-confidence note", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, { primitives: okPrimitives() }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.doesNotMatch(result.notes, /low-confidence/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* format-error → claude-code fallback                                         */
/* -------------------------------------------------------------------------- */

test("typesafe format-error (empty primitives): falls back to the claude-code dispatchAgentStage path", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { primitives: [] }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            // The fallback dispatch targets claude-code; the test env
            // points FACTORY_CLAUDE_COMMAND at a missing binary so the
            // spawn fails fast and dispatchAgentStage throws — the
            // throw is the signal the fallback path ran.
            await assert.rejects(() => agent.run(), /verify-behavior/);
            assert.equal(calls.length, 1, "typesafe adapter hit once before the fallback decision");
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("typesafe format-error (missing B10 primitive): falls back to the claude-code dispatchAgentStage path", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, {
                primitives: [{ id: "B9", value: "verified", confidence: 0.9 }],
            }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            await assert.rejects(() => agent.run(), /verify-behavior/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* typesafe unreachable → synthetic fallback shape                             */
/* -------------------------------------------------------------------------- */

test("typesafe unreachable (mock fetch → 500): returns synthetic fallback shape", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock, calls } = captureFetch(
            async () => new Response("upstream down", { status: 500 }),
        );
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.equal(result.status, "blocked");
            assert.ok(["browser", "desktop", "hybrid"].includes(result.channel));
            assert.match(result.notes, /http 500/);
            assert.equal(result.ozRunUrl, "https://oz.warp.dev/runs/run-test-77");
            assert.equal(calls.length, 1, "no claude-code re-run after the synthetic fallback");
            // The registry is still published (ground truth survives
            // the fallback).
            const registry = consumeReceiptRegistry();
            assert.ok(registry);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("FACTORY_TYPESAFE_OFF=1: synthetic fallback without hitting fetch", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "1",
    });
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            throw new Error("fetch should not have been called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            const result = await agent.run();
            assert.equal(result.status, "blocked");
            assert.equal(fetchCalls, 0);
            assert.match(result.notes, /FACTORY_TYPESAFE_OFF/);
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* No regression for claude-code deployments                                   */
/* -------------------------------------------------------------------------- */

test("claude-code deployment (backend != typesafe): typesafe judgment layer is still attempted, claude fallback runs on failure", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "verify-behavior-typesafe-"));
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_should_not_be_used",
    });
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            return jsonResponse(200, { primitives: [] });
        }) as typeof fetch;
        setVerifyBehaviorFetchImpl(fetchMock);
        try {
            const agent = new VerifyBehaviorAgent(fixtureContext(workdir), "verify");
            // typesafe is the bypass judgment layer (not a per-role
            // backend): the empty batch fails parsing, so the claude
            // fallback dispatch runs and throws (missing binary).
            await assert.rejects(() => agent.run(), /verify-behavior/);
            assert.ok(fetchCalls >= 1, "typesafe judgment must be attempted whenever TYPESAFE_API_KEY is set, regardless of the role backend");
        } finally {
            setVerifyBehaviorFetchImpl(null);
            consumeReceiptRegistry();
        }
    } finally {
        restore();
        rmSync(workdir, { recursive: true, force: true });
    }
});