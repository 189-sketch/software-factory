// scripts/freshness-poc.mjs
//
// Spec `2026-09-20-decision-architecture` / Phase B / T8.4.
//
// Freshness `Noul` PoC for the polling daemon. The polling loop
// (`scripts/factory-daemon.mjs::pollingLoop`) calls
// `freshnessCheck(issue, options)` for every fetched issue before
// enqueueing it. When the cached hash matches the current state hash
// the daemon skips the issue and logs `judgment.skip reason:
// "state_unchanged"` per requirements.md §"Skip rule"; when the
// state hash differs the module optionally calls the `typesafe`
// backend (T8.1) with a single `Noul` primitive and short-circuits
// when `noul_yes < threshold`. Failures fall back to `skip: false`
// with `reason: 'freshness_unavailable'` so the existing
// `enqueueIssue` path runs unchanged.
//
// The SHA-256 hash and `JudgmentState` builder are re-implemented in
// pure JS here so the daemon (`scripts/factory-daemon.mjs`, launched
// with `process.execPath` from `bin/factory.js`) does not need a
// TypeScript runtime. The TypeScript reference lives at
// `src/core/judgment-state.ts`; the unit test
// `src/__tests__/freshness-poc.test.ts` cross-checks the JS hash
// against `stateHashFor` to guarantee parity.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runTypesafeStageFromConfig } from "../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../runtime/agent-backends.mjs";

/**
 * Stable SHA-256 of an in-memory string. Mirrors
 * `core/artifact-hash.ts::sha256Hex` and the inline helper in
 * `src/core/judgment-state.ts`.
 */
