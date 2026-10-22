import { createHash } from 'node:crypto';
import type { IssueStateStore } from '../core/state.js';
import { FACTORY_LABELS_TO_CLEAR, type FactoryIssueState, type TriageLabel, type SpecReviewResult, type JudgmentFailure } from '../core/types.js';
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
export async function publishSpecReviewDecision(state: FactoryIssueState, review: SpecReviewResult, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
    const issue = state.issue;
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    try {
        const judge = review.typesafeBatch?.b4;
        const findings = review.findings ?? [];
        const decisionBody = [
            `**Spec review: ${review.verdict}**`, '',
            `Reviewer: ${review.reviewerVerdict ?? review.verdict}`,
            judge ? `Jev B4: ${judge.value} (confidence=${judge.confidence.toFixed(2)})` : 'Jev B4: unavailable',
            `Final gate: ${review.verdict}`,
            review.inputRevision ? `Review snapshot: ${review.inputRevision}` : '',
            state.specs?.commitSha ? `Spec commit: ${state.specs.commitSha}` : '',
            `Final findings: ${findings.filter(f => (!f.status || f.status === 'open') && (f.severity === 'blocking' || f.severity === 'important')).length} blocking/important.`,
            '', 'Reviewer report (original):', '', review.body,
            review.notes ? `\n${review.notes}` : '',
        ].filter(line => line !== '').join('\n\n');
        const marker = `<!-- pi-software-factory:spec-review:${issue.number}:${createHash('sha256').update(decisionBody).digest('hex').slice(0, 16)} -->`;
        const outcome = await runExternalOp(state, (current) => store.save(current), {
          kind: 'issue-comment', idempotencyKey: marker, payload: { source: 'spec-review', marker },
        }, async () => {
          const current = await listIssueComments({ token, repository: repo, number: issue.number });
          if (current.some((entry) => entry.body.includes(marker))) return 'dedup';
          const body = `${decisionBody}\n\n${marker}`;
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
export async function publishReviewDecision(state: FactoryIssueState, review: { verdict: string; body: string; judgmentFailure?: JudgmentFailure }, config: FactoryConfig, store: Pick<IssueStateStore, 'save'>) {
    const issue = state.issue;
    if (!config.syncLabels) return;
    const repo = config.github.repository;
    const token = config.github.token;
    if (!repo || !token) return;
    try {
        const decisionBody = [
          review.judgmentFailure ? '**代码审查尚未完成**' : `**PR review: ${review.verdict}**`,
          review.judgmentFailure?.code === 'REVIEW_EVIDENCE_INSUFFICIENT'
            ? '工厂将自动补齐审查材料并重新审查，现有实现已保留，暂时无需你操作。'
            : review.judgmentFailure ? '独立审查判断暂不可用，后续处理状态会单独说明。' : '',
          review.judgmentFailure ? `Reviewer: ${review.verdict}` : '',
          review.body,
        ].filter(Boolean).join('\n\n');
        const marker = `<!-- pi-software-factory:pr-review:${issue.number}:${createHash('sha256').update(decisionBody).digest('hex').slice(0, 16)} -->`;
        const outcome = await runExternalOp(state, (current) => store.save(current), {
          kind: 'issue-comment', idempotencyKey: marker, payload: { source: 'pr-review', marker },
        }, async () => {
          const current = await listIssueComments({ token, repository: repo, number: issue.number });
          if (current.some((entry) => entry.body.includes(marker))) return 'dedup';
          const body = `${decisionBody}\n\n${marker}`;
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
