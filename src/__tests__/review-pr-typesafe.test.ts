/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1 acceptance tests
 * (review-pr half — B7 + B8 + `review-pr.merge_pr` routing).
 *
 * Covers the four acceptance bullets from the task table for T9.1:
 *
 *   1. typesafe batch returns valid JSON → produces `ReviewResult`
 *      with confidence; the request carries B7 (Choice) + B8
 *      (Choice × M findings) on ONE shared `JudgmentState`.
 *   2. typesafe returns `format-error` (parse miss) → falls back to
 *      the `dispatchAgentStage` envelope (claude-code).
 *   3. typesafe unreachable (mock fetch → 500) → returns a synthetic
 *      fallback shape so the orchestrator never sees `undefined`.
 *   4. `decisionRouter.apply('review-pr.merge_pr', result)` routes
 *      correctly across the three confidence bands defined in
 *      `runtime/decisions.yaml` (auto ≥ 0.90, confirm ≥ 0.65,
 *      escalate ≤ 0.65).
 *
 * The unit tests for `DecisionRouter` are co-located here because the
 * router's only production caller today is this agent; keeping the
 * tests together makes the wiring contract obvious.
 *
 * The typesafe path is gated on the runtime resolving `review-pr` to
 * the `typesafe` backend (FACTORY_AGENT_BACKEND=typesafe in these
 * tests); claude-code deployments keep their pre-T9.1 behaviour and
 * are asserted at the end of the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DecisionRouter } from "../core/decision-router.js";
import type { DecisionRoute } from "../core/decision-router.js";
import type { DecisionsFile } from "../core/decisions.js";
import { __clearAgentRuntimeCacheForTest } from "../core/agent-runtime.js";
import {
    setReviewPrDecisionRouter,
    setReviewPrFetchImpl,
    routeReviewPrMerge,
    ReviewPrAgent,
} from "../agents/review-pr.js";
import type { AgentContext, Issue, ReviewResult } from "../core/types.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SAMPLE_DECISIONS: DecisionsFile = {
    version: 1,
    decisions: [
        {
            action: "review-pr.merge_pr",
            auto: { confidence_min: 0.9, blocking_findings_max: 0 },
            confirm: {
                confidence_min: 0.65,
                prompt: "PR <n> has <k> blocking. Merge?",
            },
            escalate: { confidence_max: 0.65, target: "human" },
        },
        {
            action: "triage.apply_label",
            auto: { confidence_min: 0.85 },
            confirm: { confidence_min: 0.5 },
            escalate: { confidence_max: 0.5, target: "needs-info" },
        },
    ],
    composite: { spec: 0.3, impl: 0.25, review: 0.2, verify: 0.25 },
    fallback: {
        cjk: {
            trigger: "any_of",
            conditions: [],
            fallback_backend: "claude-code",
            log_warning: "typesafe_fallback_to_claude",
        },
    },
};

function fixtureIssue(): Issue {
    return {
        number: 42,
        title: "Add a typesafe adapter",
        body: "Connect to api.typesafe.ai for cheap judgments.",
        labels: ["ready-to-merge"],
        author: "operator",
        url: "https://example.com/42",
        createdAt: "2026-09-20T10:00:00Z",
        comments: [],
    };
}

function fixtureContext(workdir: string, issue: Issue): AgentContext {
    return {
        repo: {
            owner: "acme",
            name: "factory",
            defaultBranch: "main",
            workdir,
        },
        issue,
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
        runId: "run-test-42",
    } as unknown as AgentContext;
}

/** Stage the diff / description files the agent reads from
 * `FACTORY_REVIEW_DIR`. Returns the directory; caller MUST `rmSync` on
 * teardown. */
function stageReviewDir(): { dir: string; diffPath: string; descriptionPath: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "review-pr-typesafe-"));
    const diff = "diff --git a/src/x.ts b/src/x.ts\n@@\n+export const x = 1;\n";
    const description = "Adds a constant.";
    writeFileSync(path.join(dir, "pr_diff.txt"), diff, "utf8");
    writeFileSync(path.join(dir, "pr_description.txt"), description, "utf8");
    return {
        dir,
        diffPath: path.join(dir, "pr_diff.txt"),
        descriptionPath: path.join(dir, "pr_description.txt"),
    };
}

