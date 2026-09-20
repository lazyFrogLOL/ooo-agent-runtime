# OOO Agent Runtime 设计总览（v0.3 · 2026-09-20）

> 本文是整个项目的**单一权威入口**：用一份文档把问题、核心设计、两条实现线、
> 实验结论、外部定位、已知缺陷和路线图串起来。
> 细节请分别深入：[DSH 设计文档](DSH-OOO-Loop-设计.md)（实现细节）、
> [技术报告](OOO-Agent-Runtime-技术报告.md)（实验叙事）、
> [源码审查](ooo-agent-runtime-review.md)（问题清单）、
> [竞品证据](ooo-agent-competition-evidence.md)（外部工作核实）。

---

## 0. 一分钟版本

主流 Agent runtime 的执行模型是 ReAct 直线：思考 → 调工具 → **等所有工具返回** →
再思考。工具并发早已解决，没解决的是两件事：

1. **join 屏障**：同一步发出的工具调用，最快的也要等最慢的，结果才一起提交给模型；
2. **决策推迟**：模型只有等 join 完成才能看到任何结果，"看到数据后才发现需要
   再查一个慢数据源"这类**发现式决策**被无谓推迟。

本项目把 CPU 乱序执行的思想搬进 Agent runtime：任务（模型请求 / 工具调用）组成
依赖图，调度器永远挑"依赖已齐"的节点立刻执行，模型核心绝不空等慢工具；
发现式后续任务（spawn）一被发现就立刻调度。

**核心结论（真实模型双向实证）**：OOO 的收益不来自"并行"，来自**提前决策**。
发现式慢 follow-up 地形下快 27.5%；后续工作可折叠进一次调用的地形下反而慢 28%。

**定位（收窄后的诚实表述）**：这是"单 Agent、依赖就绪、事件驱动的实验 runtime"，
不是首个 Agent OOO（AI Metropolis 2024 已有 scoreboard 类比先例），
也还不具备完整副作用安全、ROB 退休或持久恢复。

---

## 1. 核心设计（五个机制）

### 1.1 REASON / TOOL 双资源模型

两类节点，两类资源：

- **REASON 节点** = 节点粒度的一次模型请求。所有 REASON 共享**单槽推理核心**
  （类比单核流水线），同一时刻只服务一个节点，但永远挑 READY 的跑。
- **TOOL 节点** = 后台工具执行，并发不限于单槽，完成时以事件唤醒依赖节点。

收益的本质：把"模型等工具"的空转时间，换成"模型处理其他已就绪分支"的有效时间。

### 1.2 事件驱动 READY 调度

`scheduler.ts` 主循环：扫描 READY → 立即派发 → 任一节点落定即唤醒重扫。
对比 ReAct 的"发完一批就睡觉"，这是调度器永远醒着。

### 1.3 spawn / continuation / reroute（动态发现三件套）

模型在 REASON 节点里发出普通 tool call，即构成**动态发现**：

1. **spawn**：每个 tool call 变成一个新 TOOL 节点，立即派发；
2. **continuation**：自动补一个续跑 REASON 节点，依赖父节点 + 新工具结果，
   提示词注入父节点的初步结论；
3. **reroute（正确性关键）**：静态依赖父节点的下游节点，在 spawn 瞬间改挂到
   续跑节点上——否则"综合结论"会在 spawn 数据回来之前就拿初步结论开跑。

模型不需要学新协议：普通 function calling 就是动态发现的载体。

### 1.4 祖先锥投影（讲故事的规则）

dsh 铁律：**模型看到的每个字必须能从 append-only 会话日志重建**。乱序执行后，
"按时间顺序念流水账"不再成立，解法是**按依赖族谱讲故事**：

- 账照记（标准事件落日志，OOO 指标走 side-channel trace，不污染会话）；
- 节点 N 发模型请求时，只注入 N 的**传递闭包祖先**的结果（DFS 拓扑序），
  而不是全部历史。

附带收益：省 token（分支 B 看不到分支 A 的中间噪音）；冲突显式化
（不同分支的结果带来源标签，交给模型裁决）。

### 1.5 commit gate（现状：只是依赖门禁）

不可逆操作（发邮件、写库）只在依赖全部 DONE 后执行。
**注意**：当前实现只检查 `depends_on`，不等于 CPU 的程序序退休、
冲突隔离或外部副作用可回滚。effect_class 分级、审批集成是 M3 课题
（详见 §4 已知缺陷与 §5 路线图）。

