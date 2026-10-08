# iOS mobile-only detector (detector-refactor)

KineSync remains on Expo SDK 58, React Native 0.88, and WebView 14. No new runtime dependencies or SDK migration are required.

In iOS Mobile-Only mode, a temporary Spotify WebView reuses the existing login cookies and captures a verified browser bearer, client token, Dealer route, and observer registration destination. Verification requires a non-anonymous token response or the successful account-scoped observer response for that exact bearer. Anonymous/unverified request headers never start the detector. Onboarding and the settings sign-in WebView retain their existing flow.

The app opens its own native Dealer WebSocket and registers a new hidden, non-playing observer against its own connection ID. After registration supplies recognizable track state, the closed WebView unmounts. Dealer messages then provide track changes, pause/resume, seeks, device identity, and timestamped position anchors. Browser playback messages never populate this clock. No 250 ms polling, repeated registration snapshots, audio-device creation/state writes, or new playback commands are introduced.

## Lyrics timing

Anchors are projected once to local packet time before entering the existing playback store. The store keeps its monotonic 100 ms clock and UI interpolation, including its 80 ms deadband for ordinary playing corrections. Pause, resume, and seek anchors retain existing handling. Duplicate anchors are dropped; older source timestamps cannot overwrite newer events, including Dealer updates received while registration is in flight. Track identity uses the authoritative Spotify URI rather than title/artist strings, so catalog enrichment does not reset lyrics.

The current projection assumes the source and phone wall clocks agree. It provides no claimed absolute speaker accuracy or calibrated audio offset. Watch for drift/late pauses on an actual iPhone; synthetic timing tests cannot establish audible alignment.

## Login and lifecycle

Credentials and internal connection routes remain in detector memory. The verified Spotify token also uses the app's existing SecureStore-backed mobile lyrics settings for catalog/lyrics lookups. Known expiry schedules a session refresh; opaque tokens are renewed conservatively after 45 minutes. A 401 requests fresh browser capture. A 403/429 blocks automatic retries until explicit reconnect. Socket errors use three bounded reconnect attempts and a 15-second heartbeat with a 45-second watchdog.

Backgrounding closes the native connection and returning reconnects using the captured session when valid. Control Center's transient inactive state does not deliberately stop observation. Changing to desktop mode disables the detector. Tour entry/disposal and logout suppress queued state/auth/catalog callbacks. Logout also mounts a temporary Accounts logout WebView so shared cookies are cleared even if the player was already unmounted.

Playback controls and the explicit Spotify browser remain available through the existing browser control implementation, mounted on demand. Controls open the Spotify browser in this base version; close it to resume the lean passive detector. Native remote playback commands are a separate follow-up. Android keeps the existing browser fallback unchanged.

## Device test

1. Select Mobile-Only and sign in through the existing settings/onboarding flow.
2. Start music in the official Spotify app, then return to KineSync. If setup needs a nudge, open Spotify from KineSync and open its device picker. Close the browser after capture.
3. Verify lyrics continue while the WebView is unmounted. Let a track play uninterrupted, pause/resume from Control Center, seek, and change tracks. Look for lyric jumps or unexpected backward movement.
4. Open Spotify diagnostics to share detector state/device/receipt timestamps without credentials. Test background/foreground, desktop/mobile handoff, logout and fresh login.

Local validation: `npm run test:spotify-detector`, `npm run test:spotify-browser`, `npm run test:lyrics`, `npx tsc --noEmit`, `npm run lint`, and an iOS Hermes export. The SDK 58 Worklets test harness supports array closures so the real playback-store jitter/seek checks execute against the current SDK.

The requested development build uses `.github/workflows/ios-development-build.yml` on this branch, with the same Xcode 27 runner/toolchain check as the existing SDK 58 unsigned build. It creates the `ExpoLyrics-development-ipa` Actions artifact (Debug, Expo development client, unsigned for local re-signing). It does not use EAS or publish a release.
