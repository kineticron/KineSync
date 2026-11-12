#!/usr/bin/env python3
"""Export a standalone host benchmark chart; requires matplotlib."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

report = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2])
fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), layout='constrained')
colors = ['#5149a5', '#b1476b']
for i, (result, color) in enumerate(zip(report['results'], colors)):
    name = f"{result['width']} × {result['height']}"
    values = result['summary']
    x = [j + (i - .5) * .34 for j in range(2)]
    left = [values['cpu_scene_ms']['p95'], values['cpu_encode_ms']['p95']]
    right = [values['gpu_interval_ms']['p95'] if values['gpu_interval_ms'] else float('nan'), values['wall_frame_ms']['p95']]
    for ax, heights in zip(axes, [left, right]):
        ax.bar(x, heights, width=.32, label=name, color=color, zorder=3)
        for position, height in zip(x, heights):
            ax.annotate(f'{height:.3f}', (position, height), xytext=(0, 5), textcoords='offset points', ha='center', fontsize=9)
axes[0].set_xticks([0, 1], ['scene', 'encode/submit'])
axes[0].set_yscale('log')
axes[0].set_ylim(.01, 350)
axes[0].set_ylabel('p95 milliseconds (log scale)')
axes[0].set_title('CPU scene and encode/submission')
axes[1].set_xticks([0, 1], ['GPU interval', 'wall frame'])
axes[1].set_ylim(0, 180)
axes[1].set_ylabel('p95 milliseconds')
axes[1].set_title('Timestamp bracket and synchronous wall time')
for ax in axes:
    ax.grid(True, axis='y', alpha=.2, zorder=0)
    ax.legend(loc='upper left')
fig.suptitle('Rust lyrics spike — llvmpipe Linux host proxy', fontsize=15, fontweight='bold')
count = len(report['results'][0]['samples'])
warmup = report['results'][0]['warmup']
fig.text(.5, -.02, f'{count} measured frames/orientation · {warmup} warmup · GPU interval includes queue gaps · no phone-performance claim', ha='center', fontsize=9)
fig.savefig(output, dpi=160, bbox_inches='tight')
print(output)
