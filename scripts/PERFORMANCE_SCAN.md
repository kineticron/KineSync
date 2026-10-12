# Local performance scan

Run `powershell -ExecutionPolicy Bypass -File scripts/scan-performance.ps1` from the repository root. The script downloads the pinned Oxlint 1.87.0 package if needed and runs locally. It does not upload the repository. Full findings are saved to `.cache/optimization-scan.json`. Exit code 1 means advisory performance candidates were found, not that each candidate is a confirmed defect.

Oxlint's performance category and React performance plugin scan supported JavaScript, TypeScript and TSX in the mobile and desktop source directories. Generated WebView bundles and vendor files are excluded. Their editable entry points are scanned. Embedded HTML scripts and native code are outside this tool's coverage.

## Results from October 9, 2026

The initial scan covered 138 files and reported 485 candidates. The follow-up scan reports 428, with 57 warnings removed by the fixes below. These counts are static findings, not measurements of frame time or battery consumption.

- Hoisted 45 static JSX arrays/objects, preserving their values and avoiding repeat allocations and native prop identity changes.
- Stabilized live/demo lyric WebView HTML sources, native Spotify WebView sources, artwork image sources, and lyric load callbacks.
- Replaced two `filter(...)[0]` searches with early-exit `find` calls.
- Removed redundant vault entry copies only where a fresh JSON parse establishes exclusive ownership.
- Ran independent iTunes album search terms concurrently, merging responses in original order and canceling pending work on failure.
- Limited source-health checks to three concurrent providers, preserving sequential requests within a provider and original report order.

## Remaining advisory findings

| Rule | Count | Review outcome |
| --- | ---: | --- |
| `no-await-in-loop` | 104 | These include endpoint/candidate fallbacks, retries/backoff, token acquisition, dependent pagination, serialized vault/Live Activity updates, and bounded concurrency worker loops. Parallelizing these indiscriminately would change behavior, increase request count or violate ordering. The independently parallelizable artwork and health-check work was changed. |
| `no-map-spread` | 7 | Remaining copies include lyric candidate annotations, match scoring and conditional demo construction. Preserve source ownership and immutable data contracts. Replacing every spread with mutation is not a safe automatic optimization. |
| `jsx-no-jsx-as-prop` | 3 | Rendered elements used as mask/loading content are intentional component APIs. |
| `jsx-no-new-array-as-prop` | 109 | Remaining arrays depend on component state, dimensions or animated styles. They are candidates for runtime profiling. A new array alone does not prove avoidable rendering. |
| `jsx-no-new-function-as-prop` | 176 | Primarily event/style/render callbacks capturing current state or list items. Unconditional hook insertion into loops/conditional branches is invalid, and stale closures can break controls. Profile before adding caching beyond the WebView callbacks fixed here. |
| `jsx-no-new-object-as-prop` | 28 | Remaining objects contain dynamic state/layout values. Treat these as profiling candidates rather than confirmed defects. |
| `no-array-index-key` | 1 | Words in the fixed onboarding welcome sentence retain their order. The index represents a fixed position. There is no insertion/removal/reordering in this list. |

No rules were disabled to hide the remaining candidates. The scan remains available for future reviews. A clean static scan cannot certify that all runtime performance or battery problems are fixed.

## Verification

TypeScript and targeted ESLint checks, mobile lyric/vault/tour/launch/security/artwork/detector regressions, and 52 desktop tests. Added checks cover WebView prop identity across option updates, concurrent artwork ranking/cancellation, and bounded source-health concurrency/order. No physical-device energy measurements or screenshot comparisons were performed.

Tool documentation: [Oxlint CLI and performance plugins](https://oxc.rs/docs/guide/usage/linter/cli).
