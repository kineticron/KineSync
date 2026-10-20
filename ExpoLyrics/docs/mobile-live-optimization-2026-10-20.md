# Mobile playback responsiveness follow-up

The user reported that both Spicy and AMLL feel slower than the onboarding tour on an iPhone 16 Pro using a development build in Mobile-Only mode. This follow-up targets confirmed unnecessary work without reducing rendering quality.

## Changes

- [Shared glyph pictures](../components/lyrics/native/native-glyph-picture.tsx) reuse a proven idle picture before scanning its words or advancing its float clock. One voice-level timestamp replaces repeated writes to every word. When animation resumes, word springs receive the last observed timestamp so ordinary activation keeps its spring motion and real seeks still reset correctly.
- [AMLL line motion](../components/lyrics/native/use-reference-line-motion.ts) stops scheduling frames after scale and highlight release settle. UI-runtime changes wake it without waiting for React or sending per-frame work to JavaScript. Pause, configuration changes, and recycled active signals also wake it. Cleanup cancels outstanding frames.
- [Spotify bootstrap](../lib/spotify-detector/bootstrap.ts) no longer clones request bodies, reads unrelated responses, walks diagnostic payloads, or parses browser socket traffic for messages that were discarded. It still reads the exact successful observer response needed to verify credentials. This saves work while the bootstrap browser is mounted, including login and reconnection.

The list buffer, fonts, text shaping, glow, blur, shader code, timing curves, and animation coefficients are unchanged. This does not hide inactive text or remove nearby rows needed for smooth scrolling. The connected detector remains event driven and keeps its existing bootstrap-browser unmount behavior.

## Verification evidence

| Controlled workload | Before | After |
| --- | --- | --- |
| 12 settled AMLL voices, 120 Hz, five seconds | 7,200 line callbacks | 0 line callbacks |
| 100-word future Spicy voice, 600 frames | 120,600 word/state reads | 600 word/state reads |
| 100-word future AMLL voice, 600 frames | 120,600 word/state reads | 600 word/state reads |

The glyph counts instrument array accesses in the real production component. The after path performs one first-word boundary check per frame, independent of the voice's word count. Both versions already avoided rebuilding the idle picture. These counts are not CPU percentages or whole-app FPS measurements, and a 100-word voice is a synthetic stress case.

[Glyph regressions](../scripts/check-native-glyph-idle.cjs) compare actual recorded drawing commands against the pre-change implementation through activation, release, paused playback, resume, forward and backward seeks, and line-paint invalidation. The draw-command traces match exactly in the tested workloads.

[Line-motion regressions](../scripts/check-native-inactive-work.cjs) execute serialized production worklets and compare 60 and 120 Hz lead/background traces with the old implementation within 0.0001. They also cover interruption, recycling, disable, cleanup/setup replay, and delayed frames. Review found and fixed a case where a ten-second suspension delta was reused for the next cue, skipping its transition.

The bootstrap regression requires zero request-body clones, one response clone for valid observer verification, zero response clones for ineligible responses, and no diagnostic socket listener. Authentication, origin, endpoint, exact-request bearer, and response-shape checks remain covered.

Both new renderer regressions run inside the existing `npm test` lyrics suite. Exact pre-change sources and local verification artifacts are retained under the ignored `.cache/performance/mobile-live-optimization/` directory.

## Quality checks and limits

Verified on supported Node `24.19.0`:

- Mobile typecheck and lint, with zero errors and the same two existing lint warnings.
- Full `npm test`, including vault, renderer, security, tour, Spotify browser, detector, and native lifecycle checks.
- `npm run test:lyrics-native` and `npm run test:performance`.
- Production iOS Metro export and Hermes compilation.
- Root repository checks and `git diff --check`.

The changes were supervised and independently reviewed with GPT-6.1-Sol. No commit or pull request was created.

These changes are JavaScript and worklet changes that can load through the existing development client. A physical iPhone run was not available in this environment. No iPhone FPS, battery, or overall responsiveness percentage is claimed. The next device check is normal Mobile-Only playback in both styles, including scrolling away from the active line, seeking, pause/resume, and returning after background suspension.
