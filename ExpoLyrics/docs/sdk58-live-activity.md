# SDK 58 Live Activity experiment

Historical experiment notes: Live Activity checks and simulator previews have
since been removed from GitHub CI. The preview scripts remain available for
manual troubleshooting.

The `SDK-58-live-activity` branch uses Expo 58.0.5 and Expo's recommended
React Native 0.88 release candidate. The unsigned IPA workflow runs on
GitHub's `xcode-27` preview runner, checks the iOS SDK version, and captures
the real lyrics widget in a small native host on an iOS simulator. The
preview rejects an empty compact Island. Preview failure is reported separately
on this experiment branch so device IPA packaging can continue. This does not test device signing
or the full React Native app's playback on an iPhone.

The app checks active scenes before starting an activity and validates the
installed widget's identifier and extension point after sideloading. Host
and widget still import the same `KineSyncActivityTypes` static pod.

For Sideloadly, keep both extensions (`Dropping 0 of 2 plugins`). The host
identifier is `dev.kineticron.KineSync`; the lyrics extension must have the
same host prefix after signing. Enable File Sharing only exposes documents
and can remain enabled. A successful unsigned IPA check cannot validate
Sideloadly's provisioning profiles or signatures on the installed device.
Dismiss old blank activities, install this branch's IPA, open KineSync,
start playback, and restart live lyrics before testing compact/expanded and
Lock Screen presentations.

Two temporary beta compatibility settings remain: npm's `legacy-peer-deps`
allows Expo's recommended RN release candidate despite Reanimated's stable
peer range; TypeScript uses Expo's documented legacy RN type condition
while dependencies such as MaskedView still use removed `NativeMethods`
types. Revisit both with stable RN 0.88 / SDK 58.

## Build evidence

[Run 37396941306](https://github.com/kineticron/KineSync/actions/runs/37396941306)
compiled the SDK 58 device app at `303cb80` using the iOS 27 SDK. Build 59
contains both extensions with matching version numbers and the correct host
bundle ID prefix. The downloaded IPA passed the arm64 device, WidgetKit,
and shared attributes module verifier. SHA-256:
`900d8ba8db842807b139a48c55f920900c825e5fcadd4e09685faac7680e710e`.
TypeScript, the iOS JS export, app-source lint, Live Activity checks, and
launch, lyrics, and incoming-share regressions passed locally.

Rendering remains unverified: the iPhone 16 Pro / iOS 27 simulator screenshot
had no visible Island. Its preview step incorrectly reported success despite
all 24 content checks failing. Subsequent commits make the failure exit
explicit, preserve the exit status during cleanup, capture host request
status, and include ActivityKit system logs. These later changes affect the
CI fixture and reporting; the device app's native code is unchanged.
Sideloadly re-signing and physical-device rendering still require device testing.

References: [SDK 58 migration notes](https://expo.dev/changelog/sdk-58-beta),
[Xcode 27 runner](https://github.com/actions/runner-images/issues/14404),
[Sideloadly settings](https://sideloadly.io/).

## Static waiting presentation

The next device experiment starts an activity in the foreground even without
a detected song. Empty playback and disconnected desktop feeds now show
`KineSync`, `Ready for music`, and `Waiting for a song`, clearing old track
metadata and lyrics. Pauses and song completion keep the activity instead of
ending it after a timeout; waiting and paused states have no timer or stale
deadline. iOS still controls its maximum lifetime and user dismissal.

The compact and minimal Island have a constant `KS` text label independent
of playback data. Compact waiting content says `Ready`. Session `lyrics-v4`
retires earlier presentations; Restart also explicitly replaces the session.
The simulator fixture requests this same idle state with playback disabled.
These changes address the missing fallback but do not establish that a widget
will render after Sideloadly re-signing. Test before playback as well as during
a song, including the Lock Screen and expanded Island.

[Build 64](https://github.com/kineticron/KineSync/actions/runs/37547187265)
at `af1294e` tested the idle state on iPhone 16 Pro / iOS 27. The host screenshot
shows a successful ActivityKit request. System logs report one discovered
activity configuration and a successfully accepted 31,464-byte widget archive.
The compact screenshot still has no visible Island and fails the content
checker. This is not a confirmed rendering fix. The simulator evidence does
not establish why the physical device displays a blank, clickable Island.
