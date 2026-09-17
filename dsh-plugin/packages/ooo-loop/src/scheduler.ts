/**
 * Out-of-Order DAG scheduler (M1 placeholder).
 *
 * Ported from the Python v0.1 prototype (`ooo_runtime/core.py`). This module is
 * deliberately standalone: it knows nothing about dsh sessions, models, or
 * tools. The caller injects two executors — one for REASON nodes (a model
 * request, serialized on the single agent core) and one for TOOL nodes
 * (background I/O, unbounded concurrency) — and the scheduler drives the
 * dynamic task graph to completion in dependency order.
 *
 * M1 wiring plan: `ReactLoopAgent`'s serial turn/step pump calls into
 * `runOutOfOrder()` with executors bound to `ctx.llm` / `ctx.tools`; until
 * that wiring lands this module is exported but unused by the driver.
 *
 * CPU analogy:
 *   instruction         -> OooNode
 *   register dependency -> dependsOn
 *   reservation station -> TaskGraph.ready()
 *   cache miss          -> slow TOOL node
 *   single core         -> REASON semaphore (1)
 *   retirement          -> commit gate for IRREVERSIBLE nodes
 *
 * @module dsh-ooo-loop/scheduler
 */

/** REASON nodes occupy the single agent core; TOOL nodes run in the background. */
export type NodeKind = 'reason' | 'tool'

/**
 * Effect classification for the commit barrier. IRREVERSIBLE nodes (external
 * side effects) may only dispatch once every dependency has settled.
 */
export type EffectClass = 'pure' | 'idempotent' | 'irreversible'

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed'

/** One schedulable unit of agent work. */
export interface OooNode<R = unknown> {
  readonly id: string
  readonly name: string
  readonly kind: NodeKind
  readonly effect?: EffectClass
  /**
   * Ids that must be `done` before this node may dispatch. Mutable because a
   * spawning node reroutes its dependents onto its continuation (see
   * {@link TaskGraph.rerouteDependents}).
   */
  dependsOn?: string[]
  /**
   * Dynamic dependency discovery: after this node completes, its result may
   * spawn further nodes into the graph (e.g. a REASON node that realizes it
   * needs another tool call).
   */
  readonly spawn?: (result: R) => readonly OooNode<R>[]
  /** Produced by the executor on success. */
  result?: R
  status?: NodeStatus
  error?: unknown
}

/** Executors binding the scheduler to real work. Must not throw synchronously. */
export interface NodeExecutors<R = unknown> {
  /** Runs a REASON node; the scheduler serializes these on the agent core. */
  readonly runReason: (node: OooNode<R>) => Promise<R>
  /** Runs a TOOL node; the scheduler runs these concurrently in the background. */
  readonly runTool: (node: OooNode<R>) => Promise<R>
}

/** Per-node execution record for traces and benchmarks. */
export interface NodeTrace {
  readonly id: string
  readonly name: string
  readonly kind: NodeKind
  readonly startedAt: number
  readonly settledAt: number
}

export interface ScheduleOutcome {
  readonly traces: readonly NodeTrace[]
  /** Nodes injected at runtime via `spawn`, in discovery order. */
  readonly spawned: readonly string[]
}

/** Dynamic task graph: dependency tracking plus READY scanning. */
export class TaskGraph<R = unknown> {
  private readonly nodes = new Map<string, OooNode<R>>()
  private readonly insertionOrder: string[] = []
  readonly spawned: string[] = []

