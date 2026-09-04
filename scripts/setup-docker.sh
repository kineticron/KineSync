#!/bin/sh
# KineSync Docker bootstrap. This file is also published in the desktop-
# latest release and can be run without cloning the source repository.
set -eu

release_base="${KINESYNC_DOCKER_RELEASE_BASE_URL:-https://github.com/Kineticron/KineSync/releases/download/desktop-latest}"

download() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --retry 3 "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --tries=3 -O "$destination" "$url"
  else
    echo 'KineSync setup needs curl or wget to download the Compose file.' >&2
    exit 1
  fi
}

# When run from a checkout, use its files. When piped from a release URL,
# install into the current directory and fetch the matching Compose file.
if [ -n "${KINESYNC_ROOT:-}" ]; then
  repo_root=$KINESYNC_ROOT
  remote_bootstrap=0
else
  case "$0" in
    */*)
      remote_bootstrap=0
      script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
      if [ -f "$script_dir/compose.yaml" ]; then
        repo_root=$script_dir
      else
        repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
      fi
      ;;
    *)
      remote_bootstrap=1
      repo_root=$(pwd)
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
  echo '.env already exists; leaving it unchanged.'
else
  random_hex() {
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  }

  puid=568
  pgid=568
  if command -v id >/dev/null 2>&1; then
    puid=$(id -u 2>/dev/null || echo 568)
    pgid=$(id -g 2>/dev/null || echo 568)
  fi
  config_path="${KINESYNC_CONFIG_PATH:-./.kinesync-config}"
  case "$config_path" in
    ./*) mkdir -p "$repo_root/${config_path#./}" ;;
    /*) [ "$config_path" = "/" ] || mkdir -p "$config_path" ;;
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
    echo 'KINESYNC_WEB_USER=kinesync'
    echo 'KINESYNC_WEB_PASSWORD='
    echo "KINESYNC_CONFIG_PATH=$config_path"
    echo 'KINESYNC_WEB_PORT=3000'
    echo 'KINESYNC_WEB_HTTPS_PORT=3443'
    echo 'KINESYNC_WEB_BIND_ADDRESS=127.0.0.1'
    echo 'KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0'
    echo "PUID=$puid"
    echo "PGID=$pgid"
    echo "TZ=${TZ:-America/New_York}"
  } > "$temp_env"
  mv "$temp_env" "$env_path"
  trap - 0 1 2 15
  echo 'Created local configuration. The localhost-only app view needs no password.'
fi

if [ "${KINESYNC_SKIP_START:-0}" = 1 ]; then
  echo "Configuration ready in $env_path. Start with: docker compose -f \"$compose_path\" up -d"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker was not found. Install Docker Desktop, then run this script again.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required. Update Docker Desktop and run this script again.' >&2
  exit 1
fi

echo 'Downloading the latest KineSync Desktop Bridge image…'
docker compose --project-directory "$repo_root" pull kinesync
echo 'Starting KineSync…'
docker compose --project-directory "$repo_root" up -d kinesync
docker compose --project-directory "$repo_root" ps kinesync
echo 'Done. Open KineSync at http://localhost:3000; pair ExpoLyrics with ws://<this-host-LAN-IP>:3001.'
if command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  xdg-open http://localhost:3000 >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open http://localhost:3000 >/dev/null 2>&1 &
fi
