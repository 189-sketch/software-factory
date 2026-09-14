export const RECEIPT_STATUSES: {
  readonly succeeded: "succeeded";
  readonly failed: "failed";
  readonly unknown: "unknown";
  readonly retryWait: "retry-wait";
  readonly blocked: "blocked";
};

export interface Receipt {
  issueNumber: number;
  operationKind: string;
  status: "succeeded" | "failed" | "unknown" | "retry-wait" | "blocked";
  attempt: number | null;
  owner: string | null;
  expectedSha: string | null;
  observedSha: string | null;
  error: string | null;
  note: string | null;
  recordedAt: string;
}

export function receiptPath(stateDir: string, issueNumber: number, operationKind: string): string;

export function recordReceipt(
  stateDir: string,
  issueNumber: number,
  operationKind: string,
  receipt: Partial<Receipt>,
): Promise<Receipt>;

export function readReceipt(stateDir: string, issueNumber: number, operationKind: string): Promise<Receipt | null>;

export function clearReceipt(stateDir: string, issueNumber: number, operationKind: string): Promise<boolean>;

export function listReceipts(stateDir: string): Promise<Receipt[]>;