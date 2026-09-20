import { formatUtc8Timestamp } from "../../runtime/time.mjs";
import type { AgentLogger } from "./types.js";

/**
 * Lightweight structured logger. Each agent gets a child logger with its name
 * attached so log lines across the factory can be filtered by stage.
 */
export class ConsoleLogger implements AgentLogger {
  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  child(bindings: Record<string, unknown>): AgentLogger {
    return new ConsoleLogger({ ...this.bindings, ...bindings });
  }

  private emit(level: string, msg: string, rest: unknown[]): void {
    const ts = formatUtc8Timestamp();
    const bindings = Object.keys(this.bindings).length
      ? " " + JSON.stringify(this.bindings)
      : "";
    const tail = rest.length ? " " + rest.map(serialize).join(" ") : "";
    // eslint-disable-next-line no-console
    console.error(`${ts} ${level}${bindings} ${msg}${tail}`);
  }

  info(msg: string, ...rest: unknown[]): void {
    this.emit("INFO", msg, rest);
  }
  warn(msg: string, ...rest: unknown[]): void {
    this.emit("WARN", msg, rest);
  }
  error(msg: string, ...rest: unknown[]): void {
    this.emit("ERROR", msg, rest);
  }
}

function serialize(v: unknown): string {
  if (v instanceof Error) {
    return v.stack ?? v.message;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// `formatUtc8Timestamp` re-exported from runtime/time.mjs for
// backwards compatibility with callers that imported it from this
// module before the helper was extracted.
export { formatUtc8Timestamp };
