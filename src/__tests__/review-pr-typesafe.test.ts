/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.1 acceptance tests
 * (review-pr half — B7 + B8 + `review-pr.merge_pr` routing).
 *
 * 2026-09-22 generate-then-judge fix: the claude-code reviewer now
 * ALWAYS runs first and produces the real review (findings, verdict,
 * comments); the typesafe batch is a JUDGMENT layer over that
 * generated review (B7 verdict cross-check + B8 per-REAL-finding
 * severity). Consequences under test:
 *
 *   1. The batch request carries B7 + one B8 per real finding
 *      (keyed `B8-<findingId>`, no fixed NONE-slot vocabulary) on ONE
 *      shared `JudgmentState` that includes the `reviewFindings`
 *      slice.
 *   2. Batch answers flow through the shared `deriveReviewVerdict`
 *      policy: high-confidence B8 escalation flips APPROVE → REJECT;
 *      low-confidence blocking-class severities are downgraded to
 *      advisory (`exploreBlockFloor`).
 *   3. ANY typesafe failure (parse miss, unreachable, off-toggle)
 *      leaves the claude-code review standing UNJUDGED — no synthetic
 *      REJECT, no content-free findings. This is the CJK contract's
 *      `fallback_backend: claude-code` made real.
 *   4. `applyDecision('review-pr.merge_pr', result, decisions)` routes
 *      correctly across the three confidence bands defined in
 *      `runtime/decisions.yaml` (auto ≥ 0.90, confirm ≥ 0.65,
 *      escalate ≤ 0.65).
 *
 * Routing tests are co-located here to pin the review-pr wiring contract.
 *
 * The judgment batch runs whenever `TYPESAFE_API_KEY` is set,
 * regardless of the role's runtime backend (typesafe is the bypass
 * judgment layer, not a per-role backend); the claude-code deployment
 * case is asserted at the end of the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyDecision } from "../core/decision-router.js";
import type { DecisionRoute } from "../core/decision-router.js";
import type { DecisionsFile } from "../core/decisions.js";
import { __clearAgentRuntimeCacheForTest } from "../core/agent-runtime.js";
import {
    setReviewPrFetchImpl,
    setReviewPrGenerationOverrideForTest,
    routeReviewPrMerge,
    selectFindingsForBatch,
    parseReviewPrTypesafeAnswer,
    ReviewPrAgent,
} from "../agents/review-pr.js";
import type { AgentContext, Finding, FindingSeverity, Issue, ReviewResult, JudgmentFailure } from "../core/types.js";
import { annotateDiff, restoreAnnotatedDiff } from '../orchestrator/review-artifacts.js';

test('judgment diff projection losslessly restores additions, removals, context and source-like annotations', () => {
    const patch = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n+[OLD:123] literal source text\n context\n\\ No newline at end of file\n';
    assert.equal(restoreAnnotatedDiff(annotateDiff(patch)), patch);
});

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

/** One well-formed `Finding` as `parseReviewerOutput` would produce. */
function fixtureFinding(id: string, severity: FindingSeverity, summary: string): Finding {
    return {
        id,
        ruleId: `review-pr.${id}`,
        severity,
        requirementIds: [],
        summary,
        evidence: {},
        sourceStage: "review-pr",
        sourceRunId: "run-test-42",
        registeredAt: "2026-09-22T00:00:00.000Z",
        status: "open",
    };
}

/** A generated claude-code review the judgment batch will judge. */
function generatedReview(
    verdict: "APPROVE" | "REJECT",
    findings: Finding[],
): ReviewResult {
    return {
        verdict,
        body: `Found: ${findings.length} finding(s).\n\n${findings
            .map((f) => `- **${f.severity.toUpperCase()}** — ${f.summary}`)
            .join("\n")}`,
        comments: [],
        findings,
    };
}

/** Official choice answer helper. */
function choiceAnswer(
    choice: string,
    confidence: number,
    probabilities: Record<string, number>,
) {
    return { type: "choice", choice, probabilities, confidence };
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
 * un-stubbed claude-code generation dispatch fails fast (spawn ENOENT)
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
/* Decision routing - three confidence bands                                   */
/* -------------------------------------------------------------------------- */

test("applyDecision: review-pr.merge_pr routes auto when confidence >= auto.confidence_min (>=0.90)", () => {
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.95 }, SAMPLE_DECISIONS);
    assert.deepEqual(route, { mode: "auto" });
});

