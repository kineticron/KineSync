# ExpoLyrics

React Native (Expo) mobile app for KineSync. Displays real-time synced lyrics streamed from the [KineSync Desktop Bridge](../DesktopBridge/).

## Features

- Real-time synced lyrics with word-by-word karaoke highlighting
- Album artwork display with animated transitions
- Landscape mode with split-pane layout
- Bridge connectivity over LAN, Tailscale, or ngrok relay
- Settings panel for bridge URL, handshake key, and playback tuning

## Tech Stack

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [React Native 0.86](https://reactnative.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/) (file-based routing)
- [React Native Reanimated 4](https://docs.reanimated.dev/)
- [Zustand](https://zustand.docs.pmnd.rs/) (state management)
- [Shopify FlashList](https://shopify.github.io/flash-list/)

## Quick Start

For a prebuilt iPhone/iPad app, use the repository's
[latest unsigned IPA](https://github.com/Kineticron/KineSync/releases/download/ios-latest/KineSync-iOS-unsigned.ipa)
with SideStore or Sideloadly. See the
[iOS installation guide](../IOS_INSTALL.md) for the one-tap SideStore source,
refresh requirements, and troubleshooting.

To run from source:

```bash
npm install
npx expo start -c --tunnel
```

Scan the QR code with Expo Go. Open settings to configure your bridge URL.

## Project Structure

```
app/                  File-based routes (Expo Router)
  (tabs)/             Tab navigator screens
  _layout.tsx         Root layout
components/
  lyrics/             Lyrics display components
  onboarding/         First-launch onboarding
  ui/                 Shared UI primitives
lib/                  Business logic (bridge, timing, artwork)
store/                Zustand stores
providers/            React context providers
hooks/                Custom hooks
constants/            Theme and layout constants
types/                TypeScript type definitions
```

## Development

```bash
npx tsc --noEmit     # Type check
npx expo lint        # Lint
```

## License

GNU General Public License v3.0 (GNU GPLv3)
