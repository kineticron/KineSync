# Release operations

KineSync uses three intentionally separate channels. End-user assets have fixed
filenames so documentation and bookmarks remain valid across updates.

| Channel | Trigger | Contents | Stable location |
| --- | --- | --- | --- |
| Stable Desktop Bridge | Push `v<DesktopBridge version>` | Windows installer and verified npm native runtime | GitHub's latest stable release |
| Mobile latest | Push `main` | Signed Android APK, unsigned iOS IPA, checksums, SideStore source | `mobile-latest` prerelease |
| Docker latest | Relevant push to `main` | Prebuilt GHCR image and setup bundle | `desktop-latest` prerelease |

GitHub Actions artifacts retain the individual main-branch builds. Rolling
channels therefore do not create a GitHub Release for every commit.

## One-time repository configuration

### Android signing

Create one long-lived Android release keystore and store these repository
secrets:

- `ANDROID_KEYSTORE_BASE64`: the complete keystore encoded as base64
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Back up the keystore and passwords outside GitHub. Android will not install a
new APK over an old one when their signing identities differ, so losing or
rotating this key requires users to uninstall before reinstalling.

The Android workflow increments `versionCode` from its Actions run number,
builds locally on the GitHub runner, verifies the APK signature, and only then
updates the fixed assets on `mobile-latest`.

### Container registry

Actions must have permission to publish packages. After the first successful
Docker workflow run, confirm that
`ghcr.io/kineticron/kinesync-desktop-bridge` is public so users can pull it
without a GitHub login. The Docker build publishes provenance and an SBOM.

### Optional Windows code signing

The Windows installer can be built without a signing certificate, though
Windows SmartScreen may warn users. When a code-signing certificate is
available, configure `WINDOWS_CERTIFICATE_PFX_BASE64` and
`WINDOWS_CERTIFICATE_PASSWORD`. The workflow rejects a partial signing
configuration rather than silently producing a differently signed package.

## Creating a stable Desktop Bridge release

1. Update `DesktopBridge/package.json` and `DesktopBridge/package-lock.json` to
   the same semantic version.
2. Run the DesktopBridge tests and package checks locally.
3. Merge the version change to `main`.
4. Create and push the exact matching tag, such as `v1.0.7`.
5. Wait for both the Windows and Docker workflows to succeed.
6. Verify that the `v*` release contains the installer, its checksum, all five
   native runtime files, and `native-assets-v<version>.json`.
7. Test a clean Windows installer run and a clean `npm install` before
   announcing the release.

The Windows workflow rejects a version tag that does not exactly match
`DesktopBridge/package.json`; this prevents npm postinstall from looking for a
release that cannot exist.

## Stable download URLs

- Android APK: `https://github.com/Kineticron/KineSync/releases/download/mobile-latest/KineSync-Android.apk`
- iOS IPA: `https://github.com/Kineticron/KineSync/releases/download/mobile-latest/KineSync-iOS-unsigned.ipa`
- SideStore source: `https://github.com/Kineticron/KineSync/releases/download/mobile-latest/sidestore-source.json`
- Windows installer: `https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-Desktop-Windows-Setup.exe`
- Docker setup: `https://github.com/Kineticron/KineSync/releases/download/desktop-latest/kinesync-docker-setup.zip`

The older `ios-latest` assets remain updated as a compatibility alias for
existing bookmarks and SideStore installations. New documentation and metadata
use the combined `mobile-latest` channel.

After the first successful combined mobile run is verified, maintainers may
remove historical `ios-main-<commit>` releases and tags if they no longer need
them; Actions retains the build history. Keep `ios-latest`, because existing
SideStore users may still have that source URL saved.
