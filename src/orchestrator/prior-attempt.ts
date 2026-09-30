import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FactoryIssueState, PriorAttempt } from '../core/types.js';

const exec = promisify(execFile);

/**
 * Build the typed `PriorAttempt` artifact from the durable state. Called
 * before each implementation retry so the ImplementationAgent has
 * structured access to what it (or its predecessor) last did.
 *
 * Resolution order:
 *   1. `state.implementation` (preferred — fully populated)
 *   2. fallback: returns a minimal record with only `attemptNumber`
 *
 * The diff is truncated to `PRIOR_DIFF_MAX_BYTES` to keep prompts
 * bounded. The agent is told (in its userPrompt) that the diff may be
 * truncated and that it can fetch the full diff via `git show <sha>`.
 */
export async function buildPriorAttempt(
  state: FactoryIssueState,
  maxAttempts: number,
  cwd: string,
  baseBranch: string,
): Promise<PriorAttempt> {
  const impl = state.implementation;
  if (!impl) {
    return { attemptNumber: (state.attempts ?? 0) + 1, maxAttempts, branch: '', commitSha: '', filesChanged: [], validation: [], diff: '' };
  }
  let diff = '';
  try {
    const out = await exec('git', [
      'diff', '--unified=3',
      `origin/${baseBranch}...${impl.commitSha}`,
    ], { cwd, maxBuffer: 16 * 1024 * 1024 });
    diff = String(out.stdout ?? '');
    if (Buffer.byteLength(diff, 'utf8') > PRIOR_DIFF_MAX_BYTES) {
      const head = diff.slice(0, PRIOR_DIFF_MAX_BYTES);
      diff = `${head}\n\n[... diff truncated at ${PRIOR_DIFF_MAX_BYTES} bytes; fetch the full patch with \`git show ${impl.commitSha}\` or \`git diff origin/${baseBranch}...${impl.commitSha}\` ...]`;
    }
  } catch (error) {
    diff = `Failed to compute prior diff: ${String((error as Error).message ?? error)}`;
  }
  return {
    branch: impl.branch,
    commitSha: impl.commitSha,
    prUrl: impl.prUrl || undefined,
    filesChanged: impl.filesChanged ?? [],
    validation: impl.validation ?? [],
    diff,
    review: state.review,
    behaviorVerification: impl.behaviorVerification,
    attemptNumber: (state.attempts ?? 0) + 1,
    maxAttempts,
  };
}

/**
 * @deprecated Replaced by the unified `agentFailures` counter and the
 * triage supervisor. Retained as a no-op stub for any caller that
 * imported it before the refactor; new code should not reference this
 * symbol.
 */
export function shouldSelfHealImplAttemptLimit(
  state: Pick<FactoryIssueState, 'status' | 'error' | 'attempts'>,
  maxAttempts: number,
): boolean {
  // Triage now judges from `state.error` directly; this predicate is
  // intentionally a no-op so legacy callers do not silently recover
  // failures the supervisor should be deciding.
  void state;
  void maxAttempts;
  return false;
}

/**
 * @deprecated Same as `shouldSelfHealImplAttemptLimit` — the old
 * string-matching self-heal is gone. Triage reads `state.error` and
 * decides what to do.
 */
export function shouldSelfHealStaleParseFailure(
  state: Pick<FactoryIssueState, 'status' | 'error'>,
): boolean {
  void state;
  return false;
}

/**
 * Byte budget for the diff snapshot attached to `PriorAttempt`. We
 * truncate rather than omit because the LLM needs the diff to make a
 * materially different attempt — but unbounded diffs blow the prompt.
 */
const PRIOR_DIFF_MAX_BYTES = 64 * 1024;
