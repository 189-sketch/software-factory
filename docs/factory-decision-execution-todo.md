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
- [ ] 用专用真实 issue 验证关闭和中断后的最终收敛。
- [ ] 推送后确认 GitHub Actions 实际通过。
- [ ] 更新测试项目失效的 GitHub 凭据，验证正式 daemon 的自动闭环。

以上检查不足以证明任意需求、任意外部故障下都能无人干预成功。
缺失业务决策或外部权限时仍需明确 comment 和恢复条件，不得降低审查或验收门槛来宣称全自动完成。