/** Set process.env keys for the duration of one test and return a
 * teardown function that restores the previous values and clears the
 * cached default agent runtime (which reads process.env lazily).
 *
 * `FACTORY_CLAUDE_COMMAND` defaults to a non-existent binary so any
 * accidental claude-code fallback dispatch fails fast (spawn ENOENT)
 * instead of spawning the real CLI installed on the dev machine. */
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

/** Capture the `fetchImpl` calls so the test can assert the request
 * envelope sent by the adapter. */
function captureFetch(
    impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
    const calls: Array<{
        url: string;
        body: unknown;
        headers: Record<string, string>;
    }> = [];
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = (init ?? {}) as RequestInit;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) {
            headers[String(k).toLowerCase()] = String(v);
        }
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
            headers,
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

/* -------------------------------------------------------------------------- */
/* DecisionRouter — three confidence bands                                     */
/* -------------------------------------------------------------------------- */

test("DecisionRouter: review-pr.merge_pr routes auto when confidence >= auto.confidence_min (>=0.90)", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    const route = router.apply("review-pr.merge_pr", { confidence: 0.95 });
    assert.deepEqual(route, { mode: "auto" });
});

test("DecisionRouter: review-pr.merge_pr routes confirm when confidence is in (escalate_max, auto_min)", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    // 0.75 is between escalate.confidence_max (0.65) and auto.confidence_min (0.90).
    const route = router.apply("review-pr.merge_pr", { confidence: 0.75 });
    assert.equal(route.mode, "confirm");
    assert.equal(route.prompt, "PR <n> has <k> blocking. Merge?");
});

test("DecisionRouter: review-pr.merge_pr routes escalate when confidence <= escalate.confidence_max (<=0.65)", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    const route = router.apply("review-pr.merge_pr", { confidence: 0.4 });
    assert.deepEqual(route, { mode: "escalate", target: "human" });
});

test("DecisionRouter: review-pr.merge_pr at exactly the auto threshold routes auto", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    // The auto check is `>=`, so 0.90 (the documented threshold)
    // must route auto — a regression here would mean the auto arm
    // is mis-tuned by one tick of float precision.
    const route = router.apply("review-pr.merge_pr", { confidence: 0.9 });
    assert.equal(route.mode, "auto");
});

test("DecisionRouter: review-pr.merge_pr at exactly the escalate boundary routes escalate (conservative tie-break)", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    // 0.65 is at the confirm.confidence_min boundary AND the
    // escalate.confidence_max boundary. Escalate is evaluated before
    // confirm, so the more conservative arm wins at this exact value.
    const route = router.apply("review-pr.merge_pr", { confidence: 0.65 });
    assert.equal(route.mode, "escalate");
    assert.equal(route.target, "human");
});

test("DecisionRouter: unknown action short-circuits to escalate target=needs-info", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    const route = router.apply("future.action", { confidence: 0.99 });
    assert.deepEqual(route, { mode: "escalate", target: "needs-info" });
});

test("DecisionRouter: malformed confidence (NaN / undefined / out-of-range) collapses to escalate", () => {
    const router = DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS);
    for (const bad of [undefined, NaN, Number.POSITIVE_INFINITY, -1, 2]) {
        const route = router.apply("review-pr.merge_pr", { confidence: bad as unknown as number });
        assert.equal(route.mode, "escalate", `confidence=${String(bad)} must escalate`);
    }
});

test("routeReviewPrMerge exposes the same routing through the agent seam", () => {
    setReviewPrDecisionRouter(DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS));
    try {
        const high: DecisionRoute = routeReviewPrMerge({ verdict: "APPROVE" } as ReviewResult, 0.95);
        assert.equal(high.mode, "auto");
        const mid: DecisionRoute = routeReviewPrMerge({ verdict: "APPROVE" } as ReviewResult, 0.75);
        assert.equal(mid.mode, "confirm");
        const low: DecisionRoute = routeReviewPrMerge({ verdict: "REJECT" } as ReviewResult, 0.5);
        assert.equal(low.mode, "escalate");
        assert.equal(low.target, "human");
    } finally {
        setReviewPrDecisionRouter(null);
    }
});

