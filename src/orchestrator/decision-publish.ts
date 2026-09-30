import { createHash } from 'node:crypto';
import type { IssueStateStore } from '../core/state.js';
import { FACTORY_LABELS_TO_CLEAR, type FactoryIssueState, type TriageLabel } from '../core/types.js';
import type { FactoryConfig } from '../../runtime/factory-config.mjs';
import { runExternalOp } from '../core/external-op-ledger.js';
import { recordReceipt } from '../../runtime/operation-receipts.mjs';
import { createIssueComment, fetchIssue, listIssueComments, setIssueLabels, upsertLabel } from '../../runtime/github-rest.mjs';

export async function syncLabel(state: FactoryIssueState, label: TriageLabel | null, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
  const issue = state.issue;
  if (!config.syncLabels) return;
  const repo = config.github.repository;
  const token = config.github.token;
  if (!repo || !token) return;
  try {
    // Phase B: every gh shell-out here is replaced by undici
    // through `./runtime/github-rest.mjs`. The label diff is
    // computed locally (current labels + add/remove) and sent as a
    // single atomic PUT, which is both fewer round-trips than the
    // legacy gh command and immune to the long-running-state TLS
    // regression the Windows `gh` child suffered.
    await runExternalOp(state, (current) => store.save(current), {
      kind: 'label-sync', idempotencyKey: `${issue.number}@${label ?? 'none'}`, payload: { label },
    }, async () => {
      const issueRow = await fetchIssue({ token, repository: repo, number: issue.number });
      const current: string[] = (issueRow.labels ?? []).map((l: { name: string }) => l.name);
      if (label) {
        await upsertLabel({ token, repository: repo, name: label, color: "5319E7", description: "factory pipeline label" });
      }
      const desired = new Set(current);
      if (label) desired.add(label);
      for (const old of current) {
        if (FACTORY_LABELS_TO_CLEAR.includes(old) && old !== label) desired.delete(old);
      }
      await setIssueLabels({ token, repository: repo, number: issue.number, labels: [...desired] });
    });
    await recordExternalOp(config, issue.number, "label-sync", { status: "succeeded" });
  } catch (error) {
    await recordExternalOp(config, issue.number, "label-sync", {
      status: "failed",
      error: String((error as Error).message ?? error),
    });
    throw error;
  }
}

export async function publishTriageDecision(state: FactoryIssueState, comment: string, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
  const issue = state.issue;
  if (!config.syncLabels) return;
  const repo = config.github.repository;
  const token = config.github.token;
  if (!repo || !token) return;
  try {
    const marker = `<!-- pi-software-factory:triage:${issue.number}:${createHash('sha256').update(comment).digest('hex').slice(0, 16)} -->`;
    // Phase B: list + post are undici calls; no shell-out.
    const outcome = await runExternalOp(state, (current) => store.save(current), {
      kind: 'issue-comment', idempotencyKey: marker, payload: { source: 'triage', marker },
    }, async () => {
      const current = await listIssueComments({ token, repository: repo, number: issue.number });
      if (current.some((entry) => entry.body.includes(marker))) return 'dedup';
      await createIssueComment({ token, repository: repo, number: issue.number, body: `${comment}\n\n${marker}` });
      return 'posted';
    });
    await recordExternalOp(config, issue.number, "issue-comment", { status: "succeeded", note: `triage:${outcome}` });
  } catch (error) {
    await recordExternalOp(config, issue.number, "issue-comment", {
      status: "failed",
      error: String((error as Error).message ?? error),
      note: "triage",
    });
    throw error;
  }
}

/**
 * Post the spec-review verdict to the issue as a comment so the trail
 * is auditable. Mirrors `publishTriageDecision` but uses a different
 * comment tag so the two streams don't collide on re-post detection.
 */
