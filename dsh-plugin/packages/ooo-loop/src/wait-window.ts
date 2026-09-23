export type WaitWindowCloseReason = 'tools-failed' | 'stale' | 'cancelled'

export interface WaitWindowOptions<T> {
  signal?: AbortSignal
  graceMs: number
  maxRunMs: number
  run: (signal: AbortSignal) => Promise<T>
}

interface WaitWindowTiming {
  started: boolean
  /** Monotonic time from construction to window close; excludes background drain. */
  elapsedMs: number
  /** Time from worker start to completion or lease revocation, whichever came first. */
  runMs: number
}

export type WaitWindowOutcome<T> = WaitWindowTiming & (
  | { status: 'completed'; value: T }
  | { status: 'skipped' | 'expired' | 'timeout' | 'cancelled' | 'stale' }
  | { status: 'failed'; source: 'tools' }
  | { status: 'failed'; source: 'worker'; error: unknown }
)

/**
 * A single speculative lease over a continuous interval of dispatched eligible tools.
 * Closing is synchronous: it revokes adoption and requests cooperative cancellation,
 * never waiting for a provider. Abort cannot forcibly stop an uncooperative provider.
 * The owner must retain its worker slot until `drained` resolves (possibly never).
 */
export class WaitWindow<T> {
  private readonly createdAt = performance.now()
  private readonly child = new AbortController()
  private startedAt: number | undefined
  private finishedAt: number | undefined
  private closedAt: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private opened = false
  private timedOut = false
  private cancelled = false
  private reason: WaitWindowCloseReason | undefined
  private candidate: { value: T } | undefined
  private failure: { error: unknown } | undefined
  private resolveDrained!: () => void

  /** Resolves on actual worker exit, or close without a start. Never rejects. */
  readonly drained = new Promise<void>(resolve => { this.resolveDrained = resolve })

  private readonly onAbort = () => {
    this.cancelled = true
    this.candidate = undefined
    this.close()
    this.child.abort()
  }

  constructor(private readonly options: WaitWindowOptions<T>) {
    if (options.signal?.aborted) this.onAbort()
    else options.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Report the real in-flight eligible dispatch count, not queued/announced calls. */
  observe(activeEligibleTools: number): void {
    if (this.closedAt !== undefined) return
    if (activeEligibleTools === 0) {
      if (this.opened) this.close()
      return
    }
    if (activeEligibleTools > 0) {
      this.opened = true
      if (this.timer === undefined && this.startedAt === undefined) {
        this.timer = setTimeout(() => this.start(), this.options.graceMs)
      }
    }
  }

  /**
   * Close immediately and return an outcome snapshot; does NOT await `drained`.
   * Normal close preserves a candidate completed while its lease was valid.
   * Explicit invalidation also discards already completed candidates. The first
   * explicit reason is sticky; a parent abort is rechecked after listener cleanup.
   */
  settle(reason?: WaitWindowCloseReason): WaitWindowOutcome<T> {
    this.reason ??= reason
    if (this.options.signal?.aborted) this.onAbort()
    if (this.reason) this.candidate = undefined
    this.close()
    const timing: WaitWindowTiming = {
      started: this.startedAt !== undefined,
      elapsedMs: this.closedAt! - this.createdAt,
      runMs: this.startedAt === undefined ? 0 : (this.finishedAt ?? this.closedAt!) - this.startedAt,
    }
    if (this.reason === 'tools-failed') return { ...timing, status: 'failed', source: 'tools' }
    if (this.reason) return { ...timing, status: this.reason }
    if (this.cancelled) return { ...timing, status: 'cancelled' }
    if (this.startedAt === undefined) return { ...timing, status: 'skipped' }
    if (this.failure) return { ...timing, status: 'failed', source: 'worker', error: this.failure.error }
    if (this.timedOut) return { ...timing, status: 'timeout' }
    if (this.candidate) return { ...timing, status: 'completed', value: this.candidate.value }
    return { ...timing, status: 'expired' }
  }

  private close(): void {
    this.closedAt ??= performance.now()
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.clearTimer()
    if (this.startedAt === undefined) this.resolveDrained()
    else if (this.finishedAt === undefined) this.child.abort()
  }

  private clearTimer(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private start(): void {
    this.startedAt = performance.now()
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.close()
    }, this.options.maxRunMs)
    try {
      // Attach both handlers immediately, including for already rejected promises.
      void this.options.run(this.child.signal).then(value => {
        // Timers may be delayed by a busy event loop: check the monotonic deadline too.
        this.checkDeadline()
        if (this.closedAt === undefined) {
          this.candidate = { value }
          this.finishedAt = performance.now()
        }
        this.clearTimer()
        this.resolveDrained()
      }, error => this.fail(error))
    } catch (error) {
      this.fail(error)
    }
  }

  private checkDeadline(): void {
    if (this.closedAt === undefined && performance.now() - this.startedAt! >= this.options.maxRunMs) {
      this.timedOut = true
      this.close()
    }
  }

  private fail(error: unknown): void {
    this.checkDeadline()
    if (this.closedAt === undefined) {
      this.failure = { error }
      this.finishedAt = performance.now()
      this.close()
    }
    this.resolveDrained()
  }
}
