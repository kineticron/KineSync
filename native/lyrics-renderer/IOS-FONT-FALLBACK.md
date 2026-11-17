# iOS Han fallback correction

## Evidence and scope

Reported on physical iPhone with IPA 046ae3f, AiNA THE END 革命道中.
System UI draws the title correctly. Rust lyrics draw kana but replace Han
characters, including 革命道中, 君, 夢中 and 愛, with tofu.

The checked-in dependency versions are Parley 0.12.0, Fontique 0.12.0 and
Skrifa 0.44.0. Inspection of their installed source establishes this chain:

1. `parley/src/font.rs` implements `FontContext::new()` using its default
   Fontique collection. System font discovery is enabled. This was already
   active on iOS, so missing system registration alone is not the diagnosis.
2. `fontique/src/backend/coretext.rs` enumerates CoreText descriptors and
   obtains `kCTFontURLAttribute`. It scans those files and Library/Fonts.
   `fontique/src/scan.rs` enumerates TTC faces with their collection indexes.
3. `scan_font` rejects every face containing `hvgl`. Skrifa's outline loader
   supports glyf, CFF, CFF2 and VARC, not hvgl. Keeping those faces would not
   give Vello usable outlines.
4. CoreText Han fallback can select PingFangUI. When its family was excluded
   by the hvgl gate, Fontique tries only Heiti SC or Heiti TC. Neither is
   guaranteed installed on iOS. No additional Hiragino fallback is attempted.
5. Kana has a separate script fallback. A usable Hiragino font can therefore
   draw kana while Han resolves to glyph zero. `scene::shape` supplies no
   locale and normally requests SF Pro Display plus sans-serif.

This explains a concrete failure in the dependency code and matches the
report. The affected phone's actual font descriptors, OS version and installed
font assets were not captured in this worktree. This is not a device trace.

Primary sources:

