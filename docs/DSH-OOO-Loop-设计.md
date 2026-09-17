# DSH OOO Loop 设计（v0.2 · 源码核实版）

> 目标：把 DeepSeek Harness 的默认 agent loop 换成一个**事件驱动的乱序调度器**——
> 慢工具 pending 期间，模型去跑其他已就绪的工作，结果回来后唤醒依赖它的节点。
> 本文基于对 dsh 源码（`packages/core`）的实际阅读，所有接口结论都有文件依据。

---

## 0. 三句话版本

1. **dsh 的默认 loop 是 ReAct**：模型请求 → 等工具 → 模型请求 → 等工具……一条直线。
2. **OOO loop 把直线改成任务网**：每个模型请求、每个工具调用都是网上的节点，只记录"谁依赖谁"；调度器永远挑"依赖已齐"的节点立刻执行，模型绝不空等慢工具。
3. **最难的不是并发，是讲故事**：dsh 铁律"模型看到的每个字必须能从会话日志重建"，乱序执行后要用**按依赖族谱讲故事**（祖先锥投影）来满足它，而不是按时间顺序念流水账。

---

## 1. dsh 默认 loop 现在怎么跑（源码版）

源码位置：`packages/core/agent-loop/`。

默认驱动器类名就叫 **`ReactLoopAgent`**（`agent-loop/src/agent.ts`）——名字直接表明了范式。

执行层级：

```
turn（一次用户请求）
 └── step（一次模型请求 + 它发起的工具调用）
      ├── 模型 streaming 输出
      ├── 模型给出若干 tool calls
      ├── executeToolCalls() 执行（tool-calls.ts）
      └── 结果到齐 → 进入下一个 step
```

**一个重要发现**：`tool-calls.ts` 的文件头注释写着——

> "Dispatch may overlap, while policy, results, and result context remain **model-ordered**."

即 dsh 在**单个 step 内部**已经实现了 reorder buffer：

- 一个 step 里模型一次发多个工具调用，runtime 用有界并发池（`DEFAULT_MAX_PARALLEL_TOOL_CALLS`）并发执行；
- 标记为 exclusive 的调用构成 barrier；
- 无论执行顺序如何，**结果永远按模型给出的顺序提交**；
- abort 时为未启动的调用补写合成错误结果，保证 replay 依然有效。

**所以 dsh 已经有"乱序执行、按序提交"，但范围只有一步。** OOO loop 的本质就是把这个机制从"一步之内"放大到"整个会话"。

---

## 2. 用投研报告例子走一遍

任务：分析一家公司 = 查财报(12s) + 查新闻(2s) + 查行业(8s) + 查竞品(4s)，分别分析后写综合报告。

### 默认 loop（现在的 dsh）

```
step 1  模型：并行发起 4 个查询工具          ┐
        工具并发跑，但 step 不结束            │ 模型在等
        2s 新闻回来 …… 继续等                 │ 12s
        12s 财报终于回来，4 个结果一起提交      ┘
step 2  模型看到 4 份数据，做财务分析
step 3  模型做新闻分析
step 4  模型做行业分析
step 5  模型做竞品分析
step 6  模型写综合报告
```

痛点：**新闻 2s 就回来了，但模型要到 12s 后才能碰它**——join 屏障把最快的结果和最慢的工具绑在一起。

### OOO loop（我们要做的）

```
t=0    模型（规划节点）发起 4 个查询 → 变成 4 个后台 TOOL 节点，模型请求结束
t=2    新闻回来 → "新闻分析"节点 READY → 模型立刻开始分析新闻   ←不等财报
t=4    竞品回来 → "竞品分析"READY → 排队上模型
t=8    行业回来 → "行业分析"READY
t=12   财报回来 → "财务分析"READY → 分析中发现需要现金流明细
       → 动态 spawn 两个新节点（查现金流 → 现金流分析）
t=…    所有分析 DONE → "综合报告"READY → 模型写报告
       → "发送邮件"（不可逆）过提交屏障后执行
```

v0.1 Python 原型实测：同一场景 59s（串行）→ 45s（join 并发）→ **36s（OOO）**。

---

## 3. OOO loop 相对默认 loop 的三个改动

