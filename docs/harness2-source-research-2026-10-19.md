# Harness² 一手源码研究

研究日期：2026-10-19。
研究对象为 [google-research/harness2@1cfe254e8d25b15f37048c3730134686abe60335](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335)。
本记录区分官方主张、源码事实和工程推断。
与本项目的完整映射见[启示分析](harness2-implications-2026-10-19.md)。

## 1. 研究问题与证据范围

问题是：Harness² 如何改进 agent 的执行系统，哪些机制有源码支持，哪些限制会影响生产软件工厂的采用。
阅读范围包括官方 README、实验文档、论文摘要、核心递归、候选选择、经验库、预算、调度、恢复身份以及后端适配代码。
没有执行真实付费模型任务，没有复现论文分数，没有访问任何 benchmark 答案。

官方定位是固定模型权重、优化模型外围的 prompts、工具、记忆、skills 和编排等组件。
官方报告了三类专业 benchmark 和四组模型/harness 配置下的改善，但这属于作者实验主张，本次研究没有独立验证其数值。
来源：[论文 v1](https://arxiv.org/abs/2610.14224v1)、[README](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/README.md)。

## 2. 两层递归的实际流程

### 2.1 当前任务层

每种模式使用 `k` 次 base 任务执行作为参考。
Parallel 模式提出并试跑 `k` 个通用候选和 `k` 个领域候选，然后形成并执行 `k` 个组合候选。
Sequential 模式执行 `k` 轮 Propose → Probe → Compose，每轮携带上一轮组合 harness 和积累证据，并保留各轮 final。
来源：[recursion.py 的 run_parallel / run_sequential](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py#L345)、[EXPERIMENTS.md](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md)。

核心价值在于用同任务真实执行形成对比材料，再决定如何组合修改。
该过程不是借助标准答案逐轮训练，也不是单纯对失败任务重复同一提示。
但执行轨迹对比不构成严格因果证明，额外采样和外部环境变化仍可能影响结果；这是本研究的工程判断。
来源：[context.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/context.py)、[prompts.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/prompts.py)。

### 2.2 跨任务层

Library 保存采纳的完整 harness 目录树，以及包含 cue、lesson、evidence 等字段的 `EXPERIENCE.md`。
缺少有效经验字段时 `Library.add` 不写入该条目，并在写入前检查不应包含的 grader verdict 内容。
来源：[library.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/library.py#L58)。

同一 domain 的任务顺序执行，后续改进调用可以读取该 domain 的经验库；不同 domain 可并发。
恢复时通过 `retain` 只保留流中当前任务之前的经验，减少未来任务条目泄漏到较早任务的风险。
来源：[schedule.py 的 run_domain](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/schedule.py#L669)、[library.py 的 retain](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/library.py#L100)。

因此，源码层面的持续改进主要通过给 improver 提供已有 harness 与经验上下文实现。
不能将其描述为模型权重更新，也不能认为它已经实现了完整的生产策略发布与回滚系统。
来源：[recursion.py 的 library_dir 传递](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py#L140)、[library.py 的 context_dir](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/library.py#L79)。

## 3. 采纳候选的关键限制

`selection_pool` 明确只构造 `k` 个 finals，base 参数被显式丢弃。
代码注释明确说明该发布版本不提供 abstention，即不通过保留 base 来拒绝所有候选。
来源：[selection.py 的 selection_pool](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L93)。

`k=1` 使用 `trivial_selection`，不启动选择器模型会话。
其检查依据是 `_render_pool` 的运行/交付状态和可读取产物；对部分状态型任务也可退回轨迹作为材料。
这些检查不等同于正确性判断，更没有比较候选是否优于 baseline。
来源：[selection.py 的 _render_pool](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L114)、[trivial_selection](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L360)。

`k>1` 时选择器读取匿名化候选并选择一个，选择器失败在 finals-only 池内会退回某个 final。
虽然通用 fallback 函数保留了处理 base 的分支，但实际 selection_pool 已经排除了 base，不能据此声称运行路径支持基线回退。
来源：[selection.py 的 _fallback / run_selection](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L237)、[schedule.py 的调用点](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/schedule.py#L513)。

推断：该设计可以研究递归方法的产出，但不能单独提供生产系统所需的“没有证据改善就保留当前策略”保证。

## 4. 实际预算

预算记录的恒等式是 `R = 4k` 次 solver rollout 和 `P = 3k` 次改进阶段调用。
`R` 包括 `k` 个 base、`2k` 个候选和 `k` 个 final 的实际执行。
`P` 包括 `k` 次通用提出、`k` 次领域提出和 `k` 次组合。
选择、反思和额外重试不包含在这个公式内。
来源：[ledger.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/ledger.py#L16)。

Parallel 和 Sequential 都包含最终组合后的执行，不能把 final 当作只写提示而未执行。
当同一实验运行两个模式时，参考执行还可能在模式间共享，因此不能不加区分地将两种模式预算简单相加。
来源：[recursion.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py#L434)、[schedule.py 的 _roll_bases / run_task](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/schedule.py#L430)。

推断：与单次 agent 执行比较时，必须控制总计算预算，并增加相同预算的多次基线执行对照，否则无法区分方法收益与额外采样收益。

## 5. 适配与可修改边界

项目分离了 BenchmarkAdapter、harness 文件 surface 和执行 substrate。
发布版本支持 OpenCode 与 Codex，benchmark 集成包括 JobBench、LAB 和 WorkBuddy-Bench。
来源：[spec.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/spec.py)、[tree.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/tree.py)、[substrate](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335/harness2/substrate)。

Harness 修改通过 surface 允许的文件路径与内容树表达，并不是任意修改整个仓库的抽象承诺。
但允许编辑 guardrails、scripts 或 plugins 的能力仍需要部署方建立可信边界；路径白名单不能等同于行为安全证明。
来源：[tree.py 的 is_allowed / read_tree / write_tree](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/tree.py#L92)。

## 6. 实验身份与恢复

运行目录按 benchmark、substrate、mode、budget、seed 和 tag 构造命名空间。
`_check_identity` 另外保存模型、任务分区、任务顺序、seed 等配置，不允许配置不同的实验静默继续同一目录。
来源：[schedule.py 的 Namespace](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/schedule.py#L85)、[run_sweep.py 的 _check_identity](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/cli/run_sweep.py#L209)。

`runmark` 通过完成标志和 harness fingerprint 识别可复用执行，避免将不同 harness 下的旧输出误认为当前运行结果。
来源：[runmark.py](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/runmark.py#L41)。

官方文档说明评估失败保持未评分，而不是计为零分。
推断：比较结果时应同时报告已评分数量、缺失和失败比例，防止可评分样本选择造成乐观解释。
来源：[EXPERIMENTS.md 的 Results and resume](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md#results-and-resume)。

## 7. 评测和执行边界

代码对改进上下文和经验库做了 grader verdict 泄漏检查。
但离线文件过滤不能阻止执行器联网获取公开评分材料。
官方明确披露：一次发布验证中，Codex rollout 在没有被要求的情况下下载了 JobBench 的 rubric。
来源：[selection.py 的 context 检查](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py#L402)、[EXPERIMENTS.md 的 Web access](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md#web-access)。

官方说明执行器网络不受限，Codex sandbox 被关闭，需要部署方在网络层限制评分材料访问。
推断：不能将这套默认执行配置直接搬到持有真实仓库写权限和密钥的软件工厂。
这一限制也不意味着论文所有结果已被证明污染；本次没有足够证据得出该结论。
来源：[README 的 Web access](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/README.md#web-access)、[官方实验说明](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md#web-access)。

## 8. 运行验证与许可证

上游声明运行环境为 Linux，Python 要求为 `>=3.12,<3.14`。
本次子任务尝试运行部分上游测试时，当前 Windows/Python 3.11 环境在 `fcntl` 处失败，未取得测试通过的运行证据。
这个环境不匹配不能视为项目核心逻辑缺陷，也不能声称已复现其递归效果。
来源：[pyproject.toml](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/pyproject.toml)、[schedule.py 的 POSIX 锁](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/schedule.py#L289)。

主仓库为 Apache-2.0，第三方代码、benchmark 和数据保留各自许可。
若后续实际复用源码，应单独检查所用组件的声明与许可；本次只做分析，没有复制上游实现进入产品。
来源：[LICENSE](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/LICENSE)、[third_party/README.md](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/third_party/README.md)。
