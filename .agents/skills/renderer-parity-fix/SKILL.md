---
name: renderer-parity-fix
description: Fix Rust lyric renderer parity against the unchanged Skia AMLL and Spicy reference with minimal targeted reading.
---

Read AGENTS.md first. Identify the failing style, song, timestamp, viewport, and state transition from the report. Ask for missing reproduction details only when needed.

Read the relevant Skia feature in ExpoLyrics/components/lyrics/native/ and its native-amll-lyrics-view.tsx or native-spicy-lyrics-view.tsx wrapper. Trace only the helpers that control that feature.

Port constants, units, easing, timing windows, opacity, scale, blur, and state ownership exactly into the corresponding native/lyrics-renderer/src/ files. Do not approximate silently. Leave the Skia reference and WebView code unchanged.

Add a focused Rust regression test for the transition, including its boundary timestamps and prior state. For gestures or packet handoff, also extend the relevant ExpoLyrics/scripts/ check without weakening existing assertions.

Run the checks selected by .agents/skills/verify-changes/SKILL.md. Inspect the diff for unrelated edits and ABI changes. Compare the same fixture, style, timestamp, and viewport against Skia. Report any unverified device behavior plainly.

Commit each independent fix as Kineticron <kineticrondev@gmail.com> without AI trailers. Push only the authorized non-main branch. Native or ABI changes need a rebuilt development IPA and phone validation, not just passing host tests.
