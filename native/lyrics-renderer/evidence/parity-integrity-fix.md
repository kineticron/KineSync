# Capture integrity review corrections

Addresses all three findings in `/home/kit/rust-parity-milestone-review.md`.
Schema2 capture walks the actual importer module's complete require.cache child
closure after parsing, including DesktopBridge segmentation and translation
helpers. Publication independently compares then rehashes source, Skia font,
Rust system-font candidate and executable binary inventories, and both runs'
actual packet files. Packet SHA256 now covers the on-disk newline too.

`node --test native/lyrics-renderer/evidence/parity-integrity.test.cjs` passes18
regression cases: real parser closure; newline bytes; missing/changed/independently
mismatched dependency/font/Rust-font/binary/packet; omitted inventories/schema.
Two actual captures in `/tmp/rust-parity-integrity/{captures,repeat}` passed the
new independent-input gate and reproduced identical PNG hashes. Summary in
`parity-integrity-verification.json`. Production runtime is unchanged here.

Schema1 manifests from the prior accepted milestone remain historical evidence;
the publisher deliberately rejects them as reusable acceptance receipts. The old
`parity-files.sha256` describes the previous milestone, not these updated scripts.
Actual per-glyph Rust font-face observation is a typography implementation item;
the current system candidate list is still labeled as such, never same-font proof.