/* -------------------------------------------------------------------------- */
/* typesafe success path — B7 + B8 on one shared state                        */
/* -------------------------------------------------------------------------- */

test("typesafe batch success: produces ReviewResult and sends B7 + B8 × M on one shared JudgmentState", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        // B7: APPROVE, confidence 0.95. B8 slots all NONE so no findings.
        const responseBody = {
            model: "jev-1.13.0", answers: { B7: { type: "choice", choice: "APPROVE", probabilities: { APPROVE: 0.95, REJECT: 0.05 }, confidence: 0.95 }, "B8-0": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.95 }, "B8-1": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.95 }, "B8-2": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.95 }, "B8-3": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.95 }, "B8-4": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.95 } }, usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        setReviewPrDecisionRouter(DecisionRouter.fromDecisionsFile(SAMPLE_DECISIONS));
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            assert.equal(review.verdict, "APPROVE");
            assert.ok(review.findings, "typesafe path should populate findings");
            assert.equal(review.findings?.length ?? 0, 0, "no findings means no B8 severities filled");
            // Exactly ONE batch request, carrying B7 + B8 slots on
            // the same shared state (the whole point of the batch).
            assert.equal(calls.length, 1, "typesafe adapter must have been hit exactly once (one batch)");
            const body = calls[0].body as { state: unknown; questions: Record<string, unknown> };
            const ids = Object.keys(body.questions);
            assert.ok(ids.includes("B7"), "request must include B7");
            for (let i = 0; i < 5; i += 1) {
                assert.ok(ids.includes(`B8-${i}`), `request must include B8-${i}`);
            }
            // The shared state carries the PR diff / issue.
            const first = JSON.stringify(body.state);
            assert.ok(first.includes("Add a typesafe adapter"), "state must carry the issue");
            
            // The route artefact is persisted for the orchestrator.
            const routeFile = JSON.parse(readFileSync(path.join(staged.dir, "review-route.json"), "utf8")) as { action: string; route: DecisionRoute; confidence: number };
            assert.equal(routeFile.action, "review-pr.merge_pr");
            assert.equal(routeFile.route.mode, "auto", "confidence 0.95 must route auto");
            assert.equal(routeFile.confidence, 0.95);
        } finally {
            setReviewPrFetchImpl(null);
            setReviewPrDecisionRouter(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe batch success: maps B7=REJECT + B8 severities to a ReviewResult with findings", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const responseBody = {
            model: "jev-1.13.0", answers: { B7: { type: "choice", choice: "REJECT", probabilities: { APPROVE: 0.05, REJECT: 0.95 }, confidence: 0.88 }, "B8-0": { type: "choice", choice: "CRITICAL", probabilities: { CRITICAL: 0.88, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.04 }, confidence: 0.88 }, "B8-1": { type: "choice", choice: "IMPORTANT", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.88, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.04 }, confidence: 0.88 }, "B8-2": { type: "choice", choice: "NIT", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.88, NONE: 0.04 }, confidence: 0.88 }, "B8-3": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.88 }, "B8-4": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.88 } }, usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            assert.equal(review.verdict, "REJECT");
            const findings = review.findings ?? [];
            assert.equal(findings.length, 3, "three B8 slots filled → three findings");
            assert.deepEqual(
                findings.map((f) => f.severity).sort(),
                ["blocking", "important", "nit"].sort(),
            );
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe batch success: APPROVE verdict is auto-downgraded to REJECT when a CRITICAL finding is present", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const responseBody = {
            model: "jev-1.13.0", answers: { B7: { type: "choice", choice: "APPROVE", probabilities: { APPROVE: 0.95, REJECT: 0.05 }, confidence: 0.7 }, "B8-0": { type: "choice", choice: "CRITICAL", probabilities: { CRITICAL: 0.88, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.04 }, confidence: 0.7 }, "B8-1": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.7 }, "B8-2": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.7 }, "B8-3": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.7 }, "B8-4": { type: "choice", choice: "NONE", probabilities: { CRITICAL: 0.04, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.88 }, confidence: 0.7 } }, usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            // The contract rule: "CRITICAL or IMPORTANT findings require REJECT."
            assert.equal(review.verdict, "REJECT", "CRITICAL finding must force REJECT even when B7 said APPROVE");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* typesafe format-error path — falls back to dispatchAgentStage (claude-code) */
