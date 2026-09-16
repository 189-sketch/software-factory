/**
 * TypeScript declaration for `runtime/lease-wait-state.mjs`.
 *
 * The runtime ships as `.mjs` and is consumed by `.ts` code through
 * type-only imports; this declaration makes `import { … } from
 * "../../runtime/lease-wait-state.mjs"` type-check without forcing a
 * build-time dependency on the implementation file.
 */
export const LEASE_WAIT_REASONS: {
  readonly busy: "lease-busy";
  readonly network: "lease-network-failed";
  readonly refused: "lease-refused";
};

export interface LeaseWaitRecord {
  issueNumber: number;
  reason: string;
  blockedAt: string;
  holder: string | null;
  staleReclaimEnabled: boolean;
  staleMs: number | null;
  expectedRecoveryAt: string | null;
  note: string | null;
}

export function leaseWaitPath(stateDir: string, issueNumber: number): string;

export function recordLeaseWait(
  stateDir: string,
  issueNumber: number,
  entry: Partial<LeaseWaitRecord> & { reason?: string; blockedAt?: string },
): Promise<LeaseWaitRecord>;

export function clearLeaseWait(stateDir: string, issueNumber: number): Promise<boolean>;

export function readLeaseWait(stateDir: string, issueNumber: number): Promise<LeaseWaitRecord | null>;

export function listLeaseWaits(stateDir: string): Promise<LeaseWaitRecord[]>;

export function computeExpectedRecoveryAt(recordedAt: string, staleMs: number | null | undefined): string | null;
