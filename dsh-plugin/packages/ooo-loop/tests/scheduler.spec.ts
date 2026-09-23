import { expect, test } from 'vitest'
import { runOutOfOrder, TaskGraph, type OooNode } from '../src/scheduler'

const node = (id: string, kind: 'tool' | 'reason' = 'tool', dependsOn: string[] = []): OooNode<void> => ({ id, name: id, kind, dependsOn })
const graphOf = (...nodes: OooNode<void>[]) => { const graph = new TaskGraph<void>(); graph.add(...nodes); return graph }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('queued reason remains pending and never starts after failure', async () => {
  const first = node('first', 'reason'), queued = node('queued', 'reason'), bad = node('bad')
  const gate = deferred(), started: string[] = []
  let settled = false
  const outcome = runOutOfOrder(graphOf(first, queued, bad), {
    runReason: async n => { started.push(n.id); await gate.promise },
    runTool: async () => { throw new Error('boom') },
  }).catch(error => { settled = true; return error })
  await turn()
  const queuedStatus = queued.status
  const settledBeforeDrain = settled
  gate.resolve()
  expect(await outcome).toBeInstanceOf(Error)
  expect(queuedStatus).toBe('pending')
  expect(settledBeforeDrain).toBe(false)
  expect(started).toEqual(['first'])
})

test('mid-abort drains started work without dispatching dependents', async () => {
  const controller = new AbortController(), reason = new Error('stop')
  const gate = deferred(), parent = node('parent'), child = node('child', 'tool', ['parent'])
  const started: string[] = []
  let settled = false
  const outcome = runOutOfOrder(graphOf(parent, child), {
    runReason: async () => {},
    runTool: async n => { started.push(n.id); await gate.promise },
  }, { signal: controller.signal }).then(() => { settled = true; return undefined }, e => { settled = true; return e })
  controller.abort(reason)
  await turn()
  const settledBeforeDrain = settled
  gate.resolve()
  expect(await outcome).toBe(reason)
  expect(settledBeforeDrain).toBe(false)
  expect(started).toEqual(['parent'])
  expect(child.status).toBe('pending')
})

test.each(['throw', 'abort'] as const)('synchronous %s stops the same READY batch and drains work', async mode => {
  const controller = new AbortController(), gate = deferred(), started: string[] = []
  const reason = new Error('stop'), pending = node('pending')
  let settled = false
  const outcome = runOutOfOrder(graphOf(node('active'), node('bad'), pending), {
    runReason: async () => {},
    runTool: n => {
      started.push(n.id)
      if (n.id === 'bad') {
        if (mode === 'throw') throw reason
        controller.abort(reason)
        return Promise.resolve()
      }
      return gate.promise
    },
  }, { signal: controller.signal }).catch(e => { settled = true; return e })
  await turn()
  const settledBeforeDrain = settled
  gate.resolve()
  expect(await outcome).toBeInstanceOf(Error)
  expect(settledBeforeDrain).toBe(false)
  expect(started).toEqual(['active', 'bad'])
  expect(pending.status).toBe('pending')
})

test.each([2, undefined])('bounds tool concurrency with limit %s', async limit => {
  const gate = deferred(), nodes = Array.from({ length: 12 }, (_, i) => node(String(i)))
  let active = 0, peak = 0
  const run = runOutOfOrder(graphOf(...nodes), {
    runReason: async () => {},
    runTool: async () => { active++; peak = Math.max(peak, active); await gate.promise; active-- },
  }, limit === undefined ? {} : { maxParallelTools: limit })
  await turn()
  const running = nodes.filter(n => n.status === 'running').length
  gate.resolve()
  await run
  expect(running).toBe(limit ?? 10)
  expect(peak).toBe(limit ?? 10)
  expect(nodes.every(n => n.status === 'done')).toBe(true)
})

test.each([0, -1, 1.5, NaN, Infinity])('rejects invalid tool limit %s before starting', async maxParallelTools => {
  let starts = 0
  await expect(runOutOfOrder(graphOf(node('tool')), {
    runReason: async () => {}, runTool: async () => { starts++ },
  }, { maxParallelTools })).rejects.toThrow('maxParallelTools must be a positive integer')
  expect(starts).toBe(0)
})

