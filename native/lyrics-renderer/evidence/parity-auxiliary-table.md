| Style | Viewport | Fixture line | Scene p50 ms off → on | Encode p95 ms off → on | Steady allocations | Gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| spicy | 390×640 | 1 | 0.0137 → 0.0155 | 23.80 → 25.37 | 0 | PASS |
| spicy | 390×640 | 11 | 0.0156 → 0.0167 | 24.90 → 25.07 | 0 | PASS |
| spicy | 844×390 | 1 | 0.0107 → 0.0123 | 24.71 → 26.70 | 0 | PASS |
| spicy | 844×390 | 11 | 0.0098 → 0.0110 | 22.78 → 23.81 | 0 | PASS |
| amll | 390×640 | 1 | 0.0129 → 0.0140 | 22.16 → 23.76 | 0 | PASS |
| amll | 390×640 | 11 | 0.0072 → 0.0090 | 14.51 → 14.68 | 0 | PASS |
| amll | 844×390 | 1 | 0.0133 → 0.0153 | 25.14 → 25.96 | 0 | PASS |
| amll | 844×390 | 11 | 0.0094 → 0.0108 | 27.29 → 28.15 | 0 | PASS |

Linux Vulkan llvmpipe release-opt3 proxy. Same current binary and actual source packets, only subtitle visibility differs. No native present calls or physical phone FPS measurement. Raw wall/wait/queue-gap intervals remain separate.
