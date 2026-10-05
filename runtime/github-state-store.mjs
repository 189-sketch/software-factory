import * as github from "./github-rest.mjs";
import { encodeState, latestStateRecord, publicSnapshot, STATE_MARKER, STATE_CHUNK_MARKER } from "./state-codec.mjs";
import { issueFile, readOptionalJson, writeDurableJson, removeOptionalFile } from "./durable-json.mjs";
import { ACTIVE_PIPELINE_LABELS } from "./pipeline-definition.mjs";

/** Append-only GitHub recovery records; local files are upload journals, not read authority. */
export class GitHubStateStore {
  constructor({ repository, token, stateDir, leaseSha = "", writers = [], ghClient = github }) {
    if (!repository || !token || !stateDir) throw new Error("GitHub state requires repository, token, and state directory");
    this.repository = repository;
    this.token = token;
    this.stateDir = stateDir;
    this.leaseSha = leaseSha;
    this.writers = [...writers];
    this.gh = ghClient;
    this.saving = false;
  }

  async trustedWriters() {
    if (this.writers.length === 0) {
      const user = await this.gh.fetchAuthenticatedUser({ token: this.token });
      this.writers = [user.login];
    }
    return this.writers;
  }

  options(number) {
    issueFile(this.stateDir, "recover", number); // validate before API/file access
    return { token: this.token, repository: this.repository, number };
  }

  async readRecord(number) {
    const comments = await this.gh.listIssueComments(this.options(number));
    const latest = latestStateRecord(comments, {
      repository: this.repository, issueNumber: number, writers: await this.trustedWriters(),
    });
    return { latest, comments };
  }

  async assertLease(number) {
    if (!this.leaseSha) throw new Error("Factory state write refused: acquire a GitHub issue lease first");
    const current = await this.gh.getRef({
      token: this.token, repository: this.repository, ref: "heads/factory/leases/issue-" + number,
    });
    if (current !== this.leaseSha) throw new Error("Factory state write refused: issue lease was lost");
  }

  /** Read failures propagate; never replace unavailable GitHub state with stale local JSON. */
  async read(number, issueRow) {
    const [{ latest, comments }, row] = await Promise.all([
      this.readRecord(number), issueRow ?? this.gh.fetchIssue(this.options(number)),
    ]);
    const writers = await this.trustedWriters();
    const labels = (row.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
    const active = labels.filter((label) => ACTIVE_PIPELINE_LABELS.includes(label));
    const conflict = active.length > 1;
    const snapshot = latest?.envelope.snapshot ?? { revision: 0, merged: false };
    return {
      ...snapshot,
      nextLabel: conflict ? undefined : active[0],
      ...(conflict ? { status: 'waiting', wait: { reason: 'blocked-operator',
        since: row.updatedAt ?? row.createdAt, note: `需要你的操作：issue #${number} 存在多个流程标签（${active.join('、')}），请只保留一个当前状态标签。` } } : {}),
      issue: {
        ...row,
        author: typeof row.author === "string" ? row.author : row.author?.login ?? "unknown",
        labels,
        workflowConflict: conflict ? active : undefined,
        comments: comments.filter((comment) => !(writers.includes(comment.author)
          && [STATE_MARKER, STATE_CHUNK_MARKER].some(marker => comment.body.includes(marker)))),
      },
    };
  }

  async load(number) {
    const state = await this.read(number);
    return state.revision ? state : undefined;
  }

  /** A failed upload blocks later side effects until its exact parent is reconciled. */
  async save(state) {
    if (this.saving) throw new Error("Concurrent state writes on one store are not allowed");
    this.saving = true;
    try {
      const number = state.issue?.number;
      const file = issueFile(this.stateDir, "recover", number);
      const pending = await readOptionalJson(file);
      if (pending) throw new Error("需要你的操作：恢复记录尚未上传，请运行恢复流程后继续；不能忽略或覆盖 recover 日志。");
      await this.assertLease(number);
      const { latest } = await this.readRecord(number);
      if ((state.revision ?? 0) !== (latest?.envelope.revision ?? 0)) {
        throw new Error("Factory state revision changed; reload GitHub state before writing");
      }
      if (latest && JSON.stringify(publicSnapshot({ ...state, revision: latest.envelope.revision }))
          === JSON.stringify(latest.envelope.snapshot)) return state;
      const revision = (latest?.envelope.revision ?? 0) + 1;
      const snapshot = publicSnapshot({ ...state, revision });
      const record = encodeState({
        version: 1, repository: this.repository, issueNumber: number,
        revision, parentHash: latest?.hash ?? null, snapshot,
      });
      // Persist before POST: a hard kill or lost response cannot lose the prepared record.
      await writeDurableJson(file, record);
      await this.publishPrepared(number, record);
      state.revision = revision;
      await removeOptionalFile(file);
      return state;
    } finally {
      this.saving = false;
    }
  }

  async publishPrepared(number, record) {
    await this.assertLease(number);
    try {
      for (const body of record.chunks ?? []) {
        await this.assertLease(number);
        const { comments } = await this.readRecord(number);
        const writers = await this.trustedWriters();
        const confirmed = rows => rows.some(row => writers.includes(row.author) && row.body === body);
        if (confirmed(comments)) continue;
        try {
          const id = await this.gh.createIssueComment({ ...this.options(number), body, maxRetries: 0 });
          if (!id) throw new Error("GitHub did not confirm the recovery fragment");
        } catch (error) {
          const observed = await this.readRecord(number).catch(() => null);
          if (!observed || !confirmed(observed.comments)) throw error;
        }
      }
      await this.assertLease(number);
      const id = await this.gh.createIssueComment({ ...this.options(number), body: record.body, maxRetries: 0 });
      if (!id) throw new Error("GitHub did not confirm the recovery comment");
    } catch (error) {
      // POST may have succeeded even though its response was lost.
      const observed = await this.readRecord(number).catch(() => null);
      if (observed?.latest?.hash === record.hash) return;
      const blocked = new Error("需要你的操作：GitHub 恢复记录未确认，工厂已停止后续外部操作；恢复网络后运行恢复流程。", { cause: error });
      blocked.code = "FACTORY_STATE_UPLOAD_PENDING";
      throw blocked;
    }
  }

  /** Only an active writer can drain a journal; panel reads never mutate GitHub. */
  async recover(number) {
    if (this.saving) throw new Error("Concurrent state recovery is not allowed");
    this.saving = true;
    try {
      const file = issueFile(this.stateDir, "recover", number);
      const pending = await readOptionalJson(file);
      if (!pending) return { recovered: false };
      const { latest } = await this.readRecord(number);
      // Re-encode and compare to reject truncated/tampered local upload journals.
      const record = encodeState(pending.envelope);
      if (record.hash !== pending.hash || record.body !== pending.body
          || JSON.stringify(record.chunks ?? []) !== JSON.stringify(pending.chunks ?? [])
          || record.envelope.repository !== this.repository || record.envelope.issueNumber !== number) {
        throw new Error("Invalid factory recovery journal");
      }
      if (latest?.hash !== record.hash) {
        if (record.envelope.parentHash !== (latest?.hash ?? null)
            || record.envelope.revision !== (latest?.envelope.revision ?? 0) + 1) {
          throw new Error("需要你的操作：本地恢复日志与 GitHub 新版本冲突，请核对记录；工厂不会覆盖新状态。");
        }
        await this.publishPrepared(number, record);
      }
      await removeOptionalFile(file);
      return { recovered: true, revision: record.envelope.revision };
    } finally {
      this.saving = false;
    }
  }
}
