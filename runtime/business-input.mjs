import { createHash } from "node:crypto";

export const FACTORY_COMMENT_MARKERS = Object.freeze([
  "<!-- pi-software-factory:triage:",
  "<!-- pi-software-factory:spec-review:",
  "<!-- pi-software-factory:pr-review:",
  "<!-- pi-software-factory:operator-wait:",
  "<!-- factory-state:v1:",
  "<!-- factory-state-chunk:v1:",
  "<!-- factory-stage:",
  "<!-- factory-resume:",
  "<!-- factory-ledger:",
]);

export function isFactoryComment(comment) {
  return FACTORY_COMMENT_MARKERS.some((marker) => (comment?.body ?? "").includes(marker));
}

/** Polling freshness is business input, not a timestamp of the factory's own writes. */
export function businessInputHash(issue) {
  const input = {
    number: issue.number,
    title: issue.title ?? "",
    body: issue.body ?? "",
    state: issue.state ?? "open",
    labels: [...new Set((issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name))].sort(),
    comments: (issue.comments ?? []).filter((comment) => !isFactoryComment(comment))
      .map((comment) => ({
        author: comment.author ?? "",
        body: comment.body ?? "",
        createdAt: comment.createdAt ?? "",
      })),
  };
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}
