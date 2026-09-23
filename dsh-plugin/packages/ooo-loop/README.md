---
description: "Experimental dependency-ready DAG driver for DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-ooo-loop

English | [中文](README.zh.md)

An experimental replacement for the `agentLoop` provider, forked from DeepSeek Harness `0d1f50007f`. Mount this package **instead of**, not alongside, `dsh-agent-loop`. Without `dag`, the inherited conversational loop runs normally.

## Configured DAG mode

With `dag`, turn 1 executes the configured graph. Its waking input is claimed and logged once; it triggers the configured task, **not** a natural-language planner. A removed waking input does not execute a graph. Followups and steering queued during the graph are consumed by subsequent ordinary turns, not applied to an in-flight DAG branch.

```yaml
- name: '@deepseek-ai/dsh-ooo-loop'
  config:
    maxParallelToolCalls: 4
    dag:
      tracePath: /tmp/ooo-trace.json
      nodes:
        - id: fetch
          name: fetch evidence
          kind: tool
          tool: registered_read_tool
          arguments: {}
        - id: analyze
          name: analyze evidence
          kind: reason
          prompt: Summarize the evidence.
          dependsOn: [fetch]
    agents: []
```

Tool names must be registered in the host. A REASON response may spawn only tools advertised from the graph's declared tool set. Model arguments must parse to a JSON object; invalid JSON, arrays, scalar values, and undeclared tool names fail the node without dispatching the spawned batch.

## Scheduling and failure behavior

- One REASON runs at a time. Other ready REASON nodes remain pending rather than being placed in an already-started promise chain.
- Tools use the host's live `executionMode` classification and a per-DAG snapshot of `maxParallelToolCalls`. Exclusive tools wait for other tools to settle and hold the tool slot through finalization. An awaiting exclusive tool prevents later ready tools from bypassing its barrier. REASON work may overlap tool execution.
- The standalone `runOutOfOrder(graph, executors, options)` accepts `signal`, a positive-integer `maxParallelTools` (default 10), and a synchronous `toolMode` callback. Direct callers must supply a classifier for non-parallel-safe tools. `effect: 'irreversible'` also requires an exclusive tool slot; this is **not** a transactional commit protocol.
- Failure or cancellation stops new dispatches and drains work that actually started before rejection. Pending nodes remain pending. Drain is cooperative and unbounded: a tool that never settles can still prevent shutdown. External writes already performed are not rolled back.
- A structured tool failure fails its node and blocks dependent work. This version does not support error-recovery edges.
- REASON requests must end with `stop` or `tool-calls`. Missing finish, cancellation, truncation (`max-tokens`), provider errors, and unknown finish reasons fail rather than publish a completed analysis.
- Spawned calls are followed by a continuation. Existing pending dependents are rerouted to that continuation. REASON context contains the completed ancestor cone.

## Testing

Copy this package into `packages/experimental/ooo-loop` in a disposable, dependency-installed Harness checkout at the pinned revision; see [integration instructions](../../README.md). From that host root:

```sh
pnpm exec vitest run --config packages/experimental/ooo-loop/vitest.config.ts
node ./node_modules/typescript/bin/tsc -b packages/experimental/ooo-loop
```

The package config includes all `.spec.ts` files, excludes live-provider `.e2e.ts`, and routes the host testkit's loop/invariant imports to this fork. Retained tests import `@deepseek-ai/dsh-ooo-loop`; the package config resolves both self-imports and host testkit imports to this checkout, not the original loop. Do not substitute the host's broad test command for this config when validating the fork.

- `scheduler.spec.ts`: failure/abort, actual execution slots, bounded tools, exclusive admission, spawn, and deadlock.
- `dag.spec.ts`: executor-boundary tests with mocked external services, argument/tool validation, finish handling, error propagation, and continuation ordering.
- `dag-inbox.spec.ts`: real Cordis services, Agent driver/factory, inbox behavior, and registered tool admission; external model responses are deterministic fixtures.
- Other specs retain coverage of the inherited serial loop.

These are source-level tests, not a shipped Loader/CLI end-to-end certification or a production-readiness claim.

## Known limitations and deferred work

The DAG path remains an experiment: model requests bypass the normal prompt/request middleware, and per-node requests, responses, tool events, usage, and dependency changes are not recorded as a resumable session history. Only trigger input and turn boundaries are logged; a successful side-channel trace contains textual results. Tool additional contexts, `concludesTurn`, and non-text outputs are not integrated into DAG reasoning. Do not use tools requiring those features in this mode.

There is no speculative execution, read/write conflict inference, result staging, atomic external commit, durable DAG recovery, node/token budget, or timeout-enforced drain. A dependency-ready assertion is not a CPU reorder buffer. The DAG config does not expose scheduler effect classifications. Duplicate IDs are rejected by the graph; missing dependencies or cycles may only surface at runtime, so validate externally before using effectful graphs. Trace paths should be unique per agent/run and their directories must already exist.

## Model, token, and cache effects

Each REASON is a separate one-shot request containing its prompt and ancestor results, plus the declared tool schemas. More frequent decisions can launch follow-up tools sooner, but add model calls and context cost; prompt-prefix reuse is not guaranteed. Trigger text is not injected into these requests. Measure end-to-end latency, quality, and tokens together rather than treating core utilization as the objective.
