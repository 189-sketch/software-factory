# R3 GitHub 状态统一

## 已确认的实施约束

GitHub 是生产 issue 状态的唯一主存储。
标签表达流程状态，版本化评论保存重启所需的修订反馈、审查结果、计数器和外部操作意图。
这些数据仍作为内存运行上下文存在，不按原计划直接删除，以免丢失恢复语义。
不再把不断增长的 rubric 判断点计数器映射为大量标签。
恢复评论必须绑定仓库、issue、修订号、父记录哈希和可信作者。
编码校验和只能检测损坏，不能替代作者校验。

本地仅保留私有 CLI 会话、待确认的恢复上传日志和外部操作未知结果日志。
租约所有权保留在 GitHub git-ref 中。
运维日志和测试 fixture 不属于生产 issue 状态。

## TODO

- [x] 保存原工作区源码为提交，并合并剩余源码和 R1/R2。
- [x] 实现版本化恢复评论的编码、去敏、大小预算和修订链校验。
- [x] 实现可信作者读取和 GitHub 租约写入校验。
- [x] 实现私有 SessionStore 和 GitHubIssueStore 适配层。
- [x] 实现提交前持久化的上传日志及显式恢复流程。
- [x] 拒绝旧版本覆盖、丢失租约写入及有分歧的恢复日志。
- [x] 补齐 issue 评论分页，防止只读取前 100 条而丢失最新恢复记录。
- [x] 使用真实测试仓库验证发评论后的进程中断及新进程恢复。
- [ ] 把 orchestrator、daemon、面板和 freshness 接入同一 GitHub 状态读取路径。
- [ ] 把外部操作 intent 和 outcome 接入恢复记录，取消重复的本地成功收据。
- [ ] 强制生产 lease 使用 GitHub-ref，移除文件 lease 和 lease-wait 旁路。
- [ ] 把 reconciler 切到 GitHub 评论和租约扫描。
- [ ] freshness 只使用业务输入和可信恢复版本，排除工厂自身评论带来的自触发。
- [x] 对旧 checkpoint 做显式只读迁移预检，冲突时优先展示 GitHub 现状，不自动覆盖。
- [ ] 完成整条真实流水线、网络故障和中途退出的回归后切换默认路径。

## 当前切换边界

核心存储已实现，但尚未替换生产调度器的默认存储。
必须同时切换读写消费者，不能让新 worker 写 GitHub 而旧 daemon 继续读取本地 checkpoint。
原始 checkpoint 没有被删除或改写。

freshness 已与 TypeScript orchestrator 共用业务输入哈希和工厂评论分类器。
daemon 的等待判断和作者唤醒判断也使用相同的业务输入及工厂评论分类器，不把恢复记录误认为作者回复。
工厂评论、issue updatedAt、lastTriageAt 和内部收据不会自触发 freshness。
人类评论内容修改、删除、标题、正文、标签及关闭状态会改变业务输入哈希。
标签排序或重复不会产生伪变化。
轮询 freshness 不再写 checkpoint，避免 worker 尚未执行就把输入标记为已处理。
freshness 支持显式注入 GitHub 恢复快照，但调度器默认读路径尚未切换。

## 恢复协议

写入前验证当前 lease SHA 和调用者持有的修订号。
在发出 POST 前以临时文件、fsync 和 rename 保存待上传记录。
POST 响应丢失时读取 GitHub，确认相同内容已经落地则直接完成，不重复 POST。
不能确认时保留日志并阻止后续副作用。
只读 load 不使用本地日志覆盖 GitHub，也不偷偷执行恢复上传。
持有有效租约的写入者显式调用 recover，父记录不匹配时停下来展示需要人工处理的冲突。

GitHub REST 的评论读取使用分页，恢复读取必须获取完整记录链。
接口契约见 [GitHub issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28)。

## 已执行验证

核心存储和会话检查全部通过。
真实测试使用 software-factory-demo 的已关闭 issue #50。
第一进程成功创建评论后退出，第二进程恢复 revision=1，记录数保持为 1。
第二进程确认私有会话未公开、上传日志已清除，并释放测试租约。
这验证了核心持久化和崩溃窗口，不代表完整生产流水线迁移已经完成。

## 旧 checkpoint 只读预检

使用已配置的 FACTORY_GH_REPO 和 GH_TOKEN 执行以下命令。

```powershell
node scripts/inspect-legacy-state.mjs E:/ai/open/pi-software-factory-target/.factory/issues/48.json 48
```

该命令只读取指定文件及 GitHub issue 和可信评论，不获取租约、不发评论、不修改标签，也不修改原文件。
命令输出仅显示哈希、GitHub 现状及冲突，不输出包含项目材料的候选快照。
只有无冲突的本地状态才会形成内存中的去敏候选记录，显式上传入口尚未启用。
GitHub 已有可信版本、本地标签不一致、未确认外部操作、未确认标签写入和关闭状态不一致都会阻止导入。
API 或文件读取错误直接返回错误，不伪装为不存在的 GitHub 状态。

真实项目 #48 的预检显示 GitHub 标签为 ready-to-implement，而旧 checkpoint 的 nextLabel 不一致，并有未确认外部操作。
该 checkpoint 没有被导入，GitHub 也没有被改写。

本轮使用真实 #50 的恢复评论复现自触发问题，修改后相同数据不再改变业务输入哈希。
本轮使用真实 #48 运行 Jev triage 成功，结果为 Ready to implement，测试使用隔离状态目录且关闭 GitHub 写入。
全量测试、主程序和面板构建、两端 TypeScript 检查及 16 项规格检查通过。
测试项目 .factory-daemon/.env 中的 GitHub 凭据返回 401，本轮测试临时使用现有 gh 登录，不修改原凭据文件。
正式重启长期 daemon 前，需要更新该文件中的 GitHub 凭据。
