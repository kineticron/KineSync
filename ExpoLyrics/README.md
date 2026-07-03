# ExpoLyrics

React Native (Expo) mobile app for KineSync. Displays real-time synced lyrics streamed from the [KineSync Desktop Bridge](../DesktopBridge/).

## Features

- Real-time synced lyrics with word-by-word karaoke highlighting
- Album artwork display with animated transitions
- iOS Live Activities (Dynamic Island / Lock Screen)
- Landscape mode with split-pane layout
- Bridge connectivity over LAN, Tailscale, or ngrok relay
- Settings panel for bridge URL, handshake key, and playback tuning

## Tech Stack

- [Expo SDK 54](https://docs.expo.dev/)
- [React Native 0.81](https://reactnative.dev/)
- [Expo Router](https://docs.expo.dev/router/introduction/) (file-based routing)
- [React Native Reanimated 4](https://docs.reanimated.dev/)
- [Zustand](https://zustand.docs.pmnd.rs/) (state management)
- [Shopify FlashList](https://shopify.github.io/flash-list/)

## Quick Start

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
