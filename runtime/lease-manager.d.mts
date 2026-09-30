export interface IssueLease {
  backend: "github-ref";
  repository: string;
  issueNumber: number;
  owner: string;
  ref: string;
  sha: string;
}
export function createLeaseManager(options: {
  repository: string; token: string; stateDir: string; defaultBranch?: string; staleMs?: number;
}): {
  acquire(number: number, owner: string): Promise<IssueLease | null>;
  release(lease: IssueLease): Promise<void>;
  clear(number: number): Promise<void>;
};
export function isLeaseHolderDeadOnThisHost(owner: string): boolean;
