import * as github from "./github-rest.mjs";
import { encodeState, decodeStateComment, latestStateRecord, stateRecordHistory, publicSnapshot, STATE_MARKER, STATE_CHUNK_MARKER } from "./state-codec.mjs";
import { issueFile, readOptionalJson, writeDurableJson, removeOptionalFile } from "./durable-json.mjs";
import { ACTIVE_PIPELINE_LABELS } from "./pipeline-definition.mjs";

const REF_MESSAGE = 'factory-state-ref:v1\n';

/** Repository-owned state refs; old Issue comments remain read-only recovery history. */
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
    this.records = new Map();
    this.heads = new Map();
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
    const options = this.options(number);
    const [comments, sha] = await Promise.all([
      this.gh.listIssueComments(options), this.gh.getRef({ ...options, ref: `heads/factory/state/issue-${number}` }),
    ]);
    const legacy = latestStateRecord(comments, {
      repository: this.repository, issueNumber: number, writers: await this.trustedWriters(),
    });
    if (!sha) {
      this.heads.set(number, legacy);
      return { latest: legacy, comments };
    }
    const latest = await this.readRefRecord(number, sha);
    if (latest.legacyHash !== (legacy?.hash ?? null)) throw new Error('Factory legacy state changed after ref migration');
    const parent = latest.parentSha ? await this.readRefRecord(number, latest.parentSha) : legacy;
    if (latest.envelope.revision !== (parent?.envelope.revision ?? 0) + 1
      || latest.envelope.parentHash !== (parent?.hash ?? null)
      || (latest.parentSha && parent.legacyHash !== latest.legacyHash)) throw new Error('Factory state ref revision conflict or missing parent');
    this.heads.set(number, latest);
    return { latest, comments };
  }

  async readRefRecord(number, sha) {
    const key = `${number}:${sha}`;
    if (this.records.has(key)) return this.records.get(key);
    const commit = await this.gh.fetchGitCommit({ ...this.options(number), sha });
    if (!commit?.message?.startsWith(REF_MESSAGE) || !Array.isArray(commit.parents)
      || commit.parents.length > 1 || !commit.tree?.sha) throw new Error('Invalid factory state ref commit');
    const { blobSha } = JSON.parse(commit.message.slice(REF_MESSAGE.length));
    if (!/^[a-f0-9]{40}$/.test(blobSha ?? '')) throw new Error('Invalid factory state blob pointer');
    const blob = await this.gh.fetchGitBlob({ ...this.options(number), sha: blobSha });
    if (blob.encoding !== 'base64' || blob.size > 1_000_000) throw new Error('Invalid factory state blob');
    const stored = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    // Ref updates require repository write access; author filtering still protects legacy comments.
    const row = body => ({ author: 'repository-ref', body });
    const record = decodeStateComment(row(stored.body), { repository: this.repository, issueNumber: number,
      writers: ['repository-ref'], comments: (stored.chunks ?? []).map(row) });
    if (!record || (stored.legacyHash !== null && !/^[a-f0-9]{64}$/.test(stored.legacyHash ?? ''))) throw new Error('Invalid factory state ref payload');
    const result = { ...record, refSha: sha, treeSha: commit.tree?.sha, parentSha: commit.parents[0]?.sha, legacyHash: stored.legacyHash };
    this.records.set(key, result);
    return result;
  }

  async history(number) {
    const { latest, comments } = await this.readRecord(number);
    const history = stateRecordHistory(comments, { repository: this.repository, issueNumber: number, writers: await this.trustedWriters() });
    const records = [];
    for (let current = latest; current?.refSha; current = current.parentSha ? await this.readRefRecord(number, current.parentSha) : null) records.push(current);
    for (const record of records.reverse()) {
      const parent = history.at(-1);
      if (record.envelope.revision !== (parent?.envelope.revision ?? 0) + 1 || record.envelope.parentHash !== (parent?.hash ?? null)) throw new Error('Factory state history conflict');
      history.push(record);
    }
    return history;
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
      ...structuredClone(snapshot),
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
      if (!this.leaseSha) throw new Error("Factory state write refused: acquire a GitHub issue lease first");
      // The last validated head only prepares a journal; publication still rechecks
      // the live lease, revision and parent hash before advancing the remote ref.
      if (!this.heads.has(number)) {
        await this.assertLease(number);
        await this.readRecord(number);
      }
      const latest = this.heads.get(number);
      if ((state.revision ?? 0) !== (latest?.envelope.revision ?? 0)) {
        throw new Error("Factory state revision changed; reload GitHub state before writing");
      }
      if (latest && JSON.stringify(publicSnapshot({ ...state, revision: latest.envelope.revision }))
          === JSON.stringify(latest.envelope.snapshot)) {
        await this.assertLease(number);
        const observed = await this.readRecord(number);
        if (observed.latest?.hash !== latest.hash) throw new Error('Factory state revision changed; reload GitHub state before writing');
        return state;
      }
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
      this.heads.set(number, record);
      await removeOptionalFile(file);
      return state;
    } finally {
      this.saving = false;
    }
  }

  async publishPrepared(number, record) {
    await this.assertLease(number);
    try {
      const { latest } = await this.readRecord(number);
      if (latest?.hash === record.hash) return;
      if (record.envelope.parentHash !== (latest?.hash ?? null) || record.envelope.revision !== (latest?.envelope.revision ?? 0) + 1) throw new Error('Factory state revision changed before publication');
      const options = this.options(number);
      const legacyHash = latest?.refSha ? latest.legacyHash : latest?.hash ?? null;
      const content = JSON.stringify({ body: record.body, chunks: record.chunks ?? [], legacyHash });
      const tree = await this.gh.createGitTree({ ...options, tree: [{ path: 'state.json', mode: '100644', type: 'blob', content }] });
      const blobSha = tree.tree?.find(entry => entry.path === 'state.json')?.sha;
      if (!tree.sha || !blobSha) throw new Error('GitHub did not confirm the state tree');
      const message = REF_MESSAGE + JSON.stringify({ blobSha });
      const commit = await this.gh.createCommit({ ...options, message, tree: tree.sha, parents: latest?.refSha ? [latest.refSha] : [] });
      if (!commit?.sha) throw new Error('GitHub did not confirm the state commit');
      await this.assertLease(number);
      const ref = `heads/factory/state/issue-${number}`;
      if (latest?.refSha) await this.gh.updateRef({ ...options, ref, sha: commit.sha, force: false });
      else await this.gh.createRef({ ...options, ref: `refs/${ref}`, sha: commit.sha });
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
