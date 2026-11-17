# Paused AMLL credits replacement investigation

Worktree: `C:/Users/rawes/.t3/worktrees/KineSync/t3-e78e4fce`

Branch: `t3/fix-credits-footer-switch`

Base: `a02c9f868af5495b818197770a5a241762c3ab06`, fetched from origin/development before editing. Later harness commits were deliberately left for the parent to combine. No push was made.

## Exact fixture and preceding sequence

The supplied `C:/Users/rawes/FullAppRunner.java` section 40 swipes, flings and reverse flings both styles. Waiting seven seconds does not explicitly restore following. Section 50 loads each style, pauses and taps a discovered lyric row. A successful row tap restores following. A failed discovery leaves the earlier manual ownership intact.

Section 60 loads `credits`, discovers the maker target and sends a real tap. It then loads `credits-amll`. Both fixture states use track ID `fx-track-credits`, ten rows and position 51600 ms, paused. The last lyric ends at 49600 ms. Each apply creates new lyrics and metadata objects. The maker URL is `https://example.com/maker`.

The fixture functions from `fullapp-test-entry.js`, starting at `lines` and ending before `handle`, are preserved verbatim in `ExpoLyrics/scripts/fixtures/credits-footer-fullapp.js`. The deterministic prepared packets in `test/credits-switch-track.json` are intentional regression inputs. Regenerate them with `node ExpoLyrics/scripts/check-rust-credits-switch.cjs --write` and review changes.

Original scratch SHA256 values, unchanged at handoff:

| File | SHA256 |
| --- | --- |
| FullAppRunner.java | 82487444b8a01e8e037b97e9a191f02d9a090a0e706af9190cfc447d1fc9cbbc |
| fullapp-test-entry.js | fc7c6cec546ebbebb7ecf94d5b9a69c7227e2f672d28032108084e8f19a01cd2 |
| FullAppRunner-original.java | 9f412de8eb114a40965aec16f08c1d3934a02b8b80cb7b9885166372d2cb06b5 |
| fullapp-test-entry-original.js | e6af4abde57b82148fb392991ae7624cb4de0d0f0578aaba509a37347d942276 |

## Causal evidence and change

`rust-lyrics-gesture.js` takes ownership on grant, sending `setFollowing(false)` and `onAutoFollowChange(false)`. Its footer release invokes the footer handler without resuming following. The player retains that flag. `rust-lyrics-view.tsx` includes style and lyric objects in its revision, sends a new generation and reapplies the retained follow flag. The paused anchor remains 51600 ms.

Before this fix, `kr_set_track` always configured and reset `FollowScroll`, setting its position to zero. `FollowScroll::sample` returns through the manual path before checking `armed`. Consequently an explicit `kr_set_anchor` snap cannot rescue this viewport. This is a real native scene replacement state loss reachable through valid app input. The harness exposes it by tapping a link before replacing the same track. The evidence does not establish every physical-device timeout cause.

Same-track matching text and row timing now preserve a logical row and fraction, with the final interval mapped through the footer scroll limit. Render-order preparation resolves this anchor again after lazy measurement. Mapped values are clamped to the new scene. Explicit seek snaps survive until follow resumes. New track resets retain their prior behavior. Changed count, reordered or unrelated text, and empty layouts do not reuse old row indices.

Manual input clears the logical anchor. Ordinary rubber-band and fling frames bypass relocation. Cached scene activation clears stale anchors, including resize activation. Automatic following continues to use its existing targets. The Skia reference, Android touch handlers and ABI remain unchanged.

## Reproduction and verification

Run from the repository root:

```text
node ExpoLyrics/scripts/check-rust-credits-switch.cjs
node native/lyrics-renderer/test/credits-switch-host.cjs --before
node native/lyrics-renderer/test/credits-switch-host.cjs
node ExpoLyrics/scripts/check-rust-gestures.cjs
```

The `--before` command intentionally fails. It substitutes the original unconditional configure/reset behavior into the narrow host harness. After 35 simulated seconds, following=true reaches target 2070 and following=false stays at 0. The fixed command passes, including repeated geometry changes, pending seek and resume, earlier manual rows, rubber band, fling, cached resize and unrelated/new tracks. Synthetic footer y is 325.2 in the 640 px viewport after remapping. This command compiles production motion, mapping and frame-preparation functions with synthetic layout stand-ins using installed rustc 1.84.1. It does not establish font shaping, profile hit rectangles, GPU output or Android behavior.

The JS regression executes the preserved fixture functions, actual gesture contract and current packet preparation. It confirms the preceding ownership chain and unchanged ID/time. It runs through the existing gesture check and npm test.

Full crate regression:

```text
cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml credits_switch_
cargo +1.97.0 fmt --manifest-path native/lyrics-renderer/Cargo.toml --check
cargo +1.97.0 clippy --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 test --manifest-path native/lyrics-renderer/Cargo.toml
```

The native tests use real bundled fonts and scenes. They assert the whole footer text block is inside the viewport and discover on-screen footer, maker and uploader hit targets -2, -3 and -4. Cases cover fresh AMLL and Spicy to AMLL at 49599, 49600 and 51600 ms, three viewport/scale combinations, following on/off, snap after replacement, pending seek before replacement, earlier manual rows, 80-row wrapped translation fixtures, repeated preparation, cached resize and safe fallback. No Node runtime dependency was added to Rust tests.

Initial RA-WINDOWS results: Expo `npm run typecheck`, full `npm test`, gesture checks, JS fixture checks and the fixed narrow host check passed. System Cargo 1.84.1 is standalone and reports `no such command: +1.97.0`. Rustup is unavailable. On resumption, temporary 1.97 components were unpacked only into this worktree's ignored target directory. The matching compiler DLL enabled rustfmt 1.97, which formatted only changed Rust files. No toolchain installation or default configuration change was made.

The parent ran the actual WIP crate library tests on rescue. The initial long fixture failed because nested emphasis timestamps were not shifted with their words. After correcting those timestamps, the parent reported 97 passed, 0 failed and 16 ignored in `/tmp/footer-fix-lib.log`. Exact committed revision checks, formatting and independent final review remain with the parent.

No new physical or emulator visual reproduction was performed. No FTL, billing, API, main or tag changes were made. Emulator 5556 and its apps were untouched. Emulator 5558 and the sole normal-entry Metro belong to the drag investigation and were not reused. No Metro was started or stopped by this investigation. Generated probes, binaries, formatter files and logs remain outside the commit under the ignored target directory.
