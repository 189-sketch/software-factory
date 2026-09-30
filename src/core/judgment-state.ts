/**
 * Spec `2026-09-20-decision-architecture` / Phase B / T8.2.
 *
 * `JudgmentState` is the canonical state object every primitive question
 * (Choice / Score / Noul / extraction) consumes when the orchestrator fans
 * out to the `typesafe` backend (Phase B). Sharing a single state across
 * many primitives in one batch call is the whole point: there is no
 * per-agent state duplication, so multiple primitives stay in lock-step
 * with the same `issue.updatedAt` / `comments.length` / `lastReceiptSha`.
 *
 * The shape is reproduced verbatim from
 * `specs/2026-09-20-decision-architecture/requirements.md` §"State Shape
 * Contract"; renaming a field here without updating the spec is a
 * cross-spec drift that `validation.md` L7 will catch.
 *
 * `stateHashFor` implements the freshness SHA-256 defined in §"Freshness
 * Protocol". The hash is small (one sha-256 over a fixed-shape string),
 * stable across processes, and changes when any input field changes --
 * which is what the polling `Noul` (E1 / A1) depends on.
 *
 * Scope (additive helper only):
 * - This module is purely additive. No existing caller is modified.
 * - The opaque `ReceiptRegistry` stub keeps the dependency direction
 *   clean: `src/core/` does not import from `src/agents/`.
 * - Later tasks (T9.x) wire `buildJudgmentState` into the agent calls;
 *   T8.2 only defines the helper.
 */
import { createHash } from "node:crypto";
import type { Issue } from "./types.js";
import { isFactoryComment } from "./factory-comments.js";

/**
 * Canonical judgment state per requirements.md §"State Shape Contract".
 *
 * Rules from the contract:
 * - State is **read-only** for the primitive call; mutations happen in
 *   code after the call returns.
 * - Optional fields are populated lazily by `buildJudgmentState`; the
 *   contract does not require all fields for every primitive question.
 * - The same `JudgmentState` instance can be reused across many
 *   primitives in one batch call.
 */
export interface JudgmentState {
  // Source: GitHub
  issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    /** ISO-8601; falls back to `issue.createdAt` when caller omits an explicit value. */
    updatedAt: string;
    comments: ReadonlyArray<{
      author: string;
      body: string;
      createdAt: string;
      isFactoryComment: boolean;
    }>;
  };
  // Source: factory runtime
  factory: {
    lastTriageAt?: string;
    /** Hash of `(issue.updatedAt, comments.length, lastReceiptSha)`; see `stateHashFor`. */
    lastJudgmentHash?: string;
    /** Two-level counter: `[stage][class] -> count`. Caller-supplied (see `JudgmentFactoryContext`). */
    failureCounts: Record<string, Record<string, number>>;
    /** Ground-truth receipts from the most recent verify-behavior run. */
    lastReceiptRegistry?: ReceiptRegistry;
    /** Ordered history of every decision the factory has recorded for this issue. */
    priorDecisions: ReadonlyArray<DecisionRecord>;
  };
  // Source: repo
  repoSignals: {
    primaryLanguage: string;
    hasOpenSpec: boolean;
    hasOpenPRs: number;
  };
  // Source: optional, lazy-loaded
  roadmap?: { missionText?: string; relevantSectionText?: string };
  /** PR diff (lazy-loaded by review-pr primitives). */
  prDiff?: string;
  /** Spec body (lazy-loaded by spec / review-spec primitives). */
  specBody?: string;
  /** Implementation diff (lazy-loaded by review-pr primitives). */
  implementationDiff?: string;
  /**
   * The reviewer's structured findings (lazy-loaded by review-pr
   * primitives). The B7 verdict / B8 per-finding severity questions
   * judge the review the claude-code generator ALREADY produced —
   * Jev never invents findings, so the generated findings must
   * travel on the state (2026-09-22 generate-then-judge fix).
   */
  reviewFindings?: ReadonlyArray<{ id: string; severity: string; summary: string }>;
  /**
   * The executing agent's structured checks (lazy-loaded by
   * verify-behavior primitives). The B9 verdict / B11 per-check
   * questions judge the verification the claude-code generator
   * ALREADY produced — same generate-then-judge principle as
   * `reviewFindings`.
   */
  verificationChecks?: ReadonlyArray<{ criterion: string; passed: boolean; receiptIds: ReadonlyArray<string> }>;
}

