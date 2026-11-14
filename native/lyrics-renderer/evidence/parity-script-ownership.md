# Comparison script ownership — active run14

Comparison implementation belongs to the parent/Gemini task `f4169b6c` in its
separate worktree/branch. This Codex worker has dropped comparison/numeric/CLI
implementation and will not edit those scripts or self-merge Gemini work.
Coordinator integrates reviewed changes only at a safe clean commit checkpoint;
never merge/reset the dirty runtime worktree. No model/vision scoring dependency.

## Exact touched paths

Earlier committed integrity fix `097622a` owns the reviewed foundation:

- `native/lyrics-renderer/evidence/parity-capture.cjs`
- `native/lyrics-renderer/evidence/parity-publish.cjs`
- `native/lyrics-renderer/evidence/parity-verify.cjs`
- `native/lyrics-renderer/evidence/parity-integrity.cjs`
- `native/lyrics-renderer/evidence/parity-integrity.test.cjs`

None of those scripts has been edited in active run14. The existing
`native/lyrics-renderer/evidence/parity-contact-sheets.py` remains unchanged.
No new numeric CLI, metric implementation or comparison fixture was created.

One comparison entrypoint has an existing uncommitted runtime-signature change:
`native/lyrics-renderer/examples/parity-capture.rs`: `let track` became
`let mut track` because new lazy preparation makes `frame` require mutable state.
It otherwise still invokes the legacy `from_lines` constructor and therefore
**does not exercise new ABI4 style/font paths**. Preserve this change; Gemini may
adapt its own copy against the runtime API, then coordinator integrates safely.
Codex will make no further comparison-entrypoint edits before integration.

The following dirty scripts are runtime/ABI integration, not comparison ownership:
`scripts/ios-dev-ci/rust-device.cjs` adds font/diagnostic exports to symbol checks;
`scripts/test/ios-dev-ci.test.cjs` updates ABI4 C/JS/native guards. Device-only
slice/cache restrictions are unchanged. These remain Codex-owned runtime work.

## Safe API handoff

The ABI4 runtime checkpoint in `parity-typography-handoff.md` defines the following API. Visual acceptance remains pending the parent-owned numeric comparison:

- `typography::Fonts::default()` + `register(regular_bytes, bold_bytes)`;
  exact existing asset SHA256/roles are validated; per-owner font set immutable.
- `TrackScene::with_fonts(lines,width_px,height_px,dpr,Some(&settings),&mut fonts)`;
  `settings` carries distinct `style`, `font_scale`, `landscape`. Prepared
  `Line.paint` metadata is required. Do not claim style coverage using legacy
  `from_lines` or duplicate the same Rust baseline under two style names.
- `TrackScene::prepare(time_ms)` and mutable `frame` / `frame_at`; near-active
  timed fragments + cached visible plain rows are being implemented, not final.
- `TrackScene.diagnostics` records actual selected font SHA256, collection index,
  family/subfamily/PostScript, size/attributes/variation coordinates and geometry.
  It is sparse for unprepared rows. Capture after preparation, not construction.
- `ExpoLyrics/lib/rust-lyrics-preparation.ts::prepareRustTrack` reuses actual
  buildNativeVoice + existing grapheme library and Intl/FormatJS segmentation.
  Schema4 packet separates original syllables from prepared paint words/offsets.

Existing schema2 integrity module compares and rehashes every source/font/Rust
candidate/binary/packet across two captures; actual packet-file hash includes
newline. Importer dependency closure is collected recursively via require.cache.
The old committed schema1 capture manifest is historical, rejected by publisher.
Fresh source build + executable attestation is still required by the new command.

Source row geometry is not actual Yoga/native execution. Existing CanvasKit
boundary uses explicit Noto CJK JP fallback; Rust phone fallback equivalence is
unverified. Keep unsupported regions native blur/auxiliary/touch explicit. No
intermediate phone test or IPA dependency; one final delivery when near complete.
