# OOO Agent Runtime：源码审查与行业对比

审查对象：`ooo-agent-runtime@637accf`；本地 `deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。分析未修改两个仓库源码，未调用付费模型。外部方案未独立运行。

## 结论

方向有价值，尤其是“部分观察一到就分析，并提前发现、启动新的慢工具”，而不是单纯把一批工具 Promise.all。但当前实现应定位为**单 Agent、依赖就绪、事件驱动的实验 runtime**，不是已经具备完整副作用安全、ROB 退休或持久恢复的通用执行引擎。

最值得保留的是 REASON/TOOL 分离、单推理槽、动态 spawn + continuation + 下游依赖改道，以及祖先锥上下文。最需要补齐的不是更激进的推测，而是默认 Harness 已有的执行与会话约束。

## 一、已有类似项目吗？

| 工作 | 相似点与区别 | 对本项目的意义 |
|---|---|---|
| AI Metropolis，2024 | 明确引入 out-of-order execution scheduling，并类比 CPU scoreboard；追踪多 Agent 仿真中的时空依赖，消除全局同步屏障。不是单 Agent 工具执行器。[9] | 不能宣称首次把 CPU OOO 搬进 Agent。应把创新范围缩小到具体执行、隔离和提交机制。 |
| LLMCompiler，2023 / ICML 2024 | Planner、Task Fetching Unit、Executor 分工；论文 §3.4 有动态重规划，§4.2 有流式规划，依赖就绪即可执行。[1] | 最应增加的直接基线，而不是只比较 ReAct 和 parallel-join。官方代码可用。[10] |
| Speculative Actions，2025 / 2026 | 推测未来动作或观察，提前执行，Actor 确认后复用；比本项目当前只执行 READY 更进一步。[7] | 属于未来推测执行的参考，不应把本项目当前实现与 action speculation 混称；存在公开研究代码。[11] |
| Google ADK long-running tools | 已有长任务进行中允许 Agent 继续工作的机制，不等于自动动态 DAG 或事务提交。[13] | “工具等待期间继续工作”本身不是空白。 |

另有 PASTE、B-PASTE、AOSpec 等研究，详见附件《ooo-agent-competition-evidence.md》；部分只有预印本或尚未确认公开实现。vLLM 的 token speculative decoding 与提前执行外部工具是不同层面的机制。

**可争取的差异化不是 OOO 这个名字，而是：分支局部的发现与续跑、复用 Harness 安全约束、可重放的因果事件、状态冲突检测、可验证的提交与恢复。** 这是产品方向建议，不是对市场空白的断言。

## 二、实际实现到了哪里？

以下源码路径的公共前缀为 `dsh-plugin/packages/ooo-loop/`。

- `scheduler.ts`：显式依赖图、READY 扫描、TOOL 并发、REASON 单槽。
- `dag.ts:213–257`：模型发出 tool call 后生成工具节点与 continuation，再把仍 pending 的下游重接到 continuation。
- `dag.ts:268–298`：祖先锥上下文，不只读取直接依赖，避免续跑时遗漏更早输入。
- `agent.ts:297–306`：只有配置 dag 且 turn=1 才走该路径；普通对话仍是原 loop。
- `dag.ts:28–39,260–266`：DAG 配置不声明 effect，也没有向调度节点传播 effect。
- `scheduler.ts:173–178`：所谓 commit gate 只是再次检查依赖 DONE，不包含全局程序序退休、冲突隔离、结果验证或外部副作用暂存。

CPU 的类比有解释价值，但不要机械要求所有 Agent 工作全局按序提交。更适合的目标是：独立纯计算允许乱序发布；同资源或有因果关系的写操作按明确约束提交；不可逆操作在授权与前置条件确认后执行。

## 三、优先修复的问题

### P1：DAG 绕过工具独占约束和并发限制

位置：`dag.ts:83–118,290–300`；`scheduler.ts:222–249`。

实际 DAG 直接进入 prepare/dispatch/finalize。默认 `tool-calls.ts` 则会读取 `executionMode`，执行 exclusive barrier，并遵守 `maxParallelToolCalls`。这不是低层工具 pipeline 自动代劳的约束。

复现：两个标为 exclusive 的工具、并发上限为 1，DAG 仍达到并发峰值 2；executionMode 调用次数为 0。

改进：先复用/抽取共享 admission 与资源仲裁；默认尊重 exclusive，未知工具保守串行。之后再扩展 read/write resource key，而不是现在就假定所有工具都是后台 I/O。

### P1：失败后继续发起新任务

位置：`scheduler.ts:225–243`。

循环先 dispatch READY，才检查 failure；排在 coreChain 中的 REASON 也不在实际启动前检查停止状态。

复现：一个分支失败、另一个分支完成后，其不可逆下游仍启动；执行顺序为 `fail, ok, write`，最后才抛异常。三个排队 REASON 中第一个失败，第二、第三个仍执行。

改进：停止状态在扫描前与实际启动前各检查一次；排队和运行分开。失败策略可以是 fail-fast 或局部分支恢复，但必须显式，不能声称 fail-fast 又继续提交副作用。

### P1：首轮输入与运行中 follow-up 没有正确收敛

位置：`agent.ts:194–203,297–306,366–371`。

DAG 分支位于 preStep/inbox claim 之前，结束直接 return false，跳过统一 pending 检查。

复现原 turn/send 方法、模拟 DAG 完成：初始输入和运行中 followup 都留在 pending，continueLoop=false，wakeRequested=false；会话只有 turn/start 与 turn/end。该复现使用变换后的原方法和模拟服务，不是完整应用启动。

改进：先明确并记录 DAG 输入的 claim/admission；DAG 退出后回到共同的队列与唤醒流程，并定义 steering 的节点取消/重规划语义。

### P1/P2：新路径没有继承标准请求与会话机制

位置：`dag.ts:138–168` 与 `agent.ts:297–306`。

REASON 直接 `ctx.llm.stream`，只传新构造的消息、provider/model、tools、signal；没有经过普通路径的 prompt assembly、agent/pre-step、agent/request、标准模型输出记录。不能仅凭 turn/start/end 配对就认为模型历史可重建。

改进：抽取共享的“节点请求执行”能力，复用请求准入、配置、重试、流状态机、用量与日志。DAG 和对话只决定何时及带哪些因果输入调用它。

### P2：错误结构与参数被丢失或改写

位置：`dag.ts:115–120,221–225,300`。

- 工具 `isError` 被降为普通文本，节点成为 done；实测依赖节点继续执行。
- `additionalContexts`、`concludesTurn` 和非文本内容没有保留。
- 非法 JSON 被悄悄变成 `{}`；实测坏 JSON 最终以空参数进入执行。
- 工具 schema 的展示过滤不是执行 allowlist：模拟模型返回未展示的工具名，仍进入 prepare。真实宿主可能继续拒绝，因此这不是已证明的权限绕过，而是 DAG 自身没有实施其宣称的工具范围限制。

改进：保留完整结果类型，区分完成与业务成功；允许恢复性 REASON 处理错误，但成功依赖不能自动放行。复用原 loop 的参数解析与工具校验；禁止静默“修复”参数。

### P2：取消、模型结束与预算不完整

位置：`dag.ts:146–168`、`scheduler.ts:189–249`。

实测取消后排队 REASON 仍进入 stream；模型流返回 finish(aborted) 时也可能作为空文本成功。当前只特殊处理 finish(error)。

改进：调度器接收 AbortSignal，dispatch 和实际调用前检查；共享正常 loop 的 finish 状态机。配置工具并发、调用/节点/深度/token预算、单工具超时和取消 drain 上限。不要把 max-tokens 截断当完整结果。

## 四、测试数量不等于新调度器被测试

程序化对比发现：插件中的 24 个 `.spec.ts` 文件与固定宿主的对应文件逐字相同。大量测试仍导入 `@deepseek-ai/dsh-agent-loop`，不是 `@deepseek-ai/dsh-ooo-loop`；少量测试直接导入本地源码。不能笼统说所有测试无效，也不能把整套测试通过当成 OOO 路径验证。

优先补：

1. spawn 后下游必须等 continuation；依赖重接不能提前发布。
2. exclusive/资源冲突、并发上限。
3. 失败或取消后没有新 dispatch；queued 与 running 分离。
4. 结构化工具错误、非法模型参数、各类 finish。
5. inbox/steering 与 DAG 结束竞态。
6. 中途崩溃、恢复与重复副作用。
7. Loader 启动的真实插件组合，以及 SDK/UI 可见历史。

## 五、性能结论：方向得到支持，数字还不够支撑泛化

本次实际运行原 Python benchmark，未执行覆盖已提交 JSON 的 main：

| 模式 | 本次观测虚拟秒 |
|---|---:|
| Sequential | 59.1 |
| Parallel-Join | 45.1 |
| OOO | 36.1 |

这里 `time_scale=0.05`，是定时器模拟。它复现了 README 的调度收益，不代表真实模型吞吐。

真实模型 L4 的历史结果支持“发现式 follow-up 提前启动有价值”，但存在：

- 基线需要在线规划最初工具，OOO 的初始 DAG 预先写好。
- 两侧模型 prompt、上下文与输出要求不同。
- OOO 以 DAG 内部时间计时，基线以会话 turn 时间计时。
- 仓库有 OOO trace，但 baseline 数字主要在绘图脚本中人工转录，缺少原始 baseline JSONL。
- 缺少配对重复、置信区间、质量评分和实际 token/费用。
- 完整模型请求时间不能未经拆分就称为“固定调用开销”。

因此 27.5% 应表述为**该配置、该场景的一次历史观测**，不是通用加速承诺。报告同时披露 OOO 更慢的场景，是值得保留的优点。

### 建议拆成两条评测线

**调度器线**：同一 DAG、同一 replay、相同资源上限，比较 sequential、parallel-join、ready scheduling、关键路径优先；统一开始结束边界。

**完整系统线**：同一自然语言任务与质量门槛，允许规划/融合策略不同，但计入全部规划、模型调用、token、失败和端到端时间；增加 LLMCompiler streamed/replan 基线。[1][10]

记录 observation-ready→decision-start、follow-up 实际派发时间、READY 排队时间、TTFT、生成时间、质量、总成本。这样才知道优化的是哪一段，而不只是看甘特图更密。

## 六、推荐演进顺序

1. **先修安全与一致性**：独占/并发、fail-stop、取消、结构化错误、inbox、参数校验。
2. **再修 Harness 集成与验证**：共享请求/工具执行机制，修正测试导入，增加真实 Loader 组合测试；明确首轮实验模式与普通对话模式。
3. **落地因果事件日志与恢复**：记录 node-created、dependency-added、started、settled、validated、committed；稳定 operation ID，处理崩溃后的 unknown-outcome。不要轻易承诺跨外部系统 exactly-once。
4. **做资源与关键路径调度**：REASON 等待队列真正由 scheduler 控制，优先可能解锁长工具链的任务，而不是提前把所有 REASON 串到 FIFO Promise 链。
5. **最后做纯工具推测**：小预算、可取消、匹配 action 和输入状态后复用；有副作用的操作只在隔离/staging 和提交协议建立后考虑。

最合理的近期里程碑：**不是“完整复制 CPU”，而是一个可在真实 Harness 中启用、不会破坏工具与会话语义、能在发现式任务中稳定缩短关键路径的调度插件。**

## 已运行检查与边界

- `git apply --check dsh-integration.patch` 成功，宿主版本恰好匹配 README 基线。
- Python 三模式模拟已实际运行。
- `/tmp/ooo-parent-review/dag-probes.mjs`：实际 dag.ts/scheduler.ts、真实 zod、模拟外部宿主服务；复现独占、错误、参数/工具范围问题。
- `/tmp/ooo-audit-repro.mjs`：实际核心源文件、模拟 runtime 边界；失败续发、并发、错误、取消及模型结束复现全部断言通过。
- `/tmp/ooo-agent-routing-repro.mjs`：实际 turn/send 方法变换后执行，模拟 DAG 完成，确认 inbox/wake 问题。
- 隔离运行保留测试：仅在 `/tmp/ooo-retained-audit/` 的配置中将原 loop/invariant 映射到 OOO 源码；23/24 个 spec 文件通过、403 个已收集测试通过。另一个文件因缺少 `@earendil-works/pi-ai/providers/all` 无法收集，整体退出 1；不能声称全套通过。这验证 fork 的串行路径兼容性，不验证新增 DAG 模式。结果 JSON 已复核。
- 额外原生 Node scheduler smoke：三个补充测试通过，涵盖无关 REASON 在工具 pending 时推进、依赖与 spawn、死锁诊断；不是仓库自带测试。
- 以上不等于完整 Harness 构建、真实模型端到端或生产可用证明。

## Sources

[1] https://arxiv.org/html/2312.04511v3
[7] https://arxiv.org/html/2510.04371
[9] https://arxiv.org/html/2411.03519v1
[10] https://github.com/SqueezeAILab/LLMCompiler
[11] https://github.com/naimengye/speculative-action
[13] https://google.github.io/adk-docs/tools/function-tools