/**
 * Opaque handle to the verify-behavior receipt registry.
 *
 * The concrete receipt registry is defined in
 * `src/agents/verify-behavior.ts`, which is a downstream consumer of
 * `src/core/`. Importing that concrete type from `src/core/` would
 * invert the dependency direction, so the stub here keeps the
 * judgment-state surface opaque: any structurally-compatible object
 * is assignable, and the freshness hash treats it as opaque bytes
 * (`JSON.stringify` -> sha256).
 *
 * When `verify-behavior.ts` later gains a type-export entry point
 * (Phase B / C work), this stub is the seam where the concrete type
 * can be substituted without changing `JudgmentState`.
 */
export interface ReceiptRegistry {
  readonly [key: string]: unknown;
}

/**
 * One prior judgment decision recorded by the factory.
 *
 * - `action` is the action key from `decisions.yaml`
 *   (`triage.apply_label`, `review-pr.merge_pr`, ...).
 * - `outcome` is the resulting route (`auto`, `confirm`, `escalate`) or
 *   the primitive answer, depending on the action's vocabulary.
 * - `ts` is the ISO-8601 timestamp at which the decision was recorded,
 *   used by the freshness hash ordering.
 */
export interface DecisionRecord {
  action: string;
  outcome: string;
  ts: string;
}

/**
 * Factory-side inputs to `JudgmentState.factory`. Sourced from the
 * orchestrator's checkpoint (`FactoryIssueState`) plus caller-supplied
 * overrides. Provided additively so callers do not have to materialise
 * every field; `buildJudgmentState` substitutes empty defaults for any
 * omitted field that the contract marks as required.
 */
export interface JudgmentFactoryContext {
  lastTriageAt?: string;
  lastJudgmentHash?: string;
  failureCounts: Record<string, Record<string, number>>;
  lastReceiptRegistry?: ReceiptRegistry;
  priorDecisions?: ReadonlyArray<DecisionRecord>;
}

/**
 * Repo-derived signals used by every primitive that reasons about the
 * repository state (e.g. priority scoring, spec vs implementation path).
 * Computed by the caller before invoking `buildJudgmentState`; the
 * helper does not reach out to git / GitHub.
 */
export interface JudgmentRepoSignals {
  primaryLanguage: string;
  hasOpenSpec: boolean;
  hasOpenPRs: number;
}

/**
 * Optional roadmap excerpt (mission text + relevant section). The
 * factory's roadmap is loaded lazily by later tasks; for this additive
 * helper callers pass whatever they have already materialised.
 */
export interface JudgmentRoadmapSection {
  missionText?: string;
  relevantSectionText?: string;
}

/**
 * Extended issue input that lets the caller pass an explicit
 * `updatedAt`. The legacy `Issue` shape in `core/types.ts` does not
 * carry `updatedAt`; `buildJudgmentState` falls back to
 * `issue.createdAt` when neither `opts.issueUpdatedAt` nor the
 * extended field is supplied.
 */
export interface JudgmentIssueInput extends Issue {
  updatedAt?: string;
}

/**
 * Options bag for `buildJudgmentState`. Every optional field on
 * `JudgmentState` is sourced from here so the helper remains a pure
 * function of `(issue, ctx, opts)` with no I/O side effects.
 */
export interface BuildJudgmentStateOptions {
  /** Override for `issue.updatedAt`. Defaults to `issue.updatedAt ?? issue.createdAt`. */
  issueUpdatedAt?: string;
  /** Factory runtime context. Equivalent to passing the same bag via `ctx.factory`. */
  factory?: JudgmentFactoryContext;
  /** Repo signals. Defaults to a safe placeholder when omitted. */
  repoSignals?: JudgmentRepoSignals;
  /** Optional roadmap excerpt. */
  roadmap?: JudgmentRoadmapSection;
  /** Optional PR diff (review-pr primitives). */
  prDiff?: string;
  /** Optional spec body (spec / review-spec primitives). */
  specBody?: string;
  /** Optional implementation diff (review-pr primitives). */
  implementationDiff?: string;
  /** Optional reviewer findings slice (review-pr B7/B8 primitives). */
  reviewFindings?: ReadonlyArray<{ id: string; severity: string; summary: string }>;
  /** Optional verifier checks slice (verify-behavior B9/B11 primitives). */
  verificationChecks?: ReadonlyArray<{ criterion: string; passed: boolean; receiptIds: ReadonlyArray<string> }>;
  /**
   * Override the default factory-comment detector. Defaults to
   * `isFactoryComment` from `core/factory-comments.ts` so the judgment
   * state stays consistent with how agents already classify comments.
   */
  isFactoryComment?: (comment: { body?: string }) => boolean;
}

