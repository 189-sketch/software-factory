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
// The TypeScript orchestrator and this plain-JS daemon share business-input.mjs.
// Polling is read-only: a completed worker judgment, not enqueueing, consumes input.

import { businessInputHash, isFactoryComment as defaultIsFactoryComment } from "../runtime/business-input.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runTypesafeStageFromConfig } from "../runtime/typesafe-backend.mjs";
import { resolveAgentConfig } from "../runtime/agent-backends.mjs";
import { stageForActiveLabel } from "../runtime/pipeline-definition.mjs";

/**
 * True when the most recent comment is a non-factory voice. Mirrors
 * `src/core/factory-comments.ts::latestVoiceIsAuthor` so the polling
 * freshness layer can override the `state_unchanged` fast path when
 * the operator has spoken (issue #46 stranded at `wait` even after the
 * author replied). Marker-only by design — never consults the GitHub
 * login because operators and the factory bot may share an account.
 */
function hasAuthorCommentAfter(comments, lastTriageAt) {
    const triageTime = lastTriageAt ? Date.parse(lastTriageAt) : NaN;
    return Boolean(comments?.some((comment) =>
        !defaultIsFactoryComment(comment)
        && typeof comment.createdAt === "string"
        && Number.isFinite(Date.parse(comment.createdAt))
        && (!Number.isFinite(triageTime) || Date.parse(comment.createdAt) > triageTime)));
}

