export type AgentBackend = 'claude-code' | 'codex-cli' | 'pi-cli';
export interface AgentSelection { readonly backend: AgentBackend; readonly model?: string }
export interface AgentConfig {
  readonly defaultBackend: AgentBackend;
  readonly overrides: Readonly<Record<string, AgentSelection>>;
  readonly timeoutMs: number;
  readonly backends: Readonly<Record<AgentBackend, Readonly<{ executable: string; model: string }>>>;
}
export const AGENT_ROLES: readonly string[];
export function resolveAgentConfig(env?: Record<string, string | undefined>): AgentConfig;
export function selectAgentBackend(config: AgentConfig, role: string): AgentSelection & { readonly executable?: string; readonly timeoutMs: number };
export function usesEmbeddedBackend(config: AgentConfig): boolean;
export function agentWorkerEnvironment(env: Record<string, string | undefined>, config: AgentConfig): Record<string, string>;