test("applyDecision: review-pr.merge_pr routes confirm when confidence is in (escalate_max, auto_min)", () => {
    // 0.75 is between escalate.confidence_max (0.65) and auto.confidence_min (0.90).
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.75 }, SAMPLE_DECISIONS);
    assert.equal(route.mode, "confirm");
    assert.equal(route.prompt, "PR <n> has <k> blocking. Merge?");
});

test("applyDecision: review-pr.merge_pr routes escalate when confidence <= escalate.confidence_max (<=0.65)", () => {
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.4 }, SAMPLE_DECISIONS);
    assert.deepEqual(route, { mode: "escalate", target: "human" });
});

test("applyDecision: review-pr.merge_pr at exactly the auto threshold routes auto", () => {
    // The auto check is `>=`, so 0.90 (the documented threshold)
    // must route auto — a regression here would mean the auto arm
    // is mis-tuned by one tick of float precision.
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.9 }, SAMPLE_DECISIONS);
    assert.equal(route.mode, "auto");
});

test("applyDecision: review-pr.merge_pr at exactly the escalate boundary routes escalate (conservative tie-break)", () => {
    // 0.65 is at the confirm.confidence_min boundary AND the
    // escalate.confidence_max boundary. Escalate is evaluated before
    // confirm, so the more conservative arm wins at this exact value.
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.65 }, SAMPLE_DECISIONS);
    assert.equal(route.mode, "escalate");
    assert.equal(route.target, "human");
});

test("applyDecision: unknown action short-circuits to escalate target=unknown_action", () => {
    const route = applyDecision("future.action", { confidence: 0.99 }, SAMPLE_DECISIONS);
    assert.deepEqual(route, { mode: "escalate", target: "unknown_action" });
});

test("applyDecision: malformed confidence (NaN / undefined / out-of-range) collapses to escalate", () => {
    for (const bad of [undefined, NaN, Number.POSITIVE_INFINITY, -1, 2]) {
        const route = applyDecision("review-pr.merge_pr", { confidence: bad as unknown as number }, SAMPLE_DECISIONS);
        assert.equal(route.mode, "escalate", `confidence=${String(bad)} must escalate`);
    }
});

test("blocking findings escalate even with high confidence", () => {
    const route = applyDecision("review-pr.merge_pr", { confidence: 0.95, blockingFindings: 1 }, SAMPLE_DECISIONS);
    assert.deepEqual(route, { mode: "escalate", target: "human" });
});

test("routeReviewPrMerge exposes the same routing through the agent seam", () => {
    const high: DecisionRoute = routeReviewPrMerge({ verdict: "APPROVE" } as ReviewResult, 0.95, SAMPLE_DECISIONS);
    assert.equal(high.mode, "auto");
    const mid: DecisionRoute = routeReviewPrMerge({ verdict: "APPROVE" } as ReviewResult, 0.75, SAMPLE_DECISIONS);
    assert.equal(mid.mode, "confirm");
    const low: DecisionRoute = routeReviewPrMerge({ verdict: "REJECT" } as ReviewResult, 0.5, SAMPLE_DECISIONS);
    assert.equal(low.mode, "escalate");
    assert.equal(low.target, "human");
});

/* -------------------------------------------------------------------------- */
/* Pure helpers — finding selection + answer parsing                           */
/* -------------------------------------------------------------------------- */

test("selectFindingsForBatch prioritises blocking severities and caps at 5 (drop count surfaced)", () => {
    const findings = [
        fixtureFinding("f-1", "nit", "naming"),
        fixtureFinding("f-2", "blocking", "xss"),
        fixtureFinding("f-3", "suggestion", "extract helper"),
        fixtureFinding("f-4", "important", "missing test"),
        fixtureFinding("f-5", "nit", "typo"),
        fixtureFinding("f-6", "blocking", "data loss"),
        fixtureFinding("f-7", "suggestion", "docs"),
    ];
    const { selected, dropped } = selectFindingsForBatch(findings);
    assert.equal(dropped, 2);
    assert.deepEqual(
        selected.map((f) => f.id),
        // blocking (f-2, f-6) → important (f-4) → suggestion (f-3, f-7
        // in reviewer order) — nits f-1/f-5 are the dropped tail.
        ["f-2", "f-6", "f-4", "f-3", "f-7"],
    );
});

