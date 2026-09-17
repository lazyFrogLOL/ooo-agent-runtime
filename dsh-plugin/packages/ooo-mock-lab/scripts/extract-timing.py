#!/usr/bin/env python3
"""从 dsh 会话日志提取精确执行时间线（benchmark 计时工具）。

用法：
  python3 scripts/extract-timing.py [session-log-path]

不传参数时自动取 ~/.dsh 下最新的会话日志。输出 turn/step/tool 的相对
毫秒时间线，用于对比默认 loop 与 OOO loop 的 makespan 和 join 开销。

事件格式（v3 日志）：顶层字段为 type/seq/time；tool/result 通过
sourceEventSeqs 关联 tool/call 的 seq。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DSH_HOME = Path.home() / ".dsh" / "sessions"

TRACKED = ("turn/start", "turn/end", "step/start", "step/end", "tool/call", "tool/result")


def latest_session() -> Path:
    logs = sorted(DSH_HOME.rglob("session.v*.jsonl*"), key=lambda p: p.stat().st_mtime)
    if not logs:
        sys.exit("no session logs found under ~/.dsh")
    return logs[-1]


def load_events(path: Path) -> list[dict]:
    if path.suffix == ".zstd":
        data = subprocess.run(["zstd", "-dc", str(path)], capture_output=True, check=True).stdout
    else:
        data = path.read_bytes()
    return [json.loads(line) for line in data.decode().splitlines() if line.strip()]


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else latest_session()
    events = [e for e in load_events(path) if e.get("type") in TRACKED and "time" in e]
    print(f"log: {path}")
    if not events:
        sys.exit("no turn/step/tool events in log")

    t0 = events[0]["time"]
    call_time_by_seq: dict[int, int] = {}
    step_start: int | None = None

    for e in events:
        t = e["time"] - t0
        kind = e["type"]
        if kind == "step/start":
            step_start = e["time"]
            print(f"{t:>6}ms  step/start")
        elif kind == "step/end":
            dur = f" (step 耗时 {e['time'] - step_start}ms)" if step_start is not None else ""
            print(f"{t:>6}ms  step/end{dur}")
        elif kind == "tool/call":
            call_time_by_seq[e["seq"]] = e["time"]
            print(f"{t:>6}ms  tool/call   {e.get('data', {}).get('name', '?')}")
        elif kind == "tool/result":
            starts = [call_time_by_seq[s] for s in e.get("sourceEventSeqs", []) if s in call_time_by_seq]
            dur = f" (工具耗时 {e['time'] - starts[0]}ms)" if starts else ""
            print(f"{t:>6}ms  tool/result{dur}")
        else:
            print(f"{t:>6}ms  {kind}")

    print(f"\nmakespan (turn/start → turn/end): {events[-1]['time'] - t0}ms")


if __name__ == "__main__":
    main()
