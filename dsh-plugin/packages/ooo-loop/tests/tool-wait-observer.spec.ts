import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-ooo-loop'
import { executeToolCalls, type ToolWaitObserver } from '../src/tool-calls.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function harness(parallel = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 3 })
  const agent = await ctx.agentLoop.create(SessionId('observer'), { provider: 'mock', model: 'mock' })
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const unregister = ctx.tools.register(defineContentToolFixture({
    name: 'gated', description: 'gated real runtime tool',
    parameters: { id: { type: 'string', required: true } },
    ...parallel ? { isConcurrencySafe: () => true } : {},
    async execute(args) {
      const gate = Promise.withResolvers<void>()
      gates.set(args.id, gate)
      await gate.promise
      return [{ type: 'text', text: args.id }]
    },
  }))
  const active: number[] = []
  let invalidations = 0
  const observer: ToolWaitObserver = {
    dispatchesChanged(count: number) { active.push(count) },
    invalidated() { invalidations++ },
  }
  const controller = new AbortController()
  const run = (ids = ['1'], observe = true) => ctx.agents.withInitiator(agent, () => executeToolCalls(
    ctx, 1, 1, ids.map((id): ToolCallBlock => ({
      type: 'tool-call', id: ToolCallId(id), name: 'gated', arguments: JSON.stringify({ id }),
    })), controller.signal, () => {}, observe ? observer : undefined,
  ))
  return { ctx, agent, gates, active, observer, controller, run, unregister, invalidations: () => invalidations }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(predicate(), 'gated runtime reached expected state').toBe(true)
}