test("parseReviewPrTypesafeAnswer maps B7 → b4 and B8-<findingId> → b5; malformed B7 is a parse miss", () => {
    const findings = [fixtureFinding("f-1", "suggestion", "input not validated")];
    const good = parseReviewPrTypesafeAnswer(
        [
            { id: "B7", value: "REJECT", confidence: 0.9 },
            { id: "B8-f-1", value: "CRITICAL", confidence: 0.95 },
        ],
        findings,
    );
    assert.ok(good);
    assert.deepEqual(good!.b4, { id: "B7", value: "REJECT", confidence: 0.9 });
    assert.equal(good!.b5.length, 1);
    assert.equal(good!.b5[0].findingId, "f-1");
    assert.equal(good!.b5[0].value, "blocking");

    // Missing B7 → null (the claude review stands unjudged).
    assert.equal(
        parseReviewPrTypesafeAnswer([{ id: "B8-f-1", value: "NIT", confidence: 0.9 }], findings),
        null,
    );
    // Malformed B7 value → null. NEVER silently normalised to APPROVE.
    assert.equal(
        parseReviewPrTypesafeAnswer([{ id: "B7", value: "MAYBE", confidence: 0.9 }], findings),
        null,
    );
});

/* -------------------------------------------------------------------------- */
/* Generate-then-judge success paths                                          */
/* -------------------------------------------------------------------------- */

