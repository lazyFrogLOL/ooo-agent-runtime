/**
 * Static-DAG benchmark driver (M1b).
 *
 * A second execution path for {@link ReactLoopAgent}: when the plugin config
 * carries a `dag`, the first turn executes that declared task graph through
 * {@link runOutOfOrder} instead of the conversational step loop. TOOL nodes
 * run through the real tool runtime pipeline (prepare → dispatch →
 * finalize/finish, the same path `tool-calls.ts` uses); REASON nodes are
 * one-shot model requests serialized on the scheduler's single agent core,
 * each receiving its dependencies' results as context.
 *
 * Instrumentation is a side-channel trace JSON (`dag.tracePath`), NOT session
 * events: `Session.append()` cannot mark events `ignorable`, so custom
 * `ooo/*` log entries would make the session unresumable for any reader that
 * does not know the type. The turn still emits the standard `turn/start` /
 * `turn/end` pair, so the session log stays valid.
 *
 * @module dsh-ooo-loop/dag
 */

import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { runOutOfOrder, TaskGraph, type NodeTrace, type OooNode } from './scheduler.ts'

const dagNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['reason', 'tool']),
  /** kind=tool: registered tool name to invoke. */
  tool: z.string().min(1).optional(),
  /** kind=tool: parsed tool arguments. */
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** kind=reason: instruction text; dependency results are appended as context. */
  prompt: z.string().optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
})

/** Schema of the plugin config's `dag` section. */
export const DAG_CONFIG_SCHEMA = z.object({
  /** Absolute path of the trace JSON written when the DAG settles. */
  tracePath: z.string().min(1),
  nodes: z.array(dagNodeSchema).min(1),
})

export type DagNodeConfig = z.infer<typeof dagNodeSchema>
export type DagConfig = z.infer<typeof DAG_CONFIG_SCHEMA>

/** A tool call a REASON node's model emitted mid-DAG — a spawn request. */
export interface SpawnedCall {
  readonly id: string
  readonly name: string
  /** Raw JSON arguments, exactly as the model produced them. */
  readonly arguments: string
}

/**
 * Every node's result. A REASON node that emitted tool calls is only
 * provisionally done: its text is the partial conclusion, and `toolCalls`
 * drives the spawn of tool nodes plus a continuation (see runDagTurn).
 */
export interface NodeResult {
  readonly text: string
  readonly toolCalls?: readonly SpawnedCall[]
}

/** The trace artifact one DAG turn writes to `dag.tracePath`. */
export interface DagTraceFile {
  readonly startedAt: number
  readonly endedAt: number
  readonly makespanMs: number
  /** Wall time the single agent core spent on REASON nodes. */
  readonly coreBusyMs: number
  readonly traces: readonly NodeTrace[]
  readonly spawned: readonly string[]
  /** Per-node result text, keyed by node id. */
  readonly results: Record<string, string>
}

/** Build the same explicit tool input for admission classification and execution. */
function toolInput(ctx: Context, config: DagNodeConfig, signal: AbortSignal): ToolExecutionInput {
  if (config.tool === undefined) throw new Error(`dag node "${config.id}": kind=tool requires 'tool'`)
  return {
    callId: ToolCallId(`ooo-${config.id}`),
    name: config.tool,
    arguments: config.arguments,
    agent: ctx.agents.requireInitiator(),
    signal,
  }
}