| # | 改动 | 一句话 |
|---|---|---|
| 1 | **工具调用不阻塞** | tool call 变成后台节点，不 await；完成时发事件 |
| 2 | **模型请求按"就绪"调度** | agent core（模型）同一时刻只服务一个节点，但永远挑 READY 的跑，不空等 |
| 3 | **每个节点只看自己的上游** | 节点 N 的模型上下文 = 基础信息 + N 的所有依赖节点的结果（祖先锥），而不是"全部历史" |

动态依赖发现不需要发明新协议：**把 `spawn_task` 注册成一个普通工具**（进 `ctx.tools`），模型想派生子任务就调它——复用原生 function calling。

---

## 4. 核心张力：乱序执行 vs "模型可见即已记录"

### 铁律

dsh 有一条运行时不变量（`session` 包强制）：**模型看到的每个字，都必须能从 append-only 的会话日志重建**。崩溃恢复、fork、resume、UI 渲染全部建立在这本账上。

### 矛盾

乱序执行 = 事情**完成**的顺序乱了（新闻分析可能比财报查询先写完）。
但模型是"读小说"的——每次请求只能读一段**线性**文字。
把一本顺序乱掉的账，讲成通顺的线性故事，怎么办？

### 解法：流水账照记，讲故事换方式

1. **账照记**：每个事件追加进日志（铁律不破），但多盖两个章：`node`（我属于哪个节点）、`parents`（我依赖谁）。
2. **讲故事按族谱，不按时间**：节点 N 要发模型请求时，从账里只挑出 **N 的祖先们**的事件，按依赖顺序念给它听。这就是**祖先锥投影（ancestor-cone projection）**。
3. **铁律形式化后依然成立**：给模型看的每个 token 都能从日志重建——我们只是注册了另一种**纯函数投影**。dsh 官方预留的正是这个 seam：`ProjectionDefinition = { key, init, apply }`，一个纯的事件折叠器（`agent-loop/src/index.ts:55` 的 `turnBoundaryProjectionDefinition` 就是完整范例，可直接照抄模式）。

**副作用走另一条规则**：发邮件、写库这类不可逆操作，按**退休序**提交——所有依赖真正落定 + 审批通过才执行，拦截点就是现成的 `tools/pre-execute` waterfall 事件。

一句话总结：**乱序执行、按依赖读、按序退休。**

### 附带收益

- **省 token**：分支 B 的模型请求根本看不到分支 A 的中间噪音；
- **冲突显式化**：两个分支基于不同假设推进时，综合节点的投影给每份结果带来源分支标签，交给模型裁决，而不是 runtime 假装世界一致。

---

## 5. 源码核实结果（2026-09-16，基于本地 clone）

| 设计假设 | 源码证据 | 结论 |
|---|---|---|
| 默认 loop 可替换 | `core/agent-loop` 是普通插件，`ReactLoopAgent` 经 `AgentFactory` 注册 | ✅ 但替换粒度见"未决问题" |
| Agent 接口 | `core/agent/src/types.ts`：极小，`{ id: SessionId }` + factory 模式（`CreateAgentOptions`/`ResumeAgentOptions`） | ✅ |
| step 内已有 reorder buffer | `tool-calls.ts` 头注释 + `DEFAULT_MAX_PARALLEL_TOOL_CALLS` | ✅ **最好的参考实现**（290 行，含 abort drain、合成结果、按序提交） |
| 自定义 projection | `ProjectionDefinition`（`session-projection` 包），`SessionProjectionStateMap` 可模块增补，`turnBoundaryProjectionDefinition` 为范例 | ✅ |
| 用户输入中途进入 | inbox 双队列 `'next-turn'/'next-step'`，持久事件 `agent/inbox/spliced` | ✅ 中途消息 = 插入新节点 |
| preset 按会话组装 | `preset/agent-presets`：preset 的 `agent.cordis.yml` 列插件；用户 preset 放 `<dshHome>/.agent-presets`；同进程多 preset 会话互相隔离 | ✅ 工具/提示词/skill 粒度 |
| `tools/pre-execute` 可拦截 | 架构文档事件映射 + tools 包把关流水线 | ✅ |

---

## 6. 事件词汇与 projection 设计（草案）

新增持久会话事件（挂进 `SessionEventMap`）：

| 事件 | 含义 | 类比 |
|---|---|---|
| `ooo/node` | 节点创建（id、kind、parents、effect_class） | 指令进入 ROB |
| `ooo/dispatch` | 节点开始执行 | 发射到执行单元 |
| `ooo/settle` | 节点结果落定（模型消息/工具结果引用） | retire |
| `ooo/cancel` | 节点及其子树取消 | pipeline flush |

