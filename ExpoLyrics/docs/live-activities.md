# Live lyrics on iOS

KineSync uses a local Expo module to publish an ActivityKit activity and a
SwiftUI WidgetKit extension to render it. Start playback in the foreground,
then leave the app to see the compact Dynamic Island. Hold the Island to expand.
The Lock Screen also shows the lyrics on devices without Dynamic Island.

## Blank Island investigation (September 2026)

The reported device runs iOS 27 Developer Beta. We downloaded the actual
[iOS unsigned IPA run 34446072397](https://github.com/kineticron/KineSync/actions/runs/34446072397)
for commit `e353eff` on `expo-ui-live-activity` (version 1.0.7, build 38).
The archive contains the arm64 widget, WidgetBundle entry point, matching
versions, correct extension point and host support flag. Its system frameworks
and Swift runpaths are present. It was compiled with Xcode 26.6 / iOS 26.5 SDK.
There is no evidence in that artifact that Sideloadly support is the problem.

The October 5 report confirmed an active but empty Island on iPhone 16 Pro,
iOS 27, installed with Sideloadly. Comparing the actual simulator artifacts
provided a reproduction independent of that phone and signer:

- [Run 34755165244](https://github.com/kineticron/KineSync/actions/runs/34755165244),
  commit `459d684`: matching attributes module names; microphone and lyric visible.
  The host build failed because the widget's Swift module shadowed the Expo pod.
- [Run 34756296771](https://github.com/kineticron/KineSync/actions/runs/34756296771),
  commit `9b14951`: host and widget modules separated; native build passes,
  extension registration logged, but the screenshot shows an empty Island.

The earlier assertion that these distinct module identities were safe was not
supported by visual verification. The fix links the small static
`KineSyncActivityTypes` pod into both targets, giving the attributes and content
state the same defining module without sharing the widget and Expo module names.
The actual IPA verifier now rejects the previous separately defined types.
Native build and rendering verification of this fix are required; passing the
synthetic IPA and project-generation checks alone does not establish rendering.

The widget also uses an intrinsic 24-point icon without a geometry-dependent
scale and nonempty text fallbacks in each presentation. Restart previously
reused the active session; it now ends it and requests a new one. Old `lyrics`
sessions of the current attributes type are retired on first playback after
upgrading to `lyrics-v3`. Activities created with the old attributes type may
need to be dismissed on the Lock Screen after installing the fix.

A successful ActivityKit request is not a renderer acknowledgement. For device
investigation, collect Console logs for subsystem
`dev.kineticron.KineSync.live-activity`: category `host` reports the requested
type, and `widget` reports registration in the extension process. These logs
contain type names, not song titles, lyrics, tokens, or pairing keys. Check the
Lock Screen as well as compact and expanded Island after installing the new
IPA. Physical-device confirmation on iOS 27 beta remains required.

## Content and rendering budgets

The compact leading and minimal regions use the app's diagonal microphone:
outlined for line timing, filled with sparkles for karaoke. Compact trailing
shows a truncated current lyric. The expanded Island and Lock Screen show two
lines of the current lyric plus song, artist, album, source, and status. Source
parsing is shared with the player footer. Static lyrics never pretend to be a
timed active line. Interludes, loading, pauses, and stale content have fallbacks.

Apple's smaller reference iPhone provides **52.33 × 36.67 pt** per compact
region and at least **36.67 × 36.67 pt** for minimal. Our icon is **22 × 22 pt**
and compact text is **48 × 28 pt**, one line. Expanded top regions are **24 pt**
high, and bottom content is bounded to **108 pt**. Lock Screen content including
padding is **140 pt**, below Apple's **160 pt** maximum. Fixed fonts, line
limits, tail truncation, and clipping bound all text; long content cannot grow
the view past its allocated region. The layout intentionally uses fixed text
sizes; larger accessibility text does not expand this constrained surface.

ActivityKit content has a **4 KB** limit. Only the current line and short text
metadata enter `ContentState`; the full lyrics timeline stays in the host's
memory. The native publisher checks the actual Swift-encoded JSON, including
escaping and Unicode, and reduces text until it fits **2,800 bytes**, leaving
room for the small immutable attributes and encoding overhead. No artwork,
base64, fonts, remote images, or JavaScript rendering enters the extension.

## Timing and lifecycle

The root provider observes authoritative playback anchors, lyrics, metadata,
source, and lifecycle changes. It ignores the 10 Hz screen interpolation clock,
serializes native calls, and coalesces pending changes to the latest snapshot.
The timeline is transferred only when lyrics or track change, or on explicit
restart. Pause and seek corrections immediately re-anchor the native clock.
New tracks atomically clear old lyrics before they can be published.

Native scheduling wakes at line boundaries while iOS permits the host to run.
It sends updates only when content or its expiry changes, not per syllable or
frame. An existing activity is reused across songs and recovered after reload.
There is a 15-second end-of-song grace period for the next track to arrive, and
paused activities end after five minutes of available runtime. Disconnected
desktop feeds end their activity. Dismissed activities stay dismissed for that
song until **Restart live lyrics**, rather than immediately returning.

**A Live Activity does not grant background execution.** A native timer also
stops when iOS suspends the host. This implementation does not play silent audio
or add background modes to bypass that rule. Every playing state becomes stale
just after its next boundary; the widget then says to open KineSync to refresh.
An app actively permitted to play background audio may continue native updates,
but the existing Spotify WebView/remote playback source and device behavior need
device testing. Continuous lyrics during suspension would require a separately
provisioned APNs service and is not provided by this local sideloadable build.
The extension cannot fetch lyrics or run its own reliable per-line timeline.

The system decides whether a Live Activity appears in compact or minimal form
when other activities compete for the Island. An activity request succeeding
is not proof that iOS displayed its view. Check both the Island and Lock Screen.
Apple may also throttle updates; this is a line-level preview, not a guaranteed
frame-accurate karaoke renderer. ActivityKit's maximum active lifetime is eight
hours; a system-ended activity can be restarted in the foreground.

## Native generation and signing

Tracked sources live in `modules/kinesync-live-activity/ios`, `widgets`, and
`plugins/with-live-activity.js`, outside generated `ios`. The root `.gitignore`
explicitly includes this module's Swift files and podspec; its general `ios/`
rule would otherwise omit them from a clean checkout. Expo Autolinking links
the local module. The config plugin recreates the extension, copies the exact
widget implementation, enables `NSSupportsLiveActivities` in
the host, adds the host target dependency and `PlugIns` copy phase, and aligns
extension bundle ID and versions while keeping its Swift module distinct from
the Expo host pod. Both import `KineSyncActivityTypes`; the widget Podfile target
links this small pod without pulling React Native or Expo into the extension.
It also declares the extension to EAS for
credential provisioning if signed EAS builds are used. It is safe to rerun and
survives `expo prebuild --clean`.

No App Group, push notification entitlement, or shared-container setup is
required. This deliberately uses Expo's custom-native-module/CNG path instead
of `expo-widgets`, whose documented configuration uses an App Group. ActivityKit
itself passes the small content state between host and extension.

Both `.github/workflows/ios-unsigned-ipa.yml` and `ios-development-build.yml`:

1. Clean-prebuild the native project, run regression checks, and assert the
   module pod, extension sources, dependency, and embed phase exist.
2. Build the host scheme and dependent widget for `iphoneos` with signing
   disabled for all targets.
3. Copy the complete `.app` with `ditto`, preserving `PlugIns`, then zip Payload.
4. Validate the **actual IPA** before uploading: host flag, extension point,
   bundle IDs/versions, compiled native code, matching shared attributes modules,
   arm64 iOS device binaries, and
   byte-for-byte preservation of every extension file from the built `.app`.

Sideloadly can remove all or individual extensions. Keep **Remove Extensions**
disabled, or explicitly preserve **KineSyncLyricsWidget**. The signer must sign
both bundles and preserve their parent/child bundle ID relationship. The widget
uses an additional provisioning App ID. The workflow can verify the downloaded
IPA, but cannot control Sideloadly's subsequent settings or provisioning.

For an exported/re-signed IPA, inspect it before installing:

```sh
python3 ExpoLyrics/scripts/verify-ios-live-activity.py /path/to/KineSync.ipa
```

The app also checks for its embedded `.appex` and exposes missing-extension,
authorization, and ActivityKit request errors under **Settings > Live lyrics**.

## Verification

```sh
cd ExpoLyrics
npm run test:live-activity
python3 scripts/check-ios-live-activity.py
npx tsc --noEmit
# On macOS, after prebuild and CocoaPods installation:
node scripts/verify-live-activity-project.js
```

The JS suite uses the installed Expo SDK's real Xcode template to check target
generation and repeat runs, source/clock behavior, and module autolinking. IPA
regressions use synthetic binaries and test missing extensions, broken IDs,
version mismatch, absent flags, simulator binaries, missing type descriptors, and
the prior module identity mismatch. These checks do not
replace Xcode compilation or a physical-device rendering test.

Before releasing, test a freshly built, Sideloadly-installed IPA:

- Smaller Dynamic Island iPhone: start a karaoke song in the foreground, leave
  the app, check compact/minimal, then hold to expand. Verify filled mic,
  current line, title/artist/album, source and status. Repeat with line timing.
- Lock Screen: check long Unicode lyrics/metadata, absent album, an interlude,
  static/no lyrics, light/dark appearance and Always-On display.
- Seek backward/forward, pause/resume, change source, and advance to the next
  song. Confirm no old-song lyric flashes and no duplicate activity appears.
- Try actual background audio and desktop remote playback separately. Wait
  beyond a line boundary while suspended and confirm stale text replaces it.
- Disable Live Activities in iOS Settings, dismiss an activity, and use the
  restart control. Confirm clear status instead of silent retry loops.
- Export an IPA with the widget removed and run the verifier: it must fail.

## References

- [Expo: adding custom native code](https://docs.expo.dev/workflow/customizing/)
- [Expo: local module autolinking](https://docs.expo.dev/modules/autolinking/)
- [Expo: iOS app extensions and prebuild](https://docs.expo.dev/build-reference/app-extensions/)
- [Expo Widgets configuration](https://docs.expo.dev/versions/latest/sdk/widgets/)
- [Apple: Live Activity layout specifications](https://developer.apple.com/design/human-interface-guidelines/live-activities)
- [Apple: displaying live data, limits, lifecycle and stale content](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [Apple: updating ActivityContent and the 4 KB limit](https://developer.apple.com/documentation/activitykit/activity/update(_:))
- [Apple: foreground starts and background updates](https://developer.apple.com/documentation/activitykit/activity)
- [Sideloadly: Remove Extensions](https://sideloadly.io/index.html)
