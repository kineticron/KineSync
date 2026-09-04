# Install KineSync on Android

The latest signed Android APK is always available at:

<https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-Android.apk>

Open that link on an Android device, allow the browser to install apps from
this source when prompted, and confirm the installation. Android may show a
warning because this APK is distributed outside Google Play.

## Choose a playback setup

Setup choices are listed from easiest to most advanced:

1. **Mobile-Only (recommended):** Open KineSync, choose **Use this phone only**
   during onboarding, and sign in to Spotify with an email address and
   password. No computer or Desktop Bridge is required. Google and Apple
   sign-in are not available in the embedded browser.
2. **Windows Desktop Bridge (optional):** Install the
   [latest Windows `.exe`](https://github.com/Kineticron/KineSync/releases/latest/download/KineSync-Desktop-Windows-Setup.exe),
   open it, and scan the pairing QR code in KineSync.
3. **Docker Desktop Bridge (optional):** Follow the
   [one-command Docker setup](DOCKER.md#one-command-install), then scan the
   pairing QR code.
4. **From source (advanced):** Follow the
   [source setup](SETUP.md#method-4-run-from-source-advanced).

For an integrity check, download the adjacent
`KineSync-Android.apk.sha256` file and compare its SHA-256 value with the APK.
The same release also contains the latest iOS, Windows, and Docker assets.

## CI signing (maintainers)

The Android workflow signs every build with one persistent release keystore so
updates install over the previous APK. Configure these repository secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded `.jks`/`.keystore` file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep a secure offline backup of the keystore. Replacing it later changes the
Android signing identity and requires users to uninstall the old app first.

## Optional Desktop Bridge connection

For a local bridge connection, keep the phone and computer on the same network.
See the [complete setup guide](SETUP.md) for manual pairing and remote access.
