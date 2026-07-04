# Development Setup

## System Requirements

| Component | Requirement                                      |
| --------- | ------------------------------------------------ |
| OS        | Windows 10/11 (desktop bridge); any for Expo app |
| Node.js   | 20.x or later                                    |
| npm       | 10.x or later                                    |
| Expo      | Expo Go or a development build                   |

> **Compiling from source only** (most contributors can skip this):
>
> | Component     | Requirement                                                  |
> | ------------- | ------------------------------------------------------------ |
> | Visual Studio | 2022 with Desktop Development with C++ and Windows 10/11 SDK |
> | .NET SDK      | 9.0 or later                                                 |
> | Python        | 3.x on PATH                                                  |

## Step-by-Step Installation

### Desktop Bridge

```powershell
cd DesktopBridge
npm install
```

That's it. On Windows, `npm install` automatically downloads the prebuilt native binaries (`windows_media_session.node`, `spotify-seek-helper.dll`) from the GitHub release that matches the current version. No C++ or .NET toolchain required.

#### If the automatic download fails

The postinstall script logs a warning and exits cleanly — it never breaks `npm install`. This can happen if:

- There is no published GitHub release for the current version yet
- You are offline or behind a firewall

In that case, build from source instead (requires Visual Studio 2022 with C++ workload, .NET SDK 9, and Python 3):

```powershell
npm run build:native
```

Or build each piece separately:

```powershell
npm run build:native-media   # C++ media session detector
npm run build:seek-helper    # .NET Spotify seek helper
```

#### Verifying the binaries are in place

```powershell
Test-Path DesktopBridge\native\windows-media-session\build\Release\windows_media_session.node
# Should return True

Test-Path DesktopBridge\native\spotify-seek-helper\bin\Release\net9.0-windows10.0.19041.0\spotify-seek-helper.dll
# Should return True
```

#### Build troubleshooting (source builds only)

- **MSB8036 / Windows SDK not found**: Install or retarget the Windows SDK in Visual Studio Installer
- **node-gyp / Python errors**: Install Python 3 and ensure `python` works from terminal
- **binding.gyp missing**: The native source files must be present locally
- **Addon builds but crashes**: Electron and Node use different ABI versions — rebuild after upgrading Electron

### Expo App

```powershell
cd ExpoLyrics
npm install
```

No native build steps needed — Expo handles this automatically.

> **Contributors:** Before building, update `ExpoLyrics/app.json`:
> - Replace `"projectId": "YOUR_EAS_PROJECT_ID"` with your own EAS project ID (`eas init`)
> - Replace `dev.kineticron.KineSync` bundle identifiers with your own if needed

## Running Locally

### Direct LAN Mode

1. Start the desktop bridge:

   ```powershell
   cd DesktopBridge
   npm run start
   ```

2. Start the Expo app:

   ```powershell
   cd ExpoLyrics
   npx expo start -c --tunnel
   ```

3. In the Expo app, open **Bridge Settings** and enter:
   ```
   WebSocket URL: ws://<your-desktop-ip>:3001
   Handshake Key: <your-chosen-key>
   ```

### ngrok Relay Mode (Remote Access)

Open three terminals:

| Terminal       | Command                                       |
| -------------- | --------------------------------------------- |
| Relay          | `cd DesktopBridge && npm run relay:ngrok`     |
| Desktop Bridge | `cd DesktopBridge && npm run start`           |
| Expo           | `cd ExpoLyrics && npx expo start -c --tunnel` |

The relay terminal prints the public URL. In the Expo app:

```
WebSocket URL: wss://<ngrok-url>/bridge/<bridge-id>
Handshake Key: password123
```

In the desktop bridge UI, fill:

- **Bridge Key**: `<your-chosen-key>` (set the same key in both desktop and mobile)
- **Relay WebSocket URL**: `ws://127.0.0.1:8787`
- **Bridge ID**: any lowercase value (e.g., `my-pc`)

## Project Conventions

### Repository Structure

- `DesktopBridge/` — Electron desktop app
- `ExpoLyrics/` — Expo React Native mobile app
- Keep changes focused on one component at a time

### Desktop Bridge

- Main process: `src/index.js` (Electron main)
- Renderer: `src/index.html` (single-page UI)
- Lyrics service: `src/lyrics/` (VM-based modular loader with 16 part files)
- Native addons: `native/windows-media-session/` and `native/spotify-seek-helper/`

The lyrics service is loaded via a shared Node.js VM context (`src/lyrics/index.js`). All part files share the same context, so top-level `const`/`let`/`class` declarations become global — each name must be unique across all part files.

### Expo App

- Routing: Expo Router (file-based, `app/` directory)
- State: Zustand (`store/playback-store.ts`)
- Animation: React Native Reanimated 4
- Lists: Shopify FlashList

### Code Style

- JavaScript: No formal linter configured; keep consistent with existing style
- TypeScript: Strict mode with `tsc --noEmit` for type checking
- Indentation: 2 spaces
- Quotes: Double quotes (JS), single quotes (TS/TSX)

## Testing

### Desktop Bridge Syntax Check

```powershell
cd DesktopBridge
node --check src\index.js
node --check src\lyrics\index.js
```

### Expo Type Check

```powershell
cd ExpoLyrics
npx tsc --noEmit
```

## License

GNU General Public License v3.0 (GNU GPLv3)
