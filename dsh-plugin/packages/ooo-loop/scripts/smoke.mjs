/**
 * Smoke test for the built dsh-ooo-loop bundle:
 *  1. the package entry imports cleanly and exposes the expected surface;
 *  2. the ported scheduler reproduces the Python v0.1 benchmark numbers
 *     (investment-report scenario, virtual seconds at 5% time scale).
 *
 * Run from the repo root:
 *   node packages/experimental/ooo-loop/scripts/smoke.mjs
 */

const lib = await import('../lib/index.js')

const failures = []
const check = (label, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

// --- 1. module surface -------------------------------------------------------

check('default export AgentLoop is a class', typeof lib.default === 'function')
check('runOutOfOrder exported', typeof lib.runOutOfOrder === 'function')
check('TaskGraph exported', typeof lib.TaskGraph === 'function')
check('turnBoundaryProjectionDefinition exported', typeof lib.turnBoundaryProjectionDefinition === 'object')
check('DEFAULT_MAX_PARALLEL_TOOL_CALLS exported', typeof lib.DEFAULT_MAX_PARALLEL_TOOL_CALLS === 'number')

// --- 2. scheduler vs Python v0.1 numbers -------------------------------------

const { TaskGraph, runOutOfOrder } = lib

const SCALE = 0.05
const sleep = virtualSeconds => new Promise(resolve => setTimeout(resolve, virtualSeconds * SCALE * 1000))

const graph = new TaskGraph()
let t0 = 0
const now = () => (Date.now() - t0) / (SCALE * 1000)

const executors = {
  async runReason(node) { await sleep(node.latency); return `${node.name}结果` },
  async runTool(node) { await sleep(node.latency); return `${node.name}数据` },
}

const node = (id, name, kind, latency, extra = {}) =>
  ({ id, name, kind, latency, ...extra })

const cashflowTool = node('cashflow-tool', '拉取现金流明细', 'tool', 10)
const cashflowAnalysis = node('cashflow-analysis', '现金流分析', 'reason', 2, { dependsOn: ['cashflow-tool'] })

graph.add(
  node('fetch-fin', '拉取财报', 'tool', 12),
  node('fin-analysis', '财务分析', 'reason', 6, {
    dependsOn: ['fetch-fin'],
    spawn: () => [cashflowTool, cashflowAnalysis],
  }),
  node('fetch-news', '搜索新闻', 'tool', 2),
  node('news-analysis', '新闻分析', 'reason', 3, { dependsOn: ['fetch-news'] }),
  node('fetch-industry', '拉取行业数据', 'tool', 8),
  node('industry-analysis', '行业分析', 'reason', 3, { dependsOn: ['fetch-industry'] }),
  node('fetch-peers', '拉取竞品数据', 'tool', 4),
  node('peer-analysis', '竞品分析', 'reason', 3, { dependsOn: ['fetch-peers'] }),
  node('synthesis', '综合报告', 'reason', 5, {
    dependsOn: ['fin-analysis', 'news-analysis', 'industry-analysis', 'peer-analysis', 'cashflow-analysis'],
  }),
  node('send-email', '发送报告邮件', 'tool', 1, { dependsOn: ['synthesis'], effect: 'irreversible' }),
)

t0 = Date.now()
const outcome = await runOutOfOrder(graph, executors)
const makespan = now()

// Python v0.1 reference: makespan ≈ 36 virtual seconds, utilization ≈ 61%.
check(`makespan ≈ 36s (got ${makespan.toFixed(1)}s)`, makespan > 35 && makespan < 39)
check('all 12 nodes settled', outcome.traces.length === 12)
check('spawn discovered 2 nodes', outcome.spawned.length === 2)

const email = outcome.traces.find(t => t.id === 'send-email')
const synthesis = outcome.traces.find(t => t.id === 'synthesis')
check(
  'commit barrier: email dispatched only after synthesis settled',
  email.startedAt >= synthesis.settledAt,
)

const reasonBusy = outcome.traces.filter(t => t.kind === 'reason')
  .reduce((sum, t) => sum + (t.settledAt - t.startedAt), 0) / (SCALE * 1000)
check(`agent utilization ≈ 61% (got ${(reasonBusy / makespan * 100).toFixed(0)}%)`,
  reasonBusy / makespan > 0.55 && reasonBusy / makespan < 0.68)

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall smoke checks passed')
