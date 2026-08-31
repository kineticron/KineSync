# Instant Docker setup

This is the fastest way to get KineSync running. One self-contained image
includes Spotify for Linux, DesktopBridge, Spicetify Marketplace, Adblockify,
an embedded ngrok client, and a browser-accessible desktop. Spotify and
DesktopBridge share one D-Bus session, so playback detection and controls work
through Linux MPRIS without Spotify Premium.

## What you need

- An `amd64` host with Docker and Docker Compose.
- A Spotify account. Use the same account on the container and playback devices.
- ExpoLyrics installed or running on your phone.
- For local mode, the phone and Docker host on the same LAN.
- Optional remote mode: an ngrok account, authtoken, and reserved domain.

The image does not need privileged mode, host D-Bus access, a Docker socket
mount, Spotify Web API playback access, or a Premium subscription.

## Image provenance and sandboxing

The Compose service enables `no-new-privileges`, keeps Docker's default seccomp
profile, drops the unnecessary `NET_RAW` capability, and runs Spotify and
Electron as the unprivileged `abc` user. Chromium's own namespace/setuid
sandbox is not compatible with that Docker boundary, so only the container
launchers use `--no-sandbox`; native desktop builds keep Chromium sandboxing.
Do not grant the container `SYS_ADMIN` or use an unconfined seccomp profile to
force Chromium's inner sandbox on—the broader container escape surface is a
worse tradeoff for this local image.
The two base images are pinned to their registry-provided immutable digests. If
a base image is changed, inspect the exact multi-architecture digest from a
trusted registry before updating `DesktopBridge/Dockerfile`:

```bash
docker buildx imagetools inspect node:22-bookworm-slim
docker buildx imagetools inspect ghcr.io/linuxserver/baseimage-kasmvnc:ubuntunoble
```

Record the selected platform digest in the Dockerfile (`image:tag@sha256:...`)
and review it with the image release notes; never invent a digest.

## Ports and persistent data

| Port/path | Purpose |
| --- | --- |
| `3000` | Browser desktop over HTTP; local host binding by default |
| `3443` | Browser desktop over HTTPS; local host binding by default |
| `3001` | ExpoLyrics WebSocket bridge; LAN binding by default; not a webpage |
| `/config` | Spotify login, DesktopBridge settings, certificates, and logs |

