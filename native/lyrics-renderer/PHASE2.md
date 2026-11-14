# Phase 2 integration progress

Starting point: 37026fe on rust-renderer-spike. No push, dispatch or Metro changes
are authorized for this implementation turn. Coordinator reviews before one CI
build. Linux checks cannot establish iOS linking, launch or phone performance.

- Inspected instructions, pinned wgpu 30 surface API, Expo native-view docs and
  installed ExpoModulesCore source. iOS uses CoreAnimationLayer surface creation.
- Plan: share scene/GPU modules between headless binary and staticlib, validate
  live timed tracks and native anchors, contain panics across the C ABI, serial
  native owner with retained layer, selectable player renderer, and CI link proof.
- Shared library now contains live protocol, scene/GPU modules and a registry-based
  panic-contained C ABI. Linux and aarch64-apple-ios cargo check succeeded for
  the initial implementation. This is a cross-target type check, not an iOS link.
- Expo owner, live-track protocol adapter and player selection are being wired.
  Background/detach drain the serial GPU owner before releasing the layer.
- Independent preliminary review identified two scheduling defects. Fixed both:
  reactivation flushes latest track/anchor/size, and a distinct retryable no-frame
  ABI result schedules at most four 100/200/400/800 ms delayed retries. Input,
  foreground, activation or resize rearms. Inactivity/detach cancel pending work.
  A source-level harness tests inactive replacement/first attachment and checks
  the asynchronous retry contract. It is not an iOS runtime test.
- Player toggle uses the real store, no fixture transport. Metrics events are
  throttled natively, with JS anchor work/render counts and clock comparison.
  React metric rerenders are opt-in. Native failures remain visible and can be
  explicitly recreated without silently substituting a production renderer.
