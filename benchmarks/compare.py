"""三模式对照 benchmark：SEQUENTIAL vs PARALLEL_JOIN vs OUT_OF_ORDER。

运行：python benchmarks/compare.py
输出：终端表格 + benchmarks/results.json（供 gantt.py 画图）
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples.investment_report import build_graph
from ooo_runtime import RunResult, Runtime, SchedulerMode, TaskKind

MODES = [
    SchedulerMode.SEQUENTIAL,
    SchedulerMode.PARALLEL_JOIN,
    SchedulerMode.OUT_OF_ORDER,
]

MODE_LABEL = {
    SchedulerMode.SEQUENTIAL: "Sequential (ReAct)",
    SchedulerMode.PARALLEL_JOIN: "Parallel-Join (Lv1)",
    SchedulerMode.OUT_OF_ORDER: "Out-of-Order (Lv3)",
}


async def run_all(time_scale: float = 0.05) -> list[RunResult]:
    results = []
    for mode in MODES:
        rt = Runtime(time_scale=time_scale)
        results.append(await rt.run(build_graph(), mode))
    return results


def print_table(results: list[RunResult]) -> None:
    base = results[0].makespan
    header = f"{'模式':<22} {'makespan':>10} {'加速比':>8} {'agent繁忙':>10} {'工具冻结':>10} {'利用率':>8}"
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{MODE_LABEL[r.mode]:<22} "
            f"{r.makespan:>8.1f}s "
            f"{base / r.makespan:>7.2f}x "
            f"{r.agent_busy:>8.1f}s "
            f"{r.agent_blocked_on_tool:>8.1f}s "
            f"{r.utilization:>7.0%}"
        )
    ooo = results[-1]
    print()
    print(f"提交记录（commit barrier）: {[(c.task_name, round(c.at, 1)) for c in ooo.commits]}")
    spawned = [t.name for t in ooo.tasks if t.name in ("拉取现金流明细", "现金流分析")]
    print(f"运行时动态发现的任务: {spawned}")


def dump_json(results: list[RunResult], path: Path) -> None:
    data = []
    for r in results:
        data.append({
            "mode": r.mode.value,
            "label": MODE_LABEL[r.mode],
            "makespan": round(r.makespan, 2),
            "agent_busy": r.agent_busy,
            "agent_blocked_on_tool": round(r.agent_blocked_on_tool, 2),
            "utilization": round(r.utilization, 4),
            "commits": [{"task": c.task_name, "at": round(c.at, 2)} for c in r.commits],
            "tasks": [
                {
                    "name": t.name,
                    "kind": t.kind.value,
                    "effect": t.effect.value,
                    "start": round(t.start or 0, 2),
                    "end": round(t.end or 0, 2),
                }
                for t in r.tasks
            ],
        })
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    rs = asyncio.run(run_all())
    print_table(rs)
    out = Path(__file__).resolve().parent / "results.json"
    dump_json(rs, out)
    print(f"\n轨迹已保存: {out}")
