What this repo does: KineSync follows Spotify playback and renders synchronized lyrics, artwork, controls, onboarding and a local lyrics vault. This audit assumes continuous foreground playback, track changes, scrubbing, repeated demo loops, background/resume and a vault containing hundreds or thousands of songs.

The audit covered routes, providers, hooks, store subscriptions, transport/detector lifecycle, artwork loading, native and WebView renderer clocks, gestures, settings, local/desktop vault UI, Live Activity synchronization, app configuration and the existing performance tests. Searches covered production application TypeScript/JavaScript, excluding generated WebView bundles and dependencies, their maintained entry points were inspected instead. The changes preserve the existing unrelated workspace edits.

## Should fix - fixed in this pass

1. **Demo clocks repeatedly render the player and both previews** ([tour hook](../hooks/use-player-tour.ts), [onboarding preview](../components/onboarding/renderer-preview.tsx)).
   - What this is: Demo playback was delivered as a new React position every 100 ms.
   - Problem: Each 25-second loop generated about 250 timer callbacks and position updates, including rerenders of the main tour screen and repeated native/WebView synchronization.
   - Fix: Pass a stable playback anchor to both renderers. Native clocks interpolate on UI, WebViews project their own clocks. One timeout resets each loop, with pause, seek, focus and background cleanup.
   - If skipped: Ordinary demo playback continues waking React ten times per second.

2. **Every active-line notification renders the main player** ([player](../app/%28tabs%29/index.tsx)).
   - What this is: The active lyric index was React state in HomeScreen.
   - Problem: Only the imperative share-selection handler read that value, displaying a new line still rerendered the whole player.
   - Fix: Retain the current index in a ref and read it when sharing.
   - If skipped: Every lyric line continues creating unrelated React work across artwork, controls and menus.

3. **Unused latency plumbing makes playback jitter render HomeScreen** ([player](../app/%28tabs%29/index.tsx), [controls](../components/lyrics/playback-controls.tsx), [settings](../components/lyrics/settings-menu.tsx)).
   - What this is: HomeScreen subscribed to driftOffset and passed it through the controls dock.
   - Problem: The controls did not render latency. Ordinary diagnostic changes could nevertheless rerender the player and its controls.
   - Fix: Delete the unused control prop chain. Subscribe to latency inside the settings menu while it is open.
   - If skipped: Diagnostic packets remain a render trigger even when no latency is visible.

4. **The native canvas duplicates UI presentation in React state** ([native host](../components/lyrics/native/native-lyrics-view.tsx)).
   - What this is: Line cues updated both the UI presentation window and a React window state.
   - Problem: The production canvas uses the shared UI presentation window, so its React mirror only caused extra host renders.
   - Fix: Update the React mirror only for the experimental renderers that actually read it. Keep cue-driven scrolling and active-line notifications.
   - If skipped: Each line cue causes an unnecessary React render even though its pixels already update on UI.

5. **Background syllables trigger redundant JS cue work** ([cue timeline](../components/lyrics/native/native-cue-timeline.ts)).
   - What this is: The native cue list included individual background syllable starts and ends.
   - Problem: Word rendering already owns those timestamps on UI, most do not change the line window, interlude or scroll target. They inflated preprocessing and RN notifications.
   - Fix: Build cues from line/extended-background boundaries and compact identical presentation states. Tests compare the resulting presentation and scroll targets against the real timeline across overlaps, pauses and seeks.
   - If skipped: Background-heavy songs continue waking RN for events that only affect UI word rendering.

6. **Translation availability scans all lyrics on every store update** ([timing helpers](../lib/lyrics-timing.ts), [controls](../components/lyrics/playback-controls.tsx)).
   - What this is: A Zustand selector called lyrics.some on every playback notification.
   - Problem: An untranslated song forces a complete scan, including notifications unrelated to its lyrics, multiplied by mounted control instances.
   - Fix: Cache the boolean by immutable lyric-array identity in a WeakMap. Controls still subscribe to the boolean rather than the full array.
   - If skipped: Long untranslated songs continue doing linear work for every store update.

7. **Closed settings stay subscribed to changing diagnostics** ([settings](../components/lyrics/settings-menu.tsx)).
   - What this is: The mounted menu subscribed to lyrics, source, status and bridgeTiming even while closed.
   - Problem: New diagnostic objects could rerender its hidden tree. Unmounting the entire menu would break its existing handoff to the QR scanner.
   - Fix: Return stable empty selector values while closed and read current data when opened. Preserve the scanner lifecycle.
   - If skipped: Invisible settings continue reacting to live playback data.

8. **Scrubbing crosses to RN more frequently than it can update lyrics** ([timeline](../components/lyrics/playback-controls.tsx), [player](../app/%28tabs%29/index.tsx)).
   - What this is: The UI gesture queued JS callbacks every 80 ms, JS throttled lyric previews again at 220 ms, and HomeScreen added another 32 ms timer.
   - Problem: Most callbacks did not update useful output. The thumb and time labels already animate on UI.
   - Fix: Gate lyric preview delivery at 220 ms on UI and remove both redundant JS throttles. Begin, exact release coordinates and cancellation remain immediate semantic events.
   - If skipped: Continuous scrubbing keeps queuing avoidable RN callbacks and timers.

