/** Real YAML composition; deterministic external-service simulation, not a model speed benchmark. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { textResponse, toolCallResponse } from './mock-adapter.ts'

const supplied = 'Already supplied evidence: project ALPHA uses a read-only cache.'
const prepared = 'Prepared summary: ALPHA uses a read-only cache.'
const external = 'External read: ALPHA cache status is healthy.'
const proposal = '<ooo-work>{"task":"summarize already supplied evidence"}</ooo-work>'
const waitWork = { graceMs: 1, maxRunMs: 1000, maxTokens: 128, maxCallsPerTurn: 1, maxSnapshotChars: 16000, maxResultChars: 4000 }
type Mark = { name: string, ms: number }

class EvidenceModel extends LlmAdapter {
  main: GenerateOptions[] = []
  auxiliary: GenerateOptions[] = []
  consumedDraft = false
  consumedTool = false
  final = ''
  readonly prepared = Promise.withResolvers<void>()
  constructor(readonly mainId: string, readonly mark: (name: string) => void) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  private async prepare(messages: GenerateOptions['messages']) {
    expect(JSON.stringify(messages)).toContain(supplied)
    this.mark('prepare:start')
    await delay(20)
    this.mark('prepare:end')
    return prepared
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.mainId) {
      this.auxiliary.push(options)
      this.mark('auxiliary:start')
      const summary = await this.prepare(options.messages)
      yield* textResponse(summary)
      this.mark('auxiliary:end')
      this.prepared.resolve()
      return
    }
    this.main.push(options)
    this.mark(`main:${this.main.length}`)
    if (this.main.length === 1) {
      yield* toolCallResponse('external-read', 'read_evidence', {}, proposal)
      return
    }
    if (this.main.length !== 2) throw new Error('Unexpected extra main request')
    const draft = options.messages.find(m => m.source.kind === 'plugin' && JSON.stringify(m.content).includes(prepared))
    const draftText = draft?.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    const summary = draftText ? draftText.slice(draftText.indexOf(prepared), draftText.indexOf(prepared) + prepared.length) : await this.prepare(options.messages)
    this.consumedDraft = draft !== undefined
    // Consume the actual result block, not the proposal or a canned final answer.
    const result = options.messages.flatMap(m => m.content).find(b => b.type === 'tool-result' && b.toolCallId === 'external-read')
    const actual = result?.type === 'tool-result' ? result.content.filter(b => b.type === 'text').map(b => b.text).join('') : ''
    this.consumedTool = actual === external
    expect(actual).toBe(external)
    this.final = `${summary}\nVerified against ${actual}`
    yield* textResponse(this.final)
    this.mark('main:done')
  }
}

async function arm(enabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'wait-work-loader-'))
  const ctx = new Context()
  const marks: Mark[] = []
  const start = performance.now()
  const mark = (name: string) => { marks.push({ name, ms: performance.now() - start }) }
  const model = new EvidenceModel(`loader-${enabled ? 'on' : 'off'}`, mark)
  try {
    const modules = new Map<string, unknown>([
      ['llm', LlmRuntime], ['session', SessionStore], ['projection', SessionProjectionRegistry],
      ['prompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop],
    ])
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [...modules.keys()].flatMap(name => [
      `- name: '${name}'`,
      ...(name === 'loop' ? ['  config:', '    agents: []', ...(enabled
        ? ['    waitWork:', ...Object.entries(waitWork).map(([key, value]) => `      ${key}: ${value}`)] : [])] : []),
    ]).join('\n') + '\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.agentLoop.config.waitWork).toEqual(enabled ? waitWork : undefined)
    expect(ctx.agentLoop.config.dag).toBeUndefined()
    ctx.llm.registerAdapter(['fixture'], model)
    ctx.tools.register(defineContentToolFixture({
      name: 'read_evidence', description: 'Read external evidence without changing state', parameters: {},
      isConcurrencySafe: () => true,
      async execute() {
        mark('tool:start')
        await delay(60)
        // A bounded gate avoids a scheduler-load race without hiding missing auxiliary calls.
        if (enabled) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([model.prepared.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 1200) })])
          } finally { clearTimeout(timer) }
        }
        mark('tool:end')
        return [{ type: 'text', text: external }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId(model.mainId), { provider: 'fixture', model: 'evidence', maxTokens: 2048 })
    const prompt = ctx.systemPrompt
    const before = await prompt.assemble({})
    agent.followup(createUserMessage({ content: [{ type: 'text', text: supplied }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const replay = Session.create(agent.id, events).deriveMessages()
    const persistedDrafts = replay.filter(m => m.source.kind === 'plugin' && JSON.stringify(m.content).includes(prepared))
    const calls = replay.flatMap(m => m.content).filter(b => b.type === 'tool-call')
    const results = replay.flatMap(m => m.content).filter(b => b.type === 'tool-result')
    const loopEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'loop')
    // Dispose just the Loader-owned loop context: the prompt service stays alive for the leak check.
    if (!loopEntry?.fiber) throw new Error('Loader did not expose loop entry')
    await loopEntry.fiber.dispose()
    const after = await prompt.assemble({})
    const interval = (name: string) => ({
      startMs: marks.find(m => m.name === `${name}:start`)?.ms ?? null,
      endMs: marks.find(m => m.name === `${name}:end`)?.ms ?? null,
    })
    return {
      enabled, model, marks, before, after, persistedDrafts, calls, results, events, replay,
      record: { enabled, mainCalls: model.main.length, auxiliaryCalls: model.auxiliary.length,
        elapsedMs: performance.now() - start, marks, tool: interval('tool'), auxiliary: interval('auxiliary'),
        preparation: interval('prepare'), finalOutput: model.final,
        consumedDraft: model.consumedDraft, consumedTool: model.consumedTool },
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

it('loads optional waitWork from YAML and reuses overlapping preparation with identical verified output', async () => {
  const disabled = await arm(false)
  const enabled = await arm(true)
  // Opt-in only; records actual adapter calls and measured intervals, never fabricated speedups.
  if (process.env.OOO_WAIT_BENCHMARK_OUTPUT) {
    await writeFile(process.env.OOO_WAIT_BENCHMARK_OUTPUT, JSON.stringify([disabled.record, enabled.record], null, 2) + '\n')
  }
  for (const run of [disabled, enabled]) {
    expect(run.model.main).toHaveLength(2)
    expect(run.model.consumedTool).toBe(true)
    expect(run.calls.map(b => b.id)).toEqual(['external-read'])
    expect(run.results.map(b => b.toolCallId)).toEqual(['external-read'])
    expect(run.marks.filter(m => m.name === 'prepare:start')).toHaveLength(1)
    expect(run.replay.filter(m => m.role === 'assistant').at(-1)?.content).toEqual([{ type: 'text', text: run.model.final }])
    expect(JSON.stringify(run.after.sections)).not.toContain('ooo-work')
    const index = (name: string) => run.marks.findIndex(m => m.name === name)
    expect(index('tool:start')).toBeLessThan(index('tool:end'))
    expect(index('tool:end')).toBeLessThan(index('main:2'))
    expect(index('main:2')).toBeLessThan(index('main:done'))
    if (run.enabled) {
      expect(index('tool:start')).toBeLessThan(index('auxiliary:start'))
      expect(index('auxiliary:start')).toBeLessThan(index('prepare:start'))
      expect(index('prepare:end')).toBeLessThan(index('auxiliary:end'))
      expect(index('auxiliary:end')).toBeLessThan(index('tool:end'))
    } else {
      expect(index('main:2')).toBeLessThan(index('prepare:start'))
    }
  }
  expect(disabled.model.auxiliary).toHaveLength(0)
  expect(disabled.persistedDrafts).toHaveLength(0)
  expect(JSON.stringify(disabled.before.sections)).not.toContain('ooo-work')
  expect(enabled.model.auxiliary).toHaveLength(1)
  expect(enabled.model.consumedDraft).toBe(true)
  expect(enabled.persistedDrafts).toHaveLength(1)
  expect(enabled.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
    && JSON.stringify(event.data.content).includes(prepared))).toHaveLength(1)
  expect(JSON.stringify(enabled.persistedDrafts[0])).toContain('Unverified')
  expect(JSON.stringify(enabled.before.sections)).toContain('ooo-work')
  const worker = enabled.model.auxiliary[0]!
  expect(worker.sessionId).not.toBe(enabled.model.main[0]!.sessionId)
  expect(worker.tools).toBeUndefined()
  expect(worker).toMatchObject({ provider: 'fixture', model: 'evidence', maxTokens: waitWork.maxTokens })
  expect(JSON.stringify(worker.messages)).not.toContain(external)
  expect(enabled.model.final).toBe(disabled.model.final)
  expect(enabled.model.final).toBe(`${prepared}\nVerified against ${external}`)
}, 10000)
