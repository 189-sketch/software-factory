import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { publicSnapshot } from "./state-codec.mjs";
import { GitHubStateStore } from "./github-state-store.mjs";
import * as github from "./github-rest.mjs";

/** Explicit read-only inspection. No lease, POST, file rewrite, or fallback to local state. */
export async function inspectLegacyCheckpoint({ file, repository, token, stateDir, number, writers = [], ghClient = github }) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Migration requires a positive issue number");
  const bytes = await readFile(file);
  const legacy = JSON.parse(bytes.toString("utf8"));
  if (legacy.issue?.number !== number) throw new Error("Legacy checkpoint issue mismatch");
  if (typeof legacy.merged !== "boolean") throw new Error("Legacy checkpoint is missing merged status");
  const remote = new GitHubStateStore({ repository, token, stateDir, writers, ghClient });
  const [{ latest }, issue] = await Promise.all([
    remote.readRecord(number), ghClient.fetchIssue({ repository, token, number }),
  ]);
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  const conflicts = [];
  if (latest) conflicts.push("GitHub 已有可信恢复记录，本地 checkpoint 不可覆盖。");
  if (legacy.nextLabel && !labels.includes(legacy.nextLabel)) {
    conflicts.push("本地 nextLabel 与 GitHub 标签不一致，请先核对实际流程位置。");
  }
  if (legacy.labelPending) conflicts.push("本地标签操作尚未确认，不能把本地意图视为 GitHub 事实。");
  if ((legacy.externalOps ?? []).some((op) => ["pending", "in-flight", "unknown"].includes(op.status))) {
    conflicts.push("本地存在未确认的外部操作，请先核对 GitHub 实际结果。");
  }
  if (issue.state === "closed" && !legacy.merged) {
    conflicts.push("GitHub issue 已关闭但本地尚未完成，不能自动恢复执行。");
  }
  if (legacy.merged && issue.state === "open") {
    conflicts.push("本地声明已合并但 GitHub issue 仍开放，请核对关联 PR。");
  }
  const candidate = conflicts.length ? undefined : publicSnapshot({
    ...legacy, revision: 1, issue: { number },
  });
  return {
    repository, issueNumber: number,
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
    authority: "github",
    github: { state: issue.state, labels, revision: latest?.envelope.revision ?? 0, hash: latest?.hash ?? null },
    eligible: conflicts.length === 0,
    conflicts,
    candidate,
    requiredAction: conflicts.length
      ? "需要你的操作：核对上述冲突；保留原 checkpoint，不自动覆盖 GitHub。"
      : "仅完成只读预检；切换时须持有 GitHub 租约、重新预检后显式上传，当前没有写入。",
  };
}