/**
 * Lazily assemble a `JudgmentState` from the existing `Issue`, an
 * optional factory context, and an options bag of lazy-loaded fields.
 *
 * Behaviour:
 * - `issue.comments` are mapped into the judgment-state comment shape;
 *   `isFactoryComment` defaults to the shared classifier from
 *   `core/factory-comments.ts` so factory / author voices stay
 *   distinguished exactly as the agent runtime already does.
 * - `issue.labels` is forwarded as-is; `TriageLabel[]` is assignable to
 *   `string[]` without a cast because every pipeline label is a string.
 * - `updatedAt` falls back through `opts.issueUpdatedAt`,
 *   `issue.updatedAt`, and `issue.createdAt` in that order so the
 *   resulting state is always well-defined even when the caller did
 *   not pass an explicit timestamp.
 * - `factory.failureCounts` defaults to `{}`; `factory.priorDecisions`
 *   defaults to `[]`. The other optional factory fields are populated
 *   only when the caller supplies them, matching the contract's
 *   "absence encoded as undefined" rule.
 * - Optional top-level fields (`roadmap`, `prDiff`, `specBody`,
 *   `implementationDiff`) are populated only when the caller supplies
 *   them; otherwise they remain `undefined` so a primitive question
 *   can detect "not loaded" without sentinel checks.
 */
export function buildJudgmentState(
  issue: JudgmentIssueInput,
  ctx: { factory?: JudgmentFactoryContext } | undefined = undefined,
  opts: BuildJudgmentStateOptions = {},
): JudgmentState {
  const detector = opts.isFactoryComment ?? isFactoryComment;
  const factory: JudgmentFactoryContext = ctx?.factory ?? opts.factory ?? { failureCounts: {} };

  const comments = issue.comments.map((c) => ({
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    isFactoryComment: detector({ body: c.body }),
  }));

  const updatedAt = opts.issueUpdatedAt ?? issue.updatedAt ?? issue.createdAt;

  const factoryState: JudgmentState["factory"] = {
    failureCounts: factory.failureCounts ?? {},
    priorDecisions: factory.priorDecisions ?? [],
  };
  if (factory.lastTriageAt !== undefined) factoryState.lastTriageAt = factory.lastTriageAt;
  if (factory.lastJudgmentHash !== undefined) factoryState.lastJudgmentHash = factory.lastJudgmentHash;
  if (factory.lastReceiptRegistry !== undefined) factoryState.lastReceiptRegistry = factory.lastReceiptRegistry;

  const state: JudgmentState = {
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      updatedAt,
      comments,
    },
    factory: factoryState,
    repoSignals: opts.repoSignals ?? { primaryLanguage: "unknown", hasOpenSpec: false, hasOpenPRs: 0 },
  };

  if (opts.roadmap) state.roadmap = { ...opts.roadmap };
  if (opts.prDiff !== undefined) state.prDiff = opts.prDiff;
  if (opts.specBody !== undefined) state.specBody = opts.specBody;
  if (opts.implementationDiff !== undefined) state.implementationDiff = opts.implementationDiff;
  if (opts.reviewFindings !== undefined) state.reviewFindings = opts.reviewFindings;
  if (opts.verificationChecks !== undefined) state.verificationChecks = opts.verificationChecks;

  return state;
}

/**
 * Compute the freshness state hash for `state` per requirements.md
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
 * `lastReceiptSha` is the SHA-256 of `JSON.stringify(lastReceiptRegistry)`
 * when the registry is present, or `''` when it is absent. Each segment
 * is stringified verbatim; absent factory fields are encoded as `''`,
 * matching the formula above.
 *
 * Properties the polling `Noul` (E1) relies on:
 * - Deterministic: the same `JudgmentState` always produces the same
 *   64-char hex digest.
 * - Sensitive: changing any input field (an extra comment, a new label,
 *   a different `updatedAt`, a different `lastReceiptRegistry`) changes
 *   the digest.
 * - Bounded cost: one `JSON.stringify` on the registry (when present)
 *   plus one sha256 over a small string. Cheap enough to recompute on
 *   every daemon poll.
 */
export function stateHashFor(state: JudgmentState): string {
  const lastReceiptSha = state.factory.lastReceiptRegistry
    ? sha256Hex(JSON.stringify(state.factory.lastReceiptRegistry))
    : "";
  const parts = [
    state.issue.updatedAt,
    String(state.issue.comments.length),
    lastReceiptSha,
    state.factory.lastTriageAt ?? "",
    state.issue.labels.join(","),
  ];
  return sha256Hex(parts.join("|"));
}

/** Stable sha-256 of an in-memory string; mirrors `core/artifact-hash.ts`. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