---

## 2. 两条实现线

| | Python v0.1 原型 | dsh 插件线（主战场） |
|---|---|---|
| 代码 | `ooo_runtime/` + `examples/` + `benchmarks/` | `dsh-plugin/packages/ooo-loop` + `ooo-mock-lab` |
| 定位 | 三分钟看懂想法；调度算法 sandbox | 真实框架里的可替换 agent loop |
| 验证 | 三模式对照 59s / 45s / 36s（虚拟时间） | 四层实验（见 §3） |
| 测试 | — | **418 个上游契约测试在 fork 源码上全绿**（2026-09-17 修复导入后） |

dsh 线的形态：fork `packages/core/agent-loop` → `packages/experimental/ooo-loop`，
factory / 生命周期 / inbox / settlement / invariant 原样保留，仅在
`ReactLoopAgent.turn()` 开头挂钩：turn 1 且配置了 `dag` 时改走 `runOutOfOrder()`。
通过 profile patch（`--patch xxx.patch.yml`）整体替换默认 loop，不改宿主一行代码。

TOOL 节点走真实工具运行时管线（prepare → dispatch → finalize，与默认 loop 同一条路）；
REASON 节点是独立一次性模型请求（祖先锥结果注入提示词），调度器单槽串行。

---

## 3. 实验结论（四层验证金字塔）

| 层 | 工具 | 结论 |
|---|---|---|
| L1 算法层（秒级） | smoke.mjs / vitest | 调度器复现理论预测，误差 <3%；418 测试全绿 |
| L2 确定性 E2E（分钟级） | mock 实验室（脚本化 mock LLM + 定时 mock 工具） | 同一场景：默认 loop 5140ms → OOO 3048ms，**1.69×**；join 屏障实证（500ms 的研报等了 2014ms） |
| L3 真实模型（Kimi K2） | bench-l3 系列 | **阴性结果**：慢工具 + 可折叠地形下 OOO 反而慢 28%——拆节点的调用开销（K2 单次 12-43s）超过藏进窗口的工作量 |
| L4 获胜区间实测 | bench-l4 系列 | 发现式慢 follow-up 地形：默认 243.0s → OOO **176.3s（1.38×，省 27.5%）**；spawn 比基线早 100s 启动 |

**OOO 成本模型（双向实证）**：

> 拆分判据：分支工具延迟 > 模型单次调用开销（~10-40s）**且**该分支后续工作
> 无法被折叠进 join 后的一次调用时，拆节点才划算。否则 planner 应融合节点。

一句话：**OOO 的收益不来自"并行"，来自"提前决策"**——关键决策依赖的数据早到，
模型就早看到、早行动；若所有决策都必须等全部数据，拆节点只有开销没有收益。

**数字的诚实边界**：27.5% 是该配置、该场景的一次历史观测（两侧计时口径、
prompt、上下文不同，无配对重复与置信区间），不是通用加速承诺。
阴性结果（L3）与阳性结果（L4）同等重要，都必须保留在报告里。

---

## 4. 已知缺陷（源码审查 P1/P2，按优先级）

审查全文见 [ooo-agent-runtime-review.md](ooo-agent-runtime-review.md)。以下为摘要：

**P1（安全与一致性，开源前必修）**

1. **DAG 绕过工具独占约束与并发上限**：DAG 路径不读 `executionMode`，
   不执行 exclusive barrier，不遵守 `maxParallelToolCalls`（已核实：
   dag.ts / scheduler.ts 全文无相关引用）。
2. **失败后继续派发**：调度循环先 dispatch READY 再检查 failure；
   REASON 的 FIFO 链启动前不查停止状态（已核实 scheduler.ts:222-249）。
3. **inbox / follow-up 不收敛**：DAG 分支在 inbox claim 之前且结束直接返回，
   首轮输入与运行中 follow-up 留在 pending。
4. **新路径未继承标准请求机制**：REASON 直接 `ctx.llm.stream`，跳过
   prompt assembly、agent/pre-step、agent/request、标准输出记录。

**P2（正确性细节）**

5. 工具 `isError` 被降为普通文本，依赖节点照常放行；非法 JSON 参数被静默改写成 `{}`；
   `additionalContexts` / `concludesTurn` 丢失。
