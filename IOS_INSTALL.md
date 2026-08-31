# Install KineSync on iPhone or iPad

KineSync is distributed as an unsigned IPA for iOS 16.4 or newer. You can sign
and install it with SideStore, Sideloadly, or another IPA signer. No paid Apple
Developer membership is required.

## SideStore: easiest ongoing installation

Before starting, complete the official
[SideStore installation](https://docs.sidestore.io/docs/installation/install).
SideStore requires a computer for its initial setup, then can install and
refresh apps directly on the device.

1. On your device, connect Wi-Fi and turn on LocalDevVPN.
2. Tap **[Add the KineSync source to SideStore](sidestore://source?url=https%3A%2F%2Fgithub.com%2FKineticron%2FKineSync%2Freleases%2Fdownload%2Fios-latest%2Fsidestore-source.json)**.
3. If the link does not open, copy this source URL and add it from SideStore's
   Sources screen:

   `https://github.com/Kineticron/KineSync/releases/download/ios-latest/sidestore-source.json`

4. Find KineSync in the new source and tap **Install**.
5. Open KineSync, allow Local Network access, and enter the WebSocket URL and
   key shown by your Desktop Bridge.

You can instead download the
[latest KineSync IPA](https://github.com/Kineticron/KineSync/releases/download/ios-latest/KineSync-iOS-unsigned.ipa),
open the file from the Files app, and share it to SideStore. If SideStore is
already installed, you can also
[install the latest IPA directly](sidestore://install?url=https%3A%2F%2Fgithub.com%2FKineticron%2FKineSync%2Freleases%2Fdownload%2Fios-latest%2FKineSync-iOS-unsigned.ipa).

With a free Apple Account, SideStore must refresh the app within seven days.
Keep SideStore available in the background and periodically open it with
LocalDevVPN connected. SideStore itself counts toward Apple's three-active-app
limit, and KineSync's Live Activity extension may use an additional App ID.

## Sideloadly

1. Install [Sideloadly](https://sideloadly.io/) on Windows or macOS.
2. Download
   [KineSync-iOS-unsigned.ipa](https://github.com/Kineticron/KineSync/releases/download/ios-latest/KineSync-iOS-unsigned.ipa)
   to the computer.
3. Connect and trust the iPhone or iPad, then drag the IPA into Sideloadly.
4. Select the device, enter the Apple Account used for sideloading, and click
   **Start**. Leave the Live Activity extension enabled if you want Lock Screen
   and Dynamic Island lyrics.
5. On iOS 16 or newer, enable **Settings > Privacy & Security > Developer Mode**
   if prompted. Trust the developer profile under
   **Settings > General > VPN & Device Management**.
6. Open KineSync, allow Local Network access, and configure the Desktop Bridge.

Free Apple Account signatures last seven days. Sideloadly can automatically
refresh the app when its daemon can reach the device over USB or Wi-Fi.

## Verify the download

The rolling iOS release includes `KineSync-iOS-unsigned.sha256`. Compare it with
the IPA before signing if you want to verify that the download is intact. The
release name and notes identify the exact `main` commit used for the build.

## Connection troubleshooting

- The phone and Desktop Bridge must be able to reach each other. For local use,
  they should normally be on the same network.
- Use the bridge address shown by the desktop app, typically
  `ws://<computer-LAN-IP>:3001`; do not use `localhost` on the phone.
- Confirm that KineSync is allowed under **Settings > Privacy & Security > Local
  Network**.
- For remote access, use the bridge's secure `wss://` relay URL.
