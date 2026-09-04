#!/bin/sh
# Cross-platform KineSync Docker bootstrap. It can be piped from a release URL;
# cloning the repository is not required.
set -eu

release_base="${KINESYNC_DOCKER_RELEASE_BASE_URL:-https://github.com/Kineticron/KineSync/releases/latest/download}"

download() {
  if command -v curl >/dev/null 2>&1; then
    if ! curl --fail --location --silent --show-error --retry 3 "$1" -o "$2"; then
      echo 'The configured proxy could not reach the download; retrying directly…'
      curl --noproxy '*' --fail --location --silent --show-error --retry 3 "$1" -o "$2"
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --tries=3 -O "$2" "$1"
  else
    echo 'KineSync setup needs curl or wget.' >&2
    exit 1
  fi
}

env_value() {
  sed -n "s/^$1=//p" "$env_path" | tail -n 1
}

ensure_env_value() {
  name=$1
  value=$2
  if ! grep -q "^${name}=" "$env_path"; then
    printf '%s=%s\n' "$name" "$value" >> "$env_path"
  fi
}

find_xpra() {
  if command -v xpra >/dev/null 2>&1; then
    command -v xpra
  elif [ -x /Applications/Xpra.app/Contents/MacOS/Xpra ]; then
    printf '%s\n' /Applications/Xpra.app/Contents/MacOS/Xpra
  elif [ -x "$HOME/Applications/Xpra.app/Contents/MacOS/Xpra" ]; then
    printf '%s\n' "$HOME/Applications/Xpra.app/Contents/MacOS/Xpra"
  else
    return 1
  fi
}

install_xpra() {
  echo 'Installing the native-window client…'
  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64) mac_arch=arm64 ;;
        x86_64) mac_arch=x86_64 ;;
        *) echo "Xpra does not publish a macOS client for $(uname -m)." >&2; exit 1 ;;
      esac
      xpra_pkg=$(mktemp "${TMPDIR:-/tmp}/kinesync-xpra.XXXXXX.pkg")
      trap 'rm -f "$xpra_pkg"' 0 1 2 15
      download "https://xpra.org/dists/MacOS/$mac_arch/Xpra-Light-$mac_arch-6.5.3-r0.pkg" "$xpra_pkg"
      sudo installer -pkg "$xpra_pkg" -target /
      rm -f "$xpra_pkg"
      trap - 0 1 2 15
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1; then
        repo_installer=$(mktemp "${TMPDIR:-/tmp}/kinesync-xpra-repo.XXXXXX")
        trap 'rm -f "$repo_installer"' 0 1 2 15
        download https://xpra.org/get-xpra.sh "$repo_installer"
        sudo sh "$repo_installer"
        rm -f "$repo_installer"
        trap - 0 1 2 15
      fi
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y xpra
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y xpra
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --needed xpra
      else
        echo 'Install the Xpra client with your package manager, then run this command again.' >&2
        exit 1
      fi
      ;;
    *)
      echo 'This setup script supports macOS and Linux. Use setup-docker.ps1 on Windows.' >&2
      exit 1
      ;;
  esac
}

wait_for_xpra_server() {
  elapsed=0
  echo 'Waiting for the KineSync window service…'
  while [ "$elapsed" -lt 90 ]; do
    if docker exec "$container_name" xpra id --compressors=brotli \
      tcp://127.0.0.1:14500/ \
      >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != true ]; then
      echo "The $container_name container stopped before its window service was ready. Run: docker logs $container_name" >&2
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "KineSync started, but its native-window service did not become ready. Run: docker logs $container_name" >&2
  exit 1
}

if [ -n "${KINESYNC_ROOT:-}" ]; then
  repo_root=$KINESYNC_ROOT
  remote_bootstrap=0