模型消息与工具结果**复用现有事件**（`assistant/message`、`tool/call`、`tool/result`），只在 data 里附带 `{ooo: {node, parents}}` 元数据——UI 与 fork/resume 的既有机器全部继续工作。

注册两个 projection：

- `oooGraph`（host 用）：折叠出当前 DAG 状态（READY/RUNNING/DONE），调度器与恢复都读它；
- `oooHistory(nodeId)`（发模型请求前用）：祖先锥折叠，产出该节点的线性上下文。

恢复语义：崩溃后重放日志 → `oooGraph` 重建到 READY 边界 → 从断点继续。这与 v0.1 的事件溯源思路一致。

---

## 7. 提交屏障与副作用

1. 工具声明 `effect_class`（pure / idempotent / irreversible），放插件配置的策略表或工具元数据；
2. `tools/pre-execute` 包一层 wrapper：`irreversible` 工具仅当 (a) 依赖全部 `ooo/settle`、(b) 审批通过时才放行；
3. 审批复用 dsh 现有管线——审批等待天然就是一个 pending 节点，不阻塞其他分支；
4. 非 `pure` 工具永远不参与（未来的）推测预执行。

---

## 8. 未决问题（按风险排序）

1. **preset 能否换掉 loop 驱动本身？** preset 组装的是工具/提示词/skill；`ReactLoopAgent` 是 host 层 factory 创建的。若 preset 不能换 loop，则退路：在测试 profile 里用 `cordis.patch.yml` 全局替换 loop 插件（不影响 web 主 profile）。**这是 M1 第一个要验证的点。**
2. **settlement 复用粒度**：默认 loop 的 stream settlement（`assistant-stream.ts`）与 step 绑定较紧，节点粒度复用需要读 `agent.ts` 的 620 行细节。
3. **取消传播**：`tool-calls.ts` 的 abort drain 语义是 step 级的；DAG 级取消（取消某子树）需要自行定义合成结果的写法。
4. **UI 渲染**：OOO 事件在 Web UI 里先按时间线平铺（兼容），树形视图留作后续。

---

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 源码核实未决问题 1/2；最小 OOO loop（静态 DAG、无 spawn、时间序投影）在测试 profile 跑通一个会话 | 能完成投研场景，事件完整落账 ✅（2026-09-17 M1b：headless 双跑对照成立，见下文实测）|
| M2 | spawn 动态发现 + 祖先锥投影 | spawn 已闭环（2026-09-17：tool-call 即 spawn，依赖改道正确，trace 完整）；祖先锥提示词注入已随 L3 闭环；会话级祖先锥投影待做 |
| M3 | effect_class + 提交屏障 + 审批集成 | 不可逆工具未被提前执行；崩溃重放可恢复 |
| M4 | 对照 benchmark：同任务默认 loop vs OOO loop | makespan / token 成本 / 利用率 报告 |
| M5 | 推测执行（pure 工具预取）+ bundle 发布（`dsh-plugin` topic） | 插件可安装 |

### M1 进展（2026-09-16）

已完成骨架：

- fork：`packages/core/agent-loop` → `packages/experimental/ooo-loop`（`@deepseek-ai/dsh-ooo-loop`，private）；factory/生命周期/inbox/settlement/invariant 原样保留
- `src/scheduler.ts`：v0.1 Python 调度器的 TS 移植（TaskGraph / READY 扫描 / 单槽 reason core / commit gate / spawn），已导出、**尚未接入驱动**
- `ooo.patch.yml`：profile patch（禁用 `agent-loop` 两行、插入 ooo-loop；因本包不在依赖链中，name 暂用绝对路径指向 `lib/index.js`）
- 构建：已登记进 `tsconfig.host.json` references（唯一一处对既有文件的改动，纯增量一行）；`build:lib:host` + tsdown 通过
- 冒烟测试 `scripts/smoke.mjs` 全绿：模块可加载；调度器复现 Python v0.1 数字（makespan 36.2s、利用率 61%、spawn 2 节点、commit barrier 成立）

未决问题 1 已闭环：**preset 无法换 loop**（`setFactory` 全局唯一 + `mountPreset` 由 factory 的 setup 调用），采用 profile 级替换方案。

遗留：`pnpm run build` 全量构建在 `build:native-system`（Rust 原生模块）失败，与本包无关；`pnpm dsh web --patch` 端到端加载验证待做。