test.each(['policy', 'irreversible'] as const)('%s exclusive waits for tools and blocks later parallel tools', async mode => {
  const before = deferred(), exclusiveGate = deferred(), started: string[] = []
  const exclusive = node('exclusive')
  if (mode === 'irreversible') Object.assign(exclusive, { effect: 'irreversible' })
  const after = node('after'), reason = node('reason', 'reason')
  const run = runOutOfOrder(graphOf(node('before'), exclusive, after, reason), {
    runReason: async n => { started.push(n.id) },
    runTool: async n => { started.push(n.id); if (n.id === 'before') await before.promise; if (n === exclusive) await exclusiveGate.promise },
  }, { toolMode: n => mode === 'policy' && n === exclusive ? 'exclusive' : 'parallel' })
  await turn()
  const firstWave = [...started]
  before.resolve()
  await turn()
  const secondWave = [...started]
  const afterStatus = after.status
  exclusiveGate.resolve()
  await run
  expect(firstWave).toEqual(['before', 'reason'])
  expect(secondWave).toEqual(['before', 'reason', 'exclusive'])
  expect(afterStatus).toBe('pending')
  expect(started).toEqual(['before', 'reason', 'exclusive', 'after'])
})

test('classification failure drains tools already running', async () => {
  const gate = deferred(), started: string[] = [], policyError = new Error('policy failed')
  let settled = false
  const pending = node('bad')
  const outcome = runOutOfOrder(graphOf(node('active'), pending, node('later')), {
    runReason: async () => {}, runTool: async n => { started.push(n.id); await gate.promise },
  }, { toolMode: n => { if (n === pending) throw policyError; return 'parallel' } })
    .catch(error => { settled = true; return error })
  await turn()
  const settledBeforeDrain = settled
  gate.resolve()
  expect(await outcome).toBe(policyError)
  expect(settledBeforeDrain).toBe(false)
  expect(started).toEqual(['active'])
  expect(pending.status).toBe('pending')
})

test('abort during classification does not start the classified tool', async () => {
  const controller = new AbortController(), reason = new Error('policy cancelled')
  const pending = node('pending'), started: string[] = []
  await expect(runOutOfOrder(graphOf(pending), {
    runReason: async () => {}, runTool: async n => { started.push(n.id) },
  }, { signal: controller.signal, toolMode: () => { controller.abort(reason); return 'parallel' } })).rejects.toBe(reason)
  expect(started).toEqual([])
  expect(pending.status).toBe('pending')
})

test('dispatch dependency assertion drains already started reasoning', async () => {
  const gate = deferred(), write = node('write')
  Object.assign(write, { effect: 'irreversible' })
  let settled = false
  const outcome = runOutOfOrder(graphOf(node('reason', 'reason'), write), {
    runReason: async () => { write.dependsOn = ['reason']; await gate.promise },
    runTool: async () => { throw new Error('must not execute') },
  }).catch(error => { settled = true; return error })
  await turn()
  const settledBeforeDrain = settled
  gate.resolve()
  expect(await outcome).toBeInstanceOf(Error)
  expect(settledBeforeDrain).toBe(false)
  expect(write.status).toBe('pending')
})

// Compatibility/contract checks: existing behavior, no production change required.
test('re-reads classification when a queued tool can actually dispatch', async () => {
  const a = deferred(), b = deferred(), c = deferred(), started: string[] = []
  let mode: 'parallel' | 'exclusive' = 'parallel'
  const queued = node('queued'), later = node('later')
  const run = runOutOfOrder(graphOf(node('a'), node('b'), queued, later), {
    runReason: async () => {},
    runTool: async n => { started.push(n.id); await new Map([['a', a], ['b', b], ['queued', c]]).get(n.id)?.promise },
  }, { maxParallelTools: 2, toolMode: n => n === queued ? mode : 'parallel' })
  mode = 'exclusive'
  a.resolve()
  await turn()
  const whileB = [...started]
  b.resolve()
  await turn()
  const whileExclusive = [...started]
  c.resolve()
  await run
  expect(whileB).toEqual(['a', 'b'])
  expect(whileExclusive).toEqual(['a', 'b', 'queued'])
  expect(started).toEqual(['a', 'b', 'queued', 'later'])
})

