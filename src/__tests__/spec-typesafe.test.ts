/**
 * Spec `2026-09-20-decision-architecture` / Phase C / T9.2 acceptance —
 * `src/agents/spec.ts` `typesafe` batch (B1, B2, B3).
 *
 * Coverage map (mirrors the acceptance bullet in `plan.md` §4 T9.2 and
 * `requirements.md` §"Decision Inventory → B"):
 *
 *   - `buildSpecTypesafeRequest` composes ONE batch carrying
 *     `{ B1: Choice, B2-AC-*: Score, B3-AC-*: Noul }` over a shared
 *     `JudgmentState`. N ACs ⇒ `1 + 2N` primitives in a SINGLE
 *     `primitives[]` array — never N round-trips.
 *   - `parseSpecTypesafeAnswer` maps the response into a
 *     `SpecTypesafeBatchAnswer` with a mean confidence; malformed
 *     primitives are dropped without aborting; a missing B1 returns
 *     null (parse miss → fallback).
 *   - `SpecAgent.run()` enriches the SpecPair with `confidence` +
 *     `typesafeBatch` on a 200 response, and falls back silently to the
 *     existing `parse()` (claude-code) output on `format-error`, 5xx,
 *     or network failure.
 *   - The `ev` batch is ONE outbound HTTP request. We assert the mocked
 *     `globalThis.fetch` is called exactly once per `run()`.
 *
 * The narrative-generation path (`claude-code` via `dispatchAgentStage`)
 * is driven through the `SpecAgent`'s injected `runtimeOverride` so no
 * real CLI is spawned; the `typesafe` adapter is driven through a mocked
 * `globalThis.fetch` so the test never reaches `api.typesafe.ai`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    SpecAgent,
    buildSpecJudgmentState,
    buildSpecTypesafeRequest,
    parseSpecTypesafeAnswer,
} from "../agents/spec.js";
import type {
    AgentRuntime,
    StageRunRequest,
    StageRunResult,
} from "../core/agent-runtime.js";
import type { AgentContext, SpecPair } from "../core/types.js";
import { buildJudgmentState } from "../core/judgment-state.js";
import type { TypesafeResponse } from "../../runtime/typesafe-backend.d.mts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function freshWorkdir(): string {
    return mkdtempSync(path.join(tmpdir(), "factory-spec-typesafe-"));
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
        repo: { owner: "o", name: "n", defaultBranch: "main", workdir },
        issue: {
            number: 42,
            title: "Spec typesafe test",
            body: "Body for spec typesafe test.",
            labels: ["ready-to-spec"],
            author: "tester",
            url: "https://example.com/42",
            createdAt: "2026-09-20T10:00:00.000Z",
            comments: [],
        },
        skills: [],
        skillsRoot: "/tmp",
        runId: "spec-typesafe-run",
        logger: logger as unknown as AgentContext["logger"],
    } as unknown as AgentContext;
}

/** A canned, parser-valid product half with the supplied acceptance criteria. */
function productJson(acIds: string[]): string {
    return JSON.stringify({
        product: {
            title: "Spec typesafe test",
            problem: "Test problem.",
            goals: ["g1"],
            nonGoals: [],
            stories: [
                {
                    id: "US-1",
                    title: "Story 1",
                    asA: "tester",
                    iWant: "to test",
                    soThat: "the batch works",
                    checks: acIds,
                },
            ],
            acceptanceCriteria: acIds,
            openQuestions: [],
            body: "# PRODUCT.md body\n\n## Acceptance criteria\n",
        },
    });
}

/** A canned, parser-valid tech half. */
function techJson(): string {
    return JSON.stringify({
        tech: {
            approach: "Use TypeScript.",
            affectedAreas: ["src/foo.ts"],
            apiChanges: [],
            dataModel: "n/a",
            migrationPlan: "n/a",
            validationPlan: ["npm test"],
            alternatives: [],
            openQuestions: [],
            body: "# TECH.md body\n\n## Validation plan\n- npm test\n",
        },
    });
}

