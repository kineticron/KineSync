# Playback Live Activity on iOS

KineSync uses a local Expo module to publish an ActivityKit activity and a
SwiftUI WidgetKit extension to render it. Start playback in the foreground,
then leave the app to see the compact Dynamic Island. Hold the Island to expand.
The Lock Screen also shows playback details on devices without Dynamic Island.

The current presentation shows album art, KineSync branding, song/artist/album,
source, and status. Compact mode shows artwork and a playback icon; minimal mode
shows `KS`. Lyrics and instrumental-break subtitles are no longer displayed.
The historical lyric-rendering investigation below describes earlier builds.

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
[Run 37354859460](https://github.com/kineticron/KineSync/actions/runs/37354859460)
compiled the actual widget with its shared CocoaPods dependency. Its captured
compact Island shows both the microphone and lyric text; the widget log reports
`KineSyncActivityTypes.LyricsActivityAttributes`. This restores the content that
was absent from run 34756296771. Cold simulator startup consumed most of the
preview timeout and the job timed out immediately after capturing its artifacts;
the limit is now twenty minutes. Production device IPA compilation and integrity
checks remain required. Physical-device confirmation on iOS 27 is still needed.

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

The expanded Island and Lock Screen show song, artist, album, source, status,
and the KineSync name. The expanded Island insets its details horizontally by
14 pt and reserves 10 pt below them to keep text clear of its rounded corners.
Compact mode shows a 24 pt album thumbnail and playback icon; minimal mode shows
`KS`. Missing artwork uses the existing microphone fallback. The Lock Screen
layout is 110 pt high including padding, below the 160 pt system maximum.

ActivityKit content has a 4 KB limit. The native publisher checks the actual
Swift-encoded JSON and reduces text until it fits 2,800 bytes, leaving room for
immutable attributes and encoding overhead. The host loads HTTP(S) or data-URI
artwork and uses ImageIO to downsample it to at most 48 px. JPEG compression is
bounded to 900 bytes before base64 encoding and included in the same content
budget. The extension decodes the thumbnail without network access or an App
Group. Changing tracks immediately clears the previous cover.

## Lifecycle

The root provider observes track metadata, artwork, playback state, source,
status, and lifecycle changes. Playback position ticks and clock corrections
no longer trigger native updates. No lyric timeline is transferred, and no
line-boundary timers or stale lyric deadlines run in the host.

An existing activity is reused across songs and recovered after reload.
Dismissed activities stay dismissed for that song until **Restart Live Activity**.
Old lyric sessions are retired when syncing the `metadata-v1` presentation.

The activity keeps its last supplied playback details when iOS suspends the
app. New tracks, pauses, or source changes still require host execution to reach
it; removing lyrics does not add background execution. The current build uses
no APNs service. SideStore with a free Apple account cannot provision the push
notification entitlement needed for remote ActivityKit updates. The activity
no longer replaces content with an "Open KineSync to refresh" lyric prompt.

The system decides whether the Island shows compact or minimal form when other
activities compete. ActivityKit can throttle updates and end the activity;
restart it in the foreground when needed.

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
authorization, and ActivityKit request errors under **Settings > Live Activity**.

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

Before releasing, test a freshly built SideStore/Sideloadly-installed IPA:

- Check artwork and the playback icon in compact mode, `KS` in minimal mode,
  and KineSync, track details, source, and status in the expanded Island.
- Verify lyrics, instrumental-break labels, and lyric refresh prompts are absent
  in all presentations. Keep ordinary player lyrics working in the app.
- Check long Unicode metadata, missing album/artwork, and Lock Screen layout.
- Pause/resume, change source, change artwork, and advance to the next song.
  Confirm no previous-song cover flashes or duplicate activities appear.
- Leave the app and confirm the last supplied details remain visible.
- Disable Live Activities, dismiss the activity, and use **Restart Live Activity**.
- Export an IPA with the widget removed; the verifier must reject it.

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
