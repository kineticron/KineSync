What this repo does: KineSync displays synchronized Spotify lyrics on phones, with an optional desktop bridge and a personal lyrics vault. This audit assumes one continuous listening session, track changes, delayed providers, and large personal vaults.

Scope: `development` at `d45dd14`, compared with `origin/main` at `7be555c`, including the feature work already present as uncommitted changes. The detector issue below was found while expanding the requested live performance checks, rather than in the two committed lrc.red changes.

## Must fix, now fixed

1. **A valid Spotify observer response never starts detection** ([bootstrap.ts](../lib/spotify-detector/bootstrap.ts))
   - **What this is:** The browser verifies the exact bearer used for an account-scoped observer request before the native detector connects.
   - **Problem:** The real HTTP 200 response contained `player_state` without a devices map. Requiring both rejected valid credentials, leaving the detector enabled but unregistered and receiving no playback samples.
   - **Fix:** Accept the recognizable playback state without a devices map. Keep the trusted origin, exact endpoint, HTTP 200, boolean playback-state fields, and request-bearer checks for fetch and XHR.
   - **If we skip it:** A signed-in player can appear idle indefinitely. Before the fix this occurred on BlueStacks, after the fix registration succeeded and a real playback sample arrived.

2. **One missing readiness callback blocks every later lyric packet** ([lyrics-packet-transition.tsx](../components/lyrics/lyrics-packet-transition.tsx))
   - **What this is:** A replacement renderer stays hidden until it has laid out its lyrics, while the previous renderer remains visible.
   - **Problem:** A pending renderer that never called `onReady` kept the transition occupied. Every later packet was coalesced behind it indefinitely.
   - **Fix:** Let a newer packet replace the unready incoming renderer while retaining the last visible renderer. Ignore stale readiness callbacks and release outgoing renderers immediately when inactive.
   - **If we skip it:** Lyrics can stay on an old packet after a delayed or failed layout. The fix keeps at most two renderers and never reveals unready content through a timeout.

3. **An old native refresh can restore a stale duplicate after a manual save** ([mobile-lyrics-vault.ts](../lib/mobile-lyrics-vault.ts))
   - **What this is:** Expired lyrics are purged while a separate job retains only track identifiers for refreshing them.
   - **Problem:** Saving a fresh copy after the purge generated a new entry ID but left the old refresh job active. Its delayed response could recreate a second copy.
   - **Fix:** Cancel refresh jobs for the saved Spotify recording inside the save transaction. A delayed-response test verifies that the fresh manual save survives alone.
   - **If we skip it:** Stale content can reappear and compete with the copy the user just saved.

4. **Web refresh can lose another song's retry job** ([mobile-lyrics-vault.web.ts](../lib/mobile-lyrics-vault.web.ts))
   - **What this is:** A refresh response is merged into the web vault and its completed job is removed.
   - **Problem:** If another entry expired during the request, reading its old job list before purging that entry overwrote the newly created retry job.
   - **Fix:** Purge and read entries before reading the latest job list inside the serialized mutation. A controlled-clock test covers expiry during an outstanding request.
   - **If we skip it:** The second song loses its scheduled retry after its expired content is removed.

5. **Web vault matching can replace a different recording** ([mobile-lyrics-vault.web.ts](../lib/mobile-lyrics-vault.web.ts))
   - **What this is:** Saves and lookups match a recording by Spotify identity, with metadata matching for imports.
   - **Problem:** Conflicting Spotify IDs still fell back to matching title and artist. Saving another recording with the same names could replace the first one.
   - **Fix:** Reject conflicting IDs, prefer an exact ID over a metadata-only match, and align file-import duration handling with native behavior.
   - **If we skip it:** Different recordings can share the wrong lyrics or remove each other's saved entries.

6. **Two web saves in one clock tick can share an entry ID** ([mobile-lyrics-vault.web.ts](../lib/mobile-lyrics-vault.web.ts))
   - **What this is:** The web vault assigns an ID from the title and current time.
   - **Problem:** Two distinct recordings with the same title saved in one millisecond received the same ID. Entry-level operations could then address the wrong saved recording.
   - **Fix:** Add a sequence suffix, matching the existing native approach. A fixed-clock test checks that both entries remain distinct.
   - **If we skip it:** Concurrent or batched saves can create ambiguous entries.

## Should fix, now fixed

