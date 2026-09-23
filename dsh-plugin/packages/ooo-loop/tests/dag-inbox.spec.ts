import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { ReactLoopAgent } from '../src/agent.ts'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const input = (text: string) => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user' },
})

async function harness(adapter = new MockAdapter([textResponse('DAG done')]), useDag = true) {
  const dir = await mkdtemp(join(tmpdir(), 'dag-inbox-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const id = SessionId('dag-inbox')
  const session = Session.create(id)
  ctx.effect(() => ctx.sessions.enter(session))
  const agent = new ReactLoopAgent(loop.ctx, id, { provider: 'mock', model: 'mock' }, session, useDag ? {
    tracePath: join(dir, 'trace.json'),
    nodes: [{ id: 'reason', name: 'configured task', kind: 'reason', prompt: 'configured task', arguments: {}, dependsOn: [] }],
  } : undefined)
  cleanups.push(async () => {
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
    await agent.scope.dispose()
  })
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  return { ctx, agent, session, adapter, errors }
}

function loggedInputs(session: Session) {
  return session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
}

describe('DAG turn inbox ownership', () => {
  it.each([
    { useDag: true, explicitWake: false },
    { useDag: false, explicitWake: false },
    { useDag: true, explicitWake: true },
    { useDag: false, explicitWake: true },
  ])('exits the cancelled driver after a turn-end observer (DAG=$useDag, explicitWake=$explicitWake)', async ({ useDag, explicitWake }) => {
    const retained = input('retained followup')
    const wake = input('explicit wake after cancel')
    const adapter = new MockAdapter([
      () => {
        agent.followup(retained)
        return textResponse('first turn done')
      },
      textResponse('retained followup done'),
      textResponse('explicit wake done'),
    ])
    const { ctx, agent, session, errors } = await harness(adapter, useDag)
    const statuses: string[] = []
    const claimed: { id: string; turn: number }[] = []
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    ctx.on('agent/inbox/claimed', ({ message, turn }) => { claimed.push({ id: message.id, turn }) })
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'turn/end' || event.data.turn !== 1) return
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      // Session publication forbids reentrant appends. Wake at its first microtask boundary,
      // before the cancelled driver's convergence, so the wake must be latched for replay.
      if (explicitWake) queueMicrotask(() => agent.followup(wake))
    })
    const trigger = input('start first turn')
    agent.followup(trigger)
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(statuses).toEqual(explicitWake ? ['running', 'idle', 'running', 'idle'] : ['running', 'idle'])
    expect(adapter.requests).toHaveLength(explicitWake ? 3 : 1)
    expect(agent.inbox.nextTurn).toEqual(explicitWake ? [] : [retained])
    expect(loggedInputs(session)).toEqual(explicitWake ? [trigger, retained, wake] : [trigger])
    expect(claimed).toEqual(explicitWake ? [
      { id: trigger.id, turn: 1 }, { id: retained.id, turn: 2 }, { id: wake.id, turn: 3 },
    ] : [{ id: trigger.id, turn: 1 }])
    expect(session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data))
      .toEqual((explicitWake ? [1, 2, 3] : [1]).map(turn => ({ turn, reason: { kind: 'completed' } })))
    expect(agent.status).toBe('idle')
  })

  it('does not run the configured graph when its waking input was removed', async () => {
    const { ctx, agent, session, adapter } = await harness()
    const trigger = input('withdrawn trigger')
    ctx.on('agent/status', ({ status }) => {
      if (status === 'running') agent.inbox.remove(trigger.id)
    })
    agent.followup(trigger)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(loggedInputs(session)).toEqual([])
    expect(agent.inbox.hasPending).toBe(false)
  })
  it.each([false, true])('honors registered tool safety and the configured cap (parallel=%s)', async (parallel) => {
    const dir = await mkdtemp(join(tmpdir(), 'dag-host-admission-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    const started: string[] = []
    const gate = Promise.withResolvers<void>()
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'gated', description: 'test tool',
      parameters: { id: { type: 'string', required: true } },
      ...(parallel ? { isConcurrencySafe: () => true } : {}),
      async execute(args) {
        started.push(args.id)
        await gate.promise
        return [{ type: 'text', text: args.id }]
      },
    })))
    await ctx.plugin(AgentLoop, {
      agents: [], maxParallelToolCalls: parallel ? 1 : 2,
      dag: { tracePath: join(dir, 'trace.json'), nodes: ['a', 'b'].map(id => ({
        id, name: id, kind: 'tool', tool: 'gated', arguments: { id },
      })) },
    })
    const agent = await ctx.agentLoop.create(SessionId('dag-host-admission'), { provider: 'mock', model: 'mock' })
    agent.followup(input('run graph'))
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0))
      expect(started).toEqual(['a'])
    } finally {
      gate.resolve()
      await agent.whenIdle()
    }
    expect(started).toEqual(['a', 'b'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
  })

  it('stops admitting the batch when a user-message observer cancels', async () => {
    const { ctx, agent, session, adapter } = await harness()
    const injected = input('first admitted')
    const trigger = input('must not be admitted')
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message') agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    agent.inject(injected)
    agent.followup(trigger)
    await agent.whenIdle()

    expect(loggedInputs(session)).toEqual([injected])
    expect(adapter.requests).toHaveLength(0)
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted' } },
    })
  })

  it('does not admit claimed inputs after a claim observer cancels the turn', async () => {
    const { ctx, agent, session, adapter } = await harness()
    const trigger = input('cancel on claim')
    ctx.on('agent/inbox/claimed', () => { agent.cancel({ kind: 'user' }, { keepInbox: true }) })
    agent.followup(trigger)
    await agent.whenIdle()

    // Claim is a durable removal, not a transaction to roll back on cancellation.
    expect(agent.inbox.hasPending).toBe(false)
    expect(loggedInputs(session)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'aborted' } },
    })
  })

  it('does not claim preserved input when canceled by a turn-start observer', async () => {
    const { ctx, agent, session, adapter } = await harness()
    const trigger = input('keep pending')
    const claimed: string[] = []
    ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id) })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/start') agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    agent.followup(trigger)
    await agent.whenIdle()

    expect(claimed).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([trigger])
    expect(loggedInputs(session)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('drains followups sent during DAG execution through normal later turns without another wake', async () => {
    const followup = input('followup during DAG')
    const later = input('another followup')
    const adapter = new MockAdapter([
      () => {
        agent.followup(followup)
        agent.followup(later)
        return textResponse('DAG done')
      },
      textResponse('normal turn two'),
      textResponse('normal turn three'),
    ])
    const { ctx, agent, session, errors } = await harness(adapter)
    const claimed: { id: string; turn: number }[] = []
    ctx.on('agent/inbox/claimed', ({ message, turn }) => { claimed.push({ id: message.id, turn }) })
    const trigger = input('start graph')
    agent.followup(trigger)
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(3)
    expect(claimed).toEqual([
      { id: trigger.id, turn: 1 }, { id: followup.id, turn: 2 }, { id: later.id, turn: 3 },
    ])
    expect(loggedInputs(session)).toEqual([trigger, followup, later])
    expect(agent.inbox.hasPending).toBe(false)
    expect(agent.status).toBe('idle')
    expect(session.snapshotEvents().filter(event => event.type === 'step/start').map(event => event.data))
      .toEqual([{ turn: 2, step: 1 }, { turn: 3, step: 1 }])
  })

  it('claims its triggering batch once and records standard surface user messages', async () => {
    const { ctx, agent, session, adapter, errors } = await harness()
    const trigger = input('start graph')
    const injected = input('queued context')
    const claimed: { id: string; turn: number }[] = []
    ctx.on('agent/inbox/claimed', ({ message, turn }) => { claimed.push({ id: message.id, turn }) })
    agent.inject(injected)
    agent.followup(trigger)
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(claimed).toEqual([{ id: injected.id, turn: 1 }, { id: trigger.id, turn: 1 }])
    expect(loggedInputs(session)).toEqual([injected, trigger])
    expect(session.deriveMessages()).toEqual([injected, trigger])
    expect(agent.inbox.hasPending).toBe(false)
    expect(adapter.requests).toHaveLength(1)
    // Input admission does not turn this configured DAG into a natural-language planner.
    expect(adapter.requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'configured task' }])
  })
})
