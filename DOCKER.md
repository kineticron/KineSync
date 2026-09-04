# Docker setup

KineSync's Docker image presents Desktop Bridge and Spotify as individual host
windows. There is no VNC desktop, browser gateway, VNC username, or VNC
password. Desktop Bridge stays open. Spotify is shown when an account needs to
be signed in, then disappears after the login is persisted in `/config`.

Docker is an optional Desktop Bridge method. The easiest KineSync setup is
**Mobile-Only**, selected during mobile-app onboarding; it needs no computer or
bridge. Use Docker when you want desktop Spotify playback, tighter sync, local
lyrics, or relay access without maintaining a Windows-native installation.

Docker cannot place a Linux window directly in a Windows, macOS, or Linux
taskbar. KineSync therefore uses Xpra's seamless application forwarding: Xpra
runs inside the container and a small native client draws each application as a
normal window on the host. This gives the WSLg-style experience without relying
on WSLg or a host-specific display socket.

## Requirements

- An `amd64` Windows, macOS, or Linux computer
- Docker Desktop, or Docker Engine with the Compose v2 plugin
- A Spotify account
- ExpoLyrics on the phone

Node.js, npm, a repository clone, Spotify Premium, and Spotify Web API playback
access are not required.

## One-command install

### Windows

Open PowerShell and run:

```powershell
irm https://github.com/Kineticron/KineSync/releases/latest/download/setup-docker.ps1 | iex
```

The command installs its small files under
`%LOCALAPPDATA%\KineSync\Docker`, downloads a checksum-verified portable Xpra
client without administrator access, starts Docker, and opens the KineSync
windows. It can be run from any directory and does not require a clone.

### macOS or Linux

Open Terminal and run:

```bash
curl -fsSL https://github.com/Kineticron/KineSync/releases/latest/download/setup-docker.sh | sh
```

Files are stored under `${XDG_DATA_HOME:-~/.local/share}/kinesync/docker`. The
helper uses an existing Xpra client or installs the official macOS package or
the appropriate Linux package through apt, dnf, or pacman. Installation may ask
for the user's `sudo` password.

Run the same command again to update. The helper preserves `.env`, Spotify's
login, bridge settings, and logs.

