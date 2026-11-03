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
kineSyncArrivalTrace.snapshot()
kineSyncArrivalTrace.stop()
```

No text, lyrics, tokens, URLs, native objects or track identifiers are retained by the trace. Source labels are limited to 64 characters. Records stop at 2048 and report dropped events; a saturated capture is incomplete and cannot establish complete stage/count totals. Handles are weakly attached to arrays; start resets ownership so stale callbacks cannot enter a later capture. Each store publication has its own packet ID and source, with an optional parent packet ID linking instrumented parser receipt. Renderer generations distinguish style/orientation/font changes and concurrent transition instances. Outgoing measurements remain owned by the outgoing packet. Same-source packet revisions do not share store publication IDs.

Coverage: lrc.red TTML response/body RN continuations and parser execution; vault TTML import parsing; store enrichment; native model/cue preparation; voice mounts/unmounts; paragraph/height and range queries; glyph shaping; React Profiler render-to-commit spans and passive effect; readiness; first UI picture record/publication per picture instance (duration on UI clock, RN receipt on RN clock). UI record duration must not be treated as RN elapsed time or compared across clock origins. Profiler spans include React scheduling and overlap child work. Never sum inclusive spans.

Other provider parsers and transformations that copy arrays without propagating ownership have no parser-arrival correlation. Their trace begins at store input, explicitly named as such. Missing upstream spans must remain unavailable, never inferred from store timestamps. Native network/body-ready timestamps and callback backlog are unavailable. A promise continuation timestamp is RN receipt, not native completion. This first harness does not automate live source-replacement/crossfade capture; exercise it with live console capture and the existing transition regression suite.

Voice counts distinguish payload rows/voices, modeled output/new voice identities and mounted voice effects. Glyph-shaping events count executed shaping spans; reused memo results do not create new shaping events. React development effect replay can produce multiple mount/unmount observations; count live ownership by balancing effects per generation rather than treating cumulative mounts as simultaneous allocation. Translation paragraphs have a separate translation-layout span. Full native resource ownership/cache/worklet counts and heartbeat/native callback injection remain future measurement extensions.

For RAM diagnosis, capture synchronized Hermes heap snapshots and native process/GPU allocation traces before warmup, after repeated style/source/rotation cycles, and after transition retirement plus GC. Compare retained owners, not only RSS. Do not dispose evicted shaders/filters while pictures may retain them. For timing, capture existing delivery decision and clock diagnostics with experiment on/off at matched source and audio events. Preserve the legacy path and toggle; do not apply a fixed latency compensation from a relative Dealer baseline.
