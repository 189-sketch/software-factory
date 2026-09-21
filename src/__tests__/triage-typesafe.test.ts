/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T9.0 acceptance.
 *
 * Exercises the typesafe batch migration of `TriageAgent.run()`.
 * The agent must:
 *
 *   1. Send ONE `typesafe` POST carrying the batch of primitives
 *      `{ A2.triage_state Choice + A2.author_committed Noul,
 *         A3.author_binding_decision Noul, B12.supervisor_action
 *         Choice, B13.supervisor_complexity Score,
 *         B14.needs_info_wakeup Noul }` over the shared
 *      `JudgmentState` produced by `buildJudgmentState`.
 *   2. Map the typesafe response back into a `TriageResult` shape
 *      (state / label / remove_labels / comment) compatible with the
 *      existing `parseTriageDecision` output.
 *   3. Route via `decisionRouter.apply('triage.apply_label', ...)`
 *      using `runtime/decisions.yaml` so the operator gets a single
 *      auto / confirm / escalate verdict.
 *   4. Fall back to the legacy claude-code path on every typesafe
 *      failure mode (network / 4xx / 5xx / missing key / format-error /
 *      parse-miss). The fallback returns the heuristic rubric when
 *      even the legacy call throws.
 *   5. Reuse the cached `TriageResult` when the orchestrator already
 *      stamped an unchanged `lastJudgmentHash` — no second typesafe
 *      call is made.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    TriageAgent,
    type TriageCache,
} from "../agents/triage.js";
import { applyDecision, decisionRouter } from "../core/decision-router.js";
import { buildJudgmentState, stateHashFor } from "../core/judgment-state.js";
import { loadDecisionsSync } from "../core/decisions.js";
import type { Issue, AgentContext, TriageResult } from "../core/types.js";
import { ConsoleLogger } from "../core/log.js";
import type { AgentLogger } from "../core/types.js";
import type { TypesafePrimitive, TypesafeRequest } from "../../runtime/typesafe-backend.d.mts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function fixtureIssue(): Issue {
    return {
        number: 42,
        title: "Add a typesafe adapter",
        body: "Connect to api.typesafe.ai for cheap judgments.",
        labels: [],
        author: "operator",
        url: "https://example.com/42",
        createdAt: "2026-09-20T10:00:00Z",
        comments: [
            { author: "operator", body: "Original ask.", createdAt: "2026-09-20T10:00:00Z" },
            { author: "factory", body: "<!-- pi-software-factory:triage:ready-to-implement -->\nNoted.", createdAt: "2026-09-20T10:05:00Z" },
            { author: "operator", body: "Use TypeScript please.", createdAt: "2026-09-20T11:00:00Z" },
        ],
    };
}

function silenceLogger(): AgentLogger {
    return new ConsoleLogger({ test: "triage-typesafe" });
}

function ctxFor(issue: Issue): AgentContext {
    return {
        repo: { owner: "x", name: "y", defaultBranch: "main", workdir: "/tmp" },
        issue,
        logger: silenceLogger(),
        skills: [],
        skillsRoot: "/tmp",
        runId: "run-test",
    };
}

/**
 * Capture `fetch` calls so each test can assert exactly what the
 * triage agent POSTed. Mirrors the wrapper in
 * `typesafe-backend.test.ts` so we don't depend on `api.typesafe.ai`
 * being reachable from CI.
 */
function captureFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const calls: Array<{
        url: string;
        body: TypesafeRequest | string | undefined;
        headers: Record<string, string>;
        signal: AbortSignal | null;
    }> = [];
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = (init ?? {}) as RequestInit;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) {
            headers[String(k).toLowerCase()] = String(v);
        }
        let parsedBody: TypesafeRequest | string | undefined = req.body as string | undefined;
        if (typeof req.body === "string") {
            try { parsedBody = JSON.parse(req.body) as TypesafeRequest; } catch { parsedBody = req.body; }
        }
        calls.push({
            url: typeof input === "string" ? input : input.toString(),
            body: parsedBody,
            headers,
            signal: (req.signal as AbortSignal | null) ?? null,
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

/**
 * Build the parsed decisions fixture used by every routing assertion.
 * Re-reading `runtime/decisions.yaml` from disk per test is
 * expensive and would couple the test to the on-disk file shape;
 * instead we hand-craft the documented example row and assert
 * against it.
 */
function decisionsFixture() {
    return {
        version: 1 as const,
        decisions: [
            {
                action: "freshness.skip",
                auto: { noul_yes_max: 0.20 },
                escalate: { noul_yes_min: 0.20, target: "full_triage_batch" },
            },
            {
                action: "triage.apply_label",
                auto: { confidence_min: 0.85 },
                confirm: { confidence_min: 0.50, prompt: "Triage suggests: <state>. Apply?" },
                escalate: { confidence_max: 0.50, target: "needs-info" },
            },
        ],
        composite: { spec: 0.30, impl: 0.25, review: 0.20, verify: 0.25 },
        fallback: {
            cjk: {
                trigger: "any_of" as const,
                conditions: ["typesafe_unreachable"],
                fallback_backend: "claude-code",
                log_warning: "typesafe_fallback_to_claude",
            },
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Batch payload contract                                                      */
/* -------------------------------------------------------------------------- */

test("typesafe batch returns valid JSON -> produces TriageResult with confidence surface", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const env = {
        ...process.env,
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    try {
        const responsePrimitives: Array<{ id: string; value: unknown; confidence: number }> = [
            { id: "A2.triage_state", value: "Ready to spec", confidence: 0.92 },
            { id: "A2.author_committed", value: true, confidence: 0.88 },
            { id: "A3.author_binding_decision", value: true, confidence: 0.85 },
            { id: "B12.supervisor_action", value: "retry", confidence: 0.7 },
            { id: "B13.supervisor_complexity", value: 2, confidence: 0.65 },
            { id: "B14.needs_info_wakeup", value: false, confidence: 0.30 },
        ];
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { primitives: responsePrimitives, session_id: "ts-1" }));

        // We need to swap `globalThis.fetch` so the adapter's default
        // path picks up the mock. Save & restore around the test.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            const agent = new TriageAgent(ctx, undefined, decisionsFixture() as never);
            const result = await agent.run();

            assert.ok("state" in result, "run() must return a TriageResult");
            const triage = result as TriageResult;
            assert.equal(triage.state, "Ready to spec");
            assert.equal(triage.label, "ready-to-spec");
            assert.ok(triage.remove_labels.includes("ready-to-implement"));
            assert.ok(triage.remove_labels.includes("needs-info"));
            assert.ok(triage.remove_labels.includes("wait-to-implement"));
            assert.ok(typeof triage.comment === "string" && triage.comment.length > 0);

            // Exactly one fetch was issued; the body carries the
            // shared `state_hash` plus all six primitives in one batch.
            assert.equal(calls.length, 1);
            const body = calls[0].body as TypesafeRequest;
            assert.equal(body.state_hash.length, 64, "state_hash must be a sha-256 hex digest");
            const ids = body.primitives.map((p: TypesafePrimitive) => p.id).sort();
            assert.deepEqual(ids, [
                "A2.author_committed",
                "A2.triage_state",
                "A3.author_binding_decision",
                "B12.supervisor_action",
                "B13.supervisor_complexity",
                "B14.needs_info_wakeup",
            ]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    } finally {
        process.env = savedEnv;
    }
});

/* -------------------------------------------------------------------------- */
/* Fallback paths                                                              */
/* -------------------------------------------------------------------------- */

test("typesafe unreachable (mock fetch -> 500) -> falls back to claude-code path", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const env = {
        ...process.env,
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    try {
        const { fetch: fetchMock } = captureFetch(async () => new Response("upstream down", { status: 500 }));
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            const agent = new TriageAgent(ctx, undefined, decisionsFixture() as never);
            // The claude-code fallback path will itself fail (no
            // spawned CLI / network), so the agent must end up on
            // the deterministic heuristic rubric. Either way the
            // run() promise must resolve with a TriageResult shape.
            const result = await agent.run();
            assert.ok("state" in result, "fallback must still produce a TriageResult");
            const triage = result as TriageResult;
            assert.equal(typeof triage.state, "string");
            assert.ok(["Ready to implement", "Ready to spec", "Needs info", "Wait to implement"].includes(triage.state),
                `fallback state must be one of the four canonical readiness states; got ${triage.state}`);
        } finally {
            globalThis.fetch = originalFetch;
        }
    } finally {
        process.env = savedEnv;
    }
});

test("typesafe returns format-error -> falls back to claude-code path", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const env = {
        ...process.env,
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    try {
        // A parse-miss is a 200 OK with an unparseable body — the
        // adapter's `format-error` envelope applies when the model
        // returns a non-JSON payload. We simulate that here.
        const { fetch: fetchMock } = captureFetch(async () =>
            new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            const agent = new TriageAgent(ctx, undefined, decisionsFixture() as never);
            const result = await agent.run();
            assert.ok("state" in result, "format-error fallback must still return a TriageResult");
        } finally {
            globalThis.fetch = originalFetch;
        }
    } finally {
        process.env = savedEnv;
    }
});

/* -------------------------------------------------------------------------- */
/* decisionRouter tier math                                                    */
/* -------------------------------------------------------------------------- */

test("decisionRouter routes confidence >= 0.85 -> { mode: 'auto' }", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("triage.apply_label", { confidence: 0.92 }, decisions as never);
    assert.deepEqual(route, { mode: "auto" });
});

test("decisionRouter routes 0.50 <= confidence < 0.85 -> { mode: 'confirm', prompt: ... }", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("triage.apply_label", { confidence: 0.70 }, decisions as never);
    assert.equal(route.mode, "confirm");
    assert.equal(route.prompt, "Triage suggests: <state>. Apply?");
});

test("decisionRouter routes confidence < 0.50 -> { mode: 'escalate', target: 'needs-info' }", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("triage.apply_label", { confidence: 0.30 }, decisions as never);
    assert.deepEqual(route, { mode: "escalate", target: "needs-info" });
});

