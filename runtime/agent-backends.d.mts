export type AgentBackend = 'claude-code' | 'codex-cli' | 'pi-cli' | 'typesafe';
export interface AgentSelection { readonly backend: AgentBackend; readonly model?: string }
/**
 * Content-stream mode for the agent transcript.
 *   - `off`  — no transcript; the CLI stream is parsed and discarded.
 *   - `on`   — model text, tool calls, tool results, system events.
 *   - `full` — `on` plus model thinking blocks and partial deltas.
 */
export type AgentStreamMode = 'off' | 'on' | 'full';
export interface AgentStreamConfig {
  readonly mode: AgentStreamMode;
  /** Transcript directory; empty means "derive from the runtime state directory". */
  readonly dir: string;
  /** Maximum bytes written to one transcript file. */
  readonly maxBytes: number;
}
export interface AgentConfig {
  readonly defaultBackend: AgentBackend;
  readonly overrides: Readonly<Record<string, AgentSelection>>;
  readonly timeoutMs: number;
  readonly backends: Readonly<Record<AgentBackend, Readonly<{ executable: string; model: string }>>>;
  readonly stream: AgentStreamConfig;
}
export const AGENT_ROLES: readonly string[];
export function resolveAgentConfig(env?: Record<string, string | undefined>): AgentConfig;
export function selectAgentBackend(config: AgentConfig, role: string): AgentSelection & { readonly executable?: string; readonly timeoutMs: number };
export function usesEmbeddedBackend(config: AgentConfig): boolean;
export function agentWorkerEnvironment(env: Record<string, string | undefined>, config: AgentConfig): Record<string, string>;
export function claudeCodeCredentialSource(env?: Record<string, string | undefined>): 'environment' | 'cli-login';
