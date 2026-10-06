# SDK 58 Live Activity experiment

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

References: [SDK 58 migration notes](https://expo.dev/changelog/sdk-58-beta),
[Xcode 27 runner](https://github.com/actions/runner-images/issues/14404),
[Sideloadly settings](https://sideloadly.io/).