export async function publishSpecReviewDecision(state: FactoryIssueState, review: { verdict: string; body: string; notes?: string }, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
    const issue = state.issue;
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    try {
        const marker = `<!-- pi-software-factory:spec-review:${issue.number}:${createHash('sha256').update(review.body + (review.notes ?? '')).digest('hex').slice(0, 16)} -->`;
        const outcome = await runExternalOp(state, (current) => store.save(current), {
          kind: 'issue-comment', idempotencyKey: marker, payload: { source: 'spec-review', marker },
        }, async () => {
          const current = await listIssueComments({ token, repository: repo, number: issue.number });
          if (current.some((entry) => entry.body.includes(marker))) return 'dedup';
          const body = [
              `**Spec review: ${review.verdict}**`,
              ``,
              review.body,
              review.notes ? `\n${review.notes}` : '',
              ``,
              marker,
          ].join('\n');
          await createIssueComment({ token, repository: repo, number: issue.number, body });
          return 'posted';
        });
        await recordExternalOp(config, issue.number, "issue-comment", { status: "succeeded", note: `spec-review:${outcome}` });
    } catch (error) {
        await recordExternalOp(config, issue.number, "issue-comment", {
          status: "failed",
          error: String((error as Error).message ?? error),
          note: "spec-review",
        });
        throw error;
    }
}

/**
 * Post the implementation-PR review verdict to the issue as a comment
 * so the trail is auditable from the issue (not just the PR review
 * thread). Mirrors `publishSpecReviewDecision` and `publishTriageDecision`
 * but uses a distinct `pr-review` marker namespace so the three streams
 * don't collide on re-post detection. `ReviewResult` does not carry a
 * `notes` field (unlike `SpecReviewResult`), so only verdict + body are
 * posted.
 */
export async function publishReviewDecision(state: FactoryIssueState, review: { verdict: string; body: string }, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
    const issue = state.issue;
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    try {
        const marker = `<!-- pi-software-factory:pr-review:${issue.number}:${createHash('sha256').update(review.body).digest('hex').slice(0, 16)} -->`;
        const outcome = await runExternalOp(state, (current) => store.save(current), {
          kind: 'issue-comment', idempotencyKey: marker, payload: { source: 'pr-review', marker },
        }, async () => {
          const current = await listIssueComments({ token, repository: repo, number: issue.number });
          if (current.some((entry) => entry.body.includes(marker))) return 'dedup';
          const body = [
              `**PR review: ${review.verdict}**`,
              ``,
              review.body,
              ``,
              marker,
          ].join('\n');
          await createIssueComment({ token, repository: repo, number: issue.number, body });
          return 'posted';
        });
        await recordExternalOp(config, issue.number, "issue-comment", { status: "succeeded", note: `pr-review:${outcome}` });
    } catch (error) {
        await recordExternalOp(config, issue.number, "issue-comment", {
          status: "failed",
          error: String((error as Error).message ?? error),
          note: "pr-review",
        });
        throw error;
    }
}

/**
 * Persist a receipt for an external operation (plan §3.8). The
 * operation kind + receipt shape are validated by
 * `runtime/operation-receipts.mjs`. Falls back to stderr when the
 * receipt write itself fails so a flaky disk never blocks a successful
 * GitHub operation from being reported.
 */
export async function recordExternalOp(
  config: FactoryConfig,
  issueNumber: number,
  operationKind: string,
  receipt: { status: "succeeded" | "failed" | "unknown" | "retry-wait" | "blocked"; owner?: string | null; attempt?: number | null; error?: string | null; note?: string | null; observedSha?: string | null; expectedSha?: string | null },
): Promise<void> {
  const stateDir = config.paths?.stateDir;
  // Intent/outcome live in the leased recovery record; only unknown local outcomes are an exception.
  if (receipt.status !== 'unknown') return;
  if (!stateDir) return;
  try {
    await recordReceipt(stateDir, issueNumber, operationKind, {
      status: receipt.status,
      owner: receipt.owner ?? null,
      attempt: receipt.attempt ?? 1,
      error: receipt.error ?? null,
      note: receipt.note ?? null,
      observedSha: receipt.observedSha ?? null,
      expectedSha: receipt.expectedSha ?? null,
    });
  } catch (err) {
    // The receipt itself is best-effort: an orchestrator that cannot
    // reach GitHub but also cannot write a local file is in trouble
    // either way, and the stderr line at least leaves a forensic trace.
    process.stderr.write(
      `[factory] failed to write ${operationKind} receipt for issue ${issueNumber}: ${String((err as Error).message ?? err)}\n`,
    );
  }
}
