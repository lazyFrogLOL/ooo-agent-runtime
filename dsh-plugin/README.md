# dsh 插件包（OOO loop + mock 实验室）

这里是两个 dsh 实验包的**快照**，开发在 dsh clone 内进行、定期同步到这里：

- `packages/ooo-loop/` — OOO agent loop（fork 自 `@deepseek-ai/dsh-agent-loop` 0d1f50007f）。
  新增：`src/scheduler.ts`（事件驱动乱序调度器）、`src/dag.ts`（静态 DAG 驱动路径 +
  spawn 动态发现 + 依赖改道 + 祖先锥上下文注入）、`agent.ts`/`index.ts` 的挂钩。
  fork 的完整测试套件保留在 `tests/`。
- `packages/ooo-mock-lab/` — 确定性验证实验室：脚本化 mock LLM 适配器
  （顺序回放 / `match` 内容路由 / 每条响应独立 `thinkMs`）+ 定时工具
  （`mock_fetch` / 拟真 `fetch_data`，延迟来自 config）+ 8 个场景 patch。

## 复现步骤

```bash
# 1. 克隆宿主（固定在开发时的 commit）
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && git checkout 0d1f50007f

# 2. 应用宿主集成 patch（tsconfig.host.json 两行 references + pnpm-lock）
git apply /path/to/ooo-agent-runtime/dsh-plugin/dsh-integration.patch

# 3. 拷入两个实验包
cp -r /path/to/ooo-agent-runtime/dsh-plugin/packages/ooo-loop packages/experimental/
cp -r /path/to/ooo-agent-runtime/dsh-plugin/packages/ooo-mock-lab packages/experimental/

# 4. 安装与构建（native 模块需要带开发头文件的 Node，如 Homebrew Node）
pnpm install
PATH=/opt/homebrew/bin:$PATH pnpm run build:native-system
node ./node_modules/typescript/bin/tsc -b packages/experimental/ooo-loop packages/experimental/ooo-mock-lab
(cd packages/experimental/ooo-loop && pnpm exec tsdown)
(cd packages/experimental/ooo-mock-lab && pnpm exec tsdown)

# 5. 跑 benchmark（headless profile，mock 场景无需 API key）
pnpm dsh --profile headless \
  --patch packages/experimental/ooo-mock-lab/bench.patch.yml "分析这家公司"       # 基线
pnpm dsh --profile headless \
  --patch packages/experimental/ooo-mock-lab/bench-ooo.patch.yml "分析这家公司"   # OOO

# 6. 提取时间线 / 读 trace
python3 packages/experimental/ooo-mock-lab/scripts/extract-timing.py
# OOO 侧 trace 路径在各 patch 的 dag.tracePath 里（当前指向开发机绝对路径，按需修改）
```

## 场景 patch 一览

| patch | 内容 |
|---|---|
| `bench.patch.yml` / `bench-ooo.patch.yml` | L2 确定性对决：4 抓取 + 4 分析 + 1 综合（mock 模型每次 0.5s） |
| `bench-spawn.patch.yml` | M2 spawn：分析财报动态发现竞争对手抓取 |
| `bench-l3.patch.yml` | 真实模型首跑（真实思考 + 确定性工具） |
| `bench-l3-baseline.patch.yml` / `bench-l3-slow.patch.yml` | L3 可折叠地形对决（财报 90s） |
| `bench-l4-baseline.patch.yml` / `bench-l4-ooo.patch.yml` | L4 发现式慢 follow-up 对决（舆情核查 90s） |

真实模型场景通过环境变量路由（Anthropic 兼容端点即可）：

```bash
DEEPSEEK_API_KEY=<your-key> DEEPSEEK_BASE_URL=<anthropic-compatible-endpoint> \
  pnpm dsh --profile headless --patch .../bench-l4-ooo.patch.yml "分析这家公司"
```
