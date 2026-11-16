# Diagnostics on explicit request

Implementation item 1, based on `d6c1b2a`. Items 2 through 4 remain separate work.

Normal row preparation no longer builds face, voice, row, or subtitle JSON. `TrackScene::layout_json` materializes the existing receipt format only when requested. The C ABI entry used by Swift `copyLayout` requests that snapshot and retains its size-query, complete-copy, and NUL-termination behavior. ABI remains 8.

The first request reconstructs missing receipts for resident rows through the existing row builder with a private cloned font context. This intentionally spends debug-request time rather than retaining additional render metadata or modifying live geometry. Unprepared and evicted rows stay null. Requests can still be expensive and run on the existing worker. They do not shape every source row or enable collection on later frames.

Serialized bytes are cached until preparation or eviction changes row residency. Swift's size query and subsequent copy reuse those bytes without a second serialization. Layout-cache ownership carries the snapshot with the associated layout. New layout variants start without a snapshot.

Regression coverage:

- Twelve receipt hashes captured from the implementation at `d6c1b2a` match exactly. Cases cover both styles, lead and background voices, subtitles, initial state, promotion, distant playback seek, manual viewport preparation, eviction, and return.
- Before the first request, prepared row and subtitle receipts remain null. Repeated requests allocate nothing and reuse the byte snapshot.
- C copy tests cover null size queries, short buffers with no partial writes, complete copies, NUL termination, bounds, JSON contents, and allocation-free cached copying. The legacy fixture layout path remains covered.
- Explicit Vulkan testing checks byte-identical pixels before and after a request for both styles in portrait and landscape, with lead, background, and subtitle rendering. Both sides use fresh renderer caches to match cache history. The test also checks geometry identity, layout counts, prefixes, protection bounds, and recorded scene streams.

Validation passed:

- `cargo +1.97.0 fmt --manifest-path native/lyrics-renderer/Cargo.toml --check`
- `cargo +1.97.0 clippy --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings`
- `cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml`, 71 passed and 14 ignored by default
- Explicit `diagnostics_request_preserves_pixels_and_render_geometry` Vulkan test on llvmpipe
- Expo `npm run typecheck` and `npm test`

No Swift code, shader, reference renderer, or timing behavior changed. Device Metal validation remains unperformed. No push was attempted.