/** Execute one TOOL node through the real tool runtime pipeline. */
async function runToolNode(ctx: Context, config: DagNodeConfig, signal: AbortSignal): Promise<string> {
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
  const exec = toolInput(ctx, config, signal)
  const prepared = await scheduler.prepare(exec)
  signal.throwIfAborted()
  // finalize/finish take the prepared run context, not the caller's input.
  const runExec = prepared.exec
  let result: ToolExecutionResult
  let needsPost: boolean
  switch (prepared.kind) {
    case 'dispatch': {
      const outcome = await scheduler.dispatch(prepared.exec)
      result = outcome.result
      needsPost = outcome.kind === 'post-result'
      break
    }
    case 'post-result':
      result = prepared.result
      needsPost = true
      break
    case 'final-result':
      result = prepared.result
      needsPost = false
      break
  }
  const settled = needsPost
    ? await scheduler.finalize(runExec, result)
    : scheduler.finish(runExec, result)
  if (settled.isError) {
    throw new Error(`dag node "${config.id}": tool failed: ${settled.error.message}`, { cause: settled.error })
  }
  return settled.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

/**
 * Execute one REASON node as a one-shot model request. Dependency results
 * ride in the user message, so a scripted adapter can match on the prompt
 * and a real model sees the same content a conversational loop would feed it.
 * Tool-call blocks are collected into the result instead of being executed
 * inline — executing them as spawned nodes is what keeps the core free.
 */
async function runReasonNode(
  ctx: Context,
  config: DagNodeConfig,
  deps: readonly { name: string, result: string }[],
  route: { provider: string, model: string },
  signal: AbortSignal,
  tools?: GenerateOptions['tools'],
): Promise<NodeResult> {
  const depSection = deps
    .map(dep => `<dependency name="${dep.name}">\n${dep.result}\n</dependency>`)
    .join('\n')
  const text = `${config.prompt ?? config.name}${depSection.length > 0 ? `\n\n${depSection}` : ''}`
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [message],
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    signal,
  })
  let output = ''
  const toolCalls: SpawnedCall[] = []
  let finished = false
  for await (const chunk of stream) {
    signal.throwIfAborted()
    if (finished) throw new Error(`dag node "${config.id}": chunk after finish`)
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
        throw new Error(`dag node "${config.id}": unsuccessful model finish (${chunk.reason.kind})`, { cause: chunk.reason })
      }
      finished = true
    }
    if (chunk.type !== 'block-end') continue
    if (chunk.block.type === 'text') output += chunk.block.text
    if (chunk.block.type === 'tool-call') {
      toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
    }
  }
  signal.throwIfAborted()
  if (!finished) throw new Error(`dag node "${config.id}": missing model finish`)
  return toolCalls.length > 0 ? { text: output, toolCalls } : { text: output }
}

/**
 * Run the configured DAG to completion and write its trace file.
 * Resolves with the trace on success; rejects on the first node failure
 * (after in-flight work drains) or on scheduler deadlock.
 *
 * Dynamic discovery: a REASON node whose model emits tool calls spawns one
 * TOOL node per call plus a continuation REASON node (`<id>-cont`) that
 * depends on the spawner and those tools. Pending dependents of the spawner
 * are rerouted onto the continuation, so downstream work never starts from
 * a provisional result.
 */
