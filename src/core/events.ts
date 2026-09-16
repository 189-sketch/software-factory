/**
 * Named AgentEvent subtypes used by the orchestrator's `appendEvent`
 * surface and by the harness's SDK-event narrowings.
 *
 * The factory's cross-stage event log (`state.events[]`) is a tagged
 * union of these kinds; this file is the single place that declares the
 * shape. Lifting the inline `{ lane?: string; … }` annotations from
 * harness.ts (which only existed to silence `strict: true`) into named
 * types gives every consumer one place to discover what the harness
 * payload actually contains.
 */
import type { AgentEvent } from "./types.js";

/** Stage run started. */
export interface StageStartedEvent extends AgentEvent {
  kind?: "stageStarted" | "stage-started";
  status: "started" | "running";
}

/** Stage run completed (succeeded, failed, rejected, aborted). */
export interface StageCompletedEvent extends AgentEvent {
  kind?: "stageCompleted" | "stage-completed";
  status: "completed" | "failed" | "rejected" | "aborted";
  endedAt: string;
}

/**
 * Stage-input-manifest event (M3). Written by the orchestrator before a
 * stage starts so a recovery can rebuild the prompt input.
 */
export interface ManifestEvent extends AgentEvent {
  kind: "stage-input-manifest";
  status: "completed";
  endedAt: string;
  /** Serialized StageInputManifest (the structured payload). */
  manifest: unknown;
}

/**
 * External-operation receipt event (M5). Records that an external
 * operation (comment, label, PR, merge, lease, etc.) was attempted.
 */
export interface ReceiptEvent extends AgentEvent {
  kind: "external-receipt";
  status: "succeeded" | "failed" | "unknown" | "retry-wait" | "blocked";
  endedAt: string;
  operationKind: string;
  operationStatus: string;
}

/** Anything the orchestrator appends must be a typed AgentEvent. */
export type NamedAgentEvent = StageStartedEvent | StageCompletedEvent | ManifestEvent | ReceiptEvent | AgentEvent;

/* -------------------------------------------------------------------------- */
/* SDK event shapes (harness narrowings)                                       */
/* -------------------------------------------------------------------------- */

/** Subset of the pi-agent-core SDK event payload we care about. */
export interface HarnessLaneEvent {
  /** The lane the event originated from. */
  lane?: string;
  /** Entry payload (message_update only). */
  entry?: unknown;
  /** Token usage block (usage only). */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
}