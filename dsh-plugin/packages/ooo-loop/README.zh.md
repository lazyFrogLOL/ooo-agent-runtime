---
description: "DeepSeek Harness 的实验性依赖就绪 DAG 驱动器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ooo-loop

[English](README.md) | 中文

这是从 DeepSeek Harness `0d1f50007f` 派生的实验性 `agentLoop` 提供方。应当**替换**而不是同时挂载 `dsh-agent-loop`。不配置 `dag` 时，运行继承的普通对话循环。

## 工具等待期间的准备工作（默认关闭）

不配置 `dag` 时，可选的 `waitWork` 允许一项无工具、纯文本准备工作与真实的可并发工具执行重叠。主模型随工具调用提出工作，没有提案就不新增辅助请求。准备工作只使用已有文本，不预判工具结果。窗口关闭后不接纳迟到结果，也不等待提供方退出；不合作的请求仍占据后台槽位，直到真正退出。

配置与复现见[等待窗口工作机制](../../../docs/等待窗口工作机制.md)。`wait-work-loader.spec.ts` 用真实 YAML/Loader/普通循环及确定性外部服务验证完整链路，不代表真实模型加速。不配置 `waitWork` 则保持默认行为。

## 配置 DAG 模式

配置 `dag` 后，第 1 轮执行声明的任务图。触发输入会被领取并记录一次；它只是触发配置任务，**不是**自然语言 planner 的输入。已被移除的触发输入不会启动图。执行期间排队的 followup/steering 会在后续普通轮次消费，不会修改正在执行的 DAG 分支。

```yaml
- name: '@deepseek-ai/dsh-ooo-loop'
  config:
    maxParallelToolCalls: 4
    dag:
      tracePath: /tmp/ooo-trace.json
      nodes:
        - id: fetch
          name: fetch evidence
          kind: tool
          tool: registered_read_tool
          arguments: {}
        - id: analyze
          name: analyze evidence
          kind: reason
          prompt: Summarize the evidence.
          dependsOn: [fetch]
    agents: []
```

工具必须已在宿主注册。REASON 只能派生图声明的工具集合中实际展示的工具。模型参数必须能解析为 JSON 对象；非法 JSON、数组、标量和未声明工具名会使节点失败，不派发该批派生调用。

## 调度与失败语义

- 同时只运行一个 REASON；其余就绪 REASON 保持 pending，不预先放进已启动的 Promise 链。
- 工具使用宿主当前的 `executionMode` 分类，以及每次 DAG 启动时读取的 `maxParallelToolCalls`。独占工具等待其他工具完成，并持有工具槽直到 finalize 结束。等待中的独占工具阻止后续就绪工具越过屏障。REASON 仍可与工具重叠。
- 独立 API `runOutOfOrder(graph, executors, options)` 接受 `signal`、正整数 `maxParallelTools`（默认 10）和同步 `toolMode` 回调。直接调用者须为非并行安全工具提供分类。`effect: 'irreversible'` 也要求独占工具槽，但这**不是**事务提交协议。
- 失败或取消后不再派发新任务，等待已经实际启动的任务结束后拒绝。未开始节点保持 pending。排空是协作式且没有强制时限：永不结束的工具仍可阻塞退出。已经发生的外部写入不会回滚。
- 结构化工具错误会使节点失败并阻止依赖它的工作；本版不支持错误恢复边。
- REASON 必须以 `stop` 或 `tool-calls` 结束。缺少 finish、取消、`max-tokens` 截断、提供方错误及未知 finish 都不会被当成分析成功。
- 派生工具后会创建 continuation，并将原有 pending 下游改接到 continuation；REASON 上下文包含已完成的祖先锥结果。

## 测试

将本包复制到固定版本、已安装依赖的临时 Harness checkout 的 `packages/experimental/ooo-loop`；参见[集成说明](../../README.md)。从宿主根目录执行：

```sh
pnpm exec vitest run --config packages/experimental/ooo-loop/vitest.config.ts
node ./node_modules/typescript/bin/tsc -b packages/experimental/ooo-loop
```

包级配置包含全部 `.spec.ts`、排除真实提供方 `.e2e.ts`，并将宿主 testkit 间接导入的 loop/invariant 统一到本 fork。保留测试导入 `@deepseek-ai/dsh-ooo-loop`；包级配置将自引用和宿主 testkit 导入统一解析到当前 checkout，不再静默选择原 loop。验证本 fork 时不要以宿主全局测试命令替代这个配置。

- `scheduler.spec.ts`：失败/取消、实际执行槽、有界工具并发、独占准入、spawn 与死锁。
- `dag.spec.ts`：模拟外部服务的执行边界测试，覆盖参数/工具校验、结束状态、错误传播及 continuation 顺序。
- `dag-inbox.spec.ts`：真实 Cordis 服务、Agent 驱动器/工厂、inbox 和已注册工具准入；模型响应使用确定性 fixture。
- 其余 spec 保留对继承的串行循环的覆盖。

这是源码级验证，不是已发布 Loader/CLI 的端到端认证，也不表示生产就绪。

## 已知限制与延期工作

DAG 路径仍是实验：模型请求绕过普通 prompt/request middleware，逐节点请求、响应、工具事件、用量与依赖变化还没有记录成可恢复的会话历史。日志记录触发输入和轮次边界；成功后生成的旁路 trace 保存文本结果。工具 additionalContexts、`concludesTurn` 与非文本输出尚未接入 DAG 推理；不要在此模式使用依赖这些能力的工具。

尚无推测执行、读写冲突推断、结果暂存、外部原子提交、持久 DAG 恢复、节点/token 预算或强制超时排空。依赖就绪断言不是 CPU reorder buffer。DAG 配置没有暴露调度器的 effect 分类。重复 ID 会被图拒绝，但缺失依赖或环可能到运行时才暴露；有副作用的图应先在外部验证。每个 agent/run 应使用独立 trace 路径，父目录必须已存在。

## 模型、Token 与缓存影响

每个 REASON 都是独立请求，携带节点提示词、祖先结果和声明的工具 schema。更频繁的决策能提前派发后续工具，也增加模型调用和上下文成本，不保证命中相同前缀缓存。触发文本不会注入这些请求。应同时衡量端到端延迟、质量和 token，不以推理核利用率本身作为目标。