7. **Desktop startup rewrites the whole vault on every launch** ([lyricsVault.js](../../DesktopBridge/src/lyricsVault.js))
   - **What this is:** The new policy migration updates expiry and export restrictions, then cleans up legacy recovery files.
   - **Problem:** It parsed and updated every catalog row and scanned recovery directories on every opening, even after a successful migration.
   - **Fix:** Record successful migration and cleanup once. A restart test installs a trigger that rejects unexpected catalog updates, then verifies the next opening succeeds.
   - **If we skip it:** Startup repeats unnecessary database writes and filesystem work as the vault grows.

8. **Desktop replacement and expiry deletion scan all lookup keys** ([lyricsVault.js](../../DesktopBridge/src/lyricsVault.js))
   - **What this is:** Entry updates and foreign-key deletion remove lookup keys by vault entry ID.
   - **Problem:** SQLite's query plan reported a full `vault_keys` scan for that operation.
   - **Fix:** Index `vault_keys(vault_id)`. The query-plan regression requires the new index and rejects the old full scan.
   - **If we skip it:** Replacing or expiring one entry repeats work over unrelated songs' keys.

9. **Independent lrc.red candidates wait behind each other** ([desktop source](../../DesktopBridge/src/lyrics/parts/04-lrc-red-source.js), [mobile source](../lib/mobile-lyrics-service.js))
   - **What this is:** Up to three ranked recordings are checked for karaoke timing before using line-timed lyrics.
   - **Problem:** Each network request began only after the previous request completed. A slow first candidate delayed a useful later candidate unnecessarily.
   - **Fix:** Start the bounded candidate requests together and consume results in ranked order. Return as soon as the winning karaoke result is available, preserving the early return for a successful first candidate.
   - **If we skip it:** Fallback lookup adds independent request delays together. Deferred-response tests cover a hanging lower candidate and reverse completion order.

10. **Unchanged web reads serialize every saved lyric again** ([mobile-lyrics-vault.web.ts](../lib/mobile-lyrics-vault.web.ts))
    - **What this is:** Vault reads sanitize track metadata and remove expired entries.
    - **Problem:** An unchanged read still serialized the full payload, including lyrics and retained XML, just to detect whether cleanup changed it.
    - **Fix:** Track cleanup changes explicitly and serialize the payload only when a write is needed. A 100-song fixture asserts zero full-payload serializations for unchanged entry and catalog reads.
    - **If we skip it:** Ordinary lookups and browsing repeat work proportional to all saved lyric data.

## Additional verification

Temporary shader cleanup now also runs when surface allocation fails, with a regression that checks disposal. No shader color, resolution, frame-rate limit, blur pass, lyric typography, timing, or animation curve was reduced.

The demo renderer test harness now recognizes the packet-transition import and readiness message. The previous full mobile test run stopped at this missing harness support.

The supervising review rejected an unproven native-memory-leak claim and a proposed eager Skia disposal patch. Skia's reference-counted ownership must remain valid through React lifecycle replay and asynchronous rendering. A proposed timer that forcibly revealed an unready renderer was also rejected to preserve visual fidelity.

## Measurement method

BlueStacks ran the current JavaScript using the existing debuggable Android client reporting version `1.1.7`. Both variants used the same native binary, emulator, resolution, and display settings. These are exploratory development measurements, not matched release-build or physical battery measurements.

Before means the feature code before the audit fixes. Separate baseline modules reconstructed the original artwork, packet transition, native host, and lrc.red candidate function without switching or reverting the user's working tree. The final rendering comparison uses the corrected, verified Spotify observer in both variants to hold the detection workload constant.

Each renderer used an identical 100-line deterministic lyric workload with animated artwork. Three before/after pairs alternated order. AMLL then ran another three pairs with reversed starting order and no concurrent checks. Each capture followed three seconds of warmup and recorded roughly twelve seconds of SurfaceFlinger presentation timestamps. Reported FPS measures the app surface, not an isolated lyric layer. The emulator reported 240 Hz, so its jank percentage should not be read as a conventional 60 Hz score.

The active workload uses the demo entry into the production native renderer. That entry bypasses packet transitions, so these FPS measurements do not measure track-change crossfade cost. The native renderer and artwork frame paths were identical between the reconstructed baseline and final variant. Packet replacement, readiness, inactive cleanup, and Reduced Motion have separate regression coverage.

Live lrc.red requests used a fresh service instance and bypassed the application cache for Blinding Lights by The Weeknd. Device HTTP and TLS caches remained available. The controlled fallback used the production provider and parser in Hermes with fixed response delays: a 30 ms search, a 300 ms line-timed first candidate, and a 500 ms karaoke second candidate. Both returned the same content fingerprint and line count.

