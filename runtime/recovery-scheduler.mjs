import { createHash } from "node:crypto";
import { issueFile, readOptionalJson, writeDurableJson, removeOptionalFile } from "./durable-json.mjs";
import { isWorkerFailure } from "./worker-failure.mjs";

export const recoveryHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Local admission journal only. It cannot supply workflow state or authorize side effects. */
export class RecoveryScheduler {
  constructor({ stateDir, repository, baseDelayMs, maxDelayMs }) {
    this.stateDir = stateDir;
    this.repository = repository;
    this.directory = `scheduler/${recoveryHash(repository)}`;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  async read(number) {
    const record = await readOptionalJson(this.file(number));
    if (record && (record.version !== 1 || record.repository !== this.repository || record.issueNumber !== number
      || !isWorkerFailure(record.failure) || !/^[a-f0-9]{64}$/.test(record.context ?? "")
      || !Number.isSafeInteger(record.attempts) || record.attempts < 1
      || !Number.isFinite(Date.parse(record.nextRetryAt)) || typeof record.noticePublished !== 'boolean'
      || (record.noticeAttemptedAt !== null && !Number.isFinite(Date.parse(record.noticeAttemptedAt))))) {
      throw new Error("Invalid recovery admission journal");
    }
    return record;
  }

  async admission(number, context, now = Date.now()) {
    const record = await this.read(number);
    return { allowed: !record || record.context !== context || Date.parse(record.nextRetryAt) <= now, record };
  }

  async failed(number, context, failure, now = Date.now()) {
    if (!isWorkerFailure(failure) || !/^[a-f0-9]{64}$/.test(context)) throw new Error("Invalid worker failure envelope or admission context");
    const previous = await this.read(number);
    const same = previous?.context === context && previous.failure.fingerprint === failure.fingerprint;
    const attempts = same ? previous.attempts + 1 : 1;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempts - 1, 30));
    const record = { version: 1, repository: this.repository, issueNumber: number, context, failure,
      attempts, firstFailedAt: same ? previous.firstFailedAt : new Date(now).toISOString(),
      nextRetryAt: new Date(now + delay).toISOString(),
      noticePublished: same ? previous.noticePublished : false,
      noticeAttemptedAt: same ? previous.noticeAttemptedAt : null };
    await this.write(number, record);
    return record;
  }

  async write(number, record) {
    await writeDurableJson(this.file(number), record);
  }

  async clear(number) {
    await removeOptionalFile(this.file(number));
  }

  file(number) {
    if (!Number.isSafeInteger(number) || number < 0 || number >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid recovery issue number');
    // Zero represents repository maintenance, not a GitHub business checkpoint.
    return issueFile(this.stateDir, this.directory, number + 1);
  }
}

export function recoveryNotice(record, maxDelayMs) {
  const marker = `<!-- pi-software-factory:operator-wait:runtime:${record.context}:${record.failure.fingerprint} -->`;
  return { marker, body: [marker, `工厂运行故障：${record.failure.code}（${record.failure.owner}）。`,
    ...(record.failure.operation ? [`故障环节：${record.failure.operation}。`] : []),
    ...(record.failure.request ? [`请求诊断：${record.failure.request.resource} / ${record.failure.request.phase}；第 ${record.failure.request.attempt} 次请求，耗时 ${record.failure.request.elapsedMs} 毫秒，上限 ${record.failure.request.timeoutMs} 毫秒${record.failure.request.page ? `，第 ${record.failure.request.page} 页，每页 ${record.failure.request.perPage ?? '未记录'} 条` : ''}。`] : []),
    "本次 worker 未正常结束，不代表产品有缺陷，也不代表 issue 已完成。",
    `已暂停相同输入的重复执行，首次预计恢复检查时间：${record.nextRetryAt}。`,
    `再次发生相同故障会延长检查间隔，最长 ${maxDelayMs / 60000} 分钟，不会每个轮询都启动 worker。`,
    "新的业务输入、可信恢复版本或运行配置/版本变化可以提前触发恢复；不会清空历史、覆盖未确认操作或降低验收要求。",
    "暂不需要回复；工厂会自动重试恢复。若故障持续，需要你的操作：检查 daemon.log 中对应故障，修复 GitHub 网络、权限、磁盘或工厂运行版本。",
    "若缺少具体操作依据，不应猜测或反复回复来重置业务重试预算。"].join("\n\n") };
}
