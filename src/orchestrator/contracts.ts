import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentContext } from '../core/types.js';
import type { FactoryConfig } from '../../runtime/factory-config.mjs';

const exec = promisify(execFile);

/**
 * Implementation Acceptance Contract.
 *
 * An implementation run is only valid when ALL of these hold:
 *   1. The worktree is clean (no uncommitted, untracked, or staged
 *      changes). Untracked files like `*.tmp-test/probe.js` previously
 *      slipped past the contract and caused "Target checkout is not
 *      clean" downstream.
 *   2. A branch matching `feature/issue-<n>-*` is checked out.
 *   3. The recorded commitSha exists on origin (the agent actually
 *      pushed, not just committed locally).
 *   4. The branch points at the recorded commitSha (no rebase drift
 *      between local and remote).
 *
 * Failing this gate throws a concrete error that the retry loop can
 * surface to triage-supervisor. The supervisor then knows it is a
 * "implementation did not finalize" symptom, not a "spec content is
 * wrong" symptom, and routes to a retry of the implementation stage
 * rather than escalating to needs-info.
 */
export async function assertImplementationContract(
    implementation: { commitSha?: string; branch?: string } | undefined,
    repo: AgentContext['repo'],
    issueNumber: number,
    _config: FactoryConfig,
): Promise<void> {
    if (!implementation?.commitSha) {
        throw new Error('Implementation did not return a commitSha — agent must commit and push before exiting');
    }
    if (!implementation.branch) {
        throw new Error('Implementation did not return a branch — agent must push to a feature/issue-* branch');
    }
    if (!implementation.branch.startsWith(`feature/issue-${issueNumber}-`)) {
        throw new Error(`Implementation branch "${implementation.branch}" does not match feature/issue-${issueNumber}-* convention`);
    }
    // 1. Worktree is clean.
    const status = (await exec('git', ['status', '--porcelain'], { cwd: repo.workdir })).stdout;
    if (status.trim()) {
        throw new Error(
            `Implementation finished with a dirty working tree. The agent must commit + push its work before returning. ` +
            `Uncommitted files:\n${status.split('\n').slice(0, 10).join('\n')}`,
        );
    }
    // 2. Branch is checked out.
    const current = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.workdir })).stdout.trim();
    if (current !== implementation.branch) {
        throw new Error(`Implementation agent left the worktree on "${current}" but should be on "${implementation.branch}"`);
    }
    // 3. Recorded commitSha exists on origin. We use plain `rev-parse`
    // (not `--verify -- <ref>`) because `--verify -- <remote>/<branch>`
    // is brittle in linked worktrees: when the upstream is set the ref
    // resolves correctly, but in test setups and freshly added worktrees
    // `--verify --` rejects the ref with "Needed a single revision"
    // even though plain `rev-parse` resolves it. Plain `rev-parse` is
    // idempotent for any ref that exists, so this is the safer check.
    try {
        await exec('git', ['rev-parse', `origin/${implementation.branch}`], { cwd: repo.workdir });
    } catch {
        throw new Error(`Implementation branch "${implementation.branch}" was never pushed to origin`);
    }
    // 4. The branch on origin points at the recorded commit.
    const originHead = (await exec('git', ['rev-parse', `origin/${implementation.branch}`], { cwd: repo.workdir })).stdout.trim();
    if (originHead !== implementation.commitSha) {
        throw new Error(
            `Implementation commitSha drift: agent recorded ${implementation.commitSha} but ` +
            `origin/${implementation.branch} points at ${originHead}. The agent must ensure the recorded ` +
            `commitSha is the same one pushed.`,
        );
    }
}

/**
 * Thrown from `runSpecPhase` when the typesafe veto budget
 * (`state.specTypesafeRevisions`) is exhausted — i.e. typesafe has
 * flagged the spec as `needs-revision` twice in a row and a third
 * attempt would be a budget leak. The orchestrator's
 * `handleStageFailure` classifies this as `CONTRACT_VIOLATION` (per
 * its `expected.*found|schema mismatch` regex) and routes via
 * `decideRouting`. The budget cap keeps typesafe vetoes from
 * running away when the spec agent is structurally unable to
 * address the underlying defect (e.g. issue is so underspecified
 * that no PRODUCT.md / TECH.md can satisfy the gates).
 */
export class SpecTypesafeRevisionsExhaustedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpecTypesafeRevisionsExhaustedError';
    }
}

/**
 * Thrown from `runSpecPhase` when the R-series rubric convergence
 * ratchet trips: the same structured judgment point(s) failed
 * `RUBRIC_RATCHET_LIMIT` (default 2) consecutive review rounds despite
 * targeted revision (2026-09-21, issue #39 — the spec agent reproduced
 * the same three IMPORTANT findings verbatim across rounds while the
 * pipeline kept paying for fresh spec→review cycles).
 *
 * The message deliberately contains `needs-info` so `classifyError`
 * lands on `USER_INPUT_REQUIRED` (maxAttempts=0, defaultAction
 * `needs-info`) and `handleStageFailure` takes the deterministic
 * fast path — no supervisor, no third spec cycle. Another automated
 * attempt would repeat the same defect: the failing point is either
 * a product decision only the author can make (R4) or a revision the
 * generator has proven unable to land (R1/R2/R3/R7).
 */
export class SpecRubricRepeatedFailureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpecRubricRepeatedFailureError';
    }
}