### 端到端加载验证（2026-09-16 晚，已闭环）

- native 构建失败根因：Kimi 内置 Node 无开发头文件；改用 Homebrew Node 跑 `build:native-system` 成功产出 `system.node`（flock）。
- web profile 需要前端产物（`build:lib:client`+`build:web`），验证改用更轻的 **headless profile**。
- `pnpm dsh --profile headless --patch .../ooo.patch.yml "say hi"` 推进到 `MISSING_CREDENTIAL`（无 API key）——即插件加载、factory 注册、会话创建、轮次驱动全部成功；与默认 loop 对照组错误逐字节一致，fork 是完美 drop-in。

### 开发-验证-benchmark 闭环（2026-09-17）

三层验证金字塔，每层有固定工具和固定动作：

**L1 算法层（秒级，每次改 scheduler 都跑）**
- `packages/experimental/ooo-loop/scripts/smoke.mjs`：构建产物的模块加载 + 调度器数字复现（makespan 36.2s / 利用率 61%）。
- 后续补 vitest 单测挂进仓库测试体系。

**L2 确定性 E2E（分钟级，无 API key，每个里程碑跑）**
- `packages/experimental/ooo-mock-lab`：**脚本化 mock LLM 适配器**（`LlmAdapter.stream()` 按序回放 script，每条响应固定 thinkMs 延迟）+ **定时 mock 工具**（`mock_fetch`，latencyMs 参数控制，`isConcurrencySafe: true`）。
- 运行：`pnpm dsh --profile headless --patch packages/experimental/ooo-mock-lab/bench.patch.yml "<任务>"`；patch 把 `agent-default-model` 路由到 mock 并禁用 `session-title-llm`（标题生成会消耗脚本、污染确定性——已踩过）。
- 计时：`scripts/extract-timing.py` 解析会话日志（`~/.dsh/sessions/**/session.v3.jsonl.zstd`，字段 `time`/`seq`/`sourceEventSeqs`）输出毫秒级时间线。

**L2 基线已建立（默认 loop，2026-09-17 实测）**

场景：think 500ms → `mock_fetch(财报 2000ms)` ∥ `mock_fetch(新闻 500ms)` → think 500ms → 答案。

```
   0ms  turn/start
  83ms  step/start
 606ms  tool/call   mock_fetch(财报)   ← 思考 523ms
 609ms  tool/call   mock_fetch(新闻)   ← 两个调用相隔 3ms 同时派发
2623ms  tool/result (财报 2017ms)
2623ms  tool/result (新闻 2014ms)      ← 新闻 500ms 就完成，却等到 2623ms 才提交
2623ms  step/end
3143ms  turn/end                       ← makespan 3143ms ≈ 预测 3000ms
```

**这就是 join 屏障的实证**：新闻结果白白等了 1.5s。OOO loop 要消灭的正是这段。

**L3 真实模型 benchmark（已跑通，见下文 L3 小节）**
- 路由：`DEEPSEEK_API_KEY="$KIMI_API_KEY"` + `DEEPSEEK_BASE_URL=https://agent-gw.kimi.com/coding`，模型 `kimi-k2-0905-preview`；场景 `bench-l3.patch.yml`（真实模型 + 确定性 fetch_data 工具）；指标加 token 成本（待接 token-meter）。

**闭环流程**：改代码 → L1（秒）→ L2 双 loop 同场景对比（分钟）→ 里程碑验收 → L3 复测 → 数字回写本文档。

**场景公平性原则**：两种 loop 下模型产出的**工作内容必须相同**（同样的工具、同样的延迟、同样的思考时间），只是编排不同——默认 loop 跑自然脚本（串行 step），OOO loop 跑 plan-first 脚本（DAG 声明依赖）。依赖来自显式声明（planner / spawn_task），不是 runtime 猜测。

### M1b before/after 实测（2026-09-17，已闭环）

**实现**：`ooo-loop/src/dag.ts` 新增静态 DAG 驱动路径——`ReactLoopAgent.turn()` 开头挂钩，turn 1 且配置了 `dag` 时改走 `runOutOfOrder()`；TOOL 节点走真实工具运行时管线（`TOOL_RUNTIME_SCHEDULER` 的 prepare→dispatch→finalize，与 `tool-calls.ts` 同一条路），REASON 节点是独立一次性模型请求（依赖结果注入提示词），调度器单槽串行。mock 适配器扩展 `match` 字段按最后一条 user 消息内容路由响应（OOO 请求顺序是调度器决定的，顺序脚本不适用）+ 每条响应独立 `thinkMs`。