/**
 * Fake `AgentRuntime` answering the spec-product / spec-tech roles with
 * canned JSON so `dispatchAgentStage`'s `parse()` path succeeds without
 * spawning a real CLI child process. Captures every request so tests can
 * assert the narrative path ran.
 */
function fakeRuntime(acIds: string[]): AgentRuntime & { calls: StageRunRequest[] } {
    const calls: StageRunRequest[] = [];
    const runtime: AgentRuntime = {
        selectBackend() {
            return {
                selection: { backend: "claude-code" },
                log: { backend: "claude-code", source: "default" },
            };
        },
        describeBackend(id) {
            return {
                id,
                displayName: "fake-claude",
                capabilities: { readOnly: true },
                schemaVersion: 1,
                buildHash: "test",
            };
        },
        async runStage(request: StageRunRequest): Promise<StageRunResult> {
            calls.push(request);
            const output = request.role === "spec-product"
                ? productJson(acIds)
                : techJson();
            return {
                status: "succeeded",
                output,
                usage: null,
                logTail: "",
                backend: "claude-code",
                warnings: [],
                retryable: false,
                providerSessionId: `fake-${request.role}`,
            };
        },
    };
    return Object.assign(runtime, { calls });
}

/** JSON response helper (mirrors typesafe-backend.test.ts). */
function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/**
 * A minimal valid official `{model, answers, usage}` envelope for the
 * spec batch. The adapter maps each answer into the legacy
 * `[{id, value, confidence}]` shape the parser still consumes.
 */
function successResponse(acCount: number): TypesafeResponse {
    const n = Math.max(0, acCount);
    const answers: Record<string, { type: string } & Record<string, unknown>> = {
        B1: {
            type: "choice",
            choice: "PRODUCT+TECH",
            probabilities: { "product-only": 0.08, "PRODUCT+TECH": 0.92 },
            confidence: 0.92,
        },
    };
    for (let i = 0; i < n; i += 1) {
        answers[`B2-AC-${i + 1}`] = {
            type: "score",
            // Official Score semantics: raw score is the probability-
            // weighted mean of the LEVEL NUMBERS (0..3 for this
            // 4-level question), i.e. 1×0.05 + 2×0.1 + 3×0.85 = 2.8.
            // The adapter normalises it to 2.8/3 ≈ 0.933 before the
            // parser sees it.
            score: 2.8,
            legend: { "0": "vague", "1": "partial", "2": "mostly", "3": "fully" },
            probabilities: { "0": 0, "1": 0.05, "2": 0.1, "3": 0.85 },
            confidence: 0.88,
        };
        answers[`B3-AC-${i + 1}`] = {
            type: "noul",
            noul: 0.88,
        };
    }
    return {
        model: "jev-1.13.0",
        answers: answers as unknown as TypesafeResponse["answers"],
        usage: { input_tokens: 50, output_tokens: 5 },
        session_id: "ts-spec-session-1",
    };
}

/**
 * Run `fn` with `globalThis.fetch` replaced by a capturing mock and the
 * env configured so the typesafe adapter is reachable (API key present,
 * `FACTORY_TYPESAFE_OFF` cleared). Restores fetch + env afterwards so
 * sibling tests are unaffected. `calls` records every outbound request
 * (url + parsed body) so a test can assert "exactly one HTTP request".
 */
async function withTypesafeFetch<T>(
    impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    fn: (calls: Array<{ url: string; body: unknown }>) => Promise<T>,
): Promise<T> {
    const calls: Array<{ url: string; body: unknown }> = [];
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.TYPESAFE_API_KEY;
    const previousOff = process.env.FACTORY_TYPESAFE_OFF;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        let parsedBody: unknown = init?.body;
        if (typeof parsedBody === "string") {
            try { parsedBody = JSON.parse(parsedBody); } catch { /* keep as string */ }
        }
        calls.push({ url: typeof input === "string" ? input : input.toString(), body: parsedBody });
        return impl(input, init);
    }) as typeof fetch;
    process.env.TYPESAFE_API_KEY = "tk_test_secret";
    delete process.env.FACTORY_TYPESAFE_OFF;
    try {
        return await fn(calls);
    } finally {
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = previousKey;
        if (previousOff === undefined) delete process.env.FACTORY_TYPESAFE_OFF;
        else process.env.FACTORY_TYPESAFE_OFF = previousOff;
    }
}

