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
- [x] Separate freshness skip-rate telemetry from product-quality health.
  Verify a tick with one fresh issue does not report zero quality solely because it was processed.
  Real daemon CLI smoke confirms fetched=1, fresh=1, skippedRate=0 and health=null; the assertion is now a CI gate.
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
  最新代码提交 ba30d82 的运行 37197407152 同样全部通过，发布任务按 PR 配置跳过。
  首次云端运行暴露了测试 stub 缺少 POSIX 解释器及超时 mock 未保持事件循环的问题，已修复而非跳过失败用例。
  daemon fatal 测试使用不可用的本机模型配置，避免依赖本机真实密钥或提前命中缺配置的启动错误。
- [x] 隔离离线回归对本机已安装 Claude 和真实模型凭据的依赖。
  dispatcher 缺 CLI 和 triage fallback 用例固定使用不存在的测试命令，相关 31 项回归约 1 秒通过。
- [x] 缺失规格 SHA 或全部 AC 基线的执行标签先进入规格阶段，不再在实现后才因缺失验收基线反复失败。
- [x] 实施验证失败向恢复决策保留实际退出码、stdout 和 stderr，空 stderr 不再覆盖超时错误。
  #48 的真实回归命令失败曾只留下命令名，现已通过真实子进程超时及 stdout 断言失败的针对性回归。
- [x] 运行时格式检查与业务 JSON 解析统一，合法的代码块 JSON 不再触发多余的模型修复。
  #48 的真实规格输出可回放解析出 7 条 AC，但旧运行时误判为格式错误，格式修复调用最终超时。
- [x] 技术定向规格修订保留产品候选和 AC，只生成 TECH，并对完整候选重新执行判断。
  #48 的日志指向 spec-tech，但旧实现仍重写两份文档。
  针对性回归确认技术修订只调用一次 spec-tech，产品字段不变，且保留新一轮 Jev 判断。
- [ ] #48 在独立 checkout 的真实自动流程完成并确认最终证据。
  原工作区中的 mockUsers.ts 保持不动。
  第二次规格审查发现现有 AppNav 测试缺少 AuthProvider、未决默认方案和注册返回路径覆盖问题。
  此前 review-spec 的 AGENT_REASONING 预算曾为 2/2，GitHub 状态曾为 needs-info，未跳过审查或清零记录。
  2026-10-04 用户授权代理自行作出业务决定，已发布可审计的默认方案回复，明确要求先修订规格并重新审查。
  真实 triage 仍将该回复路由到 implementation，错误使用被拒绝的规格分支，已停止该进程并将两个生成文件保存到独立 checkout 的可恢复 stash。
- [x] 执行入口要求与当前规格 SHA 和修订匹配的 APPROVE，未通过时回到规格阶段并保留审查反馈。
  fallback 分支不再为被拒绝的规格提供实施基线。
  17 项针对性回归通过，覆盖执行标签、缺失审查、REJECT、过期审查和未解决的 blocking finding。
  本地全量回归通过，真实 #48 于 2026-10-04 20:39:39 明确从 implementation 路由回规格阶段，随后启动新一轮 spec 并保留 12 条历史 finding。
- [x] 将规格审批规则纳入共享完成合同，正常实施、手动合并确认和 daemon 恢复统一要求当前规格获批。
  隔离的真实恢复调用复现了旧入口将规格 REJECT 标记 completed 并调用关闭接口的问题，没有向真实 GitHub 写入样例状态。
  修复后拒绝、缺失或过期的规格审批不会访问关闭接口，42 项相关回归通过。
  原始隔离复现重新运行得到 accepted=false、patchCalls=0，本地全量回归通过。
  真实 #48 于 2026-10-04 20:49:04 通过规格审查，完成规格 PR 合并阶段，并于 20:50:14 启动实施。
- [x] 将真实测试项目的 Windows 回归入口修复持久化到默认基线，保留完整构建、lint 和格式门槛。
  无 shell 的 spawnSync npm 直接复现 ENOENT，原日志误报 exit=null 与 undefined，现已保留启动错误并使用 Windows shell。
  生成器排除本机 node_modules，模板以原 Prettier 规则格式化并固定 LF checkout，扩展场景保留原 Route 缩进。
  独立 checkout 的 node test/run-tests.js 真实结果为 21 passed、0 failed，耗时 93.11 秒，前端 npm test 为 83 passed、0 failed。
  未提交的修复在 21:11:15 的实施重试中被清理，重试再次命中旧入口；上述通过结果不能视为持久修复完成。
  已建立独立维护工作树 core-validation-baseline，基于合并规格 #49 后的默认分支 c928fe1，后续 PR 审查和 AC 验收尚未完成。
  测试项目 PR #58 的 Linux/Windows CI 37206318939 全部通过，已合并至默认基线 19c690f。
  独立基线重新运行生成器 21/21、前端 65/65 通过，新增双平台 CI，没有豁免验证命令。
  工厂代码提交 22cac40 的完整回归、快速回归及 Windows/Linux 打包 CI 均通过，运行编号为 37203719702。
- [x] 首次实施在清理后仅通过 fast-forward 同步默认基线，并在生成前逐份核对批准规格的实际内容。
  真实 #48 的旧 feature 分支停在 6cdc239，而批准规格已合入默认分支 c928fe1，旧分支缺少新的规格文件。
  两项针对性回归通过，其中真实本地 Git 分支与 bare origin 验证了旧分支升级、规格文件可见及内容不匹配拒绝生成。
- [x] 实施代理接收后续业务回复和指向实施阶段的纠错对话，工厂自身 checkpoint 不作为用户决定。
  原实施请求只包含 issue 原始正文和已有提交摘要，未传递 issue comments 或 context.correction。
  真实 CLI 输入捕获回归确认作者回复和 npm 启动错误纠错均可见，并排除工厂阶段 comment。
  包含基线同步和反馈修复的本地 npm test 全量通过。
  工厂提交 86a6faa 的 CI 37206368348 完整回归、快速回归及 Windows/Linux 打包全部通过。
  纠错对话不再将实际失败详情截为前 200 字，保留验证退出码及末尾诊断，避免反馈刚送入代理又丢失具体原因。
- [x] needs-info 和终止 comment 携带具体阶段及失败详情，而非仅报告预算耗尽。
  旧等待记录只补齐一次诊断，不启动代理、不清零预算、不伪造用户恢复回复。
- [x] 执行标签直接进入流程时也建立业务输入哈希，旧等待记录缺少哈希不再被误认为新输入。
  #48 的诊断刷新触发了旧 bug，可信 GitHub 历史确认第 47 版误清零预算，且没有新用户回复。
  修复覆盖历史旧回复不唤醒等待及无 triage 的状态转移建立哈希基线。
  已在租约保护下根据可信第 46 版恢复误清零字段，追加第 48 版修正记录，不改写历史。
  修复后的真实运行退出成功，第 54 版仍为 waiting/needs-info，等待 comment 已携带完整拒绝项。
- [ ] 更新测试项目失效的 GitHub 凭据，验证正式 daemon 的自动闭环。
- [ ] 处理测试模板依赖的安全告警，并在兼容升级后重新验证生成项目。
  当前真实 npm audit 报告 16 项告警，包括 1 项 critical，涉及 Vitest UI 等开发依赖。
  未运行强制跨大版本升级，未把无 UI 的测试通过等同于生产安全证明。

以上检查不足以证明任意需求、任意外部故障下都能无人干预成功。
缺失业务决策或外部权限时仍需明确 comment 和恢复条件，不得降低审查或验收门槛来宣称全自动完成。