**一个重要设计修正**：OOO 指标**不写会话事件**。核实发现 `Session.append()` 根本不接受 `ignorable` 参数（它只是事件信封上的只读标记，种子导入路径才认得），自定义 `ooo/*` 事件一旦落账，任何不认识该类型的 reader 都会拒绝重建会话。因此 trace 走 side-channel JSON（`dag.tracePath`），会话日志只保留标准的 `turn/start`/`turn/end` 边界——OOO 会话依然合法可回放。

**场景**（两组逻辑工作完全相同）：4 路抓取（财报 2000 / 公告 1500 / 新闻 1000 / 研报 500ms）+ 4 个分析（各 500ms 模型时间）+ 1 个综合（500ms）。

- 基线（默认 loop，`bench.patch.yml`）：step 1 并发 4 个 fetch（join 屏障），step 2 一次请求做完 4 分析+综合（thinkMs 2500 = 5×500）
- 实验组（OOO loop，`bench-ooo.patch.yml`）：9 节点 DAG，fetch 并发，分析就绪即跑、与抓取重叠

**结果**（各跑 2 次）：

| 指标 | 默认 loop | OOO loop | 理论预测 |
|---|---|---|---|
| makespan | 5140 / 5160ms | **3048 / 3052ms** | 5000 vs 3000ms |
| 核心（模型）利用率 | ≈59% | **≈82%**（2511/3048） | — |
| 加速比 | 1× | **1.69×（节省 41%）** | 1.67× |

OOO trace 的关键证据：`fetch-research`（500ms）在 +537ms 落定，`analyze-research` **同一毫秒**上核，此时财报抓取还在跑——分析与慢工具的重叠完全成立，核心从 +500ms 起排满到结束，零空闲。基线侧 4 个工具 600ms 同时派发、结果全部等到 2622ms 才提交（join 屏障实证再现）。

结论：在真实 dsh 驱动、真实工具管线、真实会话日志上，OOO 调度复现了 Python 原型的收益量级（原型 1.64×，dsh 实测 1.69×），且实测与理论预测误差 <3%。调度逻辑本身零成本——收益全部来自消灭等待。

### M2 第一刀：spawn 动态发现（2026-09-17，已闭环）

**机制**：REASON 节点的模型响应里带 tool-call 块即构成 spawn 请求——模型不需要学新工具，普通 function call 就是动态发现的载体。DAG 驱动把这类节点拆成：当前节点完成（初步结论）→ 每个 tool call spawn 一个 TOOL 节点（`<id>-call-<n>`）+ 一个续跑 REASON 节点（`<id>-cont`，依赖父节点与这些工具结果，提示词自动注入父节点初步结论）。

**核心正确性点——依赖改道**：静态依赖 spawner 的下游节点必须改挂到续跑节点上，否则「综合结论」会在竞争对手数据回来之前就拿初步结论开跑。`TaskGraph.rerouteDependents(fromId, toId)` 在 spawn 瞬间把 pending 下游的依赖改写为 cont 节点（cont 自身尚未入图，其对父节点的合法依赖不受影响）。

**场景**（`bench-spawn.patch.yml`）：bench-ooo 的 9 节点 DAG，「分析财报」的模型响应带 `mock_fetch(竞争对手财报, 800ms)`。

**实测**（一次跑通，与预测逐节点吻合）：

```
   0ms → 2034ms  tool   拉取财报         ┐
   1ms →  536ms  tool   拉取研报          │ 4 路并发
   1ms → 1033ms  tool   拉取新闻          │
   1ms → 1533ms  tool   拉取公告         ┘
 536ms → 1039ms  reason 分析研报         ┐
1039ms → 1541ms  reason 分析新闻          │ 核心排满
1541ms → 2043ms  reason 分析公告          │
2043ms → 2546ms  reason 分析财报 → spawn ┘
2546ms → 3349ms  tool   竞争对手财报      ← 动态发现的工具（核心唯一空闲窗口）
3349ms → 3851ms  reason 继续分析财报      ← 续跑，拿到对标数据
3851ms → 4353ms  reason 综合结论          ← reroute 生效：在 cont 之后才开跑
```

