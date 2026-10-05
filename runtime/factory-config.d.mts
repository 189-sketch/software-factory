import type { AgentConfig } from './agent-backends.mjs';
export type ExecutionAdapter = "local" | "docker" | "vm";

export interface FactoryConfig {
  readonly agents: AgentConfig;
  readonly autoMerge: boolean;
  readonly syncLabels: boolean;
  readonly syncProjects: boolean;
  readonly state: Readonly<{ backend: "github" | "fixture"; leaseSha: string; writers: string[] }>;
  readonly github: Readonly<{
    repository: string;
    token: string;
    defaultBranch: string;
    remotePath: string;
  }>;
  readonly model: Readonly<{
    adapter: string;
    apiKey: string;
    baseUrl: string;
    id: string;
    contextWindow: number;
    requestTimeoutMs?: number;
    maxRetries?: number;
    maxTokens: number;
  }>;
  readonly daemon: Readonly<{
    pollIntervalSec: number;
    webhookPort: number;
    webhookSecret: string;
    runTimeoutMs: number;
  }>;
  readonly limits: Readonly<{
    agentFailures: number;
    implementationAttempts: number;
    commandTimeoutMs?: number;
  }>;
  readonly lease: Readonly<{ staleMs: number }>;
  readonly execution: Readonly<{
    adapter: ExecutionAdapter;
    trusted: boolean;
    dockerImage: string;
    vmCommand: string;
  }>;
  readonly paths: Readonly<{ stateDir: string; workdir: string; localDir: string; reviewDir: string }>;
  readonly verify: Readonly<{ command: string; url: string }>;
}

export function resolveFactoryConfig(input?: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  cli?: Record<string, unknown>;
}): FactoryConfig;
