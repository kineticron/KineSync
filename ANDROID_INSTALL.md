# Install KineSync on Android

The latest signed Android APK is always available at:

<https://github.com/Kineticron/KineSync/releases/download/mobile-latest/KineSync-Android.apk>

Open that link on an Android device, allow the browser to install apps from
this source when prompted, and confirm the installation. Android may show a
warning because this APK is distributed outside Google Play.

For an integrity check, download the adjacent
`KineSync-Android.apk.sha256` file and compare its SHA-256 value with the APK.
The rolling `mobile-latest` release may also contain the latest iOS assets.

## CI signing (maintainers)

The Android workflow signs every build with one persistent release keystore so
updates install over the previous APK. Configure these repository secrets:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded `.jks`/`.keystore` file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep a secure offline backup of the keystore. Replacing it later changes the
Android signing identity and requires users to uninstall the old app first.

## Desktop Bridge

The mobile app connects to the Desktop Bridge over the local network. Follow
the repository's [Desktop Bridge setup guide](SETUP.md) before opening the app
and make sure the phone and computer are on the same network.
