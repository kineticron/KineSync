# Development arrival capture

No performance baseline has been measured by these scripts. Do not label unit-test timings, fixture delivery, React commits, UI picture publication, or readiness as the first presented correct line/window.

Use a physical Android device with an already installed compatible development binary and this JS bundle. No native build is required by this runner; if the binary is incompatible, stop and record that requirement. Native WebView is excluded.

From ExpoLyrics:

```
node scripts/profile-lyrics-arrival.cjs --plan
node scripts/profile-lyrics-arrival.cjs PHYSICAL_SERIAL /absolute/path/raw-arrival.json
```

The runner force-stops the specified app, rotates the device, and launches the development-only arrival-lab route for 12 independent cold process runs: AMLL/Spicy × portrait/landscape × beginning/mid-song/overlap. It restores rotation settings. It requires a working deep link and development JS connection. A timeout is a failed run, not a zero-duration result. The workload is a deterministic 100-row synthetic native fixture, not real network or provider delivery. No reused process models/pictures are assumed, but OS/font/GPU caches are not controlled or claimed empty. Repeat independently; archive raw traces and device metadata before calculating quantiles. No actual-presentation quantiles can be calculated from these traces.

Record app source SHA, binary/dependency revisions, device/OS, refresh rate, power and thermal state, debugger/profiler state, font availability, cache state and fixture revision. Repeat with tracing disabled to measure instrumentation overhead. The initial runner does not automate that comparison or native video/frame tracing. Obtain synchronized native frame capture/video to identify the first correct active line and full exposed window, using matching media time, geometry, fonts and overlap semantics. A picture publication is only a necessary intermediate event.

For real provider NEW SONG runs, use the development JS console:

```
kineSyncArrivalTrace.start()
// Deliver a genuinely new song through the existing provider path.
await kineSyncArrivalTrace.flushUiCounts() // returns snapshot after UI samples
kineSyncArrivalTrace.stop()
```

No text, lyrics, tokens, URLs, native objects or track identifiers are retained by the trace. Source labels are limited to 64 characters. Records stop at 2048 and report dropped events; a saturated capture is incomplete and cannot establish complete stage/count totals. Handles are weakly attached to arrays; start resets ownership so stale callbacks cannot enter a later capture. Each store publication has its own packet ID and source, with an optional parent packet ID linking instrumented parser receipt. Renderer generations distinguish style/orientation/font changes and concurrent transition instances. Outgoing measurements remain owned by the outgoing packet. Same-source packet revisions do not share store publication IDs.

Coverage: lrc.red TTML response/body RN continuations and parser execution; vault TTML import parsing; store enrichment; native model/cue preparation; voice mounts/unmounts; paragraph/height and range queries; glyph shaping; React Profiler render-to-commit spans and passive effect; readiness; first UI picture record/publication per owner/generation/words/geometry epoch (duration on UI clock, RN receipt on RN clock). UI record duration must not be treated as RN elapsed time or compared across clock origins. Profiler spans include React scheduling and overlap child work. Never sum inclusive spans.

Other provider parsers and transformations that copy arrays without propagating ownership have no parser-arrival correlation. Their trace begins at store input, explicitly named as such. Missing upstream spans must remain unavailable, never inferred from store timestamps. Native network/body-ready timestamps and callback backlog are unavailable. A promise continuation timestamp is RN receipt, not native completion. This first harness does not automate live source-replacement/crossfade capture; exercise it with live console capture and the existing transition regression suite.

Voice counts distinguish payload rows/voices, modeled output/new voice identities and mounted voice effects. Glyph-shaping events count executed shaping spans; reused memo results do not create new shaping events. React development effect replay can produce multiple mount/unmount observations; count live ownership by balancing effects per generation rather than treating cumulative mounts as simultaneous allocation. Translation paragraphs have a separate translation-layout span. Full native resource ownership/cache/worklet counts, allocated bytes and heartbeat/native callback injection remain unavailable.

For RAM diagnosis, capture synchronized Hermes heap snapshots and native process/GPU allocation traces before warmup, after repeated style/source/rotation cycles, and after transition retirement plus GC. Compare retained owners, not only RSS. Do not dispose evicted shaders/filters while pictures may retain them. For timing, capture existing delivery decision and clock diagnostics with experiment on/off at matched source and audio events. Preserve the legacy path and toggle; do not apply a fixed latency compensation from a relative Dealer baseline.

