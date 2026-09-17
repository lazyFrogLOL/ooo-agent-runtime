#!/usr/bin/env python3
"""为 OOO 技术报告生成三组 before/after 甘特图。

数据源：
- OOO 侧：真实 trace JSON（dsh-ooo-trace / dsh-ooo-l3-slow-trace / dsh-ooo-l4-trace）
- 默认 loop 侧：extract-timing.py 从会话日志提取的毫秒级时间线（已核实，转录于此）
"""
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(sys.executable).parent.parent.parent))
from daimon_runtime import setup_plot
setup_plot()

import matplotlib.pyplot as plt

ROOT = Path('/Users/chenwenhong/NewDocuments/Agent_Infra/AgentInfra/ooo-runtime')
OUT = ROOT / 'docs' / 'assets'
OUT.mkdir(parents=True, exist_ok=True)

C_TOOL = '#4C9AFF'      # 工具：蓝
C_REASON = '#36B37E'    # 模型思考：绿
C_IDLE = '#FF5630'      # 核心空转：红
C_SPAWN = '#FFAB00'     # 动态发现：黄


def load_trace(name):
    t = json.load(open(ROOT / 'benchmarks' / name))
    t0 = t['startedAt']
    return [(tr['name'], tr['kind'], (tr['startedAt'] - t0) / 1000, (tr['settledAt'] - t0) / 1000)
            for tr in t['traces']]


def draw_gantt(ax, rows, title, makespan, unit='s'):
    """rows: list of (label, start, end, color, hatch) 自上而下绘制。"""
    for i, (label, s, e, color, hatch) in enumerate(rows):
        y = len(rows) - 1 - i
        ax.barh(y, e - s, left=s, height=0.62, color=color, edgecolor='white',
                linewidth=0.6, hatch=hatch, alpha=0.95)
        if (e - s) / makespan >= 0.13:
            # 条够长：标签放条内居中
            ax.text(s + (e - s) / 2, y, label, ha='center', va='center',
                    fontsize=8, color='white' if color != C_SPAWN else '#333',
                    fontweight='bold', clip_on=True)
        else:
            # 短条：标签放条尾右侧，避免裁切
            ax.text(e + makespan * 0.008, y, label, ha='left', va='center',
                    fontsize=8, color='#333')
    ax.set_yticks([])
    ax.set_title(title, fontsize=11, fontweight='bold', loc='left')
    ax.set_xlabel(f'时间（{unit}）', fontsize=9)
    ax.set_xlim(0, makespan * 1.06)
    ax.spines[['top', 'right', 'left']].set_visible(False)
    ax.grid(axis='x', alpha=0.25, linewidth=0.5)
    ax.tick_params(labelsize=8)


# ============ 图 1：L2 mock 对决（500ms/次调用、4 路抓取） ============
# 基线（会话日志实测，ms→s）：think 0.075-0.600；4 fetch 0.600→2.622（join 提交）；
# step2（全部分析+综合一次调用）2.632-5.139。makespan 5.140s
l2_base = [
    ('模型思考 #1', 0.075, 0.600, C_REASON, ''),
    ('fetch 财报', 0.600, 2.622, C_TOOL, ''),
    ('fetch 公告', 0.601, 2.622, C_TOOL, ''),
    ('fetch 新闻', 0.604, 2.622, C_TOOL, ''),
    ('fetch 研报（0.5s 就完成，白等 1.5s）', 0.605, 2.622, C_TOOL, '//'),
    ('模型思考 #2（4 分析 + 综合，折叠为一次调用）', 2.632, 5.139, C_REASON, ''),
]
l2_ooo = [(n, s, e, C_TOOL if k == 'tool' else C_REASON, '')
          for n, k, s, e in load_trace('dsh-ooo-trace.json')]

fig, axes = plt.subplots(2, 1, figsize=(11, 6.2), height_ratios=[6, 9])
draw_gantt(axes[0], l2_base, '默认 loop（Parallel-Join）— makespan 5.14s', 5.4)
draw_gantt(axes[1], l2_ooo, 'OOO loop — makespan 3.05s（快 41%，1.69×）', 5.4)
fig.suptitle('L2 确定性 mock 对决：同一批工作（4 抓取 + 4 分析 + 1 综合，每次模型调用 0.5s）',
             fontsize=12.5, fontweight='bold')
