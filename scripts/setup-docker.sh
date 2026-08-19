#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_path="$repo_root/.env"
if [ -e "$env_path" ]; then
  echo '.env already exists; leaving it unchanged.'
  exit 0
fi

random_hex() {
  od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}

puid=$(id -u)
pgid=$(id -g)
umask 077
{
  echo "BRIDGE_KEY=$(random_hex 32)"
  echo 'KINESYNC_WEB_USER=kinesync'
  echo "KINESYNC_WEB_PASSWORD=$(random_hex 24)"
  echo 'KINESYNC_CONFIG_PATH=./.kinesync-config'
  echo 'KINESYNC_WEB_BIND_ADDRESS=127.0.0.1'
  echo 'KINESYNC_BRIDGE_BIND_ADDRESS=0.0.0.0'
  echo "PUID=$puid"
  echo "PGID=$pgid"
  echo "TZ=${TZ:-America/New_York}"
} > "$env_path"
echo 'Created .env with unique random bridge and web passwords.'
echo 'Run: docker compose up -d --build'