test("decisionRouter returns escalate -> unknown_action for an unknown action", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("ghost.action", { confidence: 0.9 }, decisions as never);
    assert.deepEqual(route, { mode: "escalate", target: "unknown_action" });
});

test("decisionRouter.apply is an alias for applyDecision", () => {
    assert.equal(decisionRouter.apply, applyDecision);
});

test("decisionRouter routes freshness.skip noul_yes <= 0.20 -> { mode: 'auto' } (noul-only rule)", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("freshness.skip", { noul_yes: 0.05 }, decisions as never);
    assert.deepEqual(route, { mode: "auto" });
});

test("decisionRouter routes freshness.skip noul_yes >= 0.20 -> escalate full_triage_batch", () => {
    const decisions = decisionsFixture();
    const route = applyDecision("freshness.skip", { noul_yes: 0.9 }, decisions as never);
    assert.deepEqual(route, { mode: "escalate", target: "full_triage_batch" });
    // Boundary: exactly 0.20 fires escalate first (conservative —
    // the overlap between auto.noul_yes_max and escalate.noul_yes_min
    // resolves to the full batch).
    const boundary = applyDecision("freshness.skip", { noul_yes: 0.2 }, decisions as never);
    assert.deepEqual(boundary, { mode: "escalate", target: "full_triage_batch" });
});

test("decisionRouter never routes a missing confidence to auto/confirm on a confidence-gated action", () => {
    const decisions = decisionsFixture();
    // triage.apply_label has confidence gates on every tier; a
    // missing/NaN confidence must escalate (target from the
    // escalate row) rather than silently auto-apply.
    const route = applyDecision("triage.apply_label", {}, decisions as never);
    assert.equal(route.mode, "escalate");
    assert.equal(route.target, "needs-info");
});

/* -------------------------------------------------------------------------- */
/* Cached triage reuse                                                         */
/* -------------------------------------------------------------------------- */

test("cached triage reuse: second call within the same state hash returns the cached result without making a typesafe batch call", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    // Pre-compute the hash so we can hand it to the agent.
    const hash = stateHashFor(buildJudgmentState(issue));
    const cachedTriage: TriageResult = {
        state: "Ready to implement",
        label: "ready-to-implement",
        remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement"],
        comment: "Cached triage result (Phase B T9.0 cache reuse).",
    };
    const cache: TriageCache = { lastJudgmentHash: hash, cachedTriage };

    const env = {
        ...process.env,
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    // `fetch` must NEVER be called when the cached hash matches the
    // current state hash. We wire a throwing mock so a stray call
    // surfaces as an immediate failure.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        throw new Error("fetch must not be called when the cached triage hash matches");
    }) as typeof fetch;

    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.ok("state" in result, "cache reuse must produce a TriageResult");
        const triage = result as TriageResult;
        assert.deepEqual(triage, cachedTriage, "run() must return the cached TriageResult verbatim");
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

/* -------------------------------------------------------------------------- */
/* A1 freshness Noul — agent-side call + upstream reuse                        */
/* -------------------------------------------------------------------------- */

function cachedTriageFixture(): TriageResult {
    return {
        state: "Ready to implement",
        label: "ready-to-implement",
        remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement"],
        comment: "Cached triage result (Phase B T9.0 cache reuse).",
    };
}

