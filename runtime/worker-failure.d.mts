export interface WorkerFailure {
  version: 1;
  owner: 'state-runtime' | 'worker-runtime';
  code: string;
  fingerprint: string;
}
export function workerFailure(error: unknown): WorkerFailure;
export function isWorkerFailure(value: unknown): value is WorkerFailure;