fig.tight_layout(rect=[0, 0, 1, 0.96])
fig.savefig(OUT / 'gantt-l2.png', bbox_inches='tight', dpi=160)
plt.close(fig)

# ============ 图 2：L3 可折叠地形（真实 K2，财报 90s，OOO 输了） ============
# 基线（会话日志实测）：think 0.085-7.489；fetch 7.5→97.5（join）；step2 97.5-129.0
l3_base = [
    ('思考（7.4s）', 0.085, 7.489, C_REASON, ''),
    ('fetch 财报（90s）', 7.489, 97.513, C_TOOL, ''),
    ('fetch 公告/新闻/研报（≤1.5s，白等 90s）', 7.495, 97.515, C_TOOL, '//'),
    ('一次调用完成全部分析+综合（31.5s）', 97.536, 129.016, C_REASON, ''),
]
l3_ooo = [(n, s, e, C_TOOL if k == 'tool' else C_REASON, '')
          for n, k, s, e in load_trace('dsh-ooo-l3-slow-trace.json')]

fig, axes = plt.subplots(2, 1, figsize=(11, 5.6), height_ratios=[4, 9])
draw_gantt(axes[0], l3_base, '默认 loop — makespan 129.0s（2 次模型调用）', 178)
draw_gantt(axes[1], l3_ooo, 'OOO loop — makespan 165.1s（5 次模型调用，每次固定开销 12-43s）', 178)
fig.suptitle('L3 真实模型 · 可折叠地形：OOO 输了 28%——调用开销吃掉了重叠收益',
             fontsize=12.5, fontweight='bold')
fig.tight_layout(rect=[0, 0, 1, 0.96])
fig.savefig(OUT / 'gantt-l3.png', bbox_inches='tight', dpi=160)
plt.close(fig)

# ============ 图 3：L4 发现式地形（真实 K2，OOO 赢了） ============
# 基线（会话日志实测）：think 0.084-13.801；fetch 13.8→103.8（join）；
# step2 分析 103.85→122.389 时发现异常、发起深度舆情抓取 122.389→212.406；
# step3 综合 212.441-242.963。makespan 242.964s
l4_base = [
    ('思考（13.7s）', 0.084, 13.801, C_REASON, ''),
    ('fetch 财报（90s）', 13.801, 103.822, C_TOOL, ''),
    ('fetch 公告/新闻/研报（≤1.5s，白等 90s）', 13.805, 103.823, C_TOOL, '//'),
    ('分析（18.6s 时发现舆情异常）', 103.850, 122.389, C_REASON, ''),
    ('深度舆情核查（90s，被屏障推迟了 100s 才启动）', 122.389, 212.406, C_SPAWN, ''),
    ('综合（30.5s）', 212.441, 242.963, C_REASON, ''),
]
l4_ooo = []
for n, k, s, e in load_trace('dsh-ooo-l4-trace.json'):
    color = C_SPAWN if 'fetch_data' in n else (C_TOOL if k == 'tool' else C_REASON)
    l4_ooo.append((n, s, e, color, ''))

fig, axes = plt.subplots(2, 1, figsize=(11, 6.4), height_ratios=[6, 9])
draw_gantt(axes[0], l4_base, '默认 loop — makespan 243.0s（深度核查 122s 才启动）', 260)
draw_gantt(axes[1], l4_ooo, 'OOO loop — makespan 176.3s（快 27.5%，1.38×；核查 22.5s 就启动）', 260)
fig.suptitle('L4 真实模型 · 发现式慢 follow-up 地形：OOO 赢 27.5%——收益来自"提前决策"',
             fontsize=12.5, fontweight='bold')
fig.tight_layout(rect=[0, 0, 1, 0.96])
fig.savefig(OUT / 'gantt-l4.png', bbox_inches='tight', dpi=160)
plt.close(fig)

print('saved:', *[p.name for p in OUT.glob('gantt-*.png')])
