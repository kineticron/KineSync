# Native mobile-only detector (detector-refactor)

KineSync remains on Expo SDK 58, React Native 0.88, and WebView 14. No new runtime dependencies or SDK migration are required.

In iOS and Android Mobile-Only mode, a temporary Spotify WebView reuses the existing login cookies and captures a verified browser bearer, client token, Dealer route, and observer registration destination. Verification requires a non-anonymous token response or the successful account-scoped observer response for that exact bearer. Anonymous/unverified request headers never start the detector. Onboarding and the settings sign-in WebView retain their existing flow.

The app opens its own native Dealer WebSocket and registers a new hidden, non-playing observer against its own connection ID. After registration supplies recognizable track state, the closed WebView unmounts. Dealer messages then provide track changes, pause/resume, seeks, device identity, and timestamped position anchors. Browser playback messages never populate this clock. No 250 ms polling, repeated registration snapshots, or audio-device creation/state writes are introduced.

## Lyrics timing

Anchors are projected once to local packet time before entering the existing playback store. The store keeps its monotonic 100 ms clock and UI interpolation, including its 80 ms deadband for ordinary playing corrections. Pause, resume, and seek anchors retain existing handling. Duplicate anchors are dropped; older source timestamps cannot overwrite newer events, including Dealer updates received while registration is in flight. Track identity uses the authoritative Spotify URI rather than title/artist strings, so catalog enrichment does not reset lyrics.

The current projection assumes the source and phone wall clocks agree. It provides no claimed absolute speaker accuracy or calibrated audio offset. Watch for drift/late pauses on an actual iPhone; synthetic timing tests cannot establish audible alignment.

## Login and lifecycle

Credentials and internal connection routes remain in detector memory. The verified Spotify token also uses the app's existing SecureStore-backed mobile lyrics settings for catalog/lyrics lookups. Known expiry schedules a session refresh; opaque tokens are renewed conservatively after 45 minutes. A 401 requests fresh browser capture. A 403/429 blocks automatic retries until explicit reconnect. Socket errors use three bounded reconnect attempts and a 15-second heartbeat with a 45-second watchdog.

Backgrounding closes the native connection and returning reconnects using the captured session when valid. Control Center's transient inactive state does not deliberately stop observation. Changing to desktop mode disables the detector. Tour entry/disposal and logout suppress queued state/auth/catalog callbacks. Logout also mounts a temporary Accounts logout WebView so shared cookies are cleared even if the player was already unmounted.

Artist enrichment resolves the exact Spotify track GID through the captured spclient session's `/metadata/4/track` endpoint. Connect snapshots can omit artist names; lyrics searches wait until an artist is available. Metadata is cached and simultaneous requests are deduplicated. Failures expose the HTTP status in diagnostics and the lyrics status. This path does not require the public Spotify Web API token scopes.

Playback controls send gzip JSON commands to `/connect-state/v1/player/command/from/{observer}/to/{active-device}` using the native connection ID. Pause/resume, previous/next, and seek target the device reported by Dealer without mounting the browser. Acknowledgments never synthesize clock anchors; only subsequent device state updates change playback. Commands are serialized and never automatically retried. Server errors are surfaced to the user; account/device restrictions can still reject a command. The explicit Spotify browser remains available on demand.

Android also enables the native detector. Android session capture uses the existing desktop Chrome user agent and keeps its bootstrap surface in the viewport until native registration is ready. A bounded startup discovery registers Spotify's already-created Connect observer once, without reading/polling its playback state or creating a playback device. This captures the registration route even when Android defers registration until a local playback action. The iOS bootstrap remains unchanged.

The Android APK workflow has a manual `development` variant. It builds the Debug development client using the release signing certificate and the existing package identity, allowing a certificate-checked `adb install -r` upgrade to preserve shared WebView cookies and stored settings. Subsequent JavaScript changes load through Metro. Never uninstall the existing app to resolve a signature mismatch when preserving its login.

On Android 7 (API 24/25), SDK 58's development launcher references `java.time.Duration` before JavaScript starts. The Android prebuild plugin enables core library desugaring with `desugar_jdk_libs` 2.1.5 so the missing Java APIs are packaged for these supported devices. See [Android's Java API desugaring documentation](https://developer.android.com/studio/write/java8-support). SDK 58 and the minimum Android API remain unchanged. Manual APK builds can select a single native architecture; `x86` matches the existing BlueStacks instance, while the default remains universal.

Protocol references: [Spotcontrol metadata implementation](https://github.com/mcMineyC/spotcontrol/blob/ec66eae39fe5/spclient/metadata.go) and [Spotcontrol spclient command documentation](https://pkg.go.dev/github.com/mcMineyC/spotcontrol/spclient). These internal endpoints must still be verified against the user's actual Spotify session; mocked regression tests verify our routing and handling, not Spotify's acceptance.

## Device test

The SDK 58 x86 development APK was built on `detector-refactor` in [Android Actions run 37824788307](https://github.com/kineticron/KineSync/actions/runs/37824788307). Its checksum and signing certificate were verified before updating the existing BlueStacks Android 7.1.1 installation with `adb install -r`, preserving app data. Core library desugaring resolved the development launcher's startup crash, and the app loaded its current Android JavaScript from Metro over ADB forwarding.

The live Spotify test is currently blocked before authentication: the emulator's WebView reports an untrusted certificate authority on the sign-in page. The host's validated Spotify TLS chain is issued by its Avast HTTPS-scanning root, which the emulator does not trust. No TLS checks have been disabled. Native observer registration, live metadata/lyrics, and server-accepted controls remain unverified on this device until its certificate trust and an active Spotify playback device are available. Android regression tests cover the native capture/bootstrap, enrichment, commands, and lifecycle independently of that account/network condition.

1. Select Mobile-Only and sign in through the existing settings/onboarding flow.
2. Start music in the official Spotify app, then return to KineSync. If setup needs a nudge, open Spotify from KineSync and open its device picker. Close the browser after capture.
3. Verify lyrics continue while the WebView is unmounted. Let a track play uninterrupted, pause/resume from Control Center, seek, and change tracks. Look for lyric jumps or unexpected backward movement.
4. Open Spotify diagnostics to share detector state/device/receipt timestamps without credentials. Test background/foreground, desktop/mobile handoff, logout and fresh login.
5. Confirm artist names populate before lyrics search, then test KineSync's play/pause, next/previous and seek with the browser closed. If Spotify refuses a command, record the displayed HTTP status and selected device from diagnostics.

Local validation: `npm run test:spotify-detector`, `npm run test:spotify-browser`, `npm run test:lyrics`, `npx tsc --noEmit`, `npm run lint`, and an iOS Hermes export. The SDK 58 Worklets test harness supports array closures so the real playback-store jitter/seek checks execute against the current SDK.

The requested development build uses `.github/workflows/ios-development-build.yml` on this branch, with the same Xcode 27 runner/toolchain check as the existing SDK 58 unsigned build. It creates the `ExpoLyrics-development-ipa` Actions artifact (Debug, Expo development client, unsigned for local re-signing). It does not use EAS or publish a release.
