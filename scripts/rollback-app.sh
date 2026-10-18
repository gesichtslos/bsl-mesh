#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

image="${1:-}"
if [ -z "${image}" ]; then
  echo "usage: scripts/rollback-app.sh <image>" >&2
  echo "Stops and recreates only the app service from an image that is already present locally." >&2
  echo "It does not restore SQL and does not delete volumes." >&2
  exit 1
fi

docker image inspect "${image}" >/dev/null
APP_IMAGE="${image}" docker compose up -d --no-deps --no-build --force-recreate app
echo "Recreated the app service from ${image}. The database volume was kept."
