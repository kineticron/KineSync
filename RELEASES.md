# Release operations

Every push to `main` builds one production version. All workflows publish to a
single normal GitHub Release named from `DesktopBridge/package.json`, such as
`v1.0.7`.

The release is never a prerelease. Its title is the version tag. The changelog
starts with the commit message as a placeholder. After every workflow finishes,
a maintainer can replace that line with the final changelog.

## Release contents

| Artifact | Purpose |
| --- | --- |
| `KineSync-Android.apk` | Signed Android app |
| `KineSync-iOS-unsigned.ipa` | Unsigned iOS app |
| `sidestore-source.json` | SideStore source |
| `KineSync-Desktop-Windows-Setup.exe` | Windows Desktop Bridge installer |
| `kinesync-docker-setup.zip` | Docker Desktop Bridge setup |
| Native runtime files | Windows source installation support |

Checksums are published beside the main downloads. The Docker image is also
published to GHCR with `latest`, version, and commit tags. Actions keeps the
individual workflow artifacts.

## Versioning

Before merging a release change to `main`:

1. Set the same three-part version in both `package.json` files, both
   `package-lock.json` files, and `ExpoLyrics/app.json`.
2. Run the local checks.
3. Merge to `main` and wait for the Android, iOS, Windows, and Docker workflows.
4. Open the `v*` release and replace the commit-message placeholder with the
   final changelog.
5. Test the Android app, iOS app, Windows installer, and Docker setup.

The release publisher handles parallel workflow uploads and ignores completed
builds from older `main` commits.

The release stays in draft until every required artifact and checksum is
present. The final upload publishes it and marks it as the latest release.

## Persistent download URLs

- Android APK: `https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-Android.apk`
- iOS IPA: `https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-iOS-unsigned.ipa`
- SideStore source: `https://github.com/Kineticron/KineSync/releases/latest/download/sidestore-source.json`
- Windows installer: `https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-Desktop-Windows-Setup.exe`
- Docker setup: `https://github.com/Kineticron/KineSync/releases/latest/download/kinesync-docker-setup.zip`

## Repository setup

### Android signing

Store the release keystore in these repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep an offline backup. Replacing the key prevents Android from installing an
update over an older build.

### Windows signing

Windows signing is optional. Set both secrets together when a certificate is
available:

- `WINDOWS_CERTIFICATE_PFX_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

Unsigned installers may show a Windows SmartScreen warning.

### Container registry

Allow GitHub Actions to publish packages. Keep
`ghcr.io/kineticron/kinesync-desktop-bridge` public so setup works without a
GitHub login.