test("A1 freshness Noul below the decisions.yaml threshold -> reuses cached TriageResult without a batch call", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const cached = cachedTriageFixture();
    // Hash intentionally differs from the current state hash so the
    // deterministic fast path cannot fire — the agent must ask A1.
    const cache: TriageCache = { lastJudgmentHash: "stale-hash-from-a-prior-poll", cachedTriage: cached };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    const { fetch: fetchMock, calls } = captureFetch(async () =>
        jsonResponse(200, { primitives: [{ id: "A1.freshness", value: false, confidence: 0.05 }] }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.deepEqual(result, cached, "A1 auto (noul_yes 0.05 <= 0.20) must return the cached TriageResult verbatim");
        // Exactly ONE fetch: the A1 Noul. The batch must NOT run.
        assert.equal(calls.length, 1);
        const body = calls[0].body as TypesafeRequest;
        assert.equal(body.primitives.length, 1);
        assert.equal(body.primitives[0].id, "A1.freshness");
        assert.equal(body.primitives[0].type, "Noul");
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

test("A1 freshness Noul above the threshold -> falls through to the full typesafe batch", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const cached = cachedTriageFixture();
    const cache: TriageCache = { lastJudgmentHash: "stale-hash-from-a-prior-poll", cachedTriage: cached };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    let callIndex = 0;
    const { fetch: fetchMock, calls } = captureFetch(async () => {
        callIndex += 1;
        if (callIndex === 1) {
            // A1 says "yes, the state changed" — above the 0.20 gate.
            return jsonResponse(200, { primitives: [{ id: "A1.freshness", value: true, confidence: 0.9 }] });
        }
        return jsonResponse(200, {
            primitives: [
                { id: "A2.triage_state", value: "Ready to spec", confidence: 0.92 },
                { id: "A2.author_committed", value: true, confidence: 0.88 },
                { id: "A3.author_binding_decision", value: true, confidence: 0.85 },
                { id: "B12.supervisor_action", value: "retry", confidence: 0.7 },
                { id: "B13.supervisor_complexity", value: 2, confidence: 0.65 },
                { id: "B14.needs_info_wakeup", value: false, confidence: 0.3 },
            ],
        });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.ok("state" in result);
        const triage = result as TriageResult;
        assert.equal(triage.state, "Ready to spec", "the batch answer must win over the stale cached result");
        assert.notDeepEqual(triage, cached);
        // TWO fetches: A1 first, then the full batch.
        assert.equal(calls.length, 2);
        const a1Body = calls[0].body as TypesafeRequest;
        assert.equal(a1Body.primitives.length, 1);
        assert.equal(a1Body.primitives[0].id, "A1.freshness");
        const batchBody = calls[1].body as TypesafeRequest;
        assert.equal(batchBody.primitives.length, 6);
        // A1 runs BEFORE any other primitive — ordering contract.
        assert.equal(batchBody.primitives[0].id, "A2.triage_state");
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

test("upstream freshnessCheck verdict (skip=true) is reused — no A1 call, no batch call", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const cached = cachedTriageFixture();
    // The orchestrator already ran `freshnessCheck` this poll and
    // threaded the verdict in; the agent must reuse `noul_yes`
    // instead of paying a second A1 call.
    const cache: TriageCache = {
        cachedTriage: cached,
        freshnessResult: { skip: true, reason: "state_unchanged", noul_yes: 0.1 },
    };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        throw new Error("fetch must not be called when the upstream freshness verdict says skip");
    }) as typeof fetch;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.deepEqual(result, cached);
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

test("A1 typesafe unavailable -> conservatively proceeds to the full batch (freshness_unavailable posture)", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const cached = cachedTriageFixture();
    const cache: TriageCache = { lastJudgmentHash: "stale-hash", cachedTriage: cached };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "typesafe",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    // Every typesafe call fails (500). A1 unavailable -> the agent
    // must still attempt the full batch (call 2), and when the batch
    // fails too it falls back to claude-code -> heuristic rubric.
    const { fetch: fetchMock, calls } = captureFetch(async () => new Response("upstream down", { status: 500 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.ok("state" in result, "the agent must still surface a TriageResult");
        assert.notDeepEqual(result, cached, "a stale cache must NOT be reused when freshness is unavailable");
        // Two typesafe attempts: A1 then the batch.
        assert.equal(calls.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

/* -------------------------------------------------------------------------- */
/* Sanity: hash parity against the loaded decisions file                       */
/* -------------------------------------------------------------------------- */

test("loadDecisionsSync returns the shipped runtime/decisions.yaml (sanity)", () => {
    // The T9.0 routing math is parameterised over DecisionsFile; the
    // shipped YAML is what production reads. Asserting that the
    // schema-validating loader still produces a usable shape pins
    // the contract the routing tests above rely on.
    const decisions = loadDecisionsSync();
    const route = applyDecision("triage.apply_label", { confidence: 0.92 }, decisions);
    assert.equal(route.mode, "auto");
    const escalateRoute = applyDecision("triage.apply_label", { confidence: 0.30 }, decisions);
    assert.equal(escalateRoute.mode, "escalate");
    assert.equal(escalateRoute.target, "needs-info");
});
