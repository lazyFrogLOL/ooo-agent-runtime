import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WaitWindow } from '../src/wait-window'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

describe('WaitWindow', () => {
  it('settle returns synchronously even when the provider never settles', async () => {
    const run = vi.fn((_signal: AbortSignal) => new Promise<string>(() => {}))
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    const drained = vi.fn()
    void window.drained.then(drained)
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(window.settle()).toMatchObject({ status: 'expired', started: true })
    expect(run.mock.calls[0]![0].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(drained).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settling before any dispatch drains without starting and removes the parent listener', async () => {
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const run = vi.fn(async () => 'unused')
    const window = new WaitWindow({ signal: parent.signal, graceMs: 10, maxRunMs: 50, run })
    window.observe(0)
    expect(window.settle()).toEqual({ status: 'skipped', started: false, elapsedMs: 0, runMs: 0 })
    await window.drained
    window.observe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('completed work never reruns while tools remain active or after close', async () => {
    const run = vi.fn(async () => undefined)
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    await window.drained
    window.observe(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
    window.observe(0)
    window.observe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    expect(window.settle()).toMatchObject({ status: 'completed', value: undefined, started: true })
  })

  it('reports stable lease durations, not background drain latency', async () => {
    const work = deferred<string>()
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run: () => work.promise })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(15)
    window.observe(0)
    const expected = { status: 'expired', started: true, elapsedMs: 15, runMs: 5 }
    expect(window.settle()).toEqual(expected)
    await vi.advanceTimersByTimeAsync(100)
    work.resolve('late')
    await window.drained
    expect(window.settle()).toEqual(expected)
  })
  it.each(['resolve', 'reject'] as const)('rejects %s at the deadline even if its timer has not run', async completion => {
    const work = deferred<string>()
    const run = vi.fn((_signal: AbortSignal) => work.promise)
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(60)
    try {
      if (completion === 'resolve') work.resolve('deadline-race')
      else work.reject(new Error('deadline-race'))
      await window.drained
      expect(window.settle().status).toBe('timeout')
      expect(run.mock.calls[0]![0].aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { clock.mockRestore() }
  })
  it.each([false, true])('captures async rejection without unhandled errors (closed=%s)', async closed => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const work = deferred<string>()
      const error = new Error('async failure')
      const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run: () => work.promise })
      window.observe(1)
      await vi.advanceTimersByTimeAsync(10)
      if (closed) window.observe(0)
      work.reject(error)
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
      const result = window.settle()
      expect(result.status).toBe(closed ? 'expired' : 'failed')
      if (!closed) expect(result).toMatchObject({ source: 'worker', error })
      await window.drained
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
  it('contains synchronous worker failure', async () => {
    const error = new Error('sync failure')
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run: () => { throw error } })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    await window.drained
    expect(window.settle()).toMatchObject({ status: 'failed', source: 'worker', error, started: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['tools-failed', 'stale', 'cancelled'] as const)('%s discards an already completed candidate even after normal close', async reason => {
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run: async () => 'candidate' })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    await window.drained
    window.observe(0)
    const result = window.settle(reason)
    expect(result.status).toBe(reason === 'tools-failed' ? 'failed' : reason)
    expect(result).not.toHaveProperty('value')
    expect(window.settle().status).toBe(result.status)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['before-construction', 'grace', 'running', 'completed', 'closed'] as const)('parent cancellation invalidates %s work', async stage => {
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const work = deferred<string>()
    const run = vi.fn((_signal: AbortSignal) => work.promise)
    if (stage === 'before-construction') parent.abort()
    const window = new WaitWindow({ signal: parent.signal, graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    if (stage !== 'grace') await vi.advanceTimersByTimeAsync(10)
    if (stage === 'completed' || stage === 'closed') {
      work.resolve('candidate')
      await window.drained
    }
    if (stage === 'closed') window.observe(0)
    parent.abort()
    const result = window.settle()
    expect(result.status).toBe('cancelled')
    expect(result).not.toHaveProperty('value')
    expect(vi.getTimerCount()).toBe(0)
    if (run.mock.calls.length) expect(run.mock.calls[0]![0].aborted).toBe(true)
    else expect(run).not.toHaveBeenCalled()
    if (stage !== 'before-construction') expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    work.resolve('late')
    await window.drained
  })
  it('deadline aborts and rejects late completion', async () => {
    const work = deferred<string>()
    const run = vi.fn((_signal: AbortSignal) => work.promise)
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(run.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(window.settle()).toMatchObject({ status: 'timeout', started: true })
    work.resolve('late')
    await window.drained
    expect(window.settle()).not.toHaveProperty('value')
  })
  it('zero closes immediately, retains a drain handle, discards late output and never retries', async () => {
    const work = deferred<string>()
    const run = vi.fn((_signal: AbortSignal) => work.promise)
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(10)
    window.observe(0)
    expect(run.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    let drained = false
    void window.drained.then(() => { drained = true })
    const settled = await window.settle()
    expect(settled).toMatchObject({ status: 'expired', started: true })
    expect(drained).toBe(false)
    window.observe(1)
    await vi.advanceTimersByTimeAsync(100)
    work.resolve('late')
    await window.drained
    expect(drained).toBe(true)
    expect(window.settle()).toMatchObject({ status: 'expired', started: true })
    expect(window.settle()).not.toHaveProperty('value')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('short first window is terminal, clears grace, and never starts', async () => {
    const run = vi.fn(async () => 'unused')
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(0)
    window.observe(1)
    await vi.advanceTimersByTimeAsync(9)
    window.observe(0)
    expect(vi.getTimerCount()).toBe(0)
    window.observe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
    expect(await window.settle()).toMatchObject({ status: 'skipped', started: false, runMs: 0 })
  })
  it('starts after continuous grace and retains useful overlapping completion', async () => {
    const work = deferred<string>()
    const run = vi.fn(() => work.promise)
    const window = new WaitWindow({ graceMs: 10, maxRunMs: 50, run })
    window.observe(1)
    await vi.advanceTimersByTimeAsync(9)
    expect(run).not.toHaveBeenCalled()
    window.observe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5)
    work.resolve('useful')
    await Promise.resolve()
    window.observe(0)
    expect(await window.settle()).toEqual({ status: 'completed', value: 'useful', started: true, elapsedMs: 15, runMs: 5 })
  })
})