test("typesafe batch judges the GENERATED review: B7 + one B8 per real finding on one shared state", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("APPROVE", [
        fixtureFinding("f-1", "nit", "rename local variable"),
        fixtureFinding("f-2", "suggestion", "consider extracting a constant"),
    ]);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const responseBody = {
            model: "jev-1.13.0",
            answers: {
                B7: choiceAnswer("APPROVE", 0.95, { APPROVE: 0.95, REJECT: 0.05 }),
                "B8-f-1": choiceAnswer("NIT", 0.9, { CRITICAL: 0.03, IMPORTANT: 0.04, SUGGESTION: 0.03, NIT: 0.9 }),
                "B8-f-2": choiceAnswer("SUGGESTION", 0.9, { CRITICAL: 0.03, IMPORTANT: 0.04, SUGGESTION: 0.9, NIT: 0.03 }),
            },
            usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock, calls } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        try {
            const issue = fixtureIssue();
            issue.comments = [
                { author: 'operator', body: 'Preserve the existing interface', createdAt: '' },
                { author: 'operator', body: 'Internal status payload <!-- pi-software-factory:triage:42:x -->', createdAt: '' },
            ];
            const ctx = fixtureContext(staged.dir, issue);
            const agent = new ReviewPrAgent(ctx);
            const review = await agent.run();

            // The generated review survives; the judgment agrees with it.
            assert.equal(review.verdict, "APPROVE");
            assert.equal(review.findings?.length, 2);
            assert.equal(review.findings?.[0].severity, "nit");
            assert.equal(review.findings?.[1].severity, "suggestion");
            // Headline confidence is B7's, and the batch is on the audit trail.
            assert.equal(review.confidence, 0.95);
            assert.ok(review.typesafeBatch);
            assert.equal(review.typesafeBatch!.b4.value, "APPROVE");

            // Exactly ONE batch request: B7 + one B8 per REAL finding
            // (keyed by finding id — no fixed NONE-slot vocabulary).
            assert.equal(calls.length, 1, "typesafe adapter must have been hit exactly once (one batch)");
            const body = calls[0].body as { state: Record<string, unknown>; questions: Record<string, unknown> };
            const ids = Object.keys(body.questions);
            assert.deepEqual(ids.sort(), ["B7", "B8-f-1", "B8-f-2"]);
            // The shared state carries the issue, the diff, and the
            // generated findings slice B7 judges against.
            const stateJson = JSON.stringify(body.state);
            assert.ok(stateJson.includes("Add a typesafe adapter"), "state must carry the issue");
            assert.ok(stateJson.includes("rename local variable"), "state must carry the generated findings");
            assert.ok(body.state.prDiff, "state must carry the PR diff");
            assert.ok(stateJson.includes('Preserve the existing interface'));
            assert.ok(!stateJson.includes('Internal status payload'));

            // The route artefact is persisted for the orchestrator.
            const routeFile = JSON.parse(readFileSync(path.join(staged.dir, "review-route.json"), "utf8")) as { action: string; route: DecisionRoute; confidence: number; mode: string };
            assert.equal(routeFile.action, "review-pr.merge_pr");
            assert.equal(routeFile.route.mode, "auto", "confidence 0.95 must route auto");
            assert.equal(routeFile.confidence, 0.95);
            assert.equal(routeFile.mode, "typesafe");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("high-confidence B8 escalation to blocking flips reviewer APPROVE → REJECT", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("APPROVE", [
        fixtureFinding("f-1", "suggestion", "user input flows into SQL string"),
    ]);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const responseBody = {
            model: "jev-1.13.0",
            answers: {
                B7: choiceAnswer("APPROVE", 0.7, { APPROVE: 0.7, REJECT: 0.3 }),
                "B8-f-1": choiceAnswer("CRITICAL", 0.95, { CRITICAL: 0.95, IMPORTANT: 0.02, SUGGESTION: 0.02, NIT: 0.01 }),
            },
            usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            assert.equal(review.verdict, "REJECT", "high-confidence CRITICAL escalation must force REJECT");
            assert.equal(review.findings?.[0].severity, "blocking");
            assert.match(review.body, /typesafe adjustments/);
            assert.match(review.body, /escalated to blocking/);
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("exploreBlockFloor downgrades a low-confidence B8 blocking severity to advisory", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("APPROVE", [
        fixtureFinding("f-1", "important", "helper could be extracted"),
    ]);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const responseBody = {
            model: "jev-1.13.0",
            answers: {
                B7: choiceAnswer("APPROVE", 0.95, { APPROVE: 0.95, REJECT: 0.05 }),
                // CRITICAL at confidence 0.5 — below the default
                // exploreBlockFloor (0.9): blocking power is dropped.
                "B8-f-1": choiceAnswer("CRITICAL", 0.5, { CRITICAL: 0.5, IMPORTANT: 0.2, SUGGESTION: 0.2, NIT: 0.1 }),
            },
            usage: { input_tokens: 0, output_tokens: 0 },
        };
        const { fetch: fetchMock } = captureFetch(async () => jsonResponse(200, responseBody));
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            assert.equal(review.verdict, "APPROVE", "downgraded finding must not flip the verdict");
            assert.equal(review.findings?.[0].severity, "suggestion");
            assert.match(review.body, /downgraded f-1 to suggestion/);
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* Failure paths — the generated review always survives                        */
/* -------------------------------------------------------------------------- */

function assertUnjudgedReview(review: ReviewResult, generated: ReviewResult, failure: JudgmentFailure) {
    assert.deepEqual(review, { ...generated, judgmentFailure: failure });
    assert.equal(review.mergeRoute, undefined);
}

test('cached review recovery rejudges original content without invoking the generation agent', async () => {
    const staged = stageReviewDir();
    const restore = useEnv({ FACTORY_REVIEW_DIR: staged.dir, TYPESAFE_API_KEY: 'test', FACTORY_TYPESAFE_OFF: '0' });
    const previous = { ...generatedReview('APPROVE', []), judgmentFailure: { kind: 'transient' as const, code: 'JUDGMENT_SERVICE_UNAVAILABLE' } };
    const saved = structuredClone(previous);
    setReviewPrGenerationOverrideForTest(async () => { throw new Error('Recovery must not regenerate a valid cached review'); });
    setReviewPrFetchImpl(async () => jsonResponse(200, { answers: { B7: choiceAnswer('APPROVE', 0.99, { APPROVE: 0.99, REJECT: 0.01 }) } }));
    try {
        const review = await new ReviewPrAgent(fixtureContext(staged.dir, fixtureIssue())).run(previous);
        assert.deepEqual(previous, saved);
        assert.equal(review.body, saved.body);
        assert.equal(review.mergeRoute?.mode, 'auto');
        assert.equal(review.judgmentFailure, undefined);
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        setReviewPrFetchImpl(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("batch format-error (empty answers): claude-code review stands unjudged, no route artefact", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("APPROVE", []);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const { fetch: fetchMock, calls } = captureFetch(async () =>
            jsonResponse(200, { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        );
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            assertUnjudgedReview(review, generated, { kind: 'contract', code: 'JUDGMENT_CONTRACT_INVALID' });
            assert.equal(review.confidence, undefined);
            assert.equal(calls.length, 1, "typesafe adapter must have been hit before the parse-miss decision");
            assert.ok(!existsSync(path.join(staged.dir, "review-route.json")), "no route without a judgment");
            // review.json still persists the generated artefact.
            const persisted = JSON.parse(readFileSync(path.join(staged.dir, "review.json"), "utf8"));
            assert.equal(persisted.verdict, "APPROVE");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe unreachable (mock fetch → 500): claude-code review survives verbatim (no synthetic REJECT)", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("APPROVE", [fixtureFinding("f-1", "nit", "typo")]);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const { fetch: fetchMock, calls } = captureFetch(
            async () => new Response("upstream down", { status: 500 }),
        );
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            // The outage degrades the JUDGMENT, never the review: no
            // synthetic REJECT, no typesafe_unreachable finding.
            assertUnjudgedReview(review, generated, { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' });
            assert.ok(
                !(review.findings ?? []).some((f) => f.ruleId === "review-pr.typesafe_unreachable"),
                "synthetic fallback findings must not exist anymore",
            );
            assert.equal(calls.length, 1);
            assert.ok(!existsSync(path.join(staged.dir, "review-route.json")));
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("typesafe unreachable (network error): claude-code review survives verbatim", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "",
    });
    const generated = generatedReview("REJECT", [fixtureFinding("f-1", "blocking", "race condition")]);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        const fetchMock = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            assertUnjudgedReview(review, generated, { kind: 'transient', code: 'JUDGMENT_SERVICE_UNAVAILABLE' });
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("FACTORY_TYPESAFE_OFF=1: judgment skipped without hitting fetch; review unchanged", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
        FACTORY_TYPESAFE_OFF: "1",
    });
    const generated = generatedReview("APPROVE", []);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            throw new Error("fetch should not have been called when FACTORY_TYPESAFE_OFF=1");
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            assertUnjudgedReview(review, generated, { kind: 'configuration', code: 'JUDGMENT_CONFIGURATION_UNAVAILABLE' });
            assert.equal(fetchCalls, 0, "fetchImpl must never have been called");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});

test("generation failure propagates (missing CLI binary): run() rejects before any judgment call", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_test_secret",
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
            // No generation override: the dispatch targets the missing
            // FACTORY_CLAUDE_COMMAND binary and fails fast. Generation
            // runs FIRST now, so the judgment layer is never reached.
            await assert.rejects(() => agent.run(), /review-pr/);
            assert.equal(fetchCalls, 0, "judgment batch must not run when generation failed");
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

test("claude-code deployment (backend != typesafe): judgment layer is still attempted when the API key is set", async () => {
    const staged = stageReviewDir();
    const restore = useEnv({
        FACTORY_AGENT_BACKEND: "claude-code",
        FACTORY_REVIEW_DIR: staged.dir,
        TYPESAFE_API_KEY: "tk_should_be_used_for_judgment",
    });
    const generated = generatedReview("APPROVE", []);
    setReviewPrGenerationOverrideForTest(async () => structuredClone(generated));
    try {
        let fetchCalls = 0;
        const fetchMock = (async () => {
            fetchCalls += 1;
            return jsonResponse(200, { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
        }) as typeof fetch;
        setReviewPrFetchImpl(fetchMock);
        try {
            const ctx = fixtureContext(staged.dir, fixtureIssue());
            const review = await new ReviewPrAgent(ctx).run();
            // typesafe is the bypass judgment layer (not a per-role
            // backend): the empty batch is a parse miss, so the
            // generated review stands unjudged.
            assertUnjudgedReview(review, generated, { kind: 'contract', code: 'JUDGMENT_CONTRACT_INVALID' });
            assert.ok(fetchCalls >= 1, "typesafe judgment must be attempted whenever TYPESAFE_API_KEY is set, regardless of the role backend");
        } finally {
            setReviewPrFetchImpl(null);
        }
    } finally {
        setReviewPrGenerationOverrideForTest(null);
        restore();
        rmSync(staged.dir, { recursive: true, force: true });
    }
});