## Optional same-run ci-sim count sidecars (local preparation only)

The inspected ci-sim source is 867cd7c5ae4e637a6db0e9cd626e2e151a613362. Its workflow already runs candidate/baseline variants in one workflow run, builds Release arm64 simulator apps, and pins its trusted baseline to e9abf50510b84db9f9f3a20c6f45ceb11685771f. That pinned SHA currently equals the locally fetched origin/main, but this equality must be rechecked at capture time. Do not call an arbitrary pinned baseline current main. No workflow, baseline resolver, existing scope or gates are changed here.

Existing contract stays intact: ios-simulator-candidate-artifacts and ios-simulator-baseline-artifacts, simulator-test-output/simulator-perf.json, simulator-summary.md, raw logs, screenshot metadata/images, status/commit manifests and screenshot acceptance. In particular, retain all eight stages and screenshot barriers; counter instrumentation must not signal renderer readiness or screenshot acknowledgement. Do not inject these counts into existing summary/heartbeat/stage objects. Release __DEV__=false means these new counters are unavailable in the current passing CI build; do not change the existing Release opt-ins to enable them.

For a separately opted-in **local development** harness experiment, apply the identical instrumentation-only overlay to main and candidate, record its hash, and use the same fixtures, fonts, runtime, renderer, orientation, media sequence, cache policy and observation interval. Keep production source SHAs separate from the measurement-overlay revision. Run both variants in one experiment/workflow invocation; record the shared run ID and actual hardware/host identity. The current CI matrix can use different shared hosts, so same workflow alone does not establish same host. Alternate A/B order on one host when available, keep raw repeats, and record host load. Do not compare separate historical CI runs as an improvement. No build, integration overlay application or remote dispatch was performed by this change.

At the existing harness scenario start (after initialization, before fixture delivery), call `startArrivalCapture()` from lyrics-arrival-trace. After the same existing stage boundary on both variants, before capture reset, export the optional sidecar with `exportArrivalCounters(context)`; the development console equivalent is `kineSyncArrivalCounters(context)`. Context is:

```
{ runId: 'same-experiment-id', variant: 'baseline',
  sourceSha: '<full actual main SHA>', fixtureSha: '<immutable fixture SHA/hash>',
  instrumentationSha: '<identical instrumentation overlay SHA/hash>',
  configuration: 'ios-simulator-dev-spicy-portrait-cold-fonts-revision', scenario: 'new-song-start' }
```

Use variant candidate and its actual SHA for the other side. Save each returned JSON as `arrival-counts.json` **alongside** the legacy artifacts; use distinct files per configuration/scenario/repeat. Capture start/stop and observation intervals must match. Optional sidecars can live under the already uploaded output directory when a separately approved future run wires the hook; do not add artifact requirements or change the upload/acceptance contract. Export is silent and never logs per frame. Existing chunk export remains available for raw trace transport.

Locally compare exports, optionally attaching both unchanged simulator-perf.json files:

```
node scripts/compare-lyrics-arrival-counts.cjs baseline/arrival-counts.json candidate/arrival-counts.json comparison-new.json baseline/simulator-perf.json candidate/simulator-perf.json
```

The tool only reads inputs and creates a new JSON output (refuses overwrite). It rejects mismatched run/fixture/instrumentation/configuration/scenario/build mode/schema, invalid counters and one-sided heartbeat artifacts. Metadata matching is a consistency check, not cryptographic provenance verification: retain the workflow/commit/host manifests. There is no threshold, verdict or performance exit gate. Existing CI never invokes this tool.

Available exact counters within accepted capture ownership: model calls, cue builds, glyph-shaping calls, paragraph builder constructor calls, voice component render invocations, Profiler commits and first picture publications. They continue accumulating after the raw span buffer fills; raw spans remain incomplete when dropped. Counts reset per capture and reject stale owners. Paragraph builders are an allocation-call proxy, not allocated bytes or all Skia allocations. First picture publications count only the first actual record in each measurement epoch. Separately, `uiCounts` samples every dynamic voice picture record plus reusable paint, blur-filter and reveal-shader constructor calls. Empty pictures, glyph-mask pictures, native bytes and other native allocations are outside that scope.

