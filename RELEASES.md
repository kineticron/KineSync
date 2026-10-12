# Release operations

Production workflows build Android, iOS, Windows, and Docker artifacts on pushes to `main`. Manual runs produce the artifacts described by each workflow. Development builds are for debugging and must not be used as release performance baselines.

## Versioning and release notes

Before publishing a new version:

1. Set the same three-part version in both component `package.json` files, their lockfiles (including root package entries), and `ExpoLyrics/app.json`.
2. Edit the GitHub release notes with the user-visible changes, limitations, and upgrade requirements. The platform publishers preserve the release title and notes.
3. Run `node scripts/release-version.js`, `node scripts/check-repository.cjs`, `node --test scripts/test/*.test.cjs`, and the relevant component checks in [CONTRIBUTING.md](CONTRIBUTING.md).
4. Merge the reviewed release commit to `main` and wait for the platform workflows.
5. Verify checksums and smoke-test installation, playback, pairing, and upgrades on the intended platforms.

Tags identify immutable source commits. The publisher refuses to move an existing `v<version>` tag or upload assets from a different commit under that version. Bump the version for a changed release. A retry from the same commit may replace that commit's build assets, so published binary digests should still be checked. Existing historical tags are not rewritten by this change.

Only the current `main` commit can publish. Parallel platform publishers share one versioned draft release. It becomes public when all required assets are present. A failed build leaves the release incomplete rather than publishing a partial download set. Release notes are maintained directly on the GitHub release.

## Release contents

| Artifact | Purpose |
| --- | --- |
| `KineSync-Android.apk` | Signed Android app |
| `KineSync-iOS-unsigned.ipa` | IPA to be re-signed by the user |
| `sidestore-source.json` | SideStore source |
| `KineSync-Desktop-Windows-Setup.exe` | Windows Desktop Bridge installer |
| `kinesync-docker-setup.zip` | Docker Desktop Bridge setup |
| Versioned native manifest and runtime files | Verified Windows source-installation support |
| Component license texts and third-party notices | Source licensing and renderer attribution accompanying downloads |

Checksums accompany the main downloads. GHCR publishes the Docker image with `latest`, version, and commit tags. Individual workflow artifacts retain build outputs according to GitHub's configured retention policy. Built releases must retain applicable license material and upstream notices.

The persistent downloads live under [the latest release](https://github.com/Kineticron/KineSync/releases/latest). Checksums verify integrity. They do not replace signature verification or establish compatibility with a device.

## Repository configuration

### Android signing

Configure these repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep an offline backup. Changing the certificate prevents an update from installing over an older app. Never commit keystores, certificates, or secret values. Manual Android development builds currently use the release identity/package to preserve test-device data. Install them only with that behavior understood.

### Windows signing

Signing is optional. When a certificate is available, configure both `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`. An unsigned installer can trigger SmartScreen warnings.

### iOS toolchain

The current SDK 58 workflows use the `xcode-27` preview runner and verify the iOS SDK. Review the runner/toolchain with each Expo upgrade. Unsigned CI packaging does not verify a user's provisioning profile or sideloaded device behavior.

### Container registry

Allow Actions to publish packages and keep `ghcr.io/kineticron/kinesync-desktop-bridge` public for anonymous setup. Review pinned build inputs and provenance as described in [DOCKER.md](DOCKER.md).

### GitHub quality and security settings

See [maintainer guidance](docs/maintaining.md) for pull-request checks, dependency updates, protected branches, private reporting, and the distinction between committed configuration and live GitHub settings.
