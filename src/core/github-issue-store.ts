import { GitHubStateStore } from '../../runtime/github-state-store.mjs';
import { SessionStore } from './session-store.js';
import type { FactoryIssueState } from './types.js';

/** Separate the private session ledger from the public GitHub recovery state. */
export class GitHubIssueStore {
  private readonly sessions: SessionStore;
  private readonly remote: GitHubStateStore;

  constructor(options: {
    repository: string;
    token: string;
    stateDir: string;
    leaseSha?: string;
    writers?: string[];
  }) {
    this.remote = new GitHubStateStore(options);
    this.sessions = new SessionStore(options.stateDir);
  }

  async load(number: number): Promise<FactoryIssueState | undefined> {
    const state = await this.remote.load(number);
    if (!state) return undefined;
    state.providerSessions = await this.sessions.load(number);
    return state;
  }

  async save(state: FactoryIssueState): Promise<FactoryIssueState> {
    await this.sessions.save(state.issue.number, state.providerSessions ?? {});
    return this.remote.save(state);
  }

  recover(number: number) {
    return this.remote.recover(number);
  }
}
