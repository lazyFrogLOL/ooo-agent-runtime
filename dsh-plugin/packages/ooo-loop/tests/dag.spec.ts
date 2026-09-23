import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAG_CONFIG_SCHEMA, runDagTurn } from '../src/dag.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** External service boundaries are mocked; the DAG and scheduler execute unchanged. */
async function fixture(options: {
  calls?: { name: string, arguments: string }[]
  toolError?: boolean
  finish?: string
  missingFinish?: boolean
  mode?: 'parallel' | 'exclusive'
  signal?: AbortSignal
  maxParallelTools?: number
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ooo-dag-test-'))
  directories.push(directory)
  const dispatch = vi.fn(async () => ({ kind: 'post-result', result: {
    isError: options.toolError ?? false,
    error: { code: 'DENIED', message: 'denied' },
    value: 'evidence',
    content: [{ type: 'text', text: options.toolError ? 'Error: denied' : 'evidence' }],
  } }))
  const prepare = vi.fn(async (exec: unknown) => ({ kind: 'dispatch', exec }))
  let requestCount = 0
  const stream = vi.fn(async function* () {
    requestCount++
    if (requestCount === 1 && options.calls) {
      for (const [index, call] of options.calls.entries()) {
        yield { type: 'block-end', block: { type: 'tool-call', id: `call-${index}`, ...call } }
      }
    } else yield { type: 'block-end', block: { type: 'text', text: 'analysis' } }
    if (!options.missingFinish) yield {
      type: 'finish', reason: { kind: options.finish ?? 'stop', failure: { code: 'ABORTED', message: 'aborted' } },
    }
  })
  const executionMode = vi.fn(() => ({ kind: options.mode ?? 'parallel' }))
  // Only services runDagTurn consumes are modeled, rather than constructing a fake Context class.
  const ctx = {
    agents: { requireInitiator: () => ({ id: 'test-agent' }) },
    tools: {
      schemas: () => [{ name: 'allowed', parameters: { type: 'object' } }], executionMode,
      [TOOL_RUNTIME_SCHEDULER]: {
        prepare, dispatch,
        finalize: async (_exec: unknown, result: unknown) => result,
        finish: (_exec: unknown, result: unknown) => result,
      },
    },
    llm: { stream },
  } as unknown as Context
  const run = (nodes: unknown[]) => runDagTurn({
    ctx, dag: DAG_CONFIG_SCHEMA.parse({ tracePath: join(directory, 'trace.json'), nodes }),
    provider: 'mock', model: 'mock', signal: options.signal ?? new AbortController().signal,
    ...(options.maxParallelTools === undefined ? {} : { maxParallelTools: options.maxParallelTools }),
  })
  return { run, prepare, dispatch, stream, executionMode }
}
const initialTool = { id: 'input', name: 'input', kind: 'tool', tool: 'allowed' }
const reason = { id: 'reason', name: 'reason', kind: 'reason', dependsOn: ['input'] }

describe('DAG execution', () => {
  it('reroutes downstream work through the spawned continuation', async () => {
    const f = await fixture({ calls: [{ name: 'allowed', arguments: '{"query":"follow-up"}' }] })
    const trace = await f.run([initialTool, reason, {
      id: 'summary', name: 'summary', kind: 'reason', dependsOn: ['reason'],
    }])
    expect(trace.traces.map(node => node.id)).toEqual([
      'input', 'reason', 'reason-call-0', 'reason-cont', 'summary',
    ])
    expect(f.prepare.mock.calls[1]?.[0]).toMatchObject({ arguments: { query: 'follow-up' } })
    expect(trace.results.summary).toBe('analysis')
  })

  it('does not contact tools or models for an already cancelled run', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before DAG'))
    const f = await fixture({ signal: controller.signal })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/cancelled/)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.stream).not.toHaveBeenCalled()
  })
  it.each([
    { mode: 'exclusive' as const },
    { mode: 'parallel' as const, maxParallelTools: 1 },
  ])('honors host tool admission %j', async (policy) => {
    const f = await fixture(policy)
    const release = Promise.withResolvers<void>()
    const execute = f.dispatch.getMockImplementation()!
    f.dispatch.mockImplementationOnce(async () => { await release.promise; return execute() })
    const running = f.run([initialTool, { ...initialTool, id: 'second' }])
    try {
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalled())
      expect(f.executionMode).toHaveBeenCalled()
      expect(f.dispatch).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      await running
    }
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
  it.each(['aborted', 'max-tokens', 'unknown-provider-reason'])('does not accept %s as a completed analysis', async (finish) => {
    const f = await fixture({ finish })
    await expect(f.run([{ id: 'reason', name: 'reason', kind: 'reason' }])).rejects.toThrow(/finish/)
  })

  it('rejects a truncated stream with no finish event', async () => {
    const f = await fixture({ missingFinish: true })
    await expect(f.run([{ id: 'reason', name: 'reason', kind: 'reason' }])).rejects.toThrow(/finish/)
  })
  it('does not release dependent work after a structured tool failure', async () => {
    const f = await fixture({ toolError: true })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/denied/)
    expect(f.stream).not.toHaveBeenCalled()
  })
  it('rejects a spawned tool outside the declared DAG tool surface', async () => {
    const f = await fixture({ calls: [{ name: 'hidden-write', arguments: '{}' }] })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/not allowed/)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['[]', 'null', '42', '"text"'])('rejects non-object arguments %s', async (arguments_) => {
    const f = await fixture({ calls: [{ name: 'allowed', arguments: arguments_ }] })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/arguments/)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects empty model arguments without dispatching a spawned tool', async () => {
    const f = await fixture({ calls: [{ name: 'allowed', arguments: '' }] })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/invalid arguments/)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.stream).toHaveBeenCalledTimes(1)
  })

  it('accepts an explicit empty JSON object for a spawned tool', async () => {
    const f = await fixture({ calls: [{ name: 'allowed', arguments: '{}' }] })
    const trace = await f.run([initialTool, reason])
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.prepare.mock.calls[1]?.[0]).toMatchObject({ arguments: {} })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(trace.traces.map(node => node.id)).toEqual(['input', 'reason', 'reason-call-0', 'reason-cont'])
  })

  it('rejects malformed model arguments without dispatching an empty argument call', async () => {
    const f = await fixture({ calls: [{ name: 'allowed', arguments: '{broken' }] })
    await expect(f.run([initialTool, reason])).rejects.toThrow(/arguments/)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
})