- [Fontique 0.12 CoreText backend](https://github.com/linebender/parley/blob/v0.12.0/fontique/src/backend/coretext.rs)
- [Fontique 0.12 scan rejection](https://github.com/linebender/parley/blob/v0.12.0/fontique/src/scan.rs)
- [Upstream macOS workaround](https://github.com/linebender/parley/pull/598)
- [Upstream iOS reproduction](https://github.com/linebender/parley/issues/929)
- [Apple engineer explanation](https://developer.apple.com/forums/thread/758189)
- [Apple font inventory](https://developer.apple.com/fonts/system-fonts/)
- [Apple font management overview](https://developer.apple.com/documentation/technologyoverviews/managing-the-fonts-for-your-app)

## Change and limits

`ios_fonts::configure` extends the existing default Han and Hangul fallback
lists with candidate family IDs already discovered by Fontique through
CoreText. Existing platform selections remain first. IDs are deduplicated.
The Han additions are Hiragino Sans, Hiragino Kaku Gothic ProN, installed
PingFang/Heiti variants and Apple SD Gothic Neo. Hangul adds Apple SD Gothic
Neo. Missing families are skipped. An empty candidate result leaves the
existing fallback unchanged. Fontique already excludes hvgl-only faces.

Fontique's query implementation tries subsequent families when a cluster is
not covered and adds the default Han list to script/locale queries, including
common punctuation. The regression includes an existing first fallback that
lacks Han coverage to verify that subsequent candidates are reached.

There are no new paths, font downloads, bundled production fonts, unsafe code,
global caches, ABI changes or Android changes. Initialization performs at most
two platform fallback queries, nine candidate-name lookups and small list
allocations per new renderer font context. It adds no font-file reads or
outline walks. Ordinary shaping lazily loads the selected faces through
Fontique's existing source cache and preserves TTC indexes. Cloned contexts
retain the configured lists. Mutation remains within each owned FontContext,
with the existing Fontique synchronization for shared system discovery.
Phone startup time and memory have not been measured.

This fixes the absent supplementary Han fallback when a usable Hiragino font
is present. It does not implement hvgl rendering. Hiragino has Japanese
coverage, not complete Chinese coverage, and can give Chinese text Japanese
glyph forms. Apple lists some Chinese fonts as downloadable. If no compatible
installed face covers a character, tofu remains possible. No universal offline
Chinese coverage is claimed. Achieving that requires a native CoreText outline
rendering path, explicit font download handling, or a bundled CJK fallback.
The iOS test deliberately fails on uncovered Chinese samples rather than
skipping them. Actual Japanese and Korean availability and outlines also need
device validation, even though Apple lists relevant system fonts.

## Regression and fixture

`src/ios_fonts.rs` has host tests for the actual production fallback
configuration, an initially missing Han fallback, preservation of a first
family without Han coverage, duplicate suppression and missing candidates.
The test aliases the licensed Noto fixture to production candidate family
names through Fontique metadata overrides. These aliases are explicitly not
evidence of Apple font availability.

The CJK regression shapes `革命道中君夢中愛`, `汉语爱漢語愛` and `한국어` at
weights 400 and 700. Every shaped glyph must be nonzero and must successfully
draw a nonempty outline through Skrifa using the run's normalized coordinates.
Bold must use TTC face 1, regular face 0. A synthetic unsupported-outline test
keeps the real CJK cmap but hides CFF, proving that nonzero IDs alone fail the
outline check. A synthetic hvgl-tagged variant verifies Fontique's scan gate.

`ios_system_fallback_shapes_drawable_cjk` is compiled only for iOS and calls
the production `Fonts::default()` plus bundled SF Pro registration. It uses
real CoreText discovery, no fixture aliases, and checks every sample and
weight with the same glyph and outline assertions. It has not been compiled
or run here. It is not sufficient to run the host fixture test on macOS.

The test-only `tests/fonts/cjk-subset.ttc` is 17,132 bytes and has SHA-256
`a4180b498052c9f16160379ce954025266eb9e806b6e8431d6274bab1285c869`.
It contains two renamed, subsetted Noto Sans CJK JP 2.004 faces, regular and
bold, with real CFF outlines. Sources are from
[Noto CJK](https://github.com/notofonts/noto-cjk), licensed under
[SIL OFL 1.1](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE).
Copyright notices and the license are in `tests/fonts/OFL.txt` and the font's
name metadata. The fixture is included only under `cfg(test)`.

Rebuild with fontTools 4.68.0 and the original Noto CJK 2.004 collections:

```sh
python3 native/lyrics-renderer/tests/fonts/build-subset.py /path/to/NotoSansCJK-Regular.ttc /path/to/NotoSansCJK-Bold.ttc
```

Original source SHA-256 values:

- Regular: `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`
- Bold: `faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb`

## Rescue validation and review handoff

Original investigation base was cc2d747 in the dedicated ios-kanji-fallback worktree. Candidate
63d4163 was absent from its object store. No other worktree was fetched or
modified. No push, IPA build, simulator work, Metro or service change occurred.

Available compiler is Rust 1.99.1, with only x86_64-unknown-linux-gnu installed.
Neither xcrun nor clang was found. iOS-specific production wiring and the
target-only regression were not compiled here.

Results:

- `cargo fmt --manifest-path native/lyrics-renderer/Cargo.toml --check`: passed
  with installed Rust 1.99.1 after formatting.
- `git diff --check`: passed.
- `node scripts/check-repository.cjs`: passed.
- `node scripts/release-version.js`: passed, printed 1.3.0.
- FontTools inspected both fixture faces, confirming weights 400/700, nonzero
  cmap IDs for all sample characters, and CFF paths with nonempty bounds.
  This is fixture inspection, not Parley shaping or Skrifa validation.
- `cargo +1.97.0 --version`: failed. That toolchain is absent, and rustup could
  not create a temporary file in its read-only installation.
- Initial Cargo test failed on the default read-only registry path.
- With `CARGO_HOME=/home/kit/.cargo`, isolated /dev/shm test compilation failed
  with permission denied executing a build script because /dev/shm is noexec.
- A one-job host test attempt using this worktree's target, debug symbols off
  and incremental compilation off, was terminated with exit 143 to protect
  disk space. No tests ran. Only this task's disposable 396 MB target was
  removed afterward, restoring approximately 846 MB free space.
- Clippy and Rust tests were not completed on rescue. The supervisor stopped
  the rescue-only Cargo build because disk space was low. This was not a
  general user ban on continuation or testing elsewhere.

The supervisor subsequently reported exact-lab validation of cc04dec with
Rust 1.97.0. All seven changed file SHA-256 values matched rescue at that
revision. Focused `ios_fonts` tests passed 3/3, library tests passed 109 with
16 ignored, and all-target Clippy with `-D warnings` passed. Independent review
accepted the code for an experimental build and required this validation-record
correction. These results do not establish iOS compilation or device behavior.

On the isolated lab checkout with sufficient disk space, run the installed
compatible toolchain or +1.97.0 if available:

```sh
cargo +1.97.0 fmt --manifest-path native/lyrics-renderer/Cargo.toml --check
cargo +1.97.0 clippy --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml
git diff --check
```

On a Mac with an installed iOS Rust target and Xcode SDK, also compile the
iOS production path and target-only tests with `cargo check --tests --target
aarch64-apple-ios --manifest-path native/lyrics-renderer/Cargo.toml` using a
compatible toolchain. Run the target-only test through an iOS test runner.
A later rebuilt development IPA and physical phone check must reproduce the
reported song and verify Japanese, Chinese and Korean samples, preferably on
an English-only device without downloaded Chinese fonts as well as one with
Chinese preferred languages. Host checks do not establish device success.

## Lab compile correction

The Rust 1.97.0 lab run of fe5516e failed with E0308 at
`src/ios_fonts.rs:116`, recorded in exact-lab `/tmp/kanji-test.log`.
Parley's run coordinates use parlance::NormalizedCoord, while Skrifa expects
its own F2Dot14 type. The outline assertion now converts each run coordinate
with `to_bits()` and Skrifa's `from_bits()`, once per run. This preserves the
actual variation coordinates exactly rather than substituting default axes.
The change affects test validation only. The subsequent exact-lab run passed
the focused tests, library tests and all-target Clippy as recorded above.
No additional build was attempted on rescue. Integration checks and final
review remain required after rebasing onto the latest development branch.
