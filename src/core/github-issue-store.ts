import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { SessionStore } from './session-store.js';
import type { FactoryIssueState, Issue, BehaviorVerificationResult } from './types.js';
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
    return this.stateOperation('read', async () => {
      const state = await this.remote.load(number);
      if (!state) return undefined;
      state.providerSessions = await this.sessions.load(number);
      return state;
    });
  }

  async save(state: FactoryIssueState): Promise<FactoryIssueState> {
    return this.stateOperation('save', async () => {
      await this.sessions.save(state.issue.number, state.providerSessions ?? {});
      if (state.issue.number === 0) return state; // Repository maintenance has no business issue checkpoint.
      return await this.remote.save(state);
    });
  }

  private async stateOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code.startsWith('FACTORY_STATE_')) throw error;
      // DOMException.code is read-only; never mutate the original failure.
      // All persistence failures must bypass business-agent retry accounting.
      throw Object.assign(new Error(`Factory state ${operation} failed`, { cause: error }),
        { code: 'FACTORY_STATE_UNAVAILABLE', stateOperation: operation });
    }
  }

  recover(number: number) {
    return this.stateOperation('recover', () => this.remote.recover(number));
  }

  async priorVerifications(number: number) {
    return (await this.stateOperation('history', () => this.remote.history(number))).map(record => record.envelope.snapshot.implementation?.behaviorVerification)
      .filter((verification): verification is BehaviorVerificationResult => verification !== undefined);
  }

  async withLease<T>(number: number, run: (state: FactoryIssueState) => Promise<T>, maintenanceIssue?: Issue,
    reconcileClosed?: (state: FactoryIssueState) => Promise<T>): Promise<T> {
    if (this.running) throw new Error('Concurrent pipelines require separate orchestrator instances');
    this.running = true;
    const manager = createLeaseManager(this.options);
    let owned;
    try {
      if (!this.options.leaseSha) {
        owned = await this.stateOperation('lease-acquire', () => manager.acquire(number, `${os.hostname()}:${process.pid}`));
        if (!owned) throw new Error('需要你的操作：issue 已有运行中的 GitHub 租约，请等待持有者结束或确认其已停止。');
        this.remote.leaseSha = owned.sha;
      }
      await this.stateOperation('lease-read', () => this.remote.assertLease(number));
      if (number !== 0) await this.recover(number);
      const state: FactoryIssueState = number === 0 && maintenanceIssue
        ? { issue: maintenanceIssue, merged: false }
        : await this.stateOperation('read', () => this.remote.read(number));
      state.providerSessions = await this.stateOperation('sessions-read', () => this.sessions.load(number));
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
      if (number !== 0) await this.stateOperation('external-recovery', () => recoverExternalOps(state, this.options, (current) => this.save(current)));
      if (state.issue.state === 'closed') {
        if (reconcileClosed) return await reconcileClosed(state);
        throw new Error('Closed GitHub issues cannot start a pipeline');
      }
      return await run(state);
    } finally {
      try {
        if (owned) await this.stateOperation('lease-release', () => manager.release(owned!));
      } finally {
        if (owned) this.remote.leaseSha = '';
        this.running = false;
      }
    }
  }
}
