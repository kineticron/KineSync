# Native reference capture follow-through — coordinator owned

This first screenshot gate executes production Skia voice preparation/paint on
Linux. It does not need a CI run. Full-screen acceptance **does** need native
Skia: Expo BlurView/UIKit material blur, Yoga row measurement, iOS fallback,
Reanimated row springs, translations/footer and touch behavior cannot execute in
this Linux process. This is a scoped native-reference blocker, not a blocker to
Linux typography work. No native full-screen screenshot is claimed.

## Located reusable resources

Read-only ci-sim snapshot:
`/home/kit/ci-run16-readiness-review-evidence/baseline/ExpoLyrics/lib/simulator-test-harness.ts`:
126-149 freezes at an exact stage position, emits READY_FOR_SCREENSHOT token and
awaits screenshot acknowledgement. `simulator-test-bridge.ts` exposes readiness,
measured orientation and screenshot acknowledgement; compile-time flags limit it
to tests. The existing scenarios at harness lines327-399 exercise renderer switch,
seek and rotation. Do not copy that branch wholesale or change its worktree.
The diagnostic-only workflow described by
`/home/kit/ci-sim-diagnostic-implementation.md` proves boot/SpringBoard only; it
cannot supply a lyric parity screenshot.

## Proposed next implementation after this screenshot review

Coordinator should review one active macOS native capture integration, with a
small test-only adapter rather than any production clock changes. No dispatch,
CI change, app build or Metro operation has been performed in this milestone.
This plan is not an implemented or executed simulator capture.

- Feed original `ZZA0P2622376.ttml` through the actual app TTML import, not a newly
  transcribed song. `parity-capture-manifest.json` pins its SHA256, source line 1
  (Korean) and source line 9 (Latin), exact original syllables, source-model words,
  timestamp 14706.9ms /56925.2ms and history. Use the manifest's actual numbers;
  prose values are explanatory. Both styles must retain distinct settings.
- Extend the existing test scenario protocol to consume a versioned manifest and
  freeze **visual sampling** at the final history entry. Waiting a second while
  advancing spring dt at a frozen lyric position changes the frame; the existing
  screenshot helper's 1000ms settle therefore cannot reproduce this motion sample.
  Advance declared time/dt samples deterministically, then hold both animation
  progression and lyric position until acknowledged. Native screenshot receipt
  must record sampling policy; use a separate settled-reference case where useful.
- The first Linux milestone declares an isolated lane at x28/y0.37H with widthW-56;
  it is deliberately not Yoga measurement. For **full-screen** reference use the
  actual native row/lane/active-next/footer measurements, emit them with the receipt,
  and use the same measured viewport to configure Rust. Do not crop arbitrary
  margins until the images happen to match. Portrait390x640 at DPR 1/3 and
  landscape 844x390 at DPR 1 are the first desired logical extents; simulator support
  for a requested DPR must be verified. Record actual screenshot physical size and
  measured lyric viewport/DPR; reject unmatched cases rather than relabeling.
- Receipt includes source commit + all prepared bundle hashes, fixture hash,
  renderer/style, original tokens and exact model mapping, font asset SHA256s,
  actual font availability/fallback policy, fontScale 1, preview/static=false,
  translation/romanization/BGV toggles, shared-blur setting/profile, line alignment,
  track/generation, clock position/rate/playing and complete seek/dt history.
- Wait for exact style/track/generation ready and measured orientation. Emit a
  unique capture token, `simctl io screenshot`, hash PNG, acknowledge token and
  archive manifest+receipt+PNG+logs. Reject a missing stage, stale token, unresolved
  font, empty frame, changing clock or wrong dimensions. Bound timeouts and upload
  failures; no assertion based only on source strings.
- Subsequent matrix adds BGV/overlap/duets, next-line protection, translation /
  romanization reflow, final attribution with provider/maker/uploader HTTPS touch
  callbacks, finite dots, pause/resume/seek and rotation ownership. Compare both
  transparent captures on the same changing checkerboard and full native scenes.

The current native IPA Rust integration targets device arm64; its CI cache guards
explicitly reject simulator slices. A simulator Rust view requires a separately
reviewed simulator build slice and cache identity. Start with actual Skia native
captures in the existing ci-sim test path, then coordinator-owned device Rust
captures using the same manifest. Do not weaken device ABI/slice guard to force a
simulator binary through the established IPA job. ABI3 is unchanged here.

## Documentation used

`chub search 'canvaskit ParagraphBuilder'` and `chub search 'parley FontContext'`
returned no entries. Exact installed Skia 2.13.1 adapter and CanvasKit 0.41.0 source/
types were inspected; loaded adapter and WASM hashes are recorded in the capture
manifest. Official [Skia CanvasKit documentation](https://skia.org/docs/user/modules/canvaskit/)
identifies CanvasKit as Skia's WebAssembly build and points to its shipped type
definitions. The attempted RN Skia `/docs/text/paragraph/` URL returned 404; no
unfetched API was assumed. No dependency was upgraded.
