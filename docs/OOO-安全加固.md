# OOO 插件第一轮正确性加固

## 范围

本轮只加固 `dsh-plugin/packages/ooo-loop` 的现有实验路径，不改 Python 原型或宿主源码，不实现推测执行、完整持久恢复或事务提交。不配置 `dag` 时保留普通对话循环；配置时仍然只在首轮执行手写 DAG。

## 改动

### 调度器

以实际执行槽代替 REASON Promise 排队链：同时只有一个 REASON 执行，其他节点保持 pending。失败、取消、分类或派发异常后停止新增执行，统一排空已经启动的任务再返回错误。两参数调用仍可用，新增可选 `signal`、`maxParallelTools`、`toolMode`；默认工具并发由无限改为 10，限制必须是正整数。

工具按实时分类准入：parallel 受上限限制，exclusive 等待其他工具完成并独占至 finalize；等待中的 exclusive 阻止后续工具绕行。独立 REASON 可以与工具重叠。`irreversible` 工具额外强制 exclusive，但依赖门禁不是全局按序退休，更不是外部事务回滚。

### DAG 与宿主工具

实际 Agent 入口将 `maxParallelToolCalls` 传给 DAG；DAG 用 `ctx.tools.executionMode` 获取当前分类。工具 `isError` 不再被抹平为成功文本，依赖节点不会因此被放行。模型派生调用必须来自已展示的图声明工具集合；参数必须是 JSON 对象，禁止把坏 JSON 静默改为 `{}`。

REASON 必须有成功 finish（stop/tool-calls）；aborted、max-tokens、error、未知结束原因或缺少 finish 都使节点失败。本版选择失败停止，不提供自动重试或错误恢复边。

### 首轮输入与后续消息

DAG 首轮领取并记录触发输入；它只是配置图的触发器，不是自然语言 planner。移除提前退出，走公共 pending 收敛流程，运行期间新增 followup 不再悬挂或重放旧输入。领取前、领取后、逐条输入入日志后检查取消。已移除的唤醒输入不启动图。trace 异步写入结束和 DAG 返回 Agent 后也检查取消：写 trace 期间发生取消时，当前轮记为 aborted，`keepInbox: true` 保留的 followup 不会自动被下一轮消费。trace 文件可能已经写出，因此存在 trace 不代表 Agent 轮次成功。

### 测试入口

保留远端已修复的 `@deepseek-ai/dsh-ooo-loop` 测试自引用及 invariant 命名，新增包级 `vitest.config.ts` 将其解析到当前 fork。宿主 testkit 间接导入原 loop，因此配置还必须将原 loop/invariant 精确 alias 到同一份 fork，避免重复注册。新增 scheduler、DAG 和 inbox/实际工具准入回归测试。包 README 改为说明 OOO 的真实行为与边界，不再照搬默认 loop 文档。

## 验证

在宿主固定版本 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的临时副本中安装测试依赖，使用 Node 24.21.0、Vitest 4.1.11 执行。未调用真实模型、未覆盖历史 benchmark trace。

```sh
# 假设已按 dsh-plugin/README.md 拷入插件并安装宿主依赖，从宿主根目录运行
pnpm exec vitest run --config packages/experimental/ooo-loop/vitest.config.ts --maxWorkers 2
node ./node_modules/typescript/bin/tsc --build packages/experimental/ooo-loop --pretty false
```

合入远端 `d4d914f` 后重新验证：28 个测试文件、468 个测试全部通过（含四个新增文件的 50 个回归测试），TypeScript 项目引用构建通过。测试未调用真实模型。新增行为按逐项 RED→GREEN 验证；补充既有成功路径测试不冒充红测。源码级 Cordis 集成不等于 Loader/已发布 CLI 端到端验证，也没有证明真实模型的性能变化。

## 合并前复查与补修

独立审查补出并修复两处边界，均先观察回归测试失败，再做最小修复：

- `turn/end` 的同步观察者取消当前轮时，公共收敛流程必须检查旧 signal，不能重置控制器并自动消费 `keepInbox: true` 保留的消息。该检查同时覆盖 DAG 与普通循环；取消后明确发出的新唤醒仍由既有 driver latch 重放。已经写出的 `completed` 事件不回写。
- 模型派生工具调用的空字符串参数必须作为无效 JSON 拒绝，不再静默替换成 `{}`；显式合法字符串 `'{}'` 仍可执行。

补修新增 6 项测试：DAG/普通路径的保留消息与显式新唤醒组合，以及空参数拒绝/合法空对象接受。合并前重新运行 **28 个测试文件、474 个测试全部通过**，TypeScript 项目引用构建通过。额外运行 Python 原型三模式冒烟验证，各模式完成同一组 12 个任务和一次模拟提交；未覆盖历史 benchmark 文件，也不将压缩时间的模拟运行当成性能结论。

以上仍是固定宿主源码组合与 mock 提供方验证，不代表真实模型或已发布 CLI 端到端认证。

## 明确保留的限制

- DAG 的模型请求依然绕过标准 prompt/request middleware；节点输出与因果图还未进入可恢复会话日志，trace 只在成功时写出。
- 图不会因用户原始自然语言自动生成，运行中的 steering 不会修改分支，只在后续普通轮次处理。
- 暂不支持工具 additionalContexts、concludesTurn 和多模态结果的完整传播；不要在 DAG 模式使用依赖这些语义的工具。
- 取消与失败只保证停止新派发；已启动任务仍须协作退出，没有强制 drain 超时，也不会撤销已发生的外部副作用。
- 尚无读写冲突推断、原子结果提交、持久执行恢复、节点/token预算。缺失依赖和环仍可能在运行时暴露。
- 并发上限在每次 DAG 启动时读取，不是图运行中的动态设置订阅。

## 后续顺序

1. 抽出共享的请求/工具执行能力，保留宿主准入、用量、结束与结果上下文语义，增加 Loader 真组合验证。
2. 定义节点与依赖的持久事件、稳定 operation ID、unknown-outcome 与恢复策略，再讨论安全提交。
3. 分开做同 DAG/replay 的纯调度比较，以及同任务质量门槛的完整系统比较；计入规划、上下文、token与费用。
4. 在上述约束可靠后做关键路径调度和有预算的纯工具推测，不以扩大并发代替正确性。