function latestVoiceIsAuthor(comments) {
    return Boolean(comments?.length && !defaultIsFactoryComment(comments[comments.length - 1]));
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
            state: issue.state,
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

/** Same business-input hash as the TypeScript orchestrator. */
export function stateHashFor(state) {
    return businessInputHash(state.issue);
}

/**
 * Result of a `freshnessCheck(issue, options)` call.
 *
 * - `skip: true`  -> the daemon should NOT enqueue the issue and
 *                    SHOULD log `judgment.skip` with `reason`,
 *                    `stateHash`, `noul_yes`, `threshold`. When
 *                    `reason === "state_unchanged"`, the optional
 *                    `resumeStage` / `confidence` / `resumeReason`
 *                    fields carry the result of the polling-time
 *                    resume decision (see `decideResumeStage`).
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
 * @typedef {{
 *   skip: boolean,
 *   reason: string,
 *   stateHash: string,
 *   noul_yes: number,
 *   resumeStage?: ("wait"|"triage"|"spec"|"implementation"|"review"|"verify"|"merge"),
 *   confidence?: number,
 *   resumeReason?: ("ok"|"off-toggle"|"unreachable"|"parse-miss"|"invalid-stage"|"no-answer")
 * }} FreshnessResult
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
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

/* -------------------------------------------------------------------------- */
/* typesafe call                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the official System One request envelope for the freshness
 * `noul`. Mirrors the post-migration contract documented in
 * `runtime/typesafe-backend.mjs` and `requirements.md` Erratum
 * (2026-09-21): one `noul` question (`freshness`) over a shared
 * top-level `state`. The state carries the previous hash, the new
 * hash, and a small slice of the issue context the model needs to
 * answer "has anything changed since the last judgment?" in a single
 * yes/no probability. `state_hash` is no longer on the wire.
 */
function buildFreshnessRequest({ model, stateHash, lastJudgmentHash, ctx }) {
    return {
        model,
        state: {
            stateHash,
            lastJudgmentHash: lastJudgmentHash ?? null,
            labels: ctx?.labels ?? [],
            commentsCount: ctx?.commentsCount ?? 0,
            updatedAt: ctx?.updatedAt ?? null,
        },
        questions: {
            freshness: {
                type: "noul",
                instructions: "Has anything changed since the last triage? Compare `state.stateHash` against `state.lastJudgmentHash` and weigh `state.labels` / `state.commentsCount` / `state.updatedAt`.",
                criteria: {
                    true: "The issue state moved on; a fresh triage is warranted.",
                    false: "State is effectively unchanged; skipping triage is safe.",
                },
            },
        },
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

/**
 * Build the official System One request envelope for the polling-time
 * "resume_stage" choice (`C1.resume_stage`, spec T11.2). Mirrors
 * `src/agents/freshness-routing.ts::buildResumeStageRequest` — kept in
 * sync by hand because `scripts/freshness-poc.mjs` runs in a Node-only
 * context that does not load the TS source.
 *
 * `state.stateHash` and `state.lastJudgmentHash` are equal at the call
 * site (that's why we got here) — including both in the envelope makes
 * the model's job trivial and keeps the contract uniform with the
 * freshness `noul` primitive.
 */
function buildResumeStageRequest({ model, stateHash, lastJudgmentHash, lastTriageAt, issue }) {
    return {
        model,
        state: {
            stateHash,
            lastJudgmentHash: lastJudgmentHash ?? null,
            lastTriageAt: lastTriageAt ?? null,
            labels: issue?.labels ?? [],
            updatedAt: issue?.updatedAt ?? null,
            commentsCount: (issue?.comments ?? []).length,
        },
        questions: {
            resume_stage: {
                type: "choice",
                instructions:
                    "The issue's hash is unchanged since the last triage " +
                    "(state.stateHash == state.lastJudgmentHash). The label " +
                    "set may still indicate the pipeline should resume, or it " +
                    "may signal that the operator needs to act first. Pick the " +
                    "single next action based on the labels in state.labels " +
                    "and the most recent triage timestamp in state.lastTriageAt.",
                criteria: {
                    wait:
                        "labels include needs-info or wait-to-implement — let " +
                        "the operator respond before re-engaging the pipeline",
                    triage:
                        "no active pipeline label, or an ambiguous / " +
                        "conflicting set of active labels — let the triage " +
                        "stage re-decide the label",
                    spec:
                        "labels include ready-to-spec and no later-stage " +
                        "active label is present",
                    implementation:
                        "labels include ready-to-implement, verify-failed, " +
                        "or changes-requested, and no later-stage active " +
                        "label is present",
                    review:
                        "labels include review-needed and no later-stage " +
                        "active label is present",
                    verify:
                        "labels include ready-to-merge and no later-stage " +
                        "active label is present",
                    merge:
                        "labels include verified and no later-stage active " +
                        "label is present",
                },
            },
        },
    };
}

const RESUME_STAGE_VALUES = new Set([
    "wait",
    "triage",
    "spec",
    "implementation",
    "review",
    "verify",
    "merge",
]);

/**
 * Run the resume-stage decision against `typesafe`. Returns a
 * `{ ok, stage, confidence, reason }` envelope that always defaults
 * to `{ ok: false, stage: "triage", confidence: 0, reason: <failure> }`
 * on every error path so the daemon can always `enqueueIssue` —
 * never silently skip the issue on a transient typesafe failure.
 *
 * The function NEVER throws. Mirrors the contract of
 * `src/agents/freshness-routing.ts::parseResumeStageDecision` so the
 * daemon's behavior is identical to the TS module's reference output.
 *
 * Deterministic fallback (`FACTORY_TYPESAFE_OFF=1`, missing API key):
 * the stage is computed locally from the issue's active label so
 * the daemon can still route the issue to the right stage without a
 * network call. `reason: "off-toggle"` is logged verbatim.
 */
async function decideResumeStage({ issue, stateHash, lastJudgmentHash, lastTriageAt, env, agentConfig, fetchImpl, timeoutMs, abortSignal }) {
    const envBag = env ?? process.env;
    const typesafeOff = String(envBag?.FACTORY_TYPESAFE_OFF ?? "").trim() === "1";
    const apiKey = typeof envBag?.TYPESAFE_API_KEY === "string" && envBag.TYPESAFE_API_KEY.trim()
        ? envBag.TYPESAFE_API_KEY.trim()
        : null;

    // Deterministic fallback path: derive the stage locally from the
    // active label. Keeps the daemon working when typesafe is off
    // (the `FACTORY_TYPESAFE_OFF=1` debug knob) or when the operator
    // .env forgot `TYPESAFE_API_KEY`. Stage selection follows
    // `stageForActiveLabel` (no jev cost).
    if (typesafeOff || !apiKey) {
        const stage = stageForActiveLabel(issue?.labels ?? []);
        return { ok: true, stage, confidence: 0, reason: "off-toggle" };
    }

    const config = agentConfig ?? resolveAgentConfig(envBag);
    const request = buildResumeStageRequest({
        model: config?.backends?.typesafe?.model || envBag?.FACTORY_TYPESAFE_MODEL || "jev-fast",
        stateHash,
        lastJudgmentHash,
        lastTriageAt,
        issue,
    });

    let stageRun;
    try {
        stageRun = await runTypesafeStageFromConfig(config, "typesafe", request, {
            env: envBag,
            ...(fetchImpl ? { fetchImpl } : {}),
            ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
            ...(abortSignal ? { abortSignal } : {}),
        });
    } catch (error) {
        // Adapter should already collapse errors to a fallback
        // envelope; this catch is a defensive net for an unexpected
        // throw. Either way we route to triage.
        return {
            ok: false,
            stage: "triage",
            confidence: 0,
            reason: "unreachable",
        };
    }

    if (stageRun?.status !== "succeeded") {
        return { ok: false, stage: "triage", confidence: 0, reason: "unreachable" };
    }
    const primitives = Array.isArray(stageRun?.structuredOutput) ? stageRun.structuredOutput : [];
    if (primitives.length === 0) {
        return { ok: false, stage: "triage", confidence: 0, reason: "parse-miss" };
    }
    const entry = primitives.find((p) => p?.id === "resume_stage");
    if (!entry) {
        return { ok: false, stage: "triage", confidence: 0, reason: "parse-miss" };
    }
    if (typeof entry.value !== "string" || !RESUME_STAGE_VALUES.has(entry.value)) {
        return { ok: false, stage: "triage", confidence: 0, reason: "invalid-stage" };
    }
    const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0;
    return { ok: true, stage: entry.value, confidence, reason: "ok" };
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
 * Judgment backend failures return an unavailable result.
 * State read failures propagate: corruption must not look like a brand-new issue.
 * Polling never modifies a checkpoint, even if a legacy caller passes persist:true.
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

    if (!issue || typeof issue.number !== "number") {
        return { skip: false, reason: "freshness_unavailable", stateHash: "", noul_yes: 0 };
    }

    const checkpoint = Object.hasOwn(options, "checkpoint")
        ? options.checkpoint
        : await readFactoryIssueState(stateDir, issue.number);
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
    // Spec T11.3: the polling-time resume decision still runs so the
    // daemon can re-engage an issue whose labels were reset without
    // any of the 5 hash fields changing (issue #43's `ready-to-spec`
    // reset). The result is attached to the `skip: true` envelope so
    // the daemon can branch on `wait` vs any other stage instead of
    // blanket-skipping. `decideResumeStage` collapses every failure
    // mode to `triage` — never silently skip the issue.
    //
    // Author-voice override (issue #46, 2026-09-24): when the most
    // recent comment is non-factory voice the hash match is misleading
    // — the operator has spoken and the issue must re-triage. Bypass
    // `decideResumeStage` and enqueue. Mirrors
    // `src/orchestrator/index.ts::latestVoiceIsAuthor` at the polling
    // layer. Only the completed worker can mark that reply as consumed.
    if (lastJudgmentHash && lastJudgmentHash === stateHash) {
        if (latestVoiceIsAuthor(issue.comments) && hasAuthorCommentAfter(issue.comments, lastTriageAt)) {
            return {
                skip: false,
                reason: "author_voice_override",
                stateHash,
                noul_yes: 0,
            };
        }
        const resume = await decideResumeStage({
            issue,
            stateHash,
            lastJudgmentHash,
            lastTriageAt,
            env,
            agentConfig: options.agentConfig,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
            abortSignal: options.abortSignal,
        });
        return {
            skip: true,
            reason: "state_unchanged",
            stateHash,
            noul_yes: 0,
            resumeStage: resume.stage,
            confidence: resume.confidence,
            resumeReason: resume.reason,
        };
    }

    // No cached hash on a brand-new issue: do not pay a typesafe
    // call when there is no "last" to compare against. The daemon
    // must run the full triage on first sight, so we return
    // `skip: false` with `noul_yes: 0` and a dedicated reason that
    // is NOT 'state_unchanged' (so the polling loop never logs the
    // skip message and never persists a hash for an issue that
    // never had one).
    if (!lastJudgmentHash) {
        return { skip: false, reason: "no_cached_hash", stateHash, noul_yes: 0 };
    }

    // typesafe short-circuit (FACTORY_TYPESAFE_OFF=1).
    const typesafeOff = String(env?.FACTORY_TYPESAFE_OFF ?? "").trim() === "1";
    if (typesafeOff) {
        return { skip: false, reason: "freshness_unavailable", stateHash, noul_yes: 0 };
    }

    // Missing API key -> fall back. Same shape as a network failure:
    // the existing enqueue path runs unchanged.
    const apiKey = typeof env?.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim()
        ? env.TYPESAFE_API_KEY.trim()
        : null;
    if (!apiKey) {
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
        return { skip: false, reason: "freshness_unavailable", stateHash, noul_yes: 0 };
    }

    const noulYes = noulResult.noul_yes;
    if (noulYes < threshold) {
        // Spec T11.3: even when the freshness `noul` says "no change",
        // the polling-time resume decision still runs. The labels may
        // have been reset between the last triage and now without any
        // of the freshness hash inputs moving.
        const resume = await decideResumeStage({
            issue,
            stateHash,
            lastJudgmentHash,
            lastTriageAt,
            env,
            agentConfig: options.agentConfig,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
            abortSignal: options.abortSignal,
        });
        return {
            skip: true,
            reason: "state_unchanged",
            stateHash,
            noul_yes: noulYes,
            resumeStage: resume.stage,
            confidence: resume.confidence,
            resumeReason: resume.reason,
        };
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