/* -------------------------------------------------------------------------- */

test("typesafe format-error (empty primitives): falls back to the claude-code dispatchAgentStage path", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        // typesafe returns 200 with an empty primitives array —
        // a parse miss, treated as format-error per the task spec.
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        );
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            // The fallback dispatch targets claude-code; the test env
            // points FACTORY_CLAUDE_COMMAND at a missing binary so
            // the spawn fails fast and dispatchAgentStage throws.
            // The throw is the signal that the fallback path ran.
            await assert.rejects(() => agent.run(), /review-pr/);
            assert.equal(calls.length, 1, "typesafe adapter must have been hit before the fallback decision");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe format-error (missing B7 primitive): falls back to the claude-code dispatchAgentStage path", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock } = captureFetch(async () =>
            jsonResponse(200, {
                model: "jev-1.13.0", answers: { "B8-0": { type: "choice", choice: "CRITICAL", probabilities: { CRITICAL: 0.88, IMPORTANT: 0.04, SUGGESTION: 0.04, NIT: 0.04, NONE: 0.04 }, confidence: 0.5 } }, usage: { input_tokens: 0, output_tokens: 0 },
            }),
        );
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            await assert.rejects(() => agent.run(), /review-pr/);
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* typesafe unreachable (HTTP 500) — synthetic fallback shape                 */
/* -------------------------------------------------------------------------- */

test("typesafe unreachable (mock fetch → 500): returns synthetic fallback ReviewResult", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const { fetch: fetchMock, calls } = captureFetch(
            async () => new Response("upstream down", { status: 500 }),
        );
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            // CJK fallback envelope → synthetic shape. The verdict
            // is REJECT (the orchestrator cannot auto-merge a
            // fallback) and the body surfaces the reason so an
            // operator can see why.
            assert.equal(review.verdict, "REJECT");
            assert.ok(review.findings && review.findings.length > 0, "synthetic shape must carry at least one finding");
            assert.equal(review.findings?.[0].ruleId, "review-pr.typesafe_unreachable");
            assert.match(review.body, /http 500/);
            // No claude-code fallback dispatch happened; the
            // synthetic path is terminal (retryable:false contract).
            assert.equal(calls.length, 1, "typesafe adapter hit exactly once; no claude-code fallback");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe unreachable (network error): returns synthetic fallback ReviewResult", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    try {
        const fetchMock = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            assert.equal(review.verdict, "REJECT");
            assert.ok(review.findings && review.findings.length > 0);
            assert.match(review.body, /ECONNREFUSED/);
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("FACTORY_TYPESAFE_OFF=1: synthetic fallback without hitting fetch", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "typesafe",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "1",
    });
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            throw new Error("fetch should not have been called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();
            assert.equal(review.verdict, "REJECT");
            assert.equal(fetchCalls, 0, "fetchImpl must never have been called");
            assert.match(review.body, /FACTORY_TYPESAFE_OFF/);
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* No regression for claude-code deployments                                   */
/* -------------------------------------------------------------------------- */

test("claude-code deployment (backend != typesafe): typesafe judgment layer is still attempted, claude fallback runs on failure", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_should_not_be_used",
    });
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            return jsonResponse(200, { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const agent = new ReviewPrAgent(ctx);
            // typesafe is the bypass judgment layer (not a per-role
            // backend): the empty batch fails parsing, so the claude
            // fallback dispatch runs and throws (missing binary in the
            // test env).
            await assert.rejects(() => agent.run(), /review-pr/);
            assert.ok(fetchCalls >= 1, "typesafe judgment must be attempted whenever TYPESAFE_API_KEY is set, regardless of the role backend");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});