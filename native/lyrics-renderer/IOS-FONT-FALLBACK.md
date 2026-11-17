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
The Han additions are Japanese Hiragino, the bundled Noto Sans CJK SC, Chinese
Hiragino variants, installed PingFang/Heiti variants, Songti, Kaiti, Yuanti,
Lantinghei and Apple SD Gothic Neo. Hangul adds Apple SD Gothic Neo. Missing
families are skipped. An empty candidate result leaves the existing fallback
unchanged. Fontique already excludes hvgl-only faces.

Song observation: the reported Spicy payload for 八方來財 by 攬佬 SKAI ISYOURGOD
(Spotify track `7jm2PueKmv4EOHfdbdXMKT`, ISRC `HKE022272921`) contains only
BMP Han, kana and Hangul. It has no Extension B codepoint. The visible tofu
positions are consistent with Simplified-only characters. 摆 U+6446,
长 U+957F, 揽 U+63FD, 诚 U+8BDA and 钱 U+94B1 are not the traditional or
Japanese forms. PingFang is hvgl and excluded. Heiti is not guaranteed to be
installed. This supports a coverage gap in the earlier candidate list, but the
reporting device font tables were not captured, so it is not a proof of the
installed families or of per-character outlines. The same positions appear in
the main and background voices. Korean background text is intended and is not
a defect.

The bundled fallback is the full official Noto Sans CJK SC Regular and Bold
OpenType CFF collection from
[`notofonts/noto-cjk`](https://github.com/notofonts/noto-cjk), path
`Sans/OTF/SimplifiedChinese/` on `main`. No characters are subsetted. The
source paths are:

- `NotoSansCJKsc-Regular.otf`, 16,437,364 bytes, SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`
- `NotoSansCJKsc-Bold.otf`, 17,002,248 bytes, SHA-256 `b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a`

The files are under the SIL Open Font License 1.1. The complete license is
checked in as `ExpoLyrics/modules/kinesync-rust-lyrics/ios/Fonts/NotoSansCJK-LICENSE.txt`
and is listed in the ExpoLyrics third-party notices. FontTools inspection on
the checked-in files reports family `Noto Sans CJK SC`, weights 400 and 700,
CFF outlines, no hvgl table, and full coverage of all 210 unique song
characters, the Japanese samples and the Korean samples. That is outline table
evidence, not a Parley or device run.

Candidates follow the Japanese families so Japanese clusters keep Japanese
glyph forms. The bundled Noto comes before the other Chinese families but
after platform and Japanese choices. Platform fallback therefore remains
preferred where it can draw. Android already discovers its full system CJK
partition through the shared `android_fonts` path and needs no bundled font or
candidate change.

Fontique's query implementation tries subsequent families when a cluster is
not covered and adds the default Han list to script/locale queries, including
common punctuation. The regression includes an existing first fallback that
lacks Han coverage to verify that subsequent candidates are reached.

The podspec adds both OTF files and the license to the existing
`KineSyncLyricsFonts` resource bundle. `KineSyncRustLyricsModule.swift` registers both
faces with `CTFontManagerRegisterFontsForURL` in process scope on the Rust
worker before `kr_create`. Fontique's CoreText scan then discovers the family
before the first font context is built. Already-registered errors are accepted
so a remount does not fail. Missing bundle files fail the renderer with an
explicit status instead of silently drawing tofu. The registration is
idempotent and adds no per-frame work or network access.

Size tradeoff: the two uncompressed OTF files add 33,439,612 bytes before any
app packaging or compression. This is the cost of guaranteed broad Simplified
coverage with real 400 and 700 outlines. A subset would be smaller but is not
used. App download size, installed size and startup memory have not been
measured. The fonts are loaded lazily by Fontique only when a cluster reaches
the family.

This does not implement hvgl rendering. It does not replace platform
Japanese or Korean choices. Hiragino can still give Japanese forms where it
covers shared Han, and the bundled Simplified forms are used only after the
platform fallback list and the two Japanese families. The host regression proves the
bundled tables and fallback order. Device time to first frame and visual
glyph-form acceptance still need a rebuilt IPA and physical phone check.

## Regression and fixture

`src/ios_fonts.rs` has host tests for the actual production fallback
configuration, an initially missing Han fallback, preservation of a first
family without Han coverage, duplicate suppression and missing candidates.
The test aliases the licensed small CJK fixture to the Japanese and Korean
candidate family names through Fontique metadata overrides. These aliases are
explicitly not evidence of Apple font availability.

A separate regression registers the two real checked-in Noto Sans CJK SC
faces, keeps the Japanese and Korean aliases ahead of them, and shapes the
actual sanitized main and background corpus at weights 400 and 700. It
requires every glyph to be nonzero and drawable, requires the five
Simplified-only forms to resolve to `Noto Sans CJK SC`, requires weight 700 to
use the Noto Bold subfamily, and requires Japanese and Korean samples to stay
on their earlier families. The fixture is not substituted for the bundled
font in that test.

The CJK regression shapes `革命道中君夢中愛`, `汉语爱漢語愛` and `한국어` at
weights 400 and 700. Every shaped glyph must be nonzero and must successfully
draw a nonempty outline through Skrifa using the run's normalized coordinates.
Bold must use TTC face 1, regular face 0. A synthetic unsupported-outline test
keeps the real CJK cmap but hides CFF, proving that nonzero IDs alone fail the
outline check. A synthetic hvgl-tagged variant verifies Fontique's scan gate.

Additional tests pin the actual song corpus. `SONG_MAIN` is the sanitized set
of unique main-voice Han. `SONG_BACKGROUND` is 揽佬 plus the intended Korean
and Chinese background set. One host test proves the corpus is entirely BMP
and contains the reported Simplified-only forms. Another pins the candidate
order so Japanese remains ahead of Chinese. The target-only iOS test shapes
both corpus voices at 400 and 700 with real CoreText discovery and requires a
drawable outline for every glyph.

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