makespan 4354ms（预测 ≈4300ms），图从 9 节点长到 11 节点，spawned 边完整落 trace。默认 loop 下同等动态发现需 500+2000+500+800+500+500 = 4800ms——单 spawn 链差距不大（串行链本就压缩空间有限），收益随并行分支数放大；这里验证的是能力与正确性。bench-ooo 回归通过（3049ms，spawned 0）。

**遗留**：spawn 出的 TOOL 节点暂不经过审批/commit gate 分级（M3）；REASON 请求的 `tools` schema 未传给模型（mock 不需要，L3 真实模型必须补）；递归 spawn（cont 再 spawn）机制已支持但未测。

### L3 真实模型首跑（2026-09-17 晚，已闭环）

**路由**：本机无 DEEPSEEK_API_KEY，但 `KIMI_API_KEY`（sk-kimi 前缀，Kimi-for-coding 订阅 key）可用，其 gateway 是 `https://agent-gw.kimi.com/coding`（Anthropic messages 协议）。llm-deepseek 适配器支持 `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY` 环境变量重定向，模型填 `kimi-k2-0905-preview` 即可——**零代码改动接入真实模型**。工具保持确定性（mock-lab 新增拟真 `fetch_data`：延迟来自 config 而非工具参数——延迟是数据源的属性，不该由模型发明；罐头数据按 topic 配置）。

**踩坑 1——静默失败**：适配器级错误（认证失败等）通过 `finish` chunk 的 `reason.kind === 'error'` 上抛，**不是异常**。runReasonNode 最初只收集 text 块，把认证失败吞成了"空分析"（节点全部"成功"、makespan 2.3s 的假象）。修复：遇到 error finish 直接 throw，节点失败、轮次报错。教训：任何自写的 stream 消费端都必须显式处理 finish/error。

**踩坑 2——上下文断链**：首次真实 spawn 跑通后发现续跑节点丢失了原始财报上下文——cont 的直接依赖只有父节点（其 text 在发 tool call 时通常为空）和 spawn 的工具结果。修复：REASON 节点的提示词上下文从「直接依赖」升级为「**祖先锥**」（transitive ancestor cone，DFS 拓扑序注入）——这正是 M2 设计里祖先锥投影的提示词侧微缩版，一次修复到位。

**模型行为观察**：提示词只说"如需……可调用"时，K2 选择不调用（宁可声明"在不掌握对标企业的情况下"）；提示词改为"必须先调用"后才真实 spawn。说明 spawn 的触发强度需要在 planner 提示词层面显式设计，不能指望模型自发。

**实测**（真实模型延迟不可控，数字仅作存在性证明）：

```
 0.0s →  2.0s  tool   拉取财报（+3 路并发）
 0.5s → 13.4s  reason 分析研报      ← 研报到手即上核，OOO 重叠成立
13.4s → 28.4s  reason 分析新闻
28.4s → 51.5s  reason 分析公告
51.5s → 59.4s  reason 分析财报 → 模型真实发起 fetch_data(竞争对手)
59.4s → 60.2s  tool   竞争对手数据（spawn）
60.2s → 95.6s  reason 继续分析财报  ← 产出本公司 vs 竞争对手对标表
95.6s →123.9s  reason 综合结论      ← reroute 生效，结论含对标
```

makespan 123.9s，核心利用率 99%。最终投资结论质量达标（含对标表、风险提示）。**"真 OOO loop"第一次不靠脚本跑通：真实模型在运行中自主扩展了任务图，调度器正确接管了它没见过的新节点。**

诚实备注：真实模型调用（10-50s）远大于工具延迟（0.5-2s）时，OOO 的重叠收益被稀释（利用率天然就近 100%）；OOO 的主战场是**慢工具**场景（分钟级网页抓取、文件分析、人工审批等待），那里模型核心空转才是大头。L2 的数字（1.69×）刻画的正是那种场景。

### L3 慢工具正面对决（2026-09-17，阴性结果，比赢更有价值）

场景：同一批逻辑工作，真实 K2，财报 fetch 90s（模拟深度抓取）+ 3 路快数据。默认 loop（`bench-l3-baseline.patch.yml`）由模型自己并行发起 4 路 fetch；OOO（`bench-l3-slow.patch.yml`）跑同结构 DAG。

| | 默认 loop | OOO loop |
|---|---|---|
| makespan | **129.0s** | 165.1s（慢 28%） |
| 模型核心总占用 | 38.9s（2 次调用） | 133.6s（5 次调用） |

