import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { SessionStore } from './session-store.js';
import type { FactoryIssueState, Issue } from './types.js';
import os from 'node:os';
import { createLeaseManager } from '../../runtime/lease-manager.mjs';
import { recoverExternalOps } from './external-op-recovery.js';
import { createIssueComment, fetchAuthenticatedUser } from '../../runtime/github-rest.mjs';
import { businessInputHash } from '../../runtime/business-input.mjs';

/** Separate the private session ledger from the public GitHub recovery state. */
export class GitHubIssueStore {
  private readonly sessions: SessionStore;
  private readonly remote: GitHubStateStore;
  private readonly options;
  private running = false;

  constructor(options: {
    repository: string;
    token: string;
    stateDir: string;
    leaseSha?: string;
    writers?: string[];
    defaultBranch?: string;
    staleMs?: number;
  }) {
    this.remote = new GitHubStateStore(options);
    this.options = options;
    this.sessions = new SessionStore(options.stateDir);
  }

  async load(number: number): Promise<FactoryIssueState | undefined> {
    const state = await this.remote.load(number);
    if (!state) return undefined;
    state.providerSessions = await this.sessions.load(number);
    return state;
  }

  async save(state: FactoryIssueState): Promise<FactoryIssueState> {
    try {
      await this.sessions.save(state.issue.number, state.providerSessions ?? {});
      if (state.issue.number === 0) return state; // Repository maintenance has no business issue checkpoint.
      return await this.remote.save(state);
    } catch (error) {
      Object.assign(error as Error, { code: (error as { code?: string }).code ?? 'FACTORY_STATE_UNAVAILABLE' });
      throw error;
    }
  }

  recover(number: number) {
    return this.remote.recover(number);
  }

  async withLease<T>(number: number, run: (state: FactoryIssueState) => Promise<T>, maintenanceIssue?: Issue): Promise<T> {
    if (this.running) throw new Error('Concurrent pipelines require separate orchestrator instances');
    this.running = true;
    const manager = createLeaseManager(this.options);
    let owned;
    try {
      if (!this.options.leaseSha) {
        owned = await manager.acquire(number, `${os.hostname()}:${process.pid}`);
        if (!owned) throw new Error('需要你的操作：issue 已有运行中的 GitHub 租约，请等待持有者结束或确认其已停止。');
        this.remote.leaseSha = owned.sha;
      }
      await this.remote.assertLease(number);
      if (number !== 0) await this.remote.recover(number);
      const state: FactoryIssueState = number === 0 && maintenanceIssue
        ? { issue: maintenanceIssue, merged: false }
        : await this.remote.read(number);
      state.providerSessions = await this.sessions.load(number);
      if (state.issue.workflowConflict && state.issue.state !== 'closed') {
        const marker = `<!-- pi-software-factory:operator-wait:label-conflict:${number}:${state.issue.workflowConflict.slice().sort().join(',')} -->`;
        const writers = this.options.writers?.length ? this.options.writers : [(await fetchAuthenticatedUser(this.options)).login];
        state.lastJudgmentHash = businessInputHash(state.issue);
        await this.save(state);
        if (!state.issue.comments.some((comment) => writers.includes(comment.author) && comment.body.includes(marker))) {
          await createIssueComment({ ...this.options, number, body: `${state.wait?.note}\n\n${marker}`, maxRetries: 0 });
        }
        throw Object.assign(new Error(state.wait?.note), { code: 'FACTORY_STATE_LABEL_CONFLICT' });
      }
      if (number !== 0) await recoverExternalOps(state, this.options, (current) => this.save(current));
      if (state.issue.state === 'closed') throw new Error('Closed GitHub issues cannot start a pipeline');
      return await run(state);
    } finally {
      try {
        if (owned) await manager.release(owned);
      } finally {
        if (owned) this.remote.leaseSha = '';
        this.running = false;
      }
    }
  }
}
