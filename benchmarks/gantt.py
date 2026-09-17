"""从 results.json 渲染三模式执行时间线（Gantt）对比图。

运行：python benchmarks/gantt.py
输出：benchmarks/gantt.png
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.executable).parent.parent.parent))
from daimon_runtime import setup_plot  # noqa: E402

setup_plot()

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / "results.json").read_text(encoding="utf-8"))

COLOR = {"tool": "#4C9BE0", "reason": "#F0A03C"}
IRREVERSIBLE = "#D65454"

fig, axes = plt.subplots(3, 1, figsize=(13, 9), sharex=True)

for ax, run in zip(axes, DATA):
    tasks = run["tasks"]
    names = [t["name"] for t in tasks]
    for i, t in enumerate(tasks):
        color = IRREVERSIBLE if t["effect"] == "irreversible" else COLOR[t["kind"]]
        ax.barh(i, t["end"] - t["start"], left=t["start"], height=0.62,
                color=color, edgecolor="white", linewidth=0.6, zorder=3)
        ax.text(t["start"] + 0.25, i, t["name"], va="center", fontsize=8.5, zorder=4)
    ax.set_yticks([])
    ax.invert_yaxis()
    ax.grid(axis="x", alpha=0.25, zorder=0)
    title = (f"{run['label']}    makespan {run['makespan']:.0f}s"
             f"    agent 利用率 {run['utilization']:.0%}")
    if run["mode"] == "sequential":
        title += f"    工具冻结 {run['agent_blocked_on_tool']:.0f}s"
    ax.set_title(title, loc="left", fontsize=11, fontweight="bold")
    ax.set_xlim(0, max(r["makespan"] for r in DATA) * 1.02)

axes[-1].set_xlabel("虚拟时间（秒）")
legend = [
    Patch(facecolor=COLOR["tool"], label="TOOL（后台 I/O）"),
    Patch(facecolor=COLOR["reason"], label="REASON（占用 agent core）"),
    Patch(facecolor=IRREVERSIBLE, label="不可逆副作用（commit barrier）"),
]
fig.legend(handles=legend, loc="lower center", ncol=3, frameon=False, fontsize=10)
fig.suptitle("Out-of-Order Agent Runtime v0.1 — 投研报告场景三模式执行时间线", fontsize=13, fontweight="bold")
fig.tight_layout(rect=[0, 0.05, 1, 0.96])

out = ROOT / "gantt.png"
fig.savefig(out, bbox_inches="tight", dpi=160)
print(f"saved: {out}")
