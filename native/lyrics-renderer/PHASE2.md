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
