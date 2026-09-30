import type { FactoryIssueState } from "../src/core/types.js";
export class GitHubStateStore {
  constructor(options: {
    repository: string; token: string; stateDir: string;
    leaseSha?: string; writers?: string[];
  });
  load(number: number): Promise<FactoryIssueState | undefined>;
  save(state: FactoryIssueState): Promise<FactoryIssueState>;
  recover(number: number): Promise<{ recovered: boolean; revision?: number }>;
}
