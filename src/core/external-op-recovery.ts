import * as github from '../../runtime/github-rest.mjs';
import type { FactoryIssueState } from './types.js';
import { finishExternalOp } from './external-op-ledger.js';
import { matchesObservedMergeCandidate } from '../../runtime/completion-contract.mjs';

/** Observe interrupted writes before any new pipeline side effect. Never infer success from local files. */
export async function recoverExternalOps(
  state: FactoryIssueState,
  options: { repository: string; token: string; writers?: string[] },
  save: (state: FactoryIssueState) => Promise<unknown>,
  api = github,
) {
  const unresolved = (state.externalOps ?? []).filter((op) => ['pending', 'in-flight', 'unknown', 'blocked'].includes(op.status));
  if (!unresolved.length) return;
  const writers = options.writers?.length ? options.writers : [(await api.fetchAuthenticatedUser(options)).login];
  const comments = await api.listIssueComments({ ...options, number: state.issue.number });
  const blocked: string[] = [];
  for (const op of unresolved) {
    // A pending record precedes the durable in-flight record and therefore precedes execution.
    if (op.status === 'pending') {
      finishExternalOp(state, { id: op.id, status: 'failed', error: 'Interrupted before execution' });
      continue;
    }
    if (op.kind === 'issue-comment' && typeof op.payload.marker === 'string') {
      const found = comments.find((comment) => writers.includes(comment.author) && comment.body.includes(op.payload.marker as string));
      finishExternalOp(state, { id: op.id, status: found ? 'succeeded' : 'failed', receipt: found ? { commentId: found.id } : undefined });
      continue;
    }
    if (op.kind === 'label-sync') {
      const observed = state.nextLabel ?? null;
      finishExternalOp(state, { id: op.id, status: observed === op.payload.label ? 'succeeded' : 'failed', error: observed === op.payload.label ? undefined : 'GitHub label superseded this intent' });
      state.labelPending = false;
      continue;
    }
    if (op.kind === 'issue-close') {
      const issue = await api.fetchIssue({ ...options, number: state.issue.number });
      if (!issue.state) throw new Error('GitHub issue state is missing during close recovery');
      finishExternalOp(state, { id: op.id, status: issue.state.toLowerCase() === 'closed' ? 'succeeded' : 'failed', receipt: { state: issue.state } });
      continue;
    }
    if (['spec-push', 'implementation-push'].includes(op.kind) && typeof op.payload.branch === 'string'
      && typeof op.expectedRemote?.commitSha === 'string') {
      const commitSha = await api.getBranchSha({ ...options, branch: op.payload.branch });
      if (commitSha === op.expectedRemote.commitSha) {
        finishExternalOp(state, { id: op.id, status: 'succeeded', receipt: { commitSha } });
        continue;
      }
    }
    if (op.kind === 'pr-create' && typeof op.payload.branch === 'string'
      && typeof op.expectedRemote?.headSha === 'string' && typeof op.expectedRemote.baseBranch === 'string') {
      const matches = (await api.listPullRequests({ ...options, state: 'all',
        head: `${options.repository.split('/')[0]}:${op.payload.branch}`, base: op.expectedRemote.baseBranch }))
        .filter(pr => pr.head?.sha === op.expectedRemote!.headSha && pr.head?.ref === op.payload.branch
          && pr.head?.repo?.full_name === options.repository
          && pr.base?.ref === op.expectedRemote!.baseBranch);
      if (matches.length === 1 && matches[0]!.number && matches[0]!.html_url) {
        finishExternalOp(state, { id: op.id, status: 'succeeded', receipt: { prNumber: matches[0]!.number,
          prUrl: matches[0]!.html_url, headSha: matches[0]!.head!.sha } });
        continue;
      }
    }
    if (op.kind === 'pr-merge' && typeof op.payload.prUrl === 'string') {
      const number = Number(op.payload.prUrl.match(/\/pull\/(\d+)$/)?.[1]);
      if (number) {
        const pr = await api.fetchPullRequest({ ...options, number });
        if (pr.merged && pr.head?.sha === op.payload.expectedHeadSha) {
          const candidate = op.payload.candidate as FactoryIssueState['mergeCandidate'];
          if (candidate) {
            const commit = pr.merge_commit_sha && await api.fetchGitCommit({ ...options, sha: pr.merge_commit_sha });
            if (!commit || commit.sha !== pr.merge_commit_sha || candidate.headSha !== op.payload.expectedHeadSha
              || !matchesObservedMergeCandidate(candidate, commit)) {
              blocked.push(`${op.kind} (${op.id})`);
              continue;
            }
          }
          finishExternalOp(state, { id: op.id, status: 'succeeded', receipt: { mergeSha: pr.merge_commit_sha } });
          // Observing the write is not implementation approval or issue completion.
          continue;
        }
      }
    }
    // Push/create/merge without conclusive evidence must not be silently re-issued.
    blocked.push(`${op.kind} (${op.id})`);
  }
  if (blocked.length) {
    state.status = 'waiting';
    if (state.wait?.reason !== 'external-unknown') state.wait = { reason: 'external-unknown', since: new Date().toISOString(), note: `需要核对远端结果：${blocked.join('、')}` };
  } else if (state.wait?.reason === 'external-unknown') {
    delete state.wait;
  }
  await save(state);
  if (!blocked.length) return;
  const marker = `<!-- pi-software-factory:operator-wait:external-ops:${unresolved.map((op) => op.id).sort().join(',')} -->`;
  const message = `需要你的操作：上次运行中断，以下外部操作结果尚未确认：${blocked.join('、')}。请核对 GitHub 分支或 PR 的实际结果，在已配置仓库和凭据的工厂目录执行 \`node scripts/resolve-external-op.mjs ${state.issue.number} <operation-id> succeeded|failed "核对的远端证据"\`，然后重启该 issue。只有确认未成功时才选择 failed。工厂已停止后续副作用，不会自动重复推送、创建或合并 PR。`;
  if (!comments.some((comment) => writers.includes(comment.author) && comment.body.includes(marker))) {
    await api.createIssueComment({ ...options, number: state.issue.number, body: `${message}\n\n${marker}`, maxRetries: 0 });
  }
  throw Object.assign(new Error(message), { code: 'FACTORY_STATE_EXTERNAL_OP_UNRESOLVED' });
}