For an offline or reviewable install, download
[`kinesync-docker-setup.zip`](https://github.com/Kineticron/KineSync/releases/latest/download/kinesync-docker-setup.zip),
verify the adjacent `.sha256` file, extract it, and run `setup-docker.ps1` or
`sh setup-docker.sh`.

## First run

1. Desktop Bridge opens as a normal host window.
2. Spotify also opens because the container has no saved login yet. Sign in.
3. Once Spotify stores the account, its window is hidden. Spotify keeps running
   in the container so Desktop Bridge can read and control it through MPRIS.
4. Scan the pairing QR in Desktop Bridge with ExpoLyrics.

The `/config` volume preserves the Spotify login across restarts and upgrades.
Spicetify Marketplace and Adblockify are already installed in the image.

## Ports and data

| Port/path | Purpose |
| --- | --- |
| `14500` | Xpra seamless-window transport, bound to `127.0.0.1` by default |
| `3001` | ExpoLyrics WebSocket bridge, reachable from the LAN by default |
| `/config` | Spotify login, Desktop Bridge settings, certificates, and logs |

The Xpra transport has no application password because Compose restricts it to
the local computer. Do not change `KINESYNC_UI_BIND_ADDRESS` to a LAN or public
address. This transport is not a public deployment boundary.

Opening `http://localhost:3001` shows **Upgrade Required**. That is expected:
port 3001 accepts WebSocket upgrades and is not a webpage.

## Configuration

The generated `.env` contains:

```dotenv
KINESYNC_IMAGE=ghcr.io/kineticron/kinesync-desktop-bridge:latest
KINESYNC_PULL_POLICY=always
KINESYNC_CONTAINER_NAME=kinesync
BRIDGE_KEY=<generated automatically>
KINESYNC_CONFIG_PATH=./.kinesync-config
KINESYNC_UI_PORT=14500
KINESYNC_UI_BIND_ADDRESS=127.0.0.1
KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0
PUID=568
PGID=568
TZ=America/New_York
```

- `BRIDGE_KEY` must match the key in ExpoLyrics; the pairing QR fills it in.
- Keep `.env` private. It is ignored by Git.
- Change `TZ` to the appropriate IANA timezone when needed.
- Keep `KINESYNC_UI_BIND_ADDRESS=127.0.0.1`.
- On Linux, `PUID` and `PGID` default to the user running the setup helper.

When the command is rerun from an older one-line install folder, that install is
migrated in place. Obsolete VNC/web variables can remain in `.env`, but the
current Compose file ignores them and adds the local Xpra settings.

## Source checkout and manual operation

Developers can run the helper from the repository root:

```powershell
./scripts/setup-docker.ps1
```

```bash
sh ./scripts/setup-docker.sh
```

Useful Compose commands, run from the install folder or source root:

```bash
docker compose ps
docker compose logs -f kinesync
docker compose restart
docker compose down
docker compose pull
docker compose up -d
```

To build the image from a checkout and launch its native windows:

```powershell
./scripts/setup-docker.ps1 -BuildLocal
```

```bash
KINESYNC_BUILD_LOCAL=1 sh ./scripts/setup-docker.sh
```

For a Compose-only local build without launching the window client:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

## Connect ExpoLyrics manually

If QR pairing is unavailable, find the Docker host's LAN IP and enter:

```text
WebSocket URL: ws://<docker-host-LAN-IP>:3001
Handshake key: the BRIDGE_KEY value from .env
```

Do not use `localhost` on the phone because it refers to the phone itself.

## Remote access with ngrok

Ngrok is embedded in Desktop Bridge. In its **Relay** page, enter the bridge
key, reserved ngrok domain, and agent authtoken. Save, wait for the connected
status, then use the displayed `wss://.../bridge/<bridge-id>` URL in ExpoLyrics.
Only one running endpoint can own a reserved free domain.

## Troubleshooting

### No windows appear

- Confirm `docker compose ps` reports `kinesync` as running or healthy.
- Run the setup command again; it reconnects the native Xpra client.
- Check that another program is not using `KINESYNC_UI_PORT`.
- Keep the UI address on `127.0.0.1`; remote-host Xpra connections are not part
  of this setup.

### ExpoLyrics cannot connect

- Use `ws://<host-LAN-IP>:3001`, not an HTTP URL.
- Allow TCP 3001 through the host firewall on the local network.
- Confirm the ExpoLyrics handshake key exactly matches `BRIDGE_KEY`.

### Playback is missing

```bash
docker exec --user abc kinesync bash -lc '
  bridge_pid=$(pgrep -f "electron.*src/index.js" | head -1)
  export DBUS_SESSION_BUS_ADDRESS=$(tr "\0" "\n" < "/proc/$bridge_pid/environ" | sed -n "s/^DBUS_SESSION_BUS_ADDRESS=//p")
  playerctl -l
  playerctl --player=spotify status
  playerctl --player=spotify metadata
'
```

`spotify` should be listed. The container does not inspect Spotify on another
machine; Spotify synchronizes account state and Desktop Bridge observes the
containerized client.

### Logs and health

```bash
docker inspect --format '{{json .State.Health}}' kinesync
docker compose logs kinesync
```

Persistent application logs are under `/config/log/` (normally
`.kinesync-config/log/` on the host). The health check validates the WebSocket
listener; it does not prove Spotify is logged in or playing.

## Image security and provenance

The service enables `no-new-privileges`, keeps Docker's default seccomp profile,
drops `NET_RAW`, and runs Spotify and Electron as the unprivileged `abc` user.
Chromium is launched with `--no-sandbox` inside that container boundary; native
desktop builds keep Chromium sandboxing. Do not add `SYS_ADMIN`, privileged
mode, a Docker socket, host D-Bus, or an unconfined seccomp profile.

Base images are pinned to immutable registry digests. Maintainers can inspect
updates with:

```bash
docker buildx imagetools inspect node:22-bookworm-slim
docker buildx imagetools inspect ubuntu:24.04
```