  add(...nodes: readonly OooNode<R>[]): void {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
      // Forward references are legal: a node may depend on a node that a
      // running task will spawn later (dynamic discovery). A misspelled dep
      // surfaces as a scheduler deadlock with diagnostics, not silently.
      node.status ??= 'pending'
      this.nodes.set(node.id, node)
      this.insertionOrder.push(node.id)
    }
  }

  addSpawned(parentId: string, nodes: readonly OooNode<R>[]): void {
    this.add(...nodes)
    for (const node of nodes) this.spawned.push(`${parentId} -> ${node.id}`)
  }

  get(id: string): OooNode<R> {
    const node = this.nodes.get(id)
    if (node === undefined) throw new Error(`unknown node: ${id}`)
    return node
  }

  /** Pending nodes whose dependencies are all done, in planner (insertion) order. */
  ready(): OooNode<R>[] {
    const out: OooNode<R>[] = []
    for (const id of this.insertionOrder) {
      const node = this.nodes.get(id)
      if (node === undefined || node.status !== 'pending') continue
      const depsDone = (node.dependsOn ?? []).every(dep => this.nodes.get(dep)?.status === 'done')
      if (depsDone) out.push(node)
    }
    return out
  }

  isDone(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status !== 'done') return false
    }
    return true
  }

  /** Names of nodes that never settled, for diagnostics. */
  unfinished(): string[] {
    const out: string[] = []
    for (const node of this.nodes.values()) {
      if (node.status !== 'done') out.push(`${node.name}(${node.status})`)
    }
    return out
  }

  /**
   * Dependency rerouting for dynamic discovery: when a node spawns a
   * continuation, every still-pending node that waited on the spawner must
   * wait on the continuation instead — otherwise a dependent could dispatch
   * before the spawned work (and its continuation) has settled. Spawned nodes
   * are not in the graph yet when this runs, so the continuation's own
   * legitimate dependency on the spawner is never rewritten.
   */
  rerouteDependents(fromId: string, toId: string): void {
    for (const node of this.nodes.values()) {
      if (node.status !== 'pending' || node.dependsOn === undefined) continue
      if (!node.dependsOn.includes(fromId)) continue
      node.dependsOn = node.dependsOn.map(dep => dep === fromId ? toId : dep)
    }
  }

  /** The first failed node in planner order, if any. */
  firstFailure(): OooNode<R> | undefined {
    for (const id of this.insertionOrder) {
      const node = this.nodes.get(id)
      if (node?.status === 'failed') return node
    }
    return undefined
  }
}

/**
 * Commit barrier: out-of-order execution, in-order retirement. An IRREVERSIBLE
 * node must never dispatch while any dependency is unsettled. The READY scan
 * already guarantees dependency completion, so this is a defense-in-depth
 * assertion at the dispatch site; write_set conflict detection is M3 work.
 */
function assertCommitGate<R>(graph: TaskGraph<R>, node: OooNode<R>): void {
  if (node.effect !== 'irreversible') return
  const unsettled = (node.dependsOn ?? []).filter(dep => graph.get(dep).status !== 'done')
  if (unsettled.length > 0) {
    throw new Error(`commit gate rejected ${node.name}: unsettled deps [${unsettled.join(', ')}]`)
  }
}

/**
 * Event-driven out-of-order scheduler.
 *
 * Loop invariant: dispatch every READY node immediately (REASON nodes through
 * a single-slot core, TOOL nodes unbounded), then wait for the next
 * completion event, rescan, repeat. The agent core never idles while a REASON
 * node is READY — that is the entire point of the design.
 */
export async function runOutOfOrder<R>(
  graph: TaskGraph<R>,
  executors: NodeExecutors<R>,
): Promise<ScheduleOutcome> {
  const traces: NodeTrace[] = []
  let coreChain: Promise<void> = Promise.resolve()
  const inflight = new Set<Promise<void>>()

  // Total by construction: never rejects, so no detached run can trigger an
  // unhandled rejection. Failures are recorded on the node and surfaced by the
  // main loop's fail-fast check.
  const exec = async (node: OooNode<R>): Promise<void> => {
    const startedAt = Date.now()
    try {
      const result = node.kind === 'reason'
        ? await executors.runReason(node)
        : await executors.runTool(node)
      node.result = result
      node.status = 'done'
      const spawned = node.spawn?.(result) ?? []
      if (spawned.length > 0) graph.addSpawned(node.id, spawned)
    } catch (error) {
      node.status = 'failed'
      node.error = error
    }
    traces.push({ id: node.id, name: node.name, kind: node.kind, startedAt, settledAt: Date.now() })
  }

  const track = (run: Promise<void>): void => {
    inflight.add(run)
    void run.finally(() => inflight.delete(run))
  }

  const dispatch = (node: OooNode<R>): void => {
    assertCommitGate(graph, node)
    node.status = 'running'
    if (node.kind === 'reason') {
      // Serialize REASON nodes on the single agent core, FIFO by dispatch order.
      const run = coreChain.then(() => exec(node))
      coreChain = run
      track(run)
    } else {
      track(exec(node))
    }
  }

  const firstFailure = (): OooNode<R> | undefined => graph.firstFailure()

  while (!graph.isDone()) {
    for (const node of graph.ready()) dispatch(node)
    const failed = firstFailure()
    if (failed !== undefined) {
      // Fail fast, but drain started work before surfacing the error.
      await Promise.all([...inflight])
      throw new Error(`node ${failed.name} failed: ${String(failed.error)}`)
    }
    if (inflight.size === 0) {
      throw new Error(`scheduler deadlock: unfinished nodes [${graph.unfinished().join(', ')}]`)
    }
    // Wake on the first completion anywhere, then rescan the whole graph.
    await Promise.race(inflight)
  }
  return { traces, spawned: graph.spawned }
}
