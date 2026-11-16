| Style / viewport | Stage | Scene p50 ms before → after | Encode p95 ms before → after | Allocations | Gate |
| --- | --- | ---: | ---: | ---: | --- |
| spicy 390×640 | Baseline → Fill | 0.0058 → 0.0126 | 23.87 → 23.20 | 0 | True |
| spicy 390×640 | Fill → Motion | 0.0087 → 0.0101 | 23.22 → 23.19 | 0 | True |
| spicy 390×640 | Motion → Glow | 0.0099 → 0.0102 | 23.39 → 22.84 | 0 | True |
| amll 390×640 | Baseline → Fill | 0.0066 → 0.0146 | 23.52 → 22.98 | 0 | True |
| amll 390×640 | Fill → Motion | 0.0121 → 0.0116 | 24.80 → 22.06 | 0 | True |
| amll 390×640 | Motion → Glow | 0.0104 → 0.0108 | 21.30 → 21.80 | 0 | True |
| spicy 844×390 | Baseline → Fill | 0.0045 → 0.0097 | 23.93 → 22.18 | 0 | True |
| spicy 844×390 | Fill → Motion | 0.0075 → 0.0089 | 14.97 → 16.63 | 0 | True |
| spicy 844×390 | Motion → Glow | 0.0089 → 0.0091 | 14.43 → 16.03 | 0 | True |
| amll 844×390 | Baseline → Fill | 0.0065 → 0.0151 | 25.25 → 23.74 | 0 | True |
| amll 844×390 | Fill → Motion | 0.0110 → 0.0108 | 22.96 → 22.21 | 0 | True |
| amll 844×390 | Motion → Glow | 0.0106 → 0.0110 | 14.68 → 15.44 | 0 | True |

Linux llvmpipe release opt3 proxy. Raw wall/readback/queue-gap timestamp samples are in the budget JSON. Native present-call throughput is unavailable/null; no phone FPS inference.
