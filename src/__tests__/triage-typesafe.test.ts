/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T9.0 acceptance.
 *
 * Exercises the typesafe batch migration of `TriageAgent.run()`.
 * The agent must:
 *
 *   1. Send ONE `typesafe` POST carrying the official `{model, state,
 *      questions:{<id>:{type, instructions, criteria}}}` envelope —
 *      six questions over the shared `JudgmentState` produced by
 *      `buildJudgmentState`. Question ids are A2.triage_state (choice),
 *      A2.author_committed (noul), A3.author_binding_decision (noul),
 *      B14.info_obtained (noul) — note B12/B13 were removed
 *      2026-09-22 (failure routing is the deterministic
 *      `decideRouting` decision, not a Jev primitive — empty state
 *      against empty `factory.failureCounts` would have been
 *      unanswerable). The adapter maps official answers
 *      back into the legacy `[{id, value, confidence}]` shape so the
 *      downstream parsers stay byte-compatible.
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
import type { TypesafeRequest } from "../../runtime/typesafe-backend.d.mts";

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
 * Official `{model, answers, usage}` envelope for the triage batch.
 * A2 is a Choice with 4 canonical states (issue #46, 2026-09-24)
 * and A3 / B14 were deleted — the batch carries two readiness
 * primitives, not four. Routing follows the Choice value 1:1
 * (`src/agents/triage.ts::choiceToRoute`), so the fixture's
 * `choice: "Ready to spec"` drives `route: auto`.
 */
function batchSuccessAnswers() {
    return {
        model: "jev-1.13.0",
        answers: {
            "A2.triage_state": {
                type: "choice",
                choice: "Ready to spec",
                probabilities: { "Needs info": 0.05, "Ready to spec": 0.85, "Ready to implement": 0.07, "Wait to implement": 0.03 },
                confidence: 0.85,
            },
            "A2.author_committed": { type: "noul", noul: 0.88 },
            "A2.author_directive": { type: "noul", noul: 0.85 },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
    };
}

/**
 * Build the parsed decisions fixture used by every routing assertion.
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
                confirm: { confidence_min: 0.30, prompt: "Triage suggests: <state>. Apply?" },
                escalate: { confidence_max: 0.30, target: "needs-info" },
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
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    try {
        const responseBody = { ...batchSuccessAnswers(), session_id: "ts-1" };
        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, responseBody));

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
            // official envelope (no state_hash, one shared `state`,
            // three primitives: state + committed + directive).
            assert.equal(calls.length, 1);
            const body = calls[0].body as TypesafeRequest;
            assert.ok(!("state_hash" in body), "state_hash must not travel on the wire");
            assert.ok(!("primitives" in body), "primitives array must not travel on the wire");
            assert.equal(typeof body.state, "object");
            const ids = Object.keys(body.questions).sort();
            assert.deepEqual(ids, [
                "A2.author_committed",
                "A2.author_directive",
                "A2.triage_state",
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
        FACTORY_AGENT_BACKEND: "claude-code",
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
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

    try {
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
    const boundary = applyDecision("freshness.skip", { noul_yes: 0.2 }, decisions as never);
    assert.deepEqual(boundary, { mode: "escalate", target: "full_triage_batch" });
});

test("decisionRouter never routes a missing confidence to auto/confirm on a confidence-gated action", () => {
    const decisions = decisionsFixture();
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
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    };
    const savedEnv = { ...process.env };
    Object.assign(process.env, env);

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
    const cache: TriageCache = { lastJudgmentHash: "stale-hash-from-a-prior-poll", cachedTriage: cached };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    const { fetch: fetchMock, calls } = captureFetch(async () =>
        jsonResponse(200, {
            model: "jev-1.13.0",
            answers: { "A1.freshness": { type: "noul", noul: 0.05 } },
            usage: { input_tokens: 0, output_tokens: 0 },
        }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.deepEqual(result, cached, "A1 auto (noul_yes 0.05 <= 0.20) must return the cached TriageResult verbatim");
        assert.equal(calls.length, 1);
        const body = calls[0].body as TypesafeRequest;
        const ids = Object.keys(body.questions);
        assert.deepEqual(ids, ["A1.freshness"]);
        assert.equal((body.questions["A1.freshness"] as { type: string }).type, "noul");
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
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    let callIndex = 0;
    const { fetch: fetchMock, calls } = captureFetch(async () => {
        callIndex += 1;
        if (callIndex === 1) {
            return jsonResponse(200, {
                model: "jev-1.13.0",
                answers: { "A1.freshness": { type: "noul", noul: 0.9 } },
                usage: { input_tokens: 0, output_tokens: 0 },
            });
        }
        return jsonResponse(200, batchSuccessAnswers());
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
        assert.equal(calls.length, 2);
        const a1Body = calls[0].body as TypesafeRequest;
        assert.deepEqual(Object.keys(a1Body.questions), ["A1.freshness"]);
        const batchBody = calls[1].body as TypesafeRequest;
        // A3 + B14 were deleted in the issue #46 (2026-09-24)
// simplification. The current batch carries three primitives:
// A2.triage_state + A2.author_committed + A2.author_directive
// (the directive primitive was added 2026-09-24 so Jev can see
// the latest author comment's intent — directive signals like
// 'ignore this finding' / 'implement with current spec' that
// authorise proceeding despite open findings). B12/B13 supervisor
// primitives were already gone (2026-09-22).
        assert.equal(Object.keys(batchBody.questions).length, 3);
        assert.equal(Object.keys(batchBody.questions)[0], "A2.triage_state");
    } finally {
        globalThis.fetch = originalFetch;
        process.env = savedEnv;
    }
});

test("upstream freshnessCheck verdict (skip=true) is reused — no A1 call, no batch call", async () => {
    const issue = fixtureIssue();
    const ctx = ctxFor(issue);
    const cached = cachedTriageFixture();
    const cache: TriageCache = {
        cachedTriage: cached,
        freshnessResult: { skip: true, reason: "state_unchanged", noul_yes: 0.1 },
    };

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
        FACTORY_AGENT_BACKEND: "claude-code",
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
        FACTORY_AGENT_BACKEND: "claude-code",
        TYPESAFE_API_KEY: "tk_test_secret",
    });

    const { fetch: fetchMock, calls } = captureFetch(async () => new Response("upstream down", { status: 500 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
        const agent = new TriageAgent(ctx, cache, decisionsFixture() as never);
        const result = await agent.run();
        assert.ok("state" in result, "the agent must still surface a TriageResult");
        assert.notDeepEqual(result, cached, "a stale cache must NOT be reused when freshness is unavailable");
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
    const decisions = loadDecisionsSync();
    // (Triage routing now follows Jev's A2.triage_state choice 1:1
    // via `choiceToRoute`, not decisions.yaml — but the entry is
    // still required by the schema and used by A1 freshness Noul.
    // Keep the legacy decision-router assertions working.)
    const route = applyDecision("triage.apply_label", { confidence: 0.92 }, decisions);
    assert.equal(route.mode, "auto");
    const escalateRoute = applyDecision("triage.apply_label", { confidence: 0.20 }, decisions);
    assert.equal(escalateRoute.mode, "escalate");
    assert.equal(escalateRoute.target, "needs-info");
});