`instrumentedSpansOver50Ms` counts instrumented synchronous spans only; spans may nest/overlap and are not event-loop tasks. Legacy heartbeat blocksOver50Ms/blocksOver100Ms are delayed timer observations, not actual JS long-task counts. Report both definitions honestly; native task tracing is required for actual JS long tasks. Timing fields are exploratory under shared-runner contention (the reported historical host load around 300 was not independently measured here). Prefer same-run operation counts over absolute simulator timing, and retain missing counters as unavailable on uninstrumented/Release baselines. The final authority remains a matching real iPhone Release profile and correct native presentation evidence; no simulator result establishes a physical baseline or a target.


## Independent-review corrections: release isolation and UI sampling

The production NativeGlyphPicture component body is kept identical to c2aaa20 and selected at module/build scope. Development recording is a separate selected component; measurement cells and snapshot worklets cannot enter the production frame closure. Shared drawing helpers select the original cache functions in production. The development measured cache helpers observe exact hits/constructor calls and add bounded lookup overhead; they do not change cache policies or drawing output. Compare instrumentation overhead before interpreting timing.

Production view trees bypass both trace Provider and LyricsArrivalCommit. Measurement hook adapters are selected once per build: production adapters call no React hooks, allocate no shared value, register no frame callback/reader, and schedule no UI/RN work. Production voice props contain no arrival fields. This is tested against c2aaa20 with compiled-release host mocks for hook sequence, tree/props, shared-value/frame-callback ownership and draw calls. It is stronger than testing export silence alone, but does not replace real binary verification.

Each development picture measurement owns a fresh UI-local mutable counter cell keyed by capture/packet owner, observation generation, words identity and geometry. First-record events carry `pictureEpoch`, which joins them to the matching scoped UI sample. Recycled cells retain old measurement cells until their final asynchronous sample completes. Geometry/owner changes do not force drawing or readiness; an idle reused picture correctly yields zero new builds until the renderer actually records again. `firstPicturePublications` means first actual record per measurement epoch, not all picture records or a presented frame.

Every existing dynamic voice picture record increments UI-local totals. Paint/filter/shader constructor calls are observed without changing allocation policy. First-record notification remains once per epoch; there is no new per-frame JS logging or counter delivery. Before exporting sidecars, explicitly `await kineSyncArrivalTrace.flushUiCounts()` while capture remains active. The fixture route does this before chunk export. Retirement also samples the old cell once. Stop/reset only after the desired sample boundary. Samples have independent UI timestamps and RN receipt timestamps; a flush is a set of per-owner observations, not an atomic compositor frame or cross-clock timestamp.

The live-reader registry is capped at 512 owners, sampled-epoch history at 2048, and pending replies at 512 with a one-second timeout. Repeated samples replace an epoch's cumulative totals, so a second flush cannot double count. Capture resets discard stale replies; retirement unregisters the native measurement owner. Drops, timeouts, ownership changes during flush, or unflushed owners make `uiCounts.complete` false. The comparator exposes `uiMetrics` only when both sides have complete, equally scoped UI samples; otherwise UI comparisons remain unavailable. `complete` means the requested scoped sample completed, not that all renderer/native allocations or all lyrics were measured.

Model/cue producer generations are distinct from geometry observation generations. `stage-producer-attribution` records the generation that actually executed each memoized stage; zero means no observed producer in that scope. A viewport/font/font-scale change creates a new geometry observation generation while retaining producer IDs if the model/cue memos do not rerun. Do not infer missing spans as zero work or require every geometry generation to contain parser/model/cue stages. Regression tests exercise actual NativeLyricsView hook behavior for resize, font replacement/font scale and packet replacement, without changing memo dependencies or forcing recomputation.

`node scripts/check-lyrics-arrival-review.cjs` covers these review regressions with mocked native hosts only. The comparison tool and sidecars remain optional; no CI workflow, artifact requirement, Release opt-in, pass scope or performance gate changed. No physical or simulator performance baseline was measured.
