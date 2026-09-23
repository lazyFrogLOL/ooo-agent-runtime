import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import type { WaitWorkConfig } from '../src/wait-work.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const proposal = '<ooo-work>{"task":"Review the existing text for edge cases"}</ooo-work>'
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(predicate()).toBe(true)
}
async function harness(enabled = true, parallel = true, options: { config?: Partial<WaitWorkConfig>; mainText?: string; worker?: StreamChunk[]; failTool?: boolean; main?: StreamChunk[] } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [], ...(enabled ? { waitWork: { graceMs: 5, ...options.config } } : {}) })
  const gate = Promise.withResolvers<void>()
  let active = false
  const unregister = ctx.tools.register(defineContentToolFixture({
    name: 'slow', description: 'gated text tool', parameters: {},
    ...(parallel ? { isConcurrencySafe: () => true } : {}),
    async execute() { active = true; await gate.promise; active = false; if (options.failTool) throw new Error('tool failed'); return [{ type: 'text', text: 'tool result' }] },
  }))
  const adapter = new MockAdapter([
    options.main ?? toolCallResponse('call-1', 'slow', {}, options.mainText ?? proposal),
    request => {
      if (request.sessionId !== 'wait-test') expect(active).toBe(true)
      return request.sessionId === 'wait-test' ? textResponse('main done') : options.worker ?? textResponse('draft edge cases')
    },
    textResponse('main done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const middleware: GenerateOptions[] = []
  ctx.on('llm/stream', (request, next) => {
    middleware.push(request)
    if (isAgentLoopRequest(request)) {
      const session = ctx.sessions.get(request.sessionId!)!
      expect(Object.isFrozen(request)).toBe(true)
      expect(request.messages).toEqual(session.deriveMessages())
      expect(request.maxTokens).toBe(session.requestHeader()!.config.maxTokens)
      expect(request.tools ?? []).toEqual(session.requestHeader()!.tools ?? [])
    }
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('wait-test'), { provider: 'mock', model: 'mock', maxTokens: 4096 })
  const events: unknown[] = []
  ctx.on('agent/wait-work', ({ agent: _agent, ...payload }) => { events.push(payload) })
  const start = () => agent.followup(createUserMessage({ content: [{ type: 'text', text: 'check current code' }], source: { kind: 'user' } }))
  return { ctx, loopFiber, agent, adapter, middleware, gate, start, events, unregister, active: () => active }
}


it('factory disposal aborts but does not wait for helper or allow late writes', async () => {
  const h = await harness()
  const release = Promise.withResolvers<void>()
  let workerSignal: AbortSignal | undefined
  h.adapter.stream = async function* (request) {
    this.requests.push(request)
    if (request.sessionId !== 'wait-test') {
      workerSignal = request.signal
      await release.promise
      yield* textResponse('late helper draft')
      return
    }
    yield* toolCallResponse('call-1', 'slow', {}, proposal)
  }
  try {
    h.start()
    await until(() => workerSignal !== undefined)
    const disposing = h.loopFiber.dispose()
    await until(() => workerSignal!.aborted)
    h.gate.resolve()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await until(() => disposed)
    expect(h.ctx.agents.get(h.agent.id)).toBeUndefined()
    const n = h.agent.session.snapshotEvents().length
    release.resolve()
    await new Promise(r => setTimeout(r, 20))
    expect(h.agent.session.snapshotEvents()).toHaveLength(n)
    expect(JSON.stringify(h.agent.session.deriveMessages())).not.toContain('late helper draft')
    expect(JSON.stringify((await h.ctx.systemPrompt.assemble({})).sections)).not.toContain('ooo-work')
  } finally { release.resolve(); h.gate.resolve() }
})

it('complete prompt remains exact and excludes optional protocol', async () => {
  const h = await harness()
  h.ctx.systemPrompt.section({ name: 'owned', order: 1, complete: true, text: 'Exact owned instructions.' })
  h.start(); h.gate.resolve(); await h.agent.whenIdle()
  const systems = h.adapter.requests[0]!.messages.filter(m => m.role === 'system')
  expect(systems).toHaveLength(1)
  expect(systems[0]!.content).toEqual([{ type: 'text', text: 'Exact owned instructions.' }])
})
