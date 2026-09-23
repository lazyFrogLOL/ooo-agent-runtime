import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '../src/index.ts'
import { ReactLoopAgent } from '../src/agent.ts'
import { runDagTurn, type DagConfig } from '../src/dag.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

// Gate only the asynchronous filesystem boundary; execute the real DAG and host.
const writes = vi.hoisted(() => new Map<string, {
  entered: ReturnType<typeof Promise.withResolvers<void>>
  release: ReturnType<typeof Promise.withResolvers<void>>
}>())
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, writeFile: async (...args: Parameters<typeof original.writeFile>) => {
    const gate = writes.get(String(args[0]))
    if (gate) {
      gate.entered.resolve()
      await gate.release.promise
    }
    return original.writeFile(...args)
  } }
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dag-trace-cancel-'))
  const tracePath = join(dir, 'trace.json')
  const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  writes.set(tracePath, gate)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('DAG done'), textResponse('unexpected followup')])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const id = SessionId('dag-trace-cancel')
  const session = Session.create(id)
  ctx.effect(() => ctx.sessions.enter(session))
  const dag: DagConfig = {
    tracePath,
    nodes: [{ id: 'reason', name: 'reason', kind: 'reason', prompt: 'reason', arguments: {}, dependsOn: [] }],
  }
  return { ctx, loop, adapter, id, session, dag, gate, async dispose() {
    gate.release.resolve()
    writes.delete(tracePath)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  } }
}

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

it('aborts the turn and preserves followup when cancelled during trace persistence', async () => {
  const f = await fixture()
  const agent = new ReactLoopAgent(f.loop.ctx, f.id, { provider: 'mock', model: 'mock' }, f.session, f.dag)
  const trigger = input('run DAG')
  const followup = input('preserve me')
  try {
    agent.followup(trigger)
    await f.gate.entered.promise
    agent.followup(followup)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    f.gate.release.resolve()
    await agent.whenIdle()

    expect(f.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data))
      .toEqual([{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }])
    expect(f.adapter.requests).toHaveLength(1)
    expect(agent.inbox.hasPending).toBe(true)
    expect(agent.inbox.nextTurn).toEqual([followup])
    expect(f.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data))
      .toEqual([trigger])
    expect(JSON.parse(await readFile(f.dag.tracePath, 'utf8')).results).toEqual({ reason: 'DAG done' })
  } finally {
    f.gate.release.resolve()
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
    await agent.scope.dispose()
    await f.dispose()
  }
})

it('rejects a direct DAG call cancelled while its trace write is pending', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const reason = new Error('cancelled during trace write')
  const running = runDagTurn({ ctx: f.loop.ctx, dag: f.dag, provider: 'mock', model: 'mock', signal: controller.signal })
  // Observe rejection immediately so a failing assertion cannot leave an unhandled promise.
  const settled = running.then(value => ({ value }), error => ({ error }))
  try {
    await f.gate.entered.promise
    controller.abort(reason)
    f.gate.release.resolve()
    expect(await settled).toEqual({ error: reason })
    expect(f.adapter.requests).toHaveLength(1)
    expect(JSON.parse(await readFile(f.dag.tracePath, 'utf8')).results).toEqual({ reason: 'DAG done' })
  } finally {
    f.gate.release.resolve()
    await settled
    await f.dispose()
  }
})