基线时间线（教科书级 join 屏障）：7.4s 思考 → 4 个 fetch 在 8ms 内同时派发 → **结果全部等到 97.5s 才提交**（500ms 的研报了等 90s）→ 一次 31.5s 调用完成全部分析+综合。

OOO 机制本身完好：3 路快数据分析（58.6s 核心工作）全部藏进 90s 抓取窗口，核心仅空闲 31s。**败因是调用开销**：基线 join 后一次调用（31.5s）折叠了全部后续工作；OOO 窗口后还需两次完整调用（42.9 + 32.2 = 75.1s）。K2 单次调用固定开销（思考+TTFT）12-43s，拆节点产生的开销超过了藏进窗口的工作量。

**核心教训——L2 假设在真实模型下反转**：mock 世界每次调用 500ms，拆节点免费，故 1.69×；真实模型每次调用开销是 20-50 倍，节点粒度经济性反转。由此得到第一版 **OOO 成本模型**：

> 拆分判据：分支工具延迟 > 模型单次调用开销（~10-40s）**且**该分支后续工作无法被折叠进 join 后的一次调用时，拆节点才划算。否则 planner 应融合节点（多个小分析合并为一次调用）。成本模型进 planner 是 M3 课题。

**OOO 的真实获胜区间**：分支有**异质后续工作**时——例如某分析分支需要自己 spawn 抓取（上一轮已验证），基线无法把这种后续折叠进一次调用，只能串行追加"思考→抓取→再分析"轮次，OOO 则只延长该分支、其他分支早已完成。估算该场景：基线 ≈ 200s vs OOO ≈ 164s（待实测）。

### L4 获胜区间实测（2026-09-17，成本模型双向验证完成）

地形设计：**发现式慢 follow-up × join 屏障**。新闻数据 1s 到手但舆情异常需深度核查（90s 慢工具）；财报抓取本身 90s。触发条件是条件式的（"如果舆情异常，必须调用 fetch_data 深度舆情"），模型看不到数据就无法决策——**folding 在这种地形上失效**。

| | 默认 loop | OOO loop |
|---|---|---|
| makespan | 243.0s | **176.3s（快 66.7s，1.38×，省 27.5%）** |

默认 loop（`bench-l4-baseline.patch.yml`）：13.8s 派发 4 路 fetch → join 等到 103.8s → step 2 分析至 122.4s 才发现异常、发起深度核查 → 核查 212.4s 才结束 → 综合 243.0s。**模型诚实地遵守了条件触发，没有在 step 1 盲目预取**——这正是"发现式"的含义。

OOO（`bench-l4-ooo.patch.yml`）：分析新闻 13.8-22.5s 发现异常 → **22.5s 就 spawn 深度核查，比基线早 100s** → 核查（22.5-112.5s）与财报抓取（0-90s）、其他分析完全重叠 → 综合 176.3s 完成，且正确等到续跑（reroute 第三次生效），最终报告包含核查结论。

**完整成本模型（双向实证）**：

| 地形 | 胜者 | 机制 |
|---|---|---|
| 慢工具 + 后续工作可折叠（L3） | 默认 loop（129 vs 165s） | join 后一次调用折叠全部分析；OOO 每次调用固定开销 12-43s，拆节点净亏 |
| 慢工具 + 发现式慢 follow-up（L4） | OOO（176 vs 243s） | 基线的 join 屏障推迟了"发现"，慢 follow-up 启动晚 ~100s；OOO 分支自治，发现即行动 |

判据一句话：**OOO 的收益不来自"并行"，来自"提前决策"**——只要关键决策依赖的数据能早到，OOO 就让模型早看到、早行动；若所有决策都必须等全部数据（可折叠地形），拆节点只有开销没有收益。

---

## 附：与 v0.1 Python 原型的对应

| v0.1（`ooo_runtime/core.py`） | dsh OOO loop |
|---|---|
| `Task(kind=REASON)` | 节点粒度的一次模型请求（走 `ctx.llm`） |
| `Task(kind=TOOL)` | 后台工具执行（走 `ctx.tools` 把关流水线） |
| `TaskGraph.ready()` | `oooGraph` projection 的 READY 视图 |
| `Task.spawn` | 模型调用 `spawn_task` 工具 |
| `EffectClass.IRREVERSIBLE` + commit gate | `tools/pre-execute` wrapper + 审批 |
| agent core `Semaphore(1)` | 调度器内单槽模型请求队列 |
