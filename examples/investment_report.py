"""示例场景：上市公司投研报告（调研附件中的经典例子）。

任务 DAG（数字为虚拟秒）：

                 ┌→ 拉取财报(12) ──→ 财务分析(6) ──┐
                 │                    └─spawn→ 拉取现金流明细(10) → 现金流分析(2) ─┐
 用户任务 → 规划 ┼→ 搜索新闻(2) ──→ 新闻分析(3) ──────────────────────────────────┤
                 ┼→ 行业数据(8) ──→ 行业分析(3) ──────────────────────────────────┼→ 综合报告(5) → 发送邮件(1, 不可逆)
                 └→ 竞品数据(4) ──→ 竞品分析(3) ──────────────────────────────────┘

关键点：
- 四个数据获取分支互相独立（并行空间）；
- 「拉取现金流明细」在运行时才被财务分析发现（动态依赖发现）；
- 「发送邮件」是 IRREVERSIBLE 副作用，必须过提交屏障。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ooo_runtime import EffectClass, Task, TaskGraph, TaskKind


def build_graph() -> TaskGraph:
    g = TaskGraph()

    fetch_cashflow = Task("拉取现金流明细", TaskKind.TOOL, latency=10)
    cashflow_analysis = Task(
        "现金流分析", TaskKind.REASON, latency=2, depends_on=[fetch_cashflow.id]
    )

    def discover_cashflow(_result: object) -> list[Task]:
        # 财务分析做到一半发现需要现金流明细 —— 运行时动态依赖发现
        return [fetch_cashflow, cashflow_analysis]

    fetch_fin = Task("拉取财报", TaskKind.TOOL, latency=12)
    fin_analysis = Task(
        "财务分析", TaskKind.REASON, latency=6,
        depends_on=[fetch_fin.id], spawn=discover_cashflow,
    )
    fetch_news = Task("搜索新闻", TaskKind.TOOL, latency=2)
    news_analysis = Task("新闻分析", TaskKind.REASON, latency=3, depends_on=[fetch_news.id])
    fetch_industry = Task("拉取行业数据", TaskKind.TOOL, latency=8)
    industry_analysis = Task("行业分析", TaskKind.REASON, latency=3, depends_on=[fetch_industry.id])
    fetch_peers = Task("拉取竞品数据", TaskKind.TOOL, latency=4)
    peer_analysis = Task("竞品分析", TaskKind.REASON, latency=3, depends_on=[fetch_peers.id])

    synthesis = Task(
        "综合报告", TaskKind.REASON, latency=5,
        depends_on=[
            fin_analysis.id, news_analysis.id, industry_analysis.id,
            peer_analysis.id, cashflow_analysis.id,
        ],
    )
    send_email = Task(
        "发送报告邮件", TaskKind.TOOL, latency=1,
        depends_on=[synthesis.id], effect=EffectClass.IRREVERSIBLE,
    )

    g.add(
        fetch_fin, fin_analysis,
        fetch_news, news_analysis,
        fetch_industry, industry_analysis,
        fetch_peers, peer_analysis,
        synthesis, send_email,
    )
    return g


if __name__ == "__main__":
    graph = build_graph()
    print(f"任务数: {len(graph.tasks)}（另有 2 个运行时动态发现）")
    for tid in graph.order:
        t = graph.tasks[tid]
        print(f"  {t.name:<10} {t.kind.value:<6} {t.latency:>4.0f}s deps={len(t.depends_on)} effect={t.effect.value}")
