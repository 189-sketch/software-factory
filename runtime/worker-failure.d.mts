export interface WorkerFailure {
  version: 1;
  owner: 'state-runtime' | 'worker-runtime';
  code: string;
  fingerprint: string;
  operation?: string;
  request?: { resource: string; method: string; phase: string; attempt: number; elapsedMs: number;
    timeoutMs: number; status?: number; page?: number; perPage?: number };
}
export function workerFailure(error: unknown): WorkerFailure;
export function isWorkerFailure(value: unknown): value is WorkerFailure;