function sha256Hex(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Detect a factory comment from its body. Mirrors
 * `src/core/factory-comments.ts::isFactoryComment` for the markers
 * used at runtime so the freshness hash agrees with the agent
 * runtime's comment classification. Keep in sync if a new marker
 * appears in `core/factory-comments.ts`.
 */
const FACTORY_COMMENT_MARKERS = [
    "<!-- pi-software-factory:triage:",
    "<!-- pi-software-factory:spec-review:",
    "<!-- pi-software-factory:pr-review:",
];
function defaultIsFactoryComment(comment) {
    const body = comment?.body ?? "";
    return FACTORY_COMMENT_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Lazily assemble a `JudgmentState` (the type lives at
 * `src/core/judgment-state.ts::JudgmentState`) from an existing
 * `Issue` and a factory context. Mirrors `buildJudgmentState` so the
 * hash the daemon computes here matches the one the orchestrator
 * computes in production. Differences from the TS version are
 * documented inline.
 *
 * @param {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   labels: string[],
 *   updatedAt?: string,
 *   createdAt: string,
 *   comments: Array<{ author: string, body: string, createdAt: string }>,
 * }} issue
 * @param {{ factory?: object, lastTriageAt?: string, lastJudgmentHash?: string, failureCounts?: object, lastReceiptRegistry?: object, priorDecisions?: Array<object> }} ctx
 * @param {{ issueUpdatedAt?: string, repoSignals?: object, isFactoryComment?: (comment: { body?: string }) => boolean, factory?: object }} [opts]
 */
export function buildJudgmentState(issue, ctx = undefined, opts = {}) {
    const detector = opts.isFactoryComment ?? defaultIsFactoryComment;
    const factoryInput = ctx?.factory ?? opts.factory ?? { failureCounts: {} };
    const comments = (issue.comments ?? []).map((c) => ({
        author: c.author ?? "",
        body: c.body ?? "",
        createdAt: c.createdAt ?? "",
        isFactoryComment: detector({ body: c.body ?? "" }),
    }));
    const updatedAt = opts.issueUpdatedAt ?? issue.updatedAt ?? issue.createdAt ?? "";
    const factory = {
        failureCounts: factoryInput.failureCounts ?? {},
        priorDecisions: factoryInput.priorDecisions ?? [],
    };
    if (factoryInput.lastTriageAt !== undefined) factory.lastTriageAt = factoryInput.lastTriageAt;
    else if (ctx?.lastTriageAt !== undefined) factory.lastTriageAt = ctx.lastTriageAt;
    if (factoryInput.lastJudgmentHash !== undefined) factory.lastJudgmentHash = factoryInput.lastJudgmentHash;
    else if (ctx?.lastJudgmentHash !== undefined) factory.lastJudgmentHash = ctx.lastJudgmentHash;
    if (factoryInput.lastReceiptRegistry !== undefined) factory.lastReceiptRegistry = factoryInput.lastReceiptRegistry;
    const repoSignals = opts.repoSignals ?? { primaryLanguage: "unknown", hasOpenSpec: false, hasOpenPRs: 0 };
    return {
        issue: {
            number: issue.number,
            title: issue.title ?? "",
            body: issue.body ?? "",
            labels: issue.labels ?? [],
            updatedAt,
            comments,
        },
        factory,
        repoSignals,
    };
}

/**
 * Compute the freshness hash for `state` per requirements.md
 * §"Freshness Protocol":
 *
 * ```
 * stateHash = sha256(
 *   issue.updatedAt
 *   || '|' || comments.length
 *   || '|' || lastReceiptSha
 *   || '|' || factory.lastTriageAt
 *   || '|' || issue.labels.join(',')
 * )
 * ```
 *
 * `lastReceiptSha` is `sha256(JSON.stringify(lastReceiptRegistry))`
 * when the registry is present or `''` when absent. Mirrors
 * `stateHashFor` in `src/core/judgment-state.ts` line-for-line.
 */
export function stateHashFor(state) {
    const lastReceiptSha = state?.factory?.lastReceiptRegistry
        ? sha256Hex(JSON.stringify(state.factory.lastReceiptRegistry))
        : "";
    const parts = [
        state?.issue?.updatedAt ?? "",
        String(state?.issue?.comments?.length ?? 0),
        lastReceiptSha,
        state?.factory?.lastTriageAt ?? "",
        (state?.issue?.labels ?? []).join(","),
    ];
    return sha256Hex(parts.join("|"));
}

/**
 * Result of a `freshnessCheck(issue, options)` call.
 *
 * - `skip: true`  -> the daemon should NOT enqueue the issue and
 *                    SHOULD log `judgment.skip` with `reason`,
 *                    `stateHash`, `noul_yes`, `threshold`.
 * - `skip: false` -> the daemon proceeds with the existing
 *                    `enqueueIssue` path. `reason` is one of:
 *                      - `'freshness_unavailable'`: typesafe short-circuited
 *                        (FACTORY_TYPESAFE_OFF / missing key / fetch failure)
 *                        so we conservatively fall back to a full triage.
 *                      - `'state_changed'`: typesafe returned a `Noul`
 *                        value above the threshold, so a full primitive
 *                        batch should run.
 *                    `noul_yes` carries the typesafe answer (or 0 when
 *                    the typesafe backend was bypassed).
 *
 * @typedef {{ skip: boolean, reason: string, stateHash: string, noul_yes: number }} FreshnessResult
 */

/* -------------------------------------------------------------------------- */
/* Checkpoint helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read the `FactoryIssueState` checkpoint for `issueNumber` from
 * `<stateDir>/issues/<number>.json`. Returns `null` when the file
 * is absent or unreadable (a brand-new issue has no checkpoint
 * yet). The contract mirrors `factory-daemon.mjs::readCheckpoint`
 * — the daemon already reads from the same path, so a freshness
 * check sees the same data the rest of the loop sees.
 */
async function readFactoryIssueState(stateDir, issueNumber) {
    if (!stateDir) return null;
    try {
        const raw = await fs.readFile(path.join(stateDir, "issues", `${issueNumber}.json`), "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Persist `lastJudgmentHash` on the existing FactoryIssueState
 * checkpoint. We do NOT touch any other field — the freshness
 * module is the single writer of `lastJudgmentHash`. Missing
 * checkpoint: no-op (a brand-new issue will get its hash on the
 * next save path that creates the checkpoint).
 */
async function persistLastJudgmentHash(stateDir, issueNumber, stateHash) {
    if (!stateDir) return;
    const file = path.join(stateDir, "issues", `${issueNumber}.json`);
    try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        parsed.lastJudgmentHash = stateHash;
        await fs.writeFile(file, JSON.stringify(parsed, null, 2));
    } catch {
        // Best-effort: a missing checkpoint just means there is
        // nothing to persist yet. The next real save will create it.
    }
}

/* -------------------------------------------------------------------------- */
/* typesafe call                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the `typesafe` request envelope for the freshness `Noul`.
 *
 * Mirrors requirements.md §"Decision 2": one primitive question
 * (`freshness` / `Noul`) over the shared judgment state. The
 * payload includes the previous hash so the model can answer
 * "has anything changed since the last judgment?" in a single
 * yes/no probability. `state_hash` is the new computed hash — the
 * adapter serialises this in the body so the backend can cache
 * results by it.
 */
function buildFreshnessRequest({ model, stateHash, lastJudgmentHash, ctx }) {
    return {
        model,
        state_hash: stateHash,
        primitives: [
            {
                id: "freshness",
                type: "Noul",
                question: "Has anything changed since the last triage?",
                state: {
                    stateHash,
                    lastJudgmentHash: lastJudgmentHash ?? null,
                    labels: ctx?.labels ?? [],
                    commentsCount: ctx?.commentsCount ?? 0,
                    updatedAt: ctx?.updatedAt ?? null,
                },
            },
        ],
    };
}

/**
 * Run the freshness `Noul` against `typesafe` and return the
 * `noul_yes` probability. The `runTypesafeStageFromConfig` adapter
 * is responsible for `FACTORY_TYPESAFE_OFF=1` short-circuiting and
 * for mapping every failure mode to a `failed` `StageRunResult`
 * with a `typesafe_fallback_to_claude:` warning; we only need to
 * extract `noul_yes` from `structuredOutput` on success and treat
 * every `failed` result as `freshness_unavailable`.
 *
 * The default `env` and `agentConfig` come from `process.env`; the
 * test layer injects both via `options.env` / `options.agentConfig`
 * / `options.fetchImpl` so it can mock `fetch` and stay offline.
 */
async function callTypesafeNoul({ config, request, env, fetchImpl, timeoutMs, abortSignal }) {
    const result = await runTypesafeStageFromConfig(config, "typesafe", request, {
        env,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        ...(abortSignal ? { abortSignal } : {}),
    });
    if (result?.status !== "succeeded") {
        const warning = Array.isArray(result?.warnings) && result.warnings.length > 0
            ? String(result.warnings[0])
            : "typesafe unavailable";
        return { ok: false, noul_yes: 0, warning };
    }
    const primitives = Array.isArray(result?.structuredOutput) ? result.structuredOutput : [];
    const freshness = primitives.find((p) => p?.id === "freshness") ?? primitives[0];
    const raw = freshness?.confidence;
    const noul = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    return { ok: true, noul_yes: noul, warning: null };
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether the daemon should enqueue `issue` (skip = false)
 * or skip it as state-unchanged (skip = true).
 *
 * Algorithm (per requirements.md §"Freshness Protocol" + §"Skip rule"):
 *
 *   1. Load the existing `FactoryIssueState` checkpoint for this
 *      issue (if any). The checkpoint carries `lastTriageAt` and
 *      `lastJudgmentHash`.
 *   2. Compute the new `stateHash` via
 *      `stateHashFor(buildJudgmentState(issue, ctx))`.
 *   3. If `stateHash === lastJudgmentHash` -> skip with
 *      `reason: 'state_unchanged'`, `noul_yes: 0`. No typesafe call.
 *   4. Otherwise, when `TYPESAFE_API_KEY` is set AND
 *      `FACTORY_TYPESAFE_OFF !== '1'`, call the `typesafe` Noul
 *      primitive via `runTypesafeStageFromConfig`. Skip when
 *      `noul_yes < threshold`; otherwise fall through to enqueue.
 *   5. On any typesafe failure (network / 4xx / 5xx / missing key /
 *      short-circuit), fall back to `skip: false` with
 *      `reason: 'freshness_unavailable'` so the existing
 *      `enqueueIssue` path runs unchanged. `phase A context`: typesafe
 *      failures do not re-run; the calling stage surfaces the failure.
 *
 * The function NEVER throws. Every failure mode maps to a
 * `{ skip, reason, stateHash, noul_yes }` result; the caller can
 * decide what to do (the daemon always treats `skip: false` as
 * "proceed with enqueue").
 *
 * @param {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   labels: string[],
 *   updatedAt?: string,
 *   createdAt: string,
 *   comments: Array<{ author: string, body: string, createdAt: string }>,
 * }} issue
 * @param {{
 *   stateDir?: string,
 *   threshold?: number,
 *   env?: NodeJS.ProcessEnv,
 *   agentConfig?: ReturnType<typeof resolveAgentConfig>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 *   persist?: boolean,
 *   now?: () => Date,
 * }} [options]
 * @returns {Promise<FreshnessResult>}
 */
export async function freshnessCheck(issue, options = {}) {
    const stateDir = options.stateDir ?? null;
    const threshold = typeof options.threshold === "number" && Number.isFinite(options.threshold)
        ? options.threshold
        : 0.20;
    const env = options.env ?? process.env;
    const persist = options.persist !== false;
    // Default `now` keeps the function deterministic in tests.
    const now = options.now ?? (() => new Date());

    if (!issue || typeof issue.number !== "number") {
        return { skip: false, reason: "freshness_unavailable", stateHash: "", noul_yes: 0 };
    }

    const checkpoint = await readFactoryIssueState(stateDir, issue.number);
    const lastJudgmentHash = typeof checkpoint?.lastJudgmentHash === "string" ? checkpoint.lastJudgmentHash : "";
    const lastTriageAt = typeof checkpoint?.lastTriageAt === "string" ? checkpoint.lastTriageAt : "";

    // Build a minimal factory context. The polling loop only feeds
    // fields that exist on the `Issue` + checkpoint; later tasks (T9.x)
    // will widen this with `failureCounts` and `lastReceiptRegistry`.
    const factoryCtx = {
        failureCounts: checkpoint?.failureCounts ?? {},
        priorDecisions: checkpoint?.priorDecisions ?? [],
        lastReceiptRegistry: checkpoint?.lastReceiptRegistry,
        lastTriageAt,
    };
    const state = buildJudgmentState(issue, { factory: factoryCtx });
    const stateHash = stateHashFor(state);

    // Fast path: state hash matches the cached hash -> nothing changed.
    if (lastJudgmentHash && lastJudgmentHash === stateHash) {
        return { skip: true, reason: "state_unchanged", stateHash, noul_yes: 0 };
    }

    // No cached hash on a brand-new issue: do not pay a typesafe
    // call when there is no "last" to compare against. The daemon
    // must run the full triage on first sight, so we return
    // `skip: false` with `noul_yes: 0` and a dedicated reason that
    // is NOT 'state_unchanged' (so the polling loop never logs the
    // skip message and never persists a hash for an issue that
    // never had one).
    if (!lastJudgmentHash) {
        if (persist) {
            await persistLastJudgmentHash(stateDir, issue.number, stateHash);
        }
        return { skip: false, reason: "no_cached_hash", stateHash, noul_yes: 0 };
    }

    // typesafe short-circuit (FACTORY_TYPESAFE_OFF=1).
    const typesafeOff = String(env?.FACTORY_TYPESAFE_OFF ?? "").trim() === "1";
    if (typesafeOff) {
        if (persist) {
            await persistLastJudgmentHash(stateDir, issue.number, stateHash);
        }
        return { skip: false, reason: "freshness_unavailable", stateHash, noul_yes: 0 };
    }

    // Missing API key -> fall back. Same shape as a network failure:
    // the existing enqueue path runs unchanged.
    const apiKey = typeof env?.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim()
        ? env.TYPESAFE_API_KEY.trim()
        : null;
    if (!apiKey) {
        if (persist) {
            await persistLastJudgmentHash(stateDir, issue.number, stateHash);
        }
        return { skip: false, reason: "freshness_unavailable", stateHash, noul_yes: 0 };
    }

    // Resolve the typesafe agent config once per call. Tests inject
    // a pre-resolved config so they can keep `process.env` clean;
    // production callers fall back to `resolveAgentConfig(env)`.
    const config = options.agentConfig ?? resolveAgentConfig(env);
    const request = buildFreshnessRequest({
        model: config?.backends?.typesafe?.model || env?.FACTORY_TYPESAFE_MODEL || "jev-fast",
        stateHash,
        lastJudgmentHash,
        ctx: {
            labels: issue.labels,
            commentsCount: (issue.comments ?? []).length,
            updatedAt: state.issue.updatedAt,
        },
    });

    let noulResult;
    try {
        noulResult = await callTypesafeNoul({
            config,
            request,
            env,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
            abortSignal: options.abortSignal,
        });
    } catch (error) {
        // The adapter already returns a fallback envelope on every
        // error path; this catch is a belt-and-suspenders guard for
        // any future bug in the adapter (e.g. an unexpected throw).
        noulResult = {
            ok: false,
            noul_yes: 0,
            warning: error instanceof Error ? error.message : String(error),
        };
    }

    if (!noulResult.ok) {
        if (persist) {
            await persistLastJudgmentHash(stateDir, issue.number, stateHash);
        }
        return { skip: false, reason: "freshness_unavailable", stateHash, noul_yes: 0 };
    }

    const noulYes = noulResult.noul_yes;
    if (noulYes < threshold) {
        if (persist) {
            await persistLastJudgmentHash(stateDir, issue.number, stateHash);
        }
        return { skip: true, reason: "state_unchanged", stateHash, noul_yes: noulYes };
    }

    if (persist) {
        await persistLastJudgmentHash(stateDir, issue.number, stateHash);
    }
    return { skip: false, reason: "state_changed", stateHash, noul_yes: noulYes };
}

/* -------------------------------------------------------------------------- */
/* Composite health (T8.3 formula in pure JS)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compute the composite `health` value per Decision 6 / T8.3
 * `computeHealth` formula:
 *
 *   health = clamp(sum(weight_i * score_i) / weightSum, 0, 1)
 *
 * Inlined here as a pure JS helper so the polling daemon
 * (`scripts/factory-daemon.mjs`, launched with `process.execPath`)
 * does not need a TypeScript runtime. The TS reference lives at
 * `src/orchestrator/composite.ts::computeHealth`; the daemon-tick
 * log MUST produce identical numbers for identical inputs. The
 * `clamp` + `weightSum` normalisations match the TS impl.
 *
 * @param {{ spec: number, impl: number, review: number, verify: number }} scores
 * @param {{ spec: number, impl: number, review: number, verify: number }} [weights]
 */
export function computeHealthJs(scores, weights) {
    const dims = ["spec", "impl", "review", "verify"];
    const effectiveWeights = weights ?? { spec: 0.30, impl: 0.25, review: 0.20, verify: 0.25 };
    if (!scores || typeof scores !== "object") {
        throw new Error("computeHealthJs: scores must be an object");
    }
    let total = 0;
    let weightSum = 0;
    for (const dim of dims) {
        const score = scores[dim];
        if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new Error(`computeHealthJs: score for "${dim}" must be a finite number (got ${String(score)})`);
        }
        const weight = effectiveWeights[dim];
        if (typeof weight !== "number" || !Number.isFinite(weight)) {
            throw new Error(`computeHealthJs: weight for "${dim}" must be a finite number (got ${String(weight)})`);
        }
        const clamped = Math.min(1, Math.max(0, score));
        total += weight * clamped;
        weightSum += weight;
    }
    if (weightSum <= 0) {
        throw new Error("computeHealthJs: weight sum must be positive");
    }
    return Math.min(1, Math.max(0, total / weightSum));
}

/**
 * Default freshness stats shape returned by `summariseFreshness`.
 * The polling loop calls `summariseFreshness` once per cycle to
 * compute the composite health.
 */
export const DEFAULT_FRESHNESS_STATS = Object.freeze({
    checked: 0,
    skipped: 0,
    fresh: 0,
    unavailable: 0,
    skippedRate: 0,
});

/**
 * Reduce a list of per-issue freshness outcomes into the four
 * dimension scores consumed by `computeHealthJs`. Per the task
 * spec, the skip-rate is the Phase B MVP proxy for all four
 * dimensions when the underlying scores are not yet available.
 *
 * `outcomes` is an array of `{ skipped: boolean, unavailable: boolean }`.
 */
export function summariseFreshness(outcomes) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) {
        return { ...DEFAULT_FRESHNESS_STATS };
    }
    let skipped = 0;
    let unavailable = 0;
    for (const o of outcomes) {
        if (o?.skipped) skipped += 1;
        if (o?.unavailable) unavailable += 1;
    }
    const checked = outcomes.length;
    const fresh = Math.max(0, checked - skipped);
    const skippedRate = skipped / checked;
    return { checked, skipped, fresh, unavailable, skippedRate };
}
