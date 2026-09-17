"""OOO Agent Runtime v0.1 核心。

核心命题（来自调研）：
    传统 Agent = 一条同步阻塞的思维链（ReAct loop）；
    本 runtime = 一个事件驱动的任务调度器 —— 慢工具 pending 期间，
    Agent 核心继续消费 READY 任务，结果以事件形式回来后再唤醒依赖节点。

CPU 类比映射：
    instruction        -> Task
    register dependency-> depends_on
    reservation station-> READY queue（TaskGraph.ready_scan）
    cache miss         -> 慢 TOOL 任务
    single core        -> REASON 任务共享的 agent core（一次只跑一个推理）
    reorder buffer     -> commit log（IRREVERSIBLE 任务只在提交点产生副作用）
    dynamic discovery  -> Task.spawn：任务完成后向图中动态注入新任务

v0.1 边界：
    - 支持三种调度模式做对照：SEQUENTIAL / PARALLEL_JOIN / OUT_OF_ORDER
    - 支持运行时动态依赖发现（spawn）
    - 支持 effect_class 元数据与不可逆操作的提交屏障（commit gate）
    - 暂不支持：推测执行、取消、跨进程 durable recovery（见 README roadmap）
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class TaskKind(Enum):
    REASON = "reason"  # 占用 agent core（LLM 推理流，单线程）
    TOOL = "tool"      # 后台 I/O，不占用 agent core


class EffectClass(Enum):
    PURE = "pure"                    # 纯读取/计算，可随时并发
    IDEMPOTENT = "idempotent"        # 可安全重试
    IRREVERSIBLE = "irreversible"    # 有外部副作用，必须过提交屏障


class TaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class SchedulerMode(Enum):
    SEQUENTIAL = "sequential"          # Level 0: ReAct，一次一个任务，工具期间冻结
    PARALLEL_JOIN = "parallel_join"    # Level 1: 同批工具并发 + join 屏障，按 wave 推进
    OUT_OF_ORDER = "out_of_order"      # Level 2/3: 事件驱动，READY 即调度，动态发现


SpawnFn = Callable[[Any], list["Task"]]


@dataclass
class Task:
    """运行时调度的最小单元。

    latency: 虚拟秒（benchmark 用 time_scale 压缩成真实等待）。
    spawn:   任务完成后回调，可向图中注入新任务 = 运行时依赖发现。
    """

    name: str
    kind: TaskKind
    latency: float
    depends_on: list[str] = field(default_factory=list)
    effect: EffectClass = EffectClass.PURE
    spawn: Optional[SpawnFn] = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: TaskStatus = TaskStatus.PENDING
    result: Any = None
    start: Optional[float] = None  # 虚拟秒
    end: Optional[float] = None

    def __post_init__(self) -> None:
        self.depends_on = list(self.depends_on)

    def produce(self) -> str:
        return f"<result of {self.name}>"


class TaskGraph:
    """动态任务图：依赖追踪 + READY 扫描。"""

    def __init__(self) -> None:
        self.tasks: dict[str, Task] = {}
        self.order: list[str] = []  # 插入序 = planner 给出的优先级

    def add(self, *tasks: Task) -> None:
        for t in tasks:
            if t.id in self.tasks:
                raise ValueError(f"duplicate task id: {t.id}")
            self.tasks[t.id] = t
            self.order.append(t.id)

    def ready(self) -> list[Task]:
        """所有依赖已 DONE 的 PENDING 任务（按 planner 优先级排序）。"""
        out = []
        for tid in self.order:
            t = self.tasks[tid]
            if t.status is not TaskStatus.PENDING:
                continue
            if all(self.tasks[d].status is TaskStatus.DONE for d in t.depends_on):
                out.append(t)
        return out

    def is_done(self) -> bool:
        return all(t.status is TaskStatus.DONE for t in self.tasks.values())

    def running_count(self) -> int:
        return sum(1 for t in self.tasks.values() if t.status is TaskStatus.RUNNING)


@dataclass
class CommitRecord:
    task_name: str
    at: float
    note: str


@dataclass
class RunResult:
    mode: SchedulerMode
    makespan: float            # 虚拟秒
    agent_busy: float          # REASON 任务占用的虚拟秒
    agent_blocked_on_tool: float  # 顺序模式下 agent 被工具冻结的虚拟秒
    tasks: list[Task]
    commits: list[CommitRecord]

    @property
    def utilization(self) -> float:
        return self.agent_busy / self.makespan if self.makespan > 0 else 0.0


class Runtime:
    """事件驱动调度器。time_scale 把虚拟秒压缩成真实 sleep 时长。"""

    def __init__(self, time_scale: float = 0.05) -> None:
        self.time_scale = time_scale
        self._t0 = 0.0
        self.commits: list[CommitRecord] = []

    def now(self) -> float:
        return (time.monotonic() - self._t0) / self.time_scale

    async def run(self, graph: TaskGraph, mode: SchedulerMode) -> RunResult:
        self._t0 = time.monotonic()
        self.commits = []
        if mode is SchedulerMode.SEQUENTIAL:
            blocked = await self._run_sequential(graph)
        elif mode is SchedulerMode.PARALLEL_JOIN:
            blocked = await self._run_parallel_join(graph)
        else:
            blocked = await self._run_out_of_order(graph)
        if not graph.is_done():
            unfinished = [t.name for t in graph.tasks.values() if t.status is not TaskStatus.DONE]
            raise RuntimeError(f"graph not finished, stuck tasks: {unfinished}")
        makespan = self.now()
        busy = sum(t.latency for t in graph.tasks.values() if t.kind is TaskKind.REASON)
        return RunResult(
            mode=mode,
            makespan=makespan,
            agent_busy=busy,
            agent_blocked_on_tool=blocked,
            tasks=[graph.tasks[tid] for tid in graph.order],
            commits=self.commits,
        )

    # ---------- 任务执行 ----------

    async def _exec(self, graph: TaskGraph, task: Task, core: Optional[asyncio.Semaphore]) -> None:
        if task.effect is EffectClass.IRREVERSIBLE:
            self._commit_gate(graph, task)
        if task.kind is TaskKind.REASON and core is not None:
            async with core:  # agent core 单线程：推理任务串行
                task.start = self.now()
                await asyncio.sleep(task.latency * self.time_scale)
        else:
            task.start = self.now()
            await asyncio.sleep(task.latency * self.time_scale)
        task.end = self.now()
        task.status = TaskStatus.DONE
        task.result = task.produce()
        if task.spawn is not None:
            graph.add(*task.spawn(task.result))  # 动态依赖发现
        if task.effect is EffectClass.IRREVERSIBLE:
            self.commits.append(
                CommitRecord(task.name, task.end, "副作用在提交点生效（commit barrier）")
            )

    def _commit_gate(self, graph: TaskGraph, task: Task) -> None:
        """提交屏障：不可逆任务的所有依赖必须已 DONE（乱序执行、按序提交）。"""
        not_done = [d for d in task.depends_on if graph.tasks[d].status is not TaskStatus.DONE]
        if not_done:
            raise RuntimeError(f"commit gate rejected {task.name}: deps not done {not_done}")

    # ---------- 三种调度模式 ----------

    async def _run_sequential(self, graph: TaskGraph) -> float:
        """ReAct 式：按 planner 顺序一次一个任务，工具期间 agent 冻结。"""
        blocked = 0.0
        while not graph.is_done():
            ready = graph.ready()
            if not ready:
                raise RuntimeError("deadlock: no ready task in sequential mode")
            task = ready[0]
            task.status = TaskStatus.RUNNING
            if task.kind is TaskKind.TOOL:
                blocked += task.latency
            await self._exec(graph, task, core=None)
        return blocked

    async def _run_parallel_join(self, graph: TaskGraph) -> float:
        """Level 1：同一 wave 的工具并发执行后 join；推理按轮次串行。

        join 屏障意味着：wave 中途完成的任务不会提前解锁下游；
        wave 中动态发现的新任务只能等下一轮（replan round）。
        """
        blocked = 0.0
        while not graph.is_done():
            wave = graph.ready()
            if not wave:
                raise RuntimeError("deadlock: empty wave")
            for t in wave:
                t.status = TaskStatus.RUNNING
            tools = [t for t in wave if t.kind is TaskKind.TOOL]
            reasons = [t for t in wave if t.kind is TaskKind.REASON]
            if tools:
                wave_start = self.now()
                await asyncio.gather(*(self._exec(graph, t, core=None) for t in tools))
                blocked += self.now() - wave_start  # join 期间模型在等
            for t in reasons:
                await self._exec(graph, t, core=None)
        return blocked

    async def _run_out_of_order(self, graph: TaskGraph) -> float:
        """Level 2/3：事件驱动乱序调度。

        - TOOL 任务后台并发（不占 agent core）；
        - REASON 任务共享单个 agent core，先到先得；
        - 每次完成事件触发重新扫描，READY 立即调度；
        - spawn 的新任务在依赖满足的瞬间即可被调度。
        """
        core = asyncio.Semaphore(1)
        done_event = asyncio.Event()
        inflight: set[asyncio.Task] = set()

        async def exec_and_signal(t: Task) -> None:
            try:
                await self._exec(graph, t, core)
            finally:
                done_event.set()

        while not graph.is_done():
            for t in graph.ready():
                t.status = TaskStatus.RUNNING
                inflight.add(asyncio.create_task(exec_and_signal(t)))
            if not inflight:
                raise RuntimeError("deadlock: nothing ready, nothing running")
            done_event.clear()
            # 先非阻塞检查是否有已完成信号，避免丢事件
            await asyncio.sleep(0)
            if not any(f.done() for f in inflight):
                await done_event.wait()
            # 传播所有已完成任务的异常（含已出队的）
            for f in inflight:
                if f.done() and f.exception() is not None:
                    raise f.exception()  # type: ignore[misc]
            inflight = {f for f in inflight if not f.done()}
        return 0.0
