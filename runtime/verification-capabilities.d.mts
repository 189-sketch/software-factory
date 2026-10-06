import type { FactoryIssueState } from '../src/core/types.js';
export const BROWSER_ACTIONS: readonly string[];
export const VERIFICATION_CAPABILITY_HASH: string;
export function validateVerificationRecovery(record: FactoryIssueState['verificationRecovery']): void;
export function verificationRecoveryContext(state: FactoryIssueState, inputHash: string, capabilities?: string): string;
export function needsVerificationCapabilityRecovery(state: FactoryIssueState | null | undefined): boolean;
