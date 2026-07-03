# KineSync

A modern, beautiful mobile app for rendering syllable-synced lyrics synced with your Spotify playback using your own self-hosted Desktop Bridge. Built natively for lyrics from [Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics), a Spicetify extension.
- ✅ 100% free & open-source
- ✅ App on Expo, sideloadable and built for iOS and Android
- ✅ Bridge on Electron, uses native windows media session markers
- ✅ No Spotify API or Premium required

## Project Layout

```
├── DesktopBridge/         Electron desktop companion
│   ├── src/
│   │   ├── index.js       Main process entry point
│   │   ├── index.html     Renderer UI
│   │   ├── lyrics/        Lyrics service (VM-based modular loader)
│   │   ├── lyricsService.js   Compatibility facade
│   │   ├── bridgeServer.js    Local WebSocket server
│   │   ├── bridgeRelayClient.js   Relay client
│   │   ├── spotifyDetector.js     Windows GSMTC media detection
│   │   ├── playbackController.js  Seek and playback management
│   │   └── artworkResolver.js     Deezer/iTunes album art
│   ├── native/            Windows native addons
│   │   ├── windows-media-session/  C++ GSMTC watcher (node-gyp)
│   │   └── spotify-seek-helper/    .NET seek helper
│   └── scripts/           Utility scripts
├── ExpoLyrics/            Expo React Native mobile app
│   ├── app/               File-based routes (Expo Router)
│   ├── components/        UI components
│   ├── lib/               Business logic
│   ├── store/             Zustand state management
│   └── providers/         React context providers
└── README.md
```

## Features

- **Real-time synced lyrics** — Line-by-line and word-by-word (karaoke) timing
- **Multi-source lyrics** — Musixmatch, QQ Music, Netease, Kugou, Spicy Lyrics, LRCLib, local vault
- **Album artwork** — Deezer + Apple iTunes Search (no API keys needed)
- **AI translation** — Optional Gemini translation of lyrics
- **Remote relay** — ngrok-based public relay for listening outside your home network
- **Lyrics vault** — Export and archive lyrics locally (TTML format)
- **Live Activities** — iOS Dynamic Island / Lock Screen lyrics display (currently broken)
- **Animated reveals** — Smooth karaoke-style word highlighting with sustain effects

## Prerequisites

- **Windows** for the Desktop Bridge (media session, seek helper)
- **Node.js 20+** and npm
- **Visual Studio 2022** (or Build Tools) with Desktop Development with C++ workload and Windows 10/11 SDK
- **Python 3.x** on PATH (for node-gyp)
- **.NET SDK 9+** (for spotify-seek-helper)
- **Expo Go** or a development build on your phone
- **ngrok CLI** (optional, for remote relay)

_Recommended Prerequisites:_

- **Spicetify** for the Desktop Bridge + **Adblockify** + **Spicy Lyrics**
- **EeveeSpotifyReincarnated**
- **iOS & Android** latest version

## Quick Start

### 1. Install dependencies

```powershell
cd DesktopBridge
npm install
npm run build:native-media
npm run build:seek-helper

cd ..\ExpoLyrics
npm install
```

### 2. Start the desktop bridge

```powershell
cd DesktopBridge
npm run start
```

### 3. Start the Expo app

```powershell
cd ExpoLyrics
npx expo start -c --tunnel
```

Scan the QR code with Expo Go on your phone. Enter your desktop's LAN IP in the app's bridge settings (e.g., `ws://192.168.1.100:3001`).

## Remote Access (ngrok)

For listening outside your home network, use the relay:

| Terminal       | Directory        | Command                      |
| -------------- | ---------------- | ---------------------------- |
| Relay          | `DesktopBridge/` | `npm run relay:ngrok`        |
| Desktop Bridge | `DesktopBridge/` | `npm run start`              |
| Expo           | `ExpoLyrics/`    | `npx expo start -c --tunnel` |

The relay terminal prints the public WebSocket URL. Enter it in the Expo app's bridge settings.

## Lyrics Sources

The desktop bridge fetches lyrics from multiple sources. Configure in the bridge UI:

- **Spotify sign-in** — Required for Spicy Lyrics compatibility
- **Musixmatch user token** — For synced/rich lyrics (extract from browser dev tools)
- **Gemini API key** — For AI translation (get from [Google AI Studio](https://ai.google.dev/gemini-api/docs/api-key))

More configured sources = better coverage. Sources gracefully fall back when unavailable.

## Useful Commands

```powershell
# Desktop bridge
cd DesktopBridge
npm run start                    # Run desktop bridge
npm run relay                    # Local relay only
npm run relay:ngrok              # Relay through ngrok
npm run build:native-media       # Rebuild Windows media detector
npm run build:seek-helper        # Rebuild .NET seek helper
npm run diagnose:seek            # Diagnose seek issues
npm run check:lyrics-sources     # Check lyrics source health

# Expo app
cd ExpoLyrics
npx expo start -c --tunnel       # Start Expo with tunnel
npx tsc --noEmit                 # Type-check

# Syntax check
cd DesktopBridge
node --check src\index.js
```

## Architecture

```
Spotify (Windows) ──► GSMTC Watcher (C++) ──► Desktop Bridge (Electron)
                                                     │
                        ┌────────────────────────────┤
                        │              ┌─────────────┤
                   Lyrics Sources     Relay (ngrok)   │
                   (Musixmatch, QQ,    │              │
                    Netease, etc.)      │              │
                        │              │     Local WebSocket
                        ▼              ▼         :3001
                   Lyrics Engine ◄─────┘         │
                        │                        │
                        ▼                        ▼
                   Mobile App ◄────── WebSocket ─┘
                   (Expo/React Native)
```

The desktop bridge uses a shared Node.js VM context to load the lyrics service from 16 modular part files, preserving execution order from the original monolithic implementation.

## License

GNU GPL v3.0 — see [LICENSE](LICENSE) for details.
