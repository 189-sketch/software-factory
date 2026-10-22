export function commandTimeoutPolicy(request: { program?: string; args?: string[]; command?: string; timeoutMs?: number }, context?: {
  commandTimeoutMs?: number; validationTimeoutMs?: number; validationCommand?: boolean;
}): { profile: string; timeoutMs: number };
export function commandTimeoutRecoveryStage(state: unknown): string | null;
export function commandRecoveryStage(state: unknown): string | null;
export function commandTimeoutRetryPending(state: unknown, now?: number): boolean;