else
  case "$0" in
    */*)
      remote_bootstrap=0
      script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
      if [ -f "$script_dir/compose.yaml" ]; then repo_root=$script_dir
      else repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
      fi
      ;;
    *)
      remote_bootstrap=1
      if [ -f "$(pwd)/compose.yaml" ] && [ -f "$(pwd)/.env" ]; then
        # Reuse installs created by older versions of the one-line command.
        repo_root=$(pwd)
      else
        repo_root="${XDG_DATA_HOME:-$HOME/.local/share}/kinesync/docker"
      fi
      ;;
  esac
fi
mkdir -p "$repo_root"
env_path="$repo_root/.env"
compose_path="$repo_root/compose.yaml"

if [ "$remote_bootstrap" = 1 ] || [ ! -f "$compose_path" ]; then
  echo 'Downloading the KineSync Docker Compose definition…'
  temp_compose="$compose_path.tmp.$$"
  trap 'rm -f "$temp_compose"' 0 1 2 15
  download "$release_base/compose.yaml" "$temp_compose"
  mv "$temp_compose" "$compose_path"
  trap - 0 1 2 15
fi

if [ -e "$env_path" ]; then
  echo '.env already exists; preserving its settings and applying any migration.'
  ensure_env_value KINESYNC_UI_PORT 14500
  ensure_env_value KINESYNC_UI_BIND_ADDRESS 127.0.0.1
else
  random_hex() { od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'; }
  puid=$(id -u 2>/dev/null || echo 568)
  pgid=$(id -g 2>/dev/null || echo 568)
  config_path="${KINESYNC_CONFIG_PATH:-./.kinesync-config}"
  case "$config_path" in
    ./*) mkdir -p "$repo_root/${config_path#./}" ;;
    /*) [ "$config_path" = / ] || mkdir -p "$config_path" ;;
    *) mkdir -p "$repo_root/$config_path" ;;
  esac
  umask 077
  temp_env="$env_path.tmp.$$"
  trap 'rm -f "$temp_env"' 0 1 2 15
  {
    echo 'KINESYNC_IMAGE=ghcr.io/kineticron/kinesync-desktop-bridge:latest'
    echo 'KINESYNC_PULL_POLICY=always'
    echo 'KINESYNC_CONTAINER_NAME=kinesync'
    echo "BRIDGE_KEY=$(random_hex 32)"
    echo "KINESYNC_CONFIG_PATH=$config_path"
    echo 'KINESYNC_UI_PORT=14500'
    echo 'KINESYNC_UI_BIND_ADDRESS=127.0.0.1'
    echo 'KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0'
    echo "PUID=$puid"
    echo "PGID=$pgid"
    echo "TZ=${TZ:-America/New_York}"
  } > "$temp_env"
  mv "$temp_env" "$env_path"
  trap - 0 1 2 15
  echo 'Created local configuration. No VNC username or password is required.'
fi

if [ "${KINESYNC_SKIP_START:-0}" = 1 ]; then
  echo "Configuration ready in $env_path. Start with: docker compose --project-directory \"$repo_root\" up -d"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker was not found. Install Docker Desktop or Docker Engine, then run this command again.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required. Update Docker and run this command again.' >&2
  exit 1
fi

# Acquire the host window client before changing the running container. A
# download failure must not turn a working installation into a headless one.
xpra_command=
if [ "${KINESYNC_SKIP_UI:-0}" != 1 ]; then
  xpra_command=$(find_xpra || true)
  if [ -z "$xpra_command" ]; then
    install_xpra
    xpra_command=$(find_xpra || true)
  fi
  if [ -z "$xpra_command" ]; then
    echo 'Xpra was installed but its launcher could not be found.' >&2
    exit 1
  fi
fi

if [ "${KINESYNC_BUILD_LOCAL:-0}" = 1 ]; then
  dev_compose_path="$repo_root/compose.dev.yaml"
  if [ ! -f "$dev_compose_path" ]; then
    echo 'KINESYNC_BUILD_LOCAL=1 must be run from a KineSync source checkout containing compose.dev.yaml.' >&2
    exit 1
  fi
  echo 'Building and starting KineSync from this source checkout…'
  docker compose --project-directory "$repo_root" -f "$compose_path" -f "$dev_compose_path" \
    up -d --build kinesync
else
  echo 'Downloading the latest KineSync Desktop Bridge image…'
  docker compose --project-directory "$repo_root" pull kinesync
  echo 'Starting KineSync…'
  docker compose --project-directory "$repo_root" up -d kinesync
fi
docker compose --project-directory "$repo_root" ps kinesync

if [ "${KINESYNC_SKIP_UI:-0}" != 1 ]; then
  container_name=$(env_value KINESYNC_CONTAINER_NAME)
  container_name=${container_name:-kinesync}
  wait_for_xpra_server
  ui_port=$(env_value KINESYNC_UI_PORT)
  echo 'Opening the KineSync windows…'
  "$xpra_command" attach "tcp://127.0.0.1:${ui_port:-14500}/" \
    --reconnect=yes --compressors=brotli --speaker=off --microphone=off \
    --webcam=no --printing=no \
    >/dev/null 2>&1 &
fi

echo 'Done. KineSync now appears as normal desktop windows; pair ExpoLyrics with ws://<this-host-LAN-IP>:3001.'