export async function runDagTurn(options: {
  ctx: Context
  dag: DagConfig
  provider: string
  model: string
  signal: AbortSignal
  /** Host tool concurrency limit; defaults to the scheduler limit for direct callers. */
  maxParallelTools?: number
}): Promise<DagTraceFile> {
  const { ctx, dag, signal } = options
  const route = { provider: options.provider, model: options.model }
  const configById = new Map(dag.nodes.map(node => [node.id, node]))
  /** Configs of nodes discovered at runtime, registered as they spawn. */
  const spawnedConfigs = new Map<string, DagNodeConfig>()
  const graph = new TaskGraph<NodeResult>()

  // REASON requests advertise exactly the tools this DAG uses (plus whatever
  // spawned nodes may call, which come from the same registry entry), so a
  // real model's function calls stay inside the declared tool surface.
  const toolNames = new Set(
    dag.nodes.flatMap(node => node.kind === 'tool' && node.tool !== undefined ? [node.tool] : []),
  )
  const reasonTools = toolNames.size > 0
    ? ctx.tools.schemas().filter(schema => toolNames.has(schema.name))
    : []

  const resolveConfig = (id: string): DagNodeConfig => {
    const config = configById.get(id) ?? spawnedConfigs.get(id)
    if (config === undefined) throw new Error(`dag node "${id}": no config`)
    return config
  }

  /** Build the spawn hook for one REASON node (static or spawned). */
  const buildSpawn = (parent: DagNodeConfig) =>
    (result: NodeResult): OooNode<NodeResult>[] => {
      const calls = result.toolCalls ?? []
      if (calls.length === 0) return []
      const nodes: OooNode<NodeResult>[] = []
      const toolIds: string[] = []
      calls.forEach((call, index) => {
        if (!reasonTools.some(tool => tool.name === call.name)) {
          throw new Error(`dag node "${parent.id}": tool ${call.name} is not allowed`)
        }
        const id = `${parent.id}-call-${index}`
        let parsed: unknown
        try {
          parsed = JSON.parse(call.arguments || '{}')
        } catch (error) {
          throw new Error(`dag node "${parent.id}": invalid arguments for ${call.name}`, { cause: error })
        }
        const validated = z.record(z.string(), z.unknown()).safeParse(parsed)
        if (!validated.success) {
          throw new Error(`dag node "${parent.id}": arguments for ${call.name} must be an object`)
        }
        const args = validated.data
        const config: DagNodeConfig = {
          id,
          name: `${parent.name}→${call.name}`,
          kind: 'tool',
          tool: call.name,
          arguments: args,
          dependsOn: [],
        }
        spawnedConfigs.set(id, config)
        toolIds.push(id)
        nodes.push({ id, name: config.name, kind: 'tool', dependsOn: [] })
      })
      const contId = `${parent.id}-cont`
      const contConfig: DagNodeConfig = {
        id: contId,
        name: `继续${parent.name}`,
        kind: 'reason',
        prompt: `继续${parent.name}：基于刚返回的工具结果完成分析。`,
        arguments: {},
        dependsOn: [parent.id, ...toolIds],
      }
      spawnedConfigs.set(contId, contConfig)
      nodes.push({
        id: contId,
        name: contConfig.name,
        kind: 'reason',
        dependsOn: [...contConfig.dependsOn],
        spawn: buildSpawn(contConfig),
      })
      // Downstream must wait for the continuation, not the provisional parent.
      graph.rerouteDependents(parent.id, contId)
      return nodes
    }

  graph.add(...dag.nodes.map((node): OooNode<NodeResult> => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    dependsOn: [...node.dependsOn],
    ...node.kind === 'reason' ? { spawn: buildSpawn(node) } : {},
  })))

  /**
   * Ancestor cone of one node, in topological order (dependencies first).
   * REASON prompts are built from the whole cone, not just direct deps:
   * a continuation's context is everything its causal ancestry produced,
   * so spawned work never loses the data its spawner was reasoning over.
   */
  const ancestorCone = (id: string): string[] => {
    const seen = new Set<string>()
    const ordered: string[] = []
    const visit = (nodeId: string): void => {
      for (const dep of graph.get(nodeId).dependsOn ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        visit(dep)
        ordered.push(dep)
      }
    }
    visit(id)
    return ordered
  }

  const startedAt = Date.now()
  const outcome = await runOutOfOrder<NodeResult>(graph, {
    runReason: async (node) => {
      const config = resolveConfig(node.id)
      // READY guarantees every cone member is done, so results are present.
      const deps = ancestorCone(node.id).map(id => ({
        name: graph.get(id).name,
        result: graph.get(id).result?.text ?? '',
      }))
      return await runReasonNode(ctx, config, deps, route, signal, reasonTools)
    },
    runTool: async (node) => ({ text: await runToolNode(ctx, resolveConfig(node.id), signal) }),
  }, {
    signal,
    ...(options.maxParallelTools === undefined ? {} : { maxParallelTools: options.maxParallelTools }),
    toolMode: node => ctx.tools.executionMode(toolInput(ctx, resolveConfig(node.id), signal)).kind,
  })
  const endedAt = Date.now()

  const results: Record<string, string> = {}
  for (const id of [...configById.keys(), ...spawnedConfigs.keys()]) {
    results[id] = graph.get(id).result?.text ?? ''
  }
  const coreBusyMs = outcome.traces
    .filter(trace => trace.kind === 'reason')
    .reduce((total, trace) => total + (trace.settledAt - trace.startedAt), 0)
  const trace: DagTraceFile = {
    startedAt,
    endedAt,
    makespanMs: endedAt - startedAt,
    coreBusyMs,
    traces: outcome.traces,
    spawned: outcome.spawned,
    results,
  }
  await writeFile(dag.tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  signal.throwIfAborted()
  return trace
}
