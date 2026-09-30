import type { FactoryIssueState } from "../src/core/types.js";
export class GitHubStateStore {
  leaseSha: string;
  assertLease(number: number): Promise<void>;
  constructor(options: {
    repository: string; token: string; stateDir: string;
    leaseSha?: string; writers?: string[];
  });
  load(number: number): Promise<FactoryIssueState | undefined>;
  read(number: number): Promise<FactoryIssueState>;
  save(state: FactoryIssueState): Promise<FactoryIssueState>;
  recover(number: number): Promise<{ recovered: boolean; revision?: number }>;
}
