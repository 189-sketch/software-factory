import type { BehaviorVerificationResult } from '../src/core/types.js';
export interface EvidenceOptions {
  workdir: string;
  stateDir?: string;
  repository: string;
  issueNumber: number;
}
export function evidenceDirectory(options: EvidenceOptions & { runId: string }): Promise<string>;
export function relocateLegacyEvidence(options: EvidenceOptions, verifications: BehaviorVerificationResult[]): Promise<{ from: string; to: string; hash: string }[]>;