9. **The local vault constructs every saved-song row** ([vault](../app/%28tabs%29/vault.tsx)).
   - What this is: A ScrollView mapped the entire catalog into artwork, blur layers and buttons.
   - Problem: Opening or searching a large vault builds every row, including rows far outside the viewport. It also subscribed to the current full lyric packet solely to enable Save.
   - Fix: Use the installed FlashList with a stable render callback, bounded draw distance, a header and an empty state. Memoize filtering, subscribe only to save availability and read the latest packet when saving.
   - If skipped: Large catalogs continue causing expensive mounting and rendering bursts.

10. **Desktop catalog page merges repeatedly scan previous rows** ([desktop catalog](../components/lyrics/desktop-vault-catalog.tsx)).
    - What this is: Pagination removed duplicates using findIndex inside filter.
    - Problem: Every row searched the growing combined catalog again, producing quadratic JS work as pages accumulated.
    - Fix: Deduplicate once with a Set, retaining the first occurrence and existing page behavior.
    - If skipped: Loading later pages becomes increasingly expensive.

## Evidence

[check-app-js-work.cjs](../scripts/check-app-js-work.cjs) executes production hooks and callbacks with deterministic lifecycle/timer boundaries. It also executes the real cue-timeline implementation and counts accesses to instrumented lyrics and catalog entries. The test now runs in the full app suite and performance suite.

- During ordinary demo playback, no 100 ms position callbacks or React position writes occur, one timeout handles each 25-second loop boundary. Pause/background cleanup and a queued callback racing a pause are covered.
- Unchanged demo anchors issue no repeated WebView sync injections and do not restart native UI tweens. Pause, scrub hold and projected positions are checked.
- A 100-background-syllable fixture produces eight line-state cues. Presentation fields and scroll targets match the production timeline at 7 ms sample intervals across the fixture.
- One hundred native canvas cues issue scroll and active-line notifications with zero React presentation writes. The experimental React path still receives its required state.
- A 1,000-line untranslated packet is scanned once. Six hundred subsequent queries perform zero translation rescans, replacement arrays and translated backgrounds invalidate correctly.
- Closed settings read none of the lyric/diagnostic fields across 600 simulated store notifications and subscribe to current fields when opened.
- A 1,000-song local catalog constructs no row subtree eagerly. Only rows requested through renderItem are constructed, this is a lazy-rendering check, not a measurement of FlashList's physical mounted-row count. Search and saving the newest playback packet are checked.
- A 1,200-entry desktop merge performs linear identity checks, preserving the first entry on overlapping pages.
- The existing Babel-serialized playback gesture test now drives 120 UI updates over one second. The thumb remains continuous while only four lyric-preview callbacks queue for RN, exact release seeks and cancellation still pass.

These are controlled work counts and behavior checks, not measured device CPU savings or whole-app FPS gains.

## Paths retained and remaining limits

Normal native lyric motion, word painting, scrolling, interludes, attribution and playback text/fill animations already run on UI. Their frame callbacks were not relabeled as RN work. The native-driver marquee is also already off the per-frame RN path. WebView animation loops run in the WebView runtime and their RN messages are semantic line/interaction events. Network observers, reconnect/heartbeat timers, one-second diagnostic playback snapshots and vault expiry work remain event-driven or deliberately low-frequency.

The previous artwork worker/persistent-canvas changes remain in place, see [background loading measurements](background-loading-performance-2026-10-20.md). No additional dependencies or animation-quality reductions were introduced here.

Provider decompression/parsing, large TTML imports, immutable packet enrichment and initial native text shaping still contain synchronous load-time work. This pass did not establish device timings for every provider/maximum-size input or move those engines to a worker. Those are the next profiling targets for remaining load-time hitches, rather than per-frame polling found in this audit. The desktop catalog also retains explicitly loaded pages, its local-vault sibling is the list virtualized here.

Validation: full npm test, native lyric tests, performance tests, Live Activity checks, TypeScript, ESLint and git diff checks pass. ESLint retains the two existing warnings in spicy-upstream-support.ts and onboarding-screen.tsx.

The choices follow [Reanimated's UI-runtime guidance](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/) and use the existing list/animation dependencies. No physical-device release trace was available. Previous emulator EGL/Skia surface errors make it unsuitable for asserting visual smoothness, no new emulator FPS claim is made.

Verdict: the confirmed recurring RN work has been reduced at its source, remaining load-time and GPU costs need matched physical release profiling.

Not checked: exhaustive third-party/provider internals, full Swift/Kotlin/C++ performance audits, every provider's maximum-size response, physical iPhone/Android frame times or battery drain. This is a performance audit, not a security review of the whole repository.
