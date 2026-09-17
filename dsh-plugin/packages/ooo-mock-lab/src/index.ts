/**
 * OOO mock lab: a deterministic mock LLM adapter plus controllable-latency
 * tools — the verification harness for the OOO agent loop.
 *
 * Why this exists: developing and benchmarking a scheduler against a real
 * model is slow, costly, and non-deterministic. This lab makes the model a
 * SCRIPTED actor (fixed sequence of responses, fixed think latency) and tools
 * into pure timers, so one benchmark run is fully reproducible and needs no
 * API key. The same scenario then runs under the default loop and the OOO
 * loop, and wall-clock makespan is the comparison.
 *
 * The script is consumed one response per model request, in order. Each
 * response is either a text answer (turn ends) or a batch of tool calls
 * (tools execute, results come back, next scripted response serves the next
 * request).
 *
 * @module @deepseek-ai/dsh-ooo-mock-lab
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const scriptResponse = z.object({
  /** Text answer; ends the turn when no toolCalls are present. */
  text: z.string().optional(),
  /** Tool calls the scripted "model" emits in this response. */
  toolCalls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })).optional(),
  /**
   * Content routing: when set, this response is served to the first request
   * whose last user message contains this substring (instead of strict
   * script order). The OOO DAG driver issues one request per REASON node
   * in scheduler order, so request order is nondeterministic and responses
   * must be routed by content.
   */
  match: z.string().optional(),
  /** Per-response think latency override; defaults to the adapter's thinkMs. */
  thinkMs: z.number().positive().optional(),
})

export const Config = z.object({
  /** Provider route this adapter registers. */
  provider: z.string().default('mock'),
  /** Simulated per-request model latency in milliseconds. */
  thinkMs: z.number().positive().default(500),
  /** Responses served in request order; exhaustion yields a stop notice. */
  script: z.array(scriptResponse).default([]),
  /**
   * Canned content for the realistic `fetch_data` tool (L3: real model,
   * deterministic tools). Keyed by topic; unknown topics get generic content.
   */
  topics: z.record(z.string(), z.string()).default({}),
  /**
   * Per-topic fetch latency in milliseconds for `fetch_data`; unknown topics
   * take 1000ms. Latency is a property of the data source, so it lives in
   * config rather than in the tool's parameters.
   */
  latencies: z.record(z.string(), z.number().positive()).default({}),
})

export type MockLabConfig = z.infer<typeof Config>
type ScriptResponse = z.infer<typeof scriptResponse>

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Extract the text of the request's last user message for `match` routing. */
function lastUserText(options: GenerateOptions): string {
  const last = options.messages.at(-1)
  if (last === undefined) return ''
  return last.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

/** Scripted adapter: replays `config.script`, one response per request. */
class MockAdapter extends LlmAdapter {
  private cursor = 0
  private serial = 0
  private readonly consumed = new Set<number>()

  constructor(private readonly config: MockLabConfig) {
    super()
  }

  /**
   * Pick the response for one request. Content-matched entries win (the OOO
   * driver's request order is scheduler-dependent); otherwise the next
   * unconsumed entry in script order keeps the sequential benchmark exact.
   */
  private pick(options: GenerateOptions): ScriptResponse {
    const text = lastUserText(options)
    const matched = this.config.script.findIndex(
      (entry, index) => !this.consumed.has(index) && entry.match !== undefined && text.includes(entry.match),
    )
    if (matched >= 0) {
      this.consumed.add(matched)
      return this.config.script[matched]!
    }
    while (this.consumed.has(this.cursor)) this.cursor += 1
    const step: ScriptResponse | undefined = this.config.script[this.cursor]
    this.consumed.add(this.cursor)
    this.cursor += 1
    return step ?? { text: '[mock-lab] script exhausted' }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step: ScriptResponse = this.pick(options)
    // Mock 不模拟中途 abort 语义；benchmark 场景用不到。
    await sleep(step.thinkMs ?? this.config.thinkMs)

    let index = 0
    if (step.text !== undefined) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: step.text }
      yield { type: 'block-end', index, block: { type: 'text', text: step.text } }
      index += 1
    }
    const calls = step.toolCalls ?? []
    for (const call of calls) {
      const id = ToolCallId(`mock-call-${++this.serial}-${index}`)
      const args = JSON.stringify(call.arguments)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      index += 1
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }
    yield { type: 'finish', reason: { kind: calls.length > 0 ? 'tool-calls' : 'stop' } }
  }
}

/**
 * A deterministic slow fetch: sleeps `latencyMs`, then returns canned content.
 * `isConcurrencySafe: true` lets sibling calls overlap in the default loop's
 * parallel pool — the benchmark measures orchestration, not tool locks.
 */
function registerMockTools(ctx: Context, config: MockLabConfig): () => void {
  const disposeFetch = ctx.tools.register(defineTool({
    name: 'mock_fetch',
    description: 'Deterministic slow fetch for benchmarking: sleeps latencyMs, then returns canned data for topic.',
    parameters: {
      topic: { type: 'string', required: true, description: 'What to fetch' },
      latencyMs: { type: 'number', required: true, description: 'Simulated fetch latency in milliseconds' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await sleep(args.latencyMs)
      return `<mock data: ${args.topic}, fetched in ${String(args.latencyMs)}ms>`
    },
  }))
  // L3 variant: a plausibly-described data source for real-model runs. Same
  // deterministic latency, but canned content reads like real data so the
  // model's analysis and spawn decisions are meaningful. Latency is config-
  // driven (a property of the source), so the model only chooses the topic.
  const disposeFetchData = ctx.tools.register(defineTool({
    name: 'fetch_data',
    description: 'Fetch business data about a company by topic (e.g. 财报, 公告, 新闻, 研报, 竞争对手). Returns the latest available dataset for that topic.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Data topic to fetch' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await sleep(config.latencies[args.topic] ?? 1000)
      return config.topics[args.topic] ?? `<${args.topic} 数据集：暂无详细记录>`
    },
  }))
  return () => {
    disposeFetch()
    disposeFetchData()
  }
}

export const name = 'ooo-mock-lab'
export const inject = ['llm', 'tools']

export function apply(ctx: Context, config: MockLabConfig): void {
  const adapter = new MockAdapter(config)
  ctx.effect(
    () => ctx.llm.registerAdapter([config.provider], adapter),
    'ooo-mock-lab.registerAdapter()',
  )
  ctx.effect(() => registerMockTools(ctx, config), 'ooo-mock-lab.registerTools()')
}