/* -------------------------------------------------------------------------- */
/* buildSpecJudgmentState                                                     */
/* -------------------------------------------------------------------------- */

test("buildSpecJudgmentState populates specBody from the candidate spec", () => {
    const workdir = freshWorkdir();
    try {
        const ctx = makeContext(workdir);
        const spec = {
            product: { body: "# PRODUCT.md candidate body" },
            tech: { body: "# TECH.md" },
        } as unknown as SpecPair;
        const state = buildSpecJudgmentState(ctx, undefined, spec);
        assert.equal(state.specBody, "# PRODUCT.md candidate body");
        assert.equal(state.issue.number, 42);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("buildSpecJudgmentState judges the revised candidate rather than the previous body", () => {
    const workdir = freshWorkdir();
    try {
        const ctx = makeContext(workdir);
        const spec = {
            product: { body: "# fresh body" },
            tech: { body: "# TECH.md" },
        } as unknown as SpecPair;
        const previous = "## Previous product body\nRevised.";
        const state = buildSpecJudgmentState(
            ctx,
            { feedback: "rev", previousProductBody: previous, previousTechBody: "previous tech" },
            spec,
        );
        assert.equal(state.specBody, spec.product.body);
        assert.notEqual(state.specBody, previous);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* buildSpecTypesafeRequest — ONE batch, 1 + 2N primitives                    */
/* -------------------------------------------------------------------------- */

test("buildSpecTypesafeRequest emits ONE batch with B1 + 2N questions over a shared state", () => {
    const workdir = freshWorkdir();
    try {
        const state = buildJudgmentState(makeContext(workdir).issue);
        const request = buildSpecTypesafeRequest(state, ["AC-1", "AC-2", "AC-3"]);

        assert.ok(!("state_hash" in request), "state_hash must not travel on the wire");
        // 1 (B1) + 3 (B2) + 3 (B3) = 7 questions in ONE request.
        assert.equal(Object.keys(request.questions).length, 7);
        assert.equal(typeof request.state, "object");
        assert.deepEqual(request.state, state);

        const ids = Object.keys(request.questions).sort();
        assert.deepEqual(ids, [
            "B1",
            "B2-AC-1", "B2-AC-2", "B2-AC-3",
            "B3-AC-1", "B3-AC-2", "B3-AC-3",
        ]);

        const b1 = request.questions.B1;
        assert.ok(b1, "B1 question must exist");
        assert.equal(b1.type, "choice");
        assert.match(String(b1.instructions), /PRODUCT/);
        // Spot-check the types directly.
        assert.equal(request.questions["B2-AC-1"].type, "score");
        assert.equal(request.questions["B3-AC-1"].type, "noul");
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------------------------------- */
/* parseSpecTypesafeAnswer                                                     */
/* -------------------------------------------------------------------------- */

test("parseSpecTypesafeAnswer maps a valid response into a typed answer with meanConfidence", () => {
    const response = successResponse(2);
    // The adapter maps the official envelope into the legacy
    // [{id, value, confidence}] array before the parser runs.
    const legacy = Object.entries(response.answers).map(([id, a]) => {
        const x = a as { type: string; choice?: unknown; score?: unknown; noul?: unknown; confidence?: number };
        if (x.type === "noul") return { id, value: (Number(x.noul ?? 0)) >= 0.5, confidence: Number(x.noul ?? 0) };
        if (x.type === "choice") return { id, value: x.choice, confidence: x.confidence ?? 0 };
        // Mirror the adapter's score normalisation: raw level-position
        // score ÷ max level index (4-level B2 question → ÷3).
        return { id, value: Number(x.score ?? 0) / 3, confidence: x.confidence ?? 0 };
    });
    const answer = parseSpecTypesafeAnswer(legacy, ["AC-1", "AC-2"]);
    assert.ok(answer);
    assert.equal(answer!.b1.value, "PRODUCT+TECH");
    assert.equal(answer!.b2.length, 2);
    assert.equal(answer!.b3.length, 2);
    assert.equal(answer!.b2[0].acId, "AC-1");
    assert.equal(answer!.b3[0].acId, "AC-1");
    // mean over B1 (0.92) + 4 per-AC primitives (0.88 each) = 5 entries.
    const expectedMean = (0.92 + 0.88 * 4) / 5;
    assert.ok(Math.abs(answer!.meanConfidence - expectedMean) < 1e-9);
});

test("parseSpecTypesafeAnswer returns null when B1 is missing (parse miss)", () => {
    const answer = parseSpecTypesafeAnswer(
        [
            { id: "B2-AC-1", value: 0.9, confidence: 0.85 },
            { id: "B3-AC-1", value: true, confidence: 0.85 },
        ],
        ["AC-1"],
    );
    assert.equal(answer, null);
});

test("parseSpecTypesafeAnswer returns null when the response shape is unusable", () => {
    assert.equal(parseSpecTypesafeAnswer(null, []), null);
    assert.equal(parseSpecTypesafeAnswer({}, []), null);
    assert.equal(parseSpecTypesafeAnswer([], []), null);
});

test("parseSpecTypesafeAnswer drops malformed per-AC primitives without aborting", () => {
    const answer = parseSpecTypesafeAnswer(
        [
            { id: "B1", value: "PRODUCT+TECH", confidence: 0.92 },
            // B2-AC-1 has a string where a number is expected — dropped.
            { id: "B2-AC-1", value: "not a number", confidence: 0.85 },
            // B3-AC-1 is well-formed — kept.
            { id: "B3-AC-1", value: true, confidence: 0.85 },
        ],
        ["AC-1"],
    );
    assert.ok(answer);
    assert.equal(answer!.b2.length, 0);
    assert.equal(answer!.b3.length, 1);
    const expectedMean = (0.92 + 0.85) / 2;
    assert.ok(Math.abs(answer!.meanConfidence - expectedMean) < 1e-9);
});

/* -------------------------------------------------------------------------- */
/* SpecAgent.run — happy / format-error / unreachable / one-request            */
/* -------------------------------------------------------------------------- */

test("SpecAgent.run attaches the typesafe answer on a 200 response (happy path)", async () => {
    const workdir = freshWorkdir();
    try {
        await withTypesafeFetch(
            async () => jsonResponse(200, successResponse(2)),
            async (calls) => {
                const runtime = fakeRuntime(["AC-1", "AC-2"]);
                const agent = new SpecAgent(makeContext(workdir), undefined, runtime);
                const pair = await agent.run();

                assert.ok(pair.confidence !== undefined, "confidence populated on success");
                assert.ok(pair.typesafeBatch !== undefined, "typesafeBatch populated on success");
                assert.equal(pair.typesafeBatch!.b1.value, "PRODUCT+TECH");
                assert.equal(pair.typesafeBatch!.b2.length, 2);
                assert.equal(pair.typesafeBatch!.b3.length, 2);
                // Exactly ONE outbound HTTP request — the batch, not N.
                assert.equal(calls.length, 1, "the typesafe batch must be ONE HTTP request");
                assert.match(calls[0].url, /api\.typesafe\.ai\/v1\/systemone/);
                // The narrative path still ran through the fake runtime.
                assert.equal(runtime.calls.length, 2);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('both spec turns receive one canonical directory and documents end with a newline', async () => {
    const workdir = freshWorkdir();
    try {
        await withTypesafeFetch(async () => jsonResponse(200, successResponse(1)), async () => {
            const runtime = fakeRuntime(['AC-1']);
            const pair = await new SpecAgent(makeContext(workdir), undefined, runtime).run();
            const directory = `specs/${pair.product.slug}`;
            for (const request of runtime.calls) {
                const prompt = request.inputManifest.messages.map((message) => message.content).join('\n');
                assert.ok(prompt.includes(directory));
                assert.ok(!prompt.includes('specs/<issue-slug>'));
            }
            assert.deepEqual(readdirSync(path.join(workdir, 'specs')), [pair.product.slug]);
            for (const file of ['PRODUCT.md', 'TECH.md']) assert.ok(readFileSync(path.join(workdir, directory, file), 'utf8').endsWith('\n'));
        });
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test('native tool writes cannot silently publish a parallel spec directory', async () => {
    const workdir = freshWorkdir();
    try {
        const runtime = fakeRuntime(['AC-1']);
        const run = runtime.runStage.bind(runtime);
        runtime.runStage = async (request, context) => {
            mkdirSync(path.join(workdir, 'specs/issue-42-native-short-slug'), { recursive: true });
            return run(request, context);
        };
        await assert.rejects(new SpecAgent(makeContext(workdir), undefined, runtime).run(), /Spec contract violation: unexpected parallel directories/);
        assert.deepEqual(readdirSync(path.join(workdir, 'specs')), ['issue-42-native-short-slug']);
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("SpecAgent.run falls back to the claude-code path on a typesafe format-error", async () => {
    const workdir = freshWorkdir();
    try {
        await withTypesafeFetch(
            // 200 but a non-JSON body → the adapter maps it to the CJK
            // fallback envelope (status: failed) → parse miss.
            async () => new Response("<html>oops</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            }),
            async (calls) => {
                const runtime = fakeRuntime(["AC-1", "AC-2"]);
                const agent = new SpecAgent(makeContext(workdir), undefined, runtime);
                const pair = await agent.run();

                // The claude-code SpecPair survives intact.
                assert.ok(pair.product);
                assert.ok(pair.tech);
                assert.equal(pair.confidence, undefined);
                assert.equal(pair.typesafeBatch, undefined);
                // The adapter still attempted exactly one request.
                assert.equal(calls.length, 1);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("SpecAgent.run falls back to the claude-code path when typesafe is unreachable (HTTP 500)", async () => {
    const workdir = freshWorkdir();
    try {
        await withTypesafeFetch(
            async () => new Response("upstream down", { status: 500 }),
            async () => {
                const runtime = fakeRuntime(["AC-1", "AC-2"]);
                const agent = new SpecAgent(makeContext(workdir), undefined, runtime);
                const pair = await agent.run();

                assert.ok(pair.product);
                assert.ok(pair.tech);
                assert.equal(pair.confidence, undefined);
                assert.equal(pair.typesafeBatch, undefined);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});

test("SpecAgent.run sends exactly ONE typesafe request regardless of N ACs", async () => {
    const workdir = freshWorkdir();
    try {
        const acIds = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"];
        await withTypesafeFetch(
            async () => jsonResponse(200, successResponse(acIds.length)),
            async (calls) => {
                const runtime = fakeRuntime(acIds);
                const agent = new SpecAgent(makeContext(workdir), undefined, runtime);
                await agent.run();

                // ONE HTTP request, not N (one per AC) — this is the
                // core R2 mitigation the task asserts.
                assert.equal(calls.length, 1, "batch must be ONE HTTP request, not N");
                const body = calls[0].body as { questions: Record<string, { type: string; id: string }> };
                // 1 (B1) + 2 * 5 (B2/B3 per AC) = 11 questions in that
                // single request.
                assert.equal(Object.keys(body.questions).length, 1 + 2 * acIds.length);
                assert.ok("B1" in body.questions);
            },
        );
    } finally {
        rmSync(workdir, { recursive: true, force: true });
    }
});
