import { createHash } from "node:crypto";
import { issueFile, readOptionalJson, writeDurableJson, removeOptionalFile } from "./durable-json.mjs";
import { isWorkerFailure } from "./worker-failure.mjs";
import { listIssueComments, createIssueComment, updateIssueComment } from './github-rest.mjs';

export const recoveryHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const CONTRACT_FAILURES = new Set(['FACTORY_AGENT_OUTPUT_CONTRACT_INVALID', 'FACTORY_AGENT_CONTEXT_PREPARATION_FAILED']);
export const recoveryNeedsOperator = record => Boolean(record && CONTRACT_FAILURES.has(record.failure.code) && record.attempts >= 3);

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
    return { allowed: !record || record.context !== context || (!recoveryNeedsOperator(record) && Date.parse(record.nextRetryAt) <= now), record };
  }

  async failed(number, context, failure, now = Date.now()) {
    if (!isWorkerFailure(failure) || !/^[a-f0-9]{64}$/.test(context)) throw new Error("Invalid worker failure envelope or admission context");
    const previous = await this.read(number);
    const same = previous?.context === context;
    const sameNotice = same && previous.failure.fingerprint === failure.fingerprint;
    const attempts = same ? previous.attempts + 1 : 1;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempts - 1, 30));
    const record = { version: 1, repository: this.repository, issueNumber: number, context, failure,
      attempts, firstFailedAt: same ? previous.firstFailedAt : new Date(now).toISOString(),
      nextRetryAt: new Date(now + delay).toISOString(),
      noticePublished: false,
      noticeAttemptedAt: sameNotice ? previous.noticeAttemptedAt : null };
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
  const request = record.failure.request;
  const denied = request?.status === 401 || request?.status === 403;
  const needsOperator = recoveryNeedsOperator(record);
  const summary = record.failure.operation === 'save'
    ? request ? '保存运行进度时未能完成 GitHub 状态确认，本次运行已暂停。' : '保存运行进度时发生故障，本次运行已暂停。'
    : '工厂运行暂时中断，尚未完成当前任务。';
  const retryAt = new Date(record.nextRetryAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) + '（北京时间）';
  return { marker, body: [marker, needsOperator ? '**工厂需要维护者处理**' : '**工厂正在自动恢复**', summary,
    ...(needsOperator ? [
      `相同输入下已连续失败 ${record.attempts} 次，结构化输出或评判上下文契约仍不满足要求，已暂停自动重试。`,
      '请维护者修复运行问题并重新构建，或提供新的有效需求输入；输入或构建发生变化后，工厂会重新核对状态并继续。',
    ] : [
      '暂不需要回复。工厂会先核对远端状态及本地恢复记录，再继续处理，避免覆盖新状态或重复未确认的操作。',
      `预计下次自动检查：${retryAt}。连续失败时会逐步延长间隔，最长 ${maxDelayMs / 60000} 分钟。`,
    ]),
    ...(denied ? [`需要维护者处理：GitHub 返回 HTTP ${request.status}，请检查工厂使用的 GitHub 凭据及仓库访问权限。`] : []),
    '<details>\n<summary>故障诊断（供维护者排查）</summary>',
    `工厂运行故障：${record.failure.code}（${record.failure.owner}）。`,
    ...(record.failure.code === 'FACTORY_AGENT_CONTEXT_EXHAUSTED' || record.failure.code === 'FACTORY_AGENT_CONTEXT_RECOVERY_FAILED'
      ? ['AI 会话上下文过长，工厂将尝试压缩原会话后继续；无需重新描述需求。'] : []),
    ...(record.failure.operation ? [`故障环节：${record.failure.operation}。`] : []),
    ...(record.failure.request ? [`请求诊断：${record.failure.request.resource} / ${record.failure.request.phase}；第 ${record.failure.request.attempt} 次请求，耗时 ${record.failure.request.elapsedMs} 毫秒，上限 ${record.failure.request.timeoutMs} 毫秒${record.failure.request.page ? `，第 ${record.failure.request.page} 页，每页 ${record.failure.request.perPage ?? '未记录'} 条` : ''}。`] : []),
    ...(request?.transportCode ? [`连接错误：${request.transportCode}。`] : []),
    "本次 worker 未正常结束，不代表 issue 已完成；工厂将保留现有产品文件和验收要求。",
    '详细请求重试记录见 daemon.log。', '</details>'].join("\n\n") };
}

/** Keep a single authored status comment even when a restart changes the failure identity. */
export async function publishRecoveryNotice({ token, repository, record, author, maxDelayMs }) {
  const notice = recoveryNotice(record, maxDelayMs);
  const options = { token, repository, number: record.issueNumber };
  const comments = await listIssueComments(options);
  const existing = comments.filter(comment => comment.author === author
    && comment.body.includes('<!-- pi-software-factory:operator-wait:runtime:')).at(-1);
  if (existing && existing.body !== notice.body) {
    const id = await updateIssueComment({ token, repository, id: existing.id, body: notice.body, maxRetries: 0 });
    if (id !== existing.id) throw new Error('GitHub did not confirm the runtime recovery notice update');
  } else if (!existing) {
    const id = await createIssueComment({ ...options, body: notice.body, maxRetries: 0 });
    if (!id) throw new Error('GitHub did not confirm the runtime recovery notice');
  }
}
