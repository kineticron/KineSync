# Run13 interruption — linker crash, do not build current dirty state

Completed atomic commit: `097622a fix(renderer): fail closed on complete parity capture inputs`.
All18 integrity regression tests pass; two real CanvasKit/Rust capture runs passed
independent input/PNG digest checks. See parity-integrity-verification.json.

Implementation stopped at the user's standing stop-on-crash condition. During:

```
cargo +1.97.0 test --locked --manifest-path native/lyrics-renderer/Cargo.toml
```

`cc`/`ld` crashed with signal7 / Bus error while linking the main test binary and
parity capture example. `df` immediately before failure showed108MB available on
49GB root filesystem. Disk exhaustion is a plausible cause, not a proven crash
root cause. No compiler/test success is claimed for these edits. Earlier
`cargo check --offline` passed the new typography/scene code before the later
FFI/native additions. No source rollback, generated-output cleanup, push, app
build, CI operation, Metro action or other-worktree edit performed.

## Uncommitted work (incomplete; review before resuming)

- `typography.rs`: explicit immutable font registration; actual selected-font
  SHA256/index/names diagnostics; UTF16-to-UTF8 validation; style geometry;
  source-derived Spicy joined wrapping and AMLL balance costs/whitespace remap.
- `scene.rs`: optional prepared style layout with cached geometry; bundled SF
  family; real cluster measurement; source-derived lane/padding/alignment;
  selected-face diagnostics; cached prefix offsets remove per-frame positions Vec.
  Legacy headless constructors remain. Appearance timing is still baseline.
- ABI4 groundwork: packet schema4 + optional style/prepared metadata; FFI fonts
  setup and layout diagnostics; JS/native/C guards; Swift worker-only cached font
  bundle loading; pod resource bundle references existing assets in place;
  device symbol list adds new exports without changing device-only slice checks.
- JS static preparation reuses existing buildNativeVoice/grapheme/CJK helpers,
  preserving original packet atoms separately from paint-word text.
- Pinned cached SHA2 0.10.9 and skrifa 0.44.0 dependencies; Cargo.lock changed.

These edits are NOT a passing coherent milestone and were intentionally not
committed. No typography PNG or same-font result has been generated. Native
simulator deterministic capture implementation is still pending; only the prior
plan exists. Full native parity is not established.

## Resume priorities

1. Resolve workspace build storage without touching other worktrees or running
   services; inspect crash cause, then compile/check current code. Generated
   workspace Cargo outputs are the obvious scoped cleanup candidate.
2. Finish meaningful tests for Unicode source/prepared mapping, source-equivalent
   wrap/balance policies, style/settings/resize invalidation and actual selected
   fonts. Validate both fonts' regular/bold identity, not only family names.
3. Update capture example/harness to use registered fonts/prepared packets and
   attest actual selected faces/binary; maintain schema2 integrity gate. Existing
   verifier's runtime-unchanged/lock checks must become scoped baseline invariants,
   rather than accepting their now expected failures blindly.
4. Check iOS font bundle resolution/Swift imports, ABI4 C/JS guards and CI symbol
   fixture expectations. TypeScript/Node command was started concurrently; do not
   assume pass without reading its session/result or rerunning after fixes.
5. Generate and inspect both-style actual typography comparisons. Then complete
   deterministic native test capture adapter/workflow proposal using real ci-sim
   readiness/ack resources, freezing visual animation samples as well as playhead.
   Do not dispatch/push/build app/operate Metro; coordinator owns those operations.
6. Full fmt/tests/strict host+iOS Clippy/Node/TS/lint/actionlint/GPU regression and
   host proxy before/after benchmarks before a runtime commit. Keep the validated
   GPU shaders/two-frame scheduler/clock and player clipping unchanged.

Potential review points already visible: prepared grapheme validation permits
full/trimmed source words (production styles differ); prepared source timings can
extend zero-duration source atoms by1ms and may need explicitly bounded handling;
AMLL break-node grouping and whitespace remapping need cross-checks against actual
production helper output; same font bytes do not establish identical rasterizer
or native fallback behavior. No ordinary implementation approval is needed.
