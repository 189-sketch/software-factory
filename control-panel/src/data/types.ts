/**
 * Domain types for the control panel.
 *
 * These mirror src/core/types.ts in the factory, but lean on control-panel
 * vocabulary (active run, recent events, per-agent config). Treat them as the
 * shape that comes off the wire from the orchestrator's event stream and the
 * persisted factory/state/<n>.json files.
 */

export type StageId =
    | "triage"
    | "spec"
    | "implementation"
    | "review"
    | "verify"
    | "merge";

export type StageStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface StageRecord {
    id: StageId;
    status: StageStatus;
    startedAt?: string;
    endedAt?: string;
    durationMs?: number;
    /** Free-form summary from the agent's structured output. */
    summary?: string;
    /** Optional PR / branch URL the stage produced. */
    artifact?: string;
}

export interface ProjectIssue {
    id: string;            // e.g. "pi-sf#142"
    projectId: string;
    number: number;
    title: string;
    author: string;
    openedAt: string;
    labels: string[];
    /** Active stage the issue is parked on right now. */
    currentStage: StageId;
    stages: StageRecord[];
    /** Optional URL to the originating issue on GitHub. */
    url?: string;
    /** Pull request URL produced by implementation, if any. */
    prUrl?: string;
    branch?: string;
    /** Last 1–2 sentences the agent left on the issue. */
    lastComment?: string;
}

export interface Project {
    id: string;
    name: string;
    repo: string;          // "owner/name"
    defaultBranch: string;
    /** Issues merged in the last 7 days, computed from factory/state/. */
    recentThroughput: number;
    /** Review verdicts APPROVE in the last 30 days. */
    approved30d: number;
    /** Review verdicts REJECT in the last 30 days. */
    rejected30d: number;
    /** Average ms from triage start to merge end across merged issues, or null. */
    avgTimeToMergeMs: number | null;
    /** Stage transitions (start) in the last 24h, across all stages. */
    started24h: number;
    /** Stage transitions (end) in the last 24h, across all stages. */
    closed24h: number;
    issues: ProjectIssue[];
}

export type EventLevel = "INFO" | "WARN" | "ERROR";

export interface FactoryEvent {
    id: string;
    ts: string;
    level: EventLevel;
    /** Which project / agent the event belongs to. */
    projectId: string;
    stage: StageId | "system";
    message: string;
    /** Optional structured payload, rendered as a k/v table in the panel. */
    bindings?: Record<string, string | number>;
}

export type AgentMode = "llm";

export interface AgentConfig {
    id: StageId | "improve";
    label: string;
    skillPath: string;
    /** Markdown body of SKILL.md. */
    skillBody: string;
    mode: AgentMode;
    model: string;
    /** Per-agent prompt override. Empty = use skill default. */
    promptOverride: string;
    /** Whether the agent is enabled for this project. */
    enabled: boolean;
    /** Optional sub-skills loaded by this agent (e.g. spec → write-product-spec). */
    subSkills?: string[];
    /** Tags used for filtering in the agent library. */
    tags: string[];
    /** Optional custom tool whitelist. Empty = full default set. */
    tools?: string[];
}

export interface GlobalSettings {
    baseUrl: string;
    defaultModel: string;
    pollIntervalSec: number;
    localDaemon: {
        active: boolean;
        pid: number | null;
        uptimeSec: number;
        workdir: string;
    };
}