test('spawn preserves continuation rerouting and records only executed traces', async () => {
  const parent = node('parent', 'reason'), final = node('final', 'tool', ['parent'])
  const tool = node('spawned-tool', 'tool', ['parent'])
  const continuation = node('continuation', 'reason', ['spawned-tool'])
  const graph = graphOf(parent, final), started: string[] = []
  Object.assign(parent, { spawn: () => { graph.rerouteDependents(parent.id, continuation.id); return [tool, continuation] } })
  const execute = async (n: OooNode<void>) => { started.push(n.id) }
  const outcome = await runOutOfOrder(graph, { runReason: execute, runTool: execute })
  expect(started).toEqual(['parent', 'spawned-tool', 'continuation', 'final'])
  expect(final.dependsOn).toEqual(['continuation'])
  expect(outcome.spawned).toEqual(['parent -> spawned-tool', 'parent -> continuation'])
  expect(outcome.traces.map(t => t.id)).toEqual(started)
  expect(outcome.traces.every(t => t.settledAt >= t.startedAt)).toBe(true)
})

test.each(['missing', 'cycle'])('reports %s dependency deadlock', async type => {
  const a = node('a', 'tool', [type === 'missing' ? 'missing' : 'b'])
  const graph = type === 'missing' ? graphOf(a) : graphOf(a, node('b', 'tool', ['a']))
  await expect(runOutOfOrder(graph, { runReason: async () => {}, runTool: async () => {} })).rejects.toThrow('scheduler deadlock: unfinished nodes [a(pending)')
})

test('synchronous reason throw does not start queued reason', async () => {
  const queued = node('queued', 'reason'), started: string[] = []
  await expect(runOutOfOrder(graphOf(node('bad', 'reason'), queued), {
    runReason: n => { started.push(n.id); throw new Error('sync reason') }, runTool: async () => {},
  })).rejects.toThrow('sync reason')
  expect(started).toEqual(['bad'])
  expect(queued.status).toBe('pending')
})

test('spawn throw fails parent without dispatching its dependent', async () => {
  const parent = node('parent'), child = node('child', 'tool', ['parent'])
  Object.assign(parent, { spawn: () => { throw new Error('spawn error') } })
  await expect(runOutOfOrder(graphOf(parent, child), { runReason: async () => {}, runTool: async () => {} })).rejects.toThrow('spawn error')
  expect(parent.status).toBe('failed')
  expect(child.status).toBe('pending')
})

test('mid-abort of last running node is not mistaken for success', async () => {
  const gate = deferred(), controller = new AbortController()
  const run = runOutOfOrder(graphOf(node('last')), {
    runReason: async () => {}, runTool: async () => { await gate.promise },
  }, { signal: controller.signal })
  controller.abort()
  gate.resolve()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
})

test('pre-abort starts no work, including an empty graph', async () => {
  const controller = new AbortController(), reason = new Error('cancelled')
  controller.abort(reason)
  const pending = node('pending')
  let starts = 0
  const executors = { runReason: async () => { starts++ }, runTool: async () => { starts++ } }
  for (const graph of [graphOf(pending), graphOf()]) {
    await expect(runOutOfOrder(graph, executors, { signal: controller.signal })).rejects.toBe(reason)
  }
  expect(starts).toBe(0)
  expect(pending.status).toBe('pending')
})

test('failure is checked before a newly READY dependent write', async () => {
  const parent = node('parent'), bad = node('bad'), write = node('write', 'tool', ['parent'])
  Object.assign(write, { effect: 'irreversible' })
  const started: string[] = []
  await expect(runOutOfOrder(graphOf(parent, bad, write), {
    runReason: async () => {},
    runTool: async n => { started.push(n.id); if (n === bad) throw new Error('boom') },
  })).rejects.toThrow('boom')
  expect(started).toEqual(['parent', 'bad'])
  expect(write.status).toBe('pending')
})