The Compose file binds the browser desktop to `127.0.0.1` by default while
leaving only the WebSocket bridge (`3001`) reachable from the LAN. To open the
desktop from another trusted machine, set `KINESYNC_WEB_BIND_ADDRESS` (for
example, to the Docker host's LAN address) in `.env`; do not expose it directly
to the public internet. The web password is not a public deployment security
boundary.

## Quick start

Run these commands from the repository root.

### 1. Create your secure configuration

PowerShell:

```powershell
./scripts/setup-docker.ps1
```

Linux/macOS shell:

```bash
sh ./scripts/setup-docker.sh
```

The setup helper creates `.env` once with separate cryptographically random
bridge and web passwords; it never overwrites an existing file. Most users can
start the container immediately. Open `.env` only if you want to change the
timezone, bind addresses, username, or config path:

```dotenv
BRIDGE_KEY=<generated automatically>
KINESYNC_WEB_USER=kinesync
KINESYNC_WEB_PASSWORD=<generated automatically>
KINESYNC_CONFIG_PATH=./.kinesync-config
KINESYNC_WEB_BIND_ADDRESS=127.0.0.1
# Keep 0.0.0.0 for simple phone-to-host LAN bridging, or use a host LAN IP.
KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0
PUID=568
PGID=568
TZ=America/New_York
```

- `BRIDGE_KEY` must exactly match the handshake key entered in ExpoLyrics; the
  desktop pairing QR fills it in automatically.
- `KINESYNC_WEB_PASSWORD` opens the browser desktop.
- Keep `.env` private. It is ignored by Git.
- Change `TZ` to your IANA timezone if necessary.
- On a Linux host, set `PUID` and `PGID` to the output of `id -u` and `id -g`
  if that user should own the local config files. Docker Desktop users can keep
  the example values.

### 2. Build and start

```bash
docker compose up -d --build
docker compose ps
```

Wait until `kinesync` reports `healthy`. The first build can take several
minutes because it downloads a pinned Spotify package and installs the runtime.

### 3. Open the container desktop

Open `http://localhost:<KINESYNC_WEB_PORT>` on the Docker host (port `3000`
by default). If you configured
`KINESYNC_WEB_BIND_ADDRESS` for LAN access, use the corresponding host address
instead. Sign in with `KINESYNC_WEB_USER` and `KINESYNC_WEB_PASSWORD` from
`.env`.

Opening `http://localhost:3001` displays **Upgrade Required**. That is expected:
port `3001` accepts WebSocket upgrades and does not host a webpage.

### 4. Sign into Spotify

1. Select the Spotify window in the browser desktop.
2. Use its QR code, or click **Log in**. Login links open in the bundled
   KineSync Login Browser inside the same desktop.
3. Use the same account as your phone, laptop, and other Spotify devices.
4. Leave the containerized Spotify client running.

The `/config` volume persists this login across restarts and image updates.
Spicetify, Marketplace, and Adblockify are already installed and applied in the
image, so they are active on the first Spotify launch with no additional setup.

### 5. Confirm playback detection

1. Start a track on any Spotify instance logged into the same account.
2. Confirm containerized Spotify mirrors the track and playback state.
3. Confirm DesktopBridge shows the track with source `linux-mpris`.

The container does not inspect another machine. Spotify synchronizes account
state into its containerized client, and DesktopBridge observes that local
client through MPRIS.

### 6. Connect ExpoLyrics on the LAN

Find the Docker host's LAN IP. Examples:

```powershell
ipconfig
```

```bash
hostname -I
```

In ExpoLyrics, open **Bridge Settings** and enter:

```text
WebSocket URL: ws://<docker-host-LAN-IP>:3001
Handshake key: the BRIDGE_KEY value from .env
```

For example: `ws://192.168.1.50:3001`.

Do not enter `localhost` on a phone: there, `localhost` means the phone itself.
Save the settings and wait for the connected status.

### 7. Verify the setup

Verify all of the following before considering setup complete:

- Track title, artist, artwork, position, and lyrics appear in ExpoLyrics.
- Pause and resume work in both directions.
- Seeking changes the real Spotify position.
- Next and previous work.
- Playback started on a different Spotify device still appears.
- `docker compose restart` preserves the Spotify login and reconnects the app.

## Optional remote access with ngrok

Use this when the phone connects away from the home LAN. Ngrok is embedded in
DesktopBridge; Docker users do not install a CLI or run extra terminals.

1. Create an ngrok account.
2. Copy the authtoken from the ngrok dashboard.
3. Reserve or copy a static domain such as `example.ngrok-free.app`.
4. In DesktopBridge's **Relay** page, enter:
   - the same Bridge Key used by ExpoLyrics;
   - the ngrok domain, with or without `https://`;
   - the ngrok authtoken.
5. Click **Save relay**.
   KineSync stops its existing listener and agent session before starting the
   saved endpoint. If ngrok is still releasing the domain, KineSync retries it
   automatically.
6. Wait for **Remote relay: connected via ngrok**.
7. Copy the displayed Mobile URL or scan its QR code.
8. Use that `wss://.../bridge/<bridge-id>` URL and the same handshake key in
   ExpoLyrics.

Only one running endpoint can own a reserved free domain. Stop any older
KineSync/ngrok instance if ngrok reports `ERR_NGROK_334`.
Use the **Agent Authtoken** from ngrok's authtoken page, not an API key;
`ERR_NGROK_105` means the saved value is not a valid authtoken.
`ERR_NGROK_108` means the account has too many active agent sessions; stop
stale agents at <https://dashboard.ngrok.com/agents> and save again.

## Routine operations

```bash
# Status
docker compose ps

# Follow service output
docker compose logs -f kinesync

# Restart without losing settings
docker compose restart

# Stop
docker compose down

# Rebuild after pulling source changes
docker compose up -d --build
```

Application logs persist in:

```text
/config/log/spotify.log
/config/log/desktop-bridge.log
```

With the default local volume, they are under `.kinesync-config/log/` on the
host. Back up `/config` to preserve login and settings.

## Troubleshooting

### Antivirus or HTTPS scanning blocks a connection

Some antivirus products intercept encrypted network calls. If Spotify reports
`accounts:4` or **No internet connection**, or ngrok reports a TLS handshake
error, add the affected endpoint to the product's HTTPS/web-scanning exception
list and restart the container:

- Spotify login: <https://accounts.spotify.com>
- ngrok agent: <https://connect.ngrok-agent.com>

Add only the affected endpoint; do not disable network protection globally.

### ExpoLyrics cannot connect

- Use `ws://<host-LAN-IP>:3001`, not an HTTP URL and not phone-localhost.
- Ensure no firewall blocks TCP `3001` between the phone and Docker host.
- Ensure the ExpoLyrics handshake key exactly matches `BRIDGE_KEY`.
- With ngrok, use the full displayed `wss://.../bridge/<bridge-id>` URL.

### Playback is missing

Run:

```bash
docker exec --user abc kinesync bash -lc '
  bridge_pid=$(pgrep -f "electron.*src/index.js" | head -1)
  export DBUS_SESSION_BUS_ADDRESS=$(tr "\0" "\n" < "/proc/$bridge_pid/environ" | sed -n "s/^DBUS_SESSION_BUS_ADDRESS=//p")
  playerctl -l
  playerctl --player=spotify status
  playerctl --player=spotify metadata
  playerctl --player=spotify position
'
```

`spotify` should appear and metadata should match the Spotify window. If Spotify
does not mirror the other device, DesktopBridge has no local state to observe.

### Controls do not work

Check `/config/log/desktop-bridge.log` for `[playback]` messages. Linux controls
use MPRIS `PlayPause`, `Next`, `Previous`, and `SetPosition`; they do not fall
back to Premium-only Spotify Web API controls.

### Health check

```bash
docker inspect --format '{{json .State.Health}}' kinesync
```

The health check confirms the local WebSocket server accepts TCP connections.
It does not prove that Spotify is logged in or playing.