Paused visual checks fixed the same artwork, lyric position, font, layout, and renderer settings. Full 1080 by 1920 screenshots were compared pixel by pixel. This checks those rendered scenes, not every device, language, or possible animation frame.

Raw local results, screenshots, archived temporary sources, and profiling scripts are retained in `.cache/performance/branch-audit/`. They are ignored local audit artifacts. Standard capture and regression commands remain in the repository's scripts.

## Before and after measurements

| Check | Before | After | Interpretation |
| --- | --- | --- | --- |
| Live lrc.red fetch median, 3 runs each | 124.2 ms | 125.3 ms | No observed median improvement for a successful first candidate |
| Controlled fallback median, 3 runs each | 855.0 ms | 548.9 ms | 35.8% lower latency with fixed network delays |
| Desktop vault reopening median, 1,000 entries, 9 runs each | 12.69 ms | 3.40 ms | 73.2% lower time in this host microbenchmark |
| Spicy active presentation FPS, 3 runs each | 124.2 | 123.3 | No FPS gain established |
| AMLL active presentation FPS, first 3 runs each | 125.3 | 118.1 | After was 5.8% lower in this pass |
| AMLL active presentation FPS, repeat 3 runs each | 118.6 | 117.6 | Gap narrowed to 0.9%, no FPS gain established |
| Spicy paused screenshot, 1080 by 1920 | Baseline | 0 changed pixels | Exact match for this fixed scene |
| AMLL paused screenshot, 1080 by 1920 | Baseline | 0 changed pixels | Exact match for this fixed scene |

All active FPS runs used an enabled detector with verified credentials, a registered observer, and an open socket at both capture boundaries. A separate probe received one real Spotify playback sample after the bootstrap fix. Steady captures recorded zero additional samples. This establishes connected-detector rendering behavior, not sustained playback-event stress or a comparison of the broken detector with the repaired detector.

AMLL's lower after result remains recorded rather than dismissed as noise. The smaller gap on the repeat, overlapping repeat ranges, unchanged frame-path source, and dev-client limitations prevent attributing it to a particular audit fix. These measurements do not establish an FPS regression-free release gate. A matched release-build run on a physical device is still needed for that claim.

Spicy CPU consumption averaged 67.6 versus 67.7 process ticks per second. AMLL averaged 69.6 versus 71.0 in the first pass and 70.4 versus 70.9 in the repeat. No CPU saving was demonstrated. Process memory rose over the continuous development session in both variants. The paired figures do not establish a resource leak or a memory saving.

Live fetches returned the same 35 lyric lines and content fingerprint in all six runs. The first baseline request took 363.2 ms, while the remaining baseline requests took 124.2 and 109.0 ms. This initial connection warmup makes the lower after mean unsuitable as evidence of a normal live fetch speedup. Controlled fallbacks returned identical parsed lyrics and showed the expected benefit of overlapping candidate requests. All measured follow-up reads hit the application cache.

Both paused variants produced zero new native and presented frames during their roughly twelve-second captures. Their exact screenshot matches supplement the unchanged shader and renderer frame paths. They do not prove visual equivalence for every animated instant, language, screen size, or device.

## Final quality gate

The final checks ran on supported Node `24.19.0` after removing temporary app routes and baseline modules. All passed:

- Root `node scripts/check-repository.cjs`, including 32 documents, internal links, pinned workflows, and tracked secret-file exclusions.
- Mobile `npm run typecheck`, `npm run lint`, and full `npm test`, including detector bootstrap and native lifecycle regressions.
- Mobile `npm run test:lyrics-native` and `npm run test:performance`.
- Desktop `npm run lint` and `npm test`, with all 97 tests passing.
- Website `npm run build`, including TypeScript and static export.
- `git diff --check`.

Mobile lint has zero errors and two existing warnings in `spicy-upstream-support.ts` and `onboarding-screen.tsx`. The website's generated project statistics and Metro's generated TypeScript configuration were restored after verification. The user's existing Metro server and original feature edits were preserved.

The fix and review rounds were supervised across OpenCode, Antigravity, and Codex. Codex rounds use GPT-6.1-Sol after the user's model correction. Each result was reviewed and revised where necessary, including rejecting the slower all-results provider wait, speculative GPU disposal, and forced readiness timer. No commit or pull request was created.

Verdict: Confirmed correctness fixes and bounded provider and vault speedups are implemented. The checked paused scenes preserve visual fidelity. No active-rendering FPS improvement or release-level performance clearance is claimed.

Not checked: matched baseline and optimized release builds, iOS on-device rendering, physical battery drain, every provider's live availability, and unrelated repository features outside the changed paths and the requested detector integration.
