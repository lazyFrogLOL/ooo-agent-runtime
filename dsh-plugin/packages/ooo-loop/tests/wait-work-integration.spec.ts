import { afterEach, describe, expect, it, vi } from 'vitest'
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
  await ctx.plugin(AgentLoop, { agents: [], ...(enabled ? { waitWork: { graceMs: 5, ...options.config } } : {}) })
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
  return { ctx, agent, adapter, middleware, gate, start, events, unregister, active: () => active }
}

describe('ordinary loop waitWork', () => {
  it.each(['fast', 'no-proposal', 'no-tools', 'oversized-snapshot'] as const)('makes zero auxiliary calls for %s', async kind => {
    const h = await harness(true, true, {
      ...(kind === 'fast' ? { config: { graceMs: 100 } } : {}),
      ...(kind === 'no-proposal' ? { mainText: 'ordinary answer' } : {}),
      ...(kind === 'no-tools' ? { main: textResponse(proposal) } : {}),
      ...(kind === 'oversized-snapshot' ? { config: { maxSnapshotChars: 256 } } : {}),
    })
    h.start()
    h.gate.resolve()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(kind === 'no-tools' ? 1 : 2)
    expect(h.events).toHaveLength(0)
  })
  it.each(['tool-error', 'worker-tools', 'worker-empty', 'worker-incomplete', 'worker-max', 'worker-long', 'worker-nested', 'worker-orphan'] as const)('drops %s and preserves main tool pairing', async kind => {
    const worker = kind === 'worker-tools' ? toolCallResponse('bad-call', 'forbidden', {})
      : kind === 'worker-orphan' ? textResponse('draft').filter(c => c.type !== 'block-start')
      : kind === 'worker-empty' ? textResponse(' ')
      : kind === 'worker-incomplete' ? textResponse('partial').filter(c => c.type !== 'finish')
      : kind === 'worker-max' ? [...textResponse('partial').filter(c => c.type !== 'finish'), { type: 'finish', reason: { kind: 'max-tokens' } } as StreamChunk]
      : kind === 'worker-long' ? textResponse('x'.repeat(40))
      : kind === 'worker-nested' ? textResponse(proposal)
      : textResponse('draft')
    const h = await harness(true, true, { worker, failTool: kind === 'tool-error', config: { maxResultChars: 30 } })
    h.start()
    try {
      await until(() => h.adapter.requests.length === 2)
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed' })]))
    expect(h.adapter.requests.at(-1)!.messages.some(m => JSON.stringify(m.content).includes('Unverified wait-work draft'))).toBe(false)
    const blocks = h.agent.session.deriveMessages().flatMap(m => m.content)
    expect(blocks.filter(b => b.type === 'tool-call').map(b => b.id)).toEqual(['call-1'])
    expect(blocks.filter(b => b.type === 'tool-result').map(b => b.toolCallId)).toEqual(['call-1'])
  })
  it('overlaps a single real parallel tool and stages an unverified plugin draft', async () => {
    const h = await harness()
    let admitted = 0
    h.ctx.on('agent/request', async (_payload, next) => { admitted++; return next() })
    h.start()
    try {
      await until(() => h.adapter.requests.length === 2)
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(3)
    const [main, worker, next] = h.adapter.requests
    expect(worker!.sessionId).not.toBe(main!.sessionId)
    expect(worker!.tools).toBeUndefined()
    expect(isAgentLoopRequest(h.middleware[0]!)).toBe(true)
    expect(isAgentLoopRequest(h.middleware[1]!)).toBe(false)
    expect(worker!.purpose).toBeUndefined()
    expect(worker!.maxTokens).toBe(1024)
    expect(worker!.provider).toBe(main!.provider)
    expect(worker!.model).toBe(main!.model)
    expect(admitted).toBe(2)
    expect(h.middleware).toHaveLength(3)
    expect(next!.messages.some(m => m.source.kind === 'plugin' && m.content.some(b => b.type === 'text' && b.text.includes('Unverified wait-work draft')))).toBe(true)
    expect(main!.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('ooo-work'))).toBe(true)
    expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed', usage: { inputTokens: 10, outputTokens: 16 } })]))
    expect(h.agent.session.snapshotEvents().every(e => e.type !== ('agent/wait-work' as string))).toBe(true)
    const restored = h.ctx.sessions.prepare(SessionId('restored'), { seed: h.agent.session.snapshotEvents() })
    expect(restored.deriveMessages()).toEqual(h.agent.session.deriveMessages())
  })
  it('inherits the admitted route and clamps to a smaller main token cap without another waterfall', async () => {
    const h = await harness()
    h.ctx.llm.registerAdapter(['approved'], h.adapter)
    let admissions = 0
    h.ctx.on('agent/request', async (_event, next) => { admissions++; return { ...await next(), provider: 'approved', model: 'approved-model', maxTokens: 64 } })
    h.start()
    try { await until(() => h.adapter.requests.length === 2); await new Promise(resolve => setTimeout(resolve, 10)) }
    finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests[1]).toMatchObject({ provider: 'approved', model: 'approved-model', maxTokens: 64 })
    expect(admissions).toBe(2)
  })
  it('does not stage a draft when the main step boundary fails', async () => {
    const h = await harness()
    const append = h.agent.session.append.bind(h.agent.session)
    const spy = vi.spyOn(h.agent.session, 'append').mockImplementation((type, data, intent) => {
      if (type === 'step/end') throw new Error('step boundary failed')
      return append(type, data, intent)
    })
    h.start()
    try { await until(() => h.adapter.requests.length === 2); await new Promise(resolve => setTimeout(resolve, 10)) }
    finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(h.agent.inbox.nextStep.some(m => JSON.stringify(m.content).includes('Unverified wait-work draft'))).toBe(false)
    spy.mockRestore()
  })
  it('never reopens a concluded turn for a completed draft', async () => {
    const h = await harness()
    h.unregister()
    h.ctx.tools.register(defineContentToolFixture({
      name: 'slow', description: 'concludes', parameters: {}, isConcurrencySafe: () => true,
      async execute(_args, exec) { await h.gate.promise; exec.concludeTurn(); return [{ type: 'text', text: 'done' }] },
    }))
    // The custom tool does not use the harness active flag.
    h.adapter.stream = async function* (request) {
      this.requests.push(request)
      yield* request.sessionId === 'wait-test' ? toolCallResponse('call-1', 'slow', {}, proposal) : textResponse('draft')
    }
    h.start()
    try { await until(() => h.adapter.requests.length === 2); await new Promise(resolve => setTimeout(resolve, 10)) }
    finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed' })]))
  })
  it('discards a completed candidate if steering arrives after dispatch zero but before tool commit', async () => {
    const h = await harness()
    const post = Promise.withResolvers<void>()
    let postStarted = false
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => { postStarted = true; await post.promise; return next() })
    h.start()
    try {
      await until(() => h.adapter.requests.length === 2)
      await new Promise(resolve => setTimeout(resolve, 10))
      h.gate.resolve()
      await until(() => postStarted)
      h.agent.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new input' }] }))
    } finally { h.gate.resolve(); post.resolve() }
    await h.agent.whenIdle()
    expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'stale' })]))
    expect(h.adapter.requests.at(-1)!.messages.some(m => JSON.stringify(m.content).includes('Unverified wait-work draft'))).toBe(false)
  })
  it('uses one attempt for multiple simultaneous parallel tools', async () => {
    const first = toolCallResponse('call-1', 'slow', {}, proposal).filter(c => c.type !== 'finish' && c.type !== 'usage')
    const second = toolCallResponse('call-2', 'slow', {}).map(c => 'index' in c ? { ...c, index: c.index + 2 } : c)
    const h = await harness(true, true, { main: [...first, ...second] })
    h.start()
    try { await until(() => h.adapter.requests.length === 2); await new Promise(resolve => setTimeout(resolve, 15)) }
    finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests.filter(r => r.sessionId !== 'wait-test')).toHaveLength(1)
    expect(h.agent.session.deriveMessages().flatMap(m => m.content).filter(b => b.type === 'tool-result')).toHaveLength(2)
  })
  it.each(['timeout', 'expired', 'cancelled'] as const)('does not await an uncooperative worker after %s or start a replacement', async ending => {
    const h = await harness(true, true, { config: { maxRunMs: ending === 'timeout' ? 10 : 1000 } })
    const provider = Promise.withResolvers<void>()
    const secondTool = Promise.withResolvers<void>()
    let toolCount = 0
    let mainCount = 0
    let workerCount = 0
    h.unregister()
    h.ctx.tools.register(defineContentToolFixture({
      name: 'slow', description: 'gated', parameters: {}, isConcurrencySafe: () => true,
      async execute() { const call = ++toolCount; await (call === 1 ? h.gate.promise : secondTool.promise); return [{ type: 'text', text: 'ok' }] },
    }))
    h.adapter.stream = async function* (request) {
      this.requests.push(request)
      if (request.sessionId !== 'wait-test') { workerCount++; await provider.promise; yield* textResponse('late draft'); return }
      mainCount++
      yield* mainCount <= 2 ? toolCallResponse(`call-${mainCount}`, 'slow', {}, proposal) : textResponse('done')
    }
    try {
      h.start()
      await until(() => workerCount === 1)
      if (ending === 'timeout') await new Promise(resolve => setTimeout(resolve, 25))
      if (ending === 'cancelled') h.agent.cancel({ kind: 'user' })
      h.gate.resolve()
      if (ending === 'cancelled') {
        await h.agent.whenIdle()
        h.start()
      }
      await until(() => mainCount === 2 && toolCount === 2)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(workerCount).toBe(1)
      secondTool.resolve()
      await h.agent.whenIdle()
      expect(mainCount).toBe(3)
      expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: ending, usage: null })]))
      const before = h.agent.session.snapshotEvents().length
      provider.resolve()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(h.agent.session.snapshotEvents()).toHaveLength(before)
      expect(h.adapter.requests.flatMap(r => r.messages).some(m => JSON.stringify(m.content).includes('Unverified wait-work draft'))).toBe(false)
    } finally { h.gate.resolve(); secondTool.resolve(); provider.resolve(); await h.agent.whenIdle(); await new Promise(resolve => setTimeout(resolve, 10)) }
  })
  it.each([false, true])('reserves a per-turn budget without refunding failed=%s attempts', async fail => {
    const h = await harness(true, true, { config: { maxCallsPerTurn: 1 } })
    let main = 0
    let workers = 0
    h.unregister()
    h.ctx.tools.register(defineContentToolFixture({
      name: 'slow', description: 'timer', parameters: {}, isConcurrencySafe: () => true,
      async execute() { await new Promise(resolve => setTimeout(resolve, 20)); return [{ type: 'text', text: 'ok' }] },
    }))
    h.adapter.stream = async function* (request) {
      this.requests.push(request)
      if (request.sessionId !== 'wait-test') { workers++; if (fail) throw new Error('worker failure'); yield* textResponse('draft'); return }
      main++
      yield* main % 3 !== 0 ? toolCallResponse(`call-${main}`, 'slow', {}, proposal) : textResponse('done')
    }
    h.start(); await h.agent.whenIdle()
    expect(workers).toBe(1)
    expect(main).toBe(3)
    h.start(); await h.agent.whenIdle()
    expect(workers).toBe(2)
    expect(main).toBe(6)
  })
  it.each(['steer', 'inject', 'followup', 'splice', 'replace', 'cancel'] as const)('discards a completed draft after %s while the tool is pending', async action => {
    const h = await harness()
    const pending = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
    h.start()
    if (action === 'replace') h.agent.inbox.splice('next-turn', Infinity, 0, [pending])
    try {
      await until(() => h.adapter.requests.length === 2)
      await new Promise(resolve => setTimeout(resolve, 10))
      const input = createUserMessage({ content: [{ type: 'text', text: 'new direction' }], source: { kind: 'user' } })
      if (action === 'cancel') h.agent.cancel({ kind: 'user' })
      else if (action === 'splice') h.agent.inbox.splice('next-step', 0, 0, [input])
      else if (action === 'replace') h.agent.inbox.replace(pending.id, input)
      else h.agent[action](input)
    } finally { h.gate.resolve() }
    await h.agent.whenIdle()
    expect(h.adapter.requests.flatMap(r => r.messages).some(m => m.source.kind === 'plugin' && JSON.stringify(m.content).includes('Unverified wait-work draft'))).toBe(false)
    expect(h.events).toEqual(expect.arrayContaining([expect.objectContaining({ status: action === 'cancel' ? 'cancelled' : 'stale' })]))
  })
  it.each([[false, true], [true, false]])('has no auxiliary calls when enabled=%s parallel=%s', async (enabled, parallel) => {
    const h = await harness(enabled, parallel)
    h.start()
    await until(h.active)
    await new Promise(resolve => setTimeout(resolve, 20))
    h.gate.resolve()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(h.events).toHaveLength(0)
  })
})
