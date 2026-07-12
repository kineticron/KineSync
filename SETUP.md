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

#### Optional: bundle San Francisco Pro fonts

The lyrics renderer works out of the box using each platform's native San
Francisco / Roboto. Bundle SF Pro only if you want pixel-identical lyrics across
iOS **and** Android.

```powershell
cd ExpoLyrics\assets\fonts
$base = "https://raw.githubusercontent.com/sahibjotsaggu/San-Francisco-Pro-Fonts/master"
curl.exe -fLO "$base/SF-Pro-Display-Regular.otf"
curl.exe -fLO "$base/SF-Pro-Display-Bold.otf"
```

> If curl fails with `CRYPT_E_NO_REVOCATION_CHECK` (schannel can't reach the cert
> revocation server behind a firewall/VPN), add `--ssl-no-revoke`, e.g.
> `curl.exe --ssl-no-revoke -fLO "$base/SF-Pro-Display-Bold.otf"`. Or use
> `Invoke-WebRequest "$base/SF-Pro-Display-Bold.otf" -OutFile SF-Pro-Display-Bold.otf`.

Then enable it:

1. Uncomment the `require(...)` block in `ExpoLyrics/assets/fonts/sf-pro-sources.ts`
2. Set `SF_PRO_ENABLED = true` in `ExpoLyrics/constants/lyrics-typography.ts`
3. Rebuild the native app (`npx expo run:ios` / `run:android`) — font assets are
   not picked up by a JS-only reload.

Lyrics use weight 700, so Regular + Bold is enough. See
`ExpoLyrics/assets/fonts/README.md` for details.

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

Use this when your phone is not on the same Wi-Fi network as your desktop (e.g. using mobile data, or connecting from elsewhere).

#### 1. Get a free ngrok static domain

1. Sign up at [ngrok.com](https://ngrok.com) (free tier is enough)
2. In the ngrok dashboard, go to **Cloud Edge → Domains** and copy your static domain — it looks like `your-subdomain.ngrok-free.app`
3. [Download and install the ngrok CLI](https://ngrok.com/download), then authenticate it:

   ```powershell
   ngrok config add-authtoken <your-auth-token>
   ```

   Your auth token is on the ngrok dashboard under **Your Authtoken**.

#### 2. Configure the Desktop Bridge

Copy `.env.example` to `.env` in the `DesktopBridge/` directory and fill in:

```env
NGROK_URL=your-subdomain.ngrok-free.app
BRIDGE_RELAY_ID=my-pc          # anything lowercase, appears in the relay URL path
BRIDGE_RELAY_PORT=8787          # leave as-is unless port 8787 is taken
```

#### 3. Start everything

Open three terminals:

| Terminal | Directory | Command |
| -------- | --------- | ------- |
| 1 — Relay | `DesktopBridge/` | `npm run relay:ngrok` |
| 2 — Desktop Bridge | `DesktopBridge/` | `npm run start` |
| 3 — Expo | `ExpoLyrics/` | `npx expo start -c --tunnel` |

Start terminal 1 first and wait until it prints something like:

```
[bridge-relay] ngrok tunnel ready
[bridge-relay] Desktop Relay WebSocket URL: ws://127.0.0.1:8787
[bridge-relay] Public Relay WebSocket URL:  wss://your-subdomain.ngrok-free.app
[bridge-relay] Expo WebSocket URL:          wss://your-subdomain.ngrok-free.app/bridge/my-pc
```

#### 4. Connect the Desktop Bridge to the relay

In the Desktop Bridge UI, set:

| Field | Value |
| ----- | ----- |
| **Bridge Key** | any password you choose (must match what you enter in the app) |
| **Relay WebSocket URL** | `ws://127.0.0.1:8787` |
| **Bridge ID** | the same value you set for `BRIDGE_RELAY_ID` (e.g. `my-pc`) |

#### 5. Connect the Expo app

In the app's **Bridge Settings**, set:

| Field | Value |
| ----- | ----- |
| **WebSocket URL** | `wss://your-subdomain.ngrok-free.app/bridge/my-pc` |
| **Handshake Key** | the same bridge key you set above |

This is the **Expo WebSocket URL** printed by terminal 1.

#### Troubleshooting

- **`ERROR: Set NGROK_URL in your .env`** — `.env` is missing or `NGROK_URL` is empty
- **ngrok exits immediately** — auth token not set; run `ngrok config add-authtoken <token>`
- **App connects but no playback** — Desktop Bridge must also be running (terminal 2); check the bridge key matches on both sides
- **Port 8787 already in use** — change `BRIDGE_RELAY_PORT` in `.env` and update the Desktop Bridge's Relay WebSocket URL to match

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