6. 取消后排队 REASON 仍进入 stream；`finish(aborted)` 可能当空文本成功；
   无并发/深度/token 预算与超时。

**已修复**：测试导入指向原包导致"测试在测原版"的问题（2026-09-17）；
patch.yml 硬编码绝对路径已参数化为包名（同日实测通过）。

---

## 5. 路线图

按"先安全、再集成、后增强"排序（与外部评审建议一致）：

| 阶段 | 内容 | 对应外部参照 |
|---|---|---|
| R1 安全与一致性 | exclusive/并发仲裁、fail-stop、取消传播、结构化错误、inbox 收敛、参数校验 | 默认 loop 的 tool-calls.ts 是现成参考实现 |
| R2 Harness 集成 | 抽取共享"节点请求执行"能力（准入/重试/流状态机/用量日志）；真实 Loader 组合测试 | dsh ProjectionDefinition seam |
| R3 因果事件日志与恢复 | node-created / settled / validated / committed 落账；崩溃重放从 READY 边界恢复 | Temporal 思路；不承诺跨系统 exactly-once |
| R4 资源与关键路径调度 | READY 队列由 scheduler 按"解锁价值"排序，替代 FIFO | B-PASTE 的 downstream unlock value |
| R5 **System-1 决策层** | 定义 `decide(state, questions)` 抽象（typed decision + confidence），用于：观察价值评估、READY 优先级、commit gate 风险门、失败策略选择、REASON 模型路由、卡住检测。后端可接 Jev / 本地小模型 / 规则 | Jev（TypeSafe AI, 2026-09）验证了"决策点专门化"方向；只借鉴接口形态，不绑定供应商 |
| R6 纯工具推测执行 | 小预算、可取消、匹配 action 和输入状态后复用；副作用操作只在隔离/提交协议建立后考虑 | PASTE / AOSpec / Speculative Actions |

**里程碑原则**：近期目标不是"完整复制 CPU"，而是一个**可在真实 Harness 中启用、
不破坏工具与会话语义、能在发现式任务中稳定缩短关键路径**的调度插件。

---

## 6. 与外部工作的关系（2026-09 核实）

| 工作 | 关系 |
|---|---|
| AI Metropolis (2024) | 已有 CPU OOO/scoreboard 类比先例——**不能宣称首次**；它是多 agent 仿真时间步，不是单 agent 工具 runtime |
| LLMCompiler (ICML'24) | 有动态 replanning + streamed planner——**不能写成静态 DAG**；是最该补跑的直接基线 |
| Google ADK long-running tools | "工具等待期间继续工作"已有产品化功能——**不是空白**；但不等于自动动态 DAG + 提交协议 |
| PASTE / B-PASTE / AOSpec (2026) | 推测执行方向的强参照，比本项目当前版更远（分支预测、CoW 隔离、状态验证）；属 R6  roadmap |
| Jev / System One (2026-09) | 模型侧的"决策点专门化"——与 REASON/TOOL 分离是同一逻辑的模型版；R5 借鉴其接口形态 |
| vLLM speculative decoding | token 级推测，与本项目的动作级调度是不同层，可叠加 |

可争取的差异化：**分支局部的发现与续跑、复用 Harness 安全约束、可重放的因果事件、
状态冲突检测、可验证的提交与恢复。**

---

## 7. 仓库地图

```
ooo-runtime/
├── README.md                # 项目门面（Python 原型 + 快速开始）
├── docs/
│   ├── OOO-Agent-Runtime-设计总览.md      ← 本文（单一权威入口）
│   ├── DSH-OOO-Loop-设计.md              # dsh fork 实现细节（源码核实版）
│   ├── OOO-Agent-Runtime-技术报告.md      # 实验叙事（从原型到真实模型）
│   ├── ooo-agent-runtime-review.md       # 外部源码审查（P1/P2 问题清单）
│   ├── ooo-agent-competition-evidence.md # 竞品证据（一手来源核实）
│   └── assets/                           # 甘特图
├── ooo_runtime/  examples/  benchmarks/  # Python v0.1 原型
└── dsh-plugin/                           # dsh 插件线
    ├── packages/ooo-loop/                # fork agent-loop（418 测试全绿）
    ├── packages/ooo-mock-lab/            # mock 实验室 + bench patch 系列
    └── dsh-integration.patch             # 宿主集成 patch（pnpm-lock + tsconfig）
```
