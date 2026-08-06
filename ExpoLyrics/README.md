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

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [React Native 0.86](https://reactnative.dev/)
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

## iOS Live Activity development

Live Activities use the SDK 57 `expo-widgets` runtime and do not run in Expo Go.
After changing the activity layout or app configuration, regenerate and rebuild the
iOS development client:

```bash
npx expo prebuild --clean --platform ios
npx expo run:ios
npm run verify:live-activity
```

The activity is created as playback metadata arrives, including in phone-only
Spotify mode. It has explicit Lock Screen, compact, minimal, and expanded Dynamic
Island layouts. Its content stays below ActivityKit's 4 KB payload limit, and it
uses SF Symbols instead of album artwork so network images cannot prevent the
system presentation from rendering.

References: [Expo Widgets for SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/widgets/),
[Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/), and
[Apple ActivityKit constraints](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities#Understand-constraints).

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
