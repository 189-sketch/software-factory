# Factory decision and execution TODO

Scope: the decision, state-transition, and verification failures observed on test issue #46.
This work does not change the test project's application code or enable automatic PR merging.

- [ ] Preserve newly fetched author comments in freshness decisions and make `needs-info` wake-ups edge-triggered by a new author event.
  Verify with a real issue reply and daemon log showing exactly one fresh re-triage.
- [ ] Represent an author's explicit disposition of known review findings without allowing an unreviewed or safety-critical defect to disappear.
  Verify issue #46 advances or requests a specific, actionable decision instead of repeating the same rubric rejection.
- [ ] Require complete Jev answer coverage and stable finding identities across revisions.
  Verify missing answers stop the gate and a renamed validation-plan item retains its failure history.
- [ ] Enforce decision routes at state transitions and supply real receipt-producing tools to behavior verification.
  Verify `confirm` and `escalate` cannot silently auto-merge and a verification result cites executed receipts.
- [ ] Separate freshness skip-rate telemetry from product-quality health.
  Verify a tick with one fresh issue does not report zero quality solely because it was processed.
- [ ] Build and run the factory against `pi-software-factory-target` with `autoMerge=false`.
  Record the actual issue outcome, stage transitions, and any remaining blockers.

## 三个核心闭环和 CI 补齐（2026-10-02）

- [x] 以规格全部 AC 为权威清单，将覆盖证明绑定规格 SHA、实现 SHA、本次 run 和实际通过收据。
- [x] 正常完成、手动合并确认和恢复统一使用完成合同。
  中断恢复只记录远端操作事实，不直接宣称任务完成。
- [x] 合并后主动关闭 issue，读取 GitHub 确认关闭后才写入 completed。
  关闭响应丢失会观察远端结果，不盲目重复写入。
- [x] 调度器使用相同合同，避免缺失覆盖证明的旧记录形成唤醒空循环。
- [x] CI 增加完整回归、规格检查、Windows/Linux 打包安装测试，并将发布校验依赖这些检查。
- [x] 本地完整回归、CLI 安装与面板 HTTP 测试、测试项目 65 项测试通过。
- [x] 真实验收定位并修复 MCP 工具桥忽略 inputSchema 的合约错误。
  首次真实运行断言已执行，但数组参数被传成对象，登记失败并正确返回 blocked。
  工具桥现保留工具 schema，验收登记明确声明数组类型，不放宽收据校验。
- [x] 使用修复后的 MCP 参数合约重新完成真实项目全部 AC 验收。
  #53 的新鲜验收 runId 为 live-acceptance-1790949703578，结果 verified、covered=true，7/7 条 AC 均关联实际通过收据。
  实现 SHA 为 5bdd6d5b65fdf141a931431fac4f2d9fad0ee01c，已跟踪文件未被修改。
- [x] 用专用真实 issue 验证关闭操作在进程中断后的远端收敛。
  #57 的真实 PATCH 关闭成功后进程直接退出，新进程只观察一次已有 intent 并确认 succeeded，没有重复关闭，租约已释放。
  此 probe 没有实现审查和验收证明，因此没有被误标为任务 completed。
- [ ] 用具备新鲜完整验收证明的真实 issue 验证从自动实施到 completed 的全部流程。
- [x] 推送后确认 GitHub Actions 实际通过。
  PR #12 基于 fix/typesafe-official-contract，提交 0973303 的运行 37021161409 的完整回归、快速回归、Linux 打包和 Windows 打包均通过。
  首次云端运行暴露了测试 stub 缺少 POSIX 解释器及超时 mock 未保持事件循环的问题，已修复而非跳过失败用例。
  daemon fatal 测试使用不可用的本机模型配置，避免依赖本机真实密钥或提前命中缺配置的启动错误。
- [x] 隔离离线回归对本机已安装 Claude 和真实模型凭据的依赖。
  dispatcher 缺 CLI 和 triage fallback 用例固定使用不存在的测试命令，相关 31 项回归约 1 秒通过。
- [x] 缺失规格 SHA 或全部 AC 基线的执行标签先进入规格阶段，不再在实现后才因缺失验收基线反复失败。
- [x] 实施验证失败向恢复决策保留实际退出码、stdout 和 stderr，空 stderr 不再覆盖超时错误。
  #48 的真实回归命令失败曾只留下命令名，现已通过真实子进程超时及 stdout 断言失败的针对性回归。
- [ ] #48 在独立 checkout 的真实自动流程完成并确认最终证据。
  原工作区中的 mockUsers.ts 保持不动。
- [ ] 更新测试项目失效的 GitHub 凭据，验证正式 daemon 的自动闭环。

以上检查不足以证明任意需求、任意外部故障下都能无人干预成功。
缺失业务决策或外部权限时仍需明确 comment 和恢复条件，不得降低审查或验收门槛来宣称全自动完成。