describe('ToolWaitObserver real runtime', () => {
  it('reports 2 to 1 to 0 at settlement even while model-order commit is blocked', async () => {
    const h = await harness()
    const post = Promise.withResolvers<void>()
    let postEntered = false
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      postEntered = true
      await post.promise
      return next()
    })
    const done = h.run(['1', '2'])
    await until(() => h.gates.size === 2)
    try {
      expect(h.active).toEqual([1, 2])
      h.gates.get('2')!.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.active).toEqual([1, 2, 1])
      expect(h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result')).toEqual([])
      h.gates.get('1')!.resolve()
      await until(() => postEntered)
      expect(h.active).toEqual([1, 2, 1, 0])
    } finally {
      for (const gate of h.gates.values()) gate.resolve()
      post.resolve()
      await done
    }
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result')
      .map(e => e.data.message.source.callId)).toEqual(['1', '2'])
    expect(h.active).toEqual([1, 2, 1, 0])
  })

  it('never reports exclusive dispatches as parallel activity', async () => {
    const h = await harness(false)
    const done = h.run()
    await until(() => h.gates.has('1'))
    try { expect(h.active.some(n => n > 0)).toBe(false) } finally { h.gates.get('1')!.resolve() }
    await done
    expect(h.active).toEqual([0])
  })

  it('does not report activity during prepare or finalize awaits', async () => {
    const h = await harness()
    const pre = Promise.withResolvers<void>()
    const post = Promise.withResolvers<void>()
    let preEntered = false
    let postEntered = false
    h.ctx.on('tools/pre-execute', async (_exec, next) => {
      preEntered = true
      await pre.promise
      return next()
    })
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      postEntered = true
      await post.promise
      return next()
    })
    const done = h.run()
    await until(() => preEntered)
    try {
      expect(h.active).toEqual([])
      pre.resolve()
      await until(() => h.gates.has('1'))
      expect(h.active).toEqual([1])
      h.gates.get('1')!.resolve()
      await until(() => postEntered)
      expect(h.active).toEqual([1, 0])
    } finally {
      pre.resolve()
      h.gates.get('1')?.resolve()
      post.resolve()
      await done
    }
  })

  it('preserves default result shape and ordered records without an observer', async () => {
    const h = await harness()
    const done = h.run(['1', '2'], false)
    await until(() => h.gates.size === 2)
    h.gates.get('2')!.resolve()
    h.gates.get('1')!.resolve()
    await expect(done).resolves.toEqual({ concluded: false })
    expect(h.active).toEqual([])
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result')
      .map(e => e.data.message.source.callId)).toEqual(['1', '2'])
  })

  it('isolates throwing invalidation callbacks and ignores aborts after close', async () => {
    const h = await harness()
    let observed = 0
    h.observer.invalidated = () => { observed++; throw new Error('observer invalidation only') }
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'policy' }))
    await expect(h.run()).resolves.toEqual({ concluded: false })
    expect(observed).toBe(1)
    expect(h.active).toEqual([0])
    h.controller.abort()
    expect(observed).toBe(1)
    expect(h.active).toEqual([0])
  })

  it('invalidates a later structured failure before its model-order commit', async () => {
    const h = await harness()
    h.ctx.on('tools/execute', async (exec, next) => {
      if (exec.callId === ToolCallId('2')) throw new Error('late sibling failed')
      return next()
    })
    const done = h.run(['1', '2'])
    await until(() => h.gates.has('1'))
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      expect(h.invalidations()).toBe(1)
      expect(h.active.at(-1)).toBe(1)
      expect(h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result')).toEqual([])
    } finally { h.gates.get('1')!.resolve() }
    await done
    expect(h.active.at(-1)).toBe(0)
  })
  it.each(['before', 'during'] as const)('invalidates cancellation %s dispatch and removes the observer at close', async timing => {
    const h = await harness()
    if (timing === 'before') h.controller.abort()
    const done = h.run()
    if (timing === 'during') {
      await until(() => h.gates.has('1'))
      h.controller.abort()
      try {
        expect(h.invalidations()).toBe(1)
        expect(h.active).toEqual([1])
      } finally { h.gates.get('1')!.resolve() }
    }
    await expect(done).resolves.toEqual({ concluded: false })
    expect(h.invalidations()).toBe(1)
    expect(h.active.at(-1)).toBe(0)
    const snapshot = [...h.active]
    h.controller.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.active).toEqual(snapshot)
  })
  it.each(['body', 'pre-deny', 'pre-throw', 'post-throw'] as const)('invalidates structured %s errors', async stage => {
    const h = await harness()
    if (stage === 'body') h.unregister()
    if (stage === 'body') h.ctx.tools.register(defineContentToolFixture({
      name: 'gated', description: 'throws into structured error', parameters: {},
      isConcurrencySafe: () => true,
      async execute() { throw new Error('body failed') },
    }))
    if (stage === 'pre-deny') h.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'denied' }))
    if (stage === 'pre-throw') h.ctx.on('tools/pre-execute', async () => { throw new Error('prepare failed') })
    if (stage === 'post-throw') h.ctx.on('tools/post-execute', async () => { throw new Error('finalize failed') })
    const done = h.run()
    if (stage === 'post-throw') {
      await until(() => h.gates.has('1'))
      h.gates.get('1')!.resolve()
    }
    await expect(done).resolves.toEqual({ concluded: false })
    expect(h.invalidations()).toBe(1)
    expect(h.active).toEqual(stage === 'body' || stage === 'post-throw' ? [1, 0] : [0])
    expect(h.agent.session.snapshotEvents().find(e => e.type === 'tool/result')).toMatchObject({
      data: { message: { content: [{ isError: true }] } },
    })
  })
  it.each(['sync', 'reject', 'prepare'] as const)('invalidates %s failure before draining a running sibling', async (failure) => {
    const h = await harness()
    const scheduler = h.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const dispatch = scheduler.dispatch.bind(scheduler)
    const prepare = scheduler.prepare.bind(scheduler)
    const error = new Error('injected scheduler failure')
    let failed = false
    scheduler.dispatch = exec => {
      if (exec.callId !== ToolCallId('2') || failure === 'prepare') return dispatch(exec)
      failed = true
      if (failure === 'sync') throw error
      return Promise.reject(error)
    }
    scheduler.prepare = async exec => {
      if (exec.callId === ToolCallId('2') && failure === 'prepare') { failed = true; throw error }
      return prepare(exec)
    }
    const result = h.run(['1', '2']).then(value => value, error => error)
    await until(() => failed)
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      expect(h.invalidations()).toBe(1)
      expect(h.active.at(-1)).toBe(1)
    } finally { h.gates.get('1')!.resolve() }
    expect(await result).toBe(error)
    expect(h.active).toEqual(failure === 'prepare' ? [1, 0] : [1, 2, 1, 0])
  })
  it('invalidates synchronous scheduler dispatch failure and closes at zero', async () => {
    const h = await harness()
    const error = new Error('dispatch failed synchronously')
    h.ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch = () => { throw error }
    await expect(h.run()).rejects.toBe(error)
    expect(h.active).toEqual([1, 0])
    expect(h.invalidations()).toBe(1)
  })
  it('isolates throwing dispatch observers from tool results', async () => {
    const h = await harness()
    h.observer.dispatchesChanged = () => { throw new Error('observer only') }
    const done = h.run()
    // Attach immediately: an observer regression must not become unhandled rejection.
    const result = done.then(value => value, error => error)
    await until(() => h.gates.has('1') || h.agent.session.snapshotEvents().some(e => e.type === 'tool/call'))
    await new Promise(resolve => setTimeout(resolve, 0))
    h.gates.get('1')?.resolve()
    expect(await result).toEqual({ concluded: false })
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'tool/result')).toHaveLength(1)
  })
  it('reports a slow single parallel dispatch until its settlement', async () => {
    const h = await harness()
    const done = h.run()
    await until(() => h.gates.has('1'))
    try { expect(h.active).toEqual([1]) } finally { h.gates.get('1')!.resolve() }
    await expect(done).resolves.toEqual({ concluded: false })
    expect(h.active).toEqual([1, 0])
    expect(h.invalidations()).toBe(0)
  })
})
