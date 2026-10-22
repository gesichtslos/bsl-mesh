#!/bin/sh
# Reports whether a running container already uses a Docker volume.
# compose.production.yaml does not call this script and does not lock the volume.
set -eu
volume="${1:-bsl-mesh-staging_pgdata}"
if [ -n "${VOLUME_USERS_FILE:-}" ]; then
  users="$(cat "${VOLUME_USERS_FILE}")"
else
  users="$(docker ps --filter "volume=${volume}" --filter status=running --format '{{.Names}}')"
fi
if [ -n "${users}" ]; then
  echo "A running container already uses ${volume}." >&2
  printf '%s\n' "${users}" >&2
  echo "compose.production.yaml does not stop that container or lock the volume." >&2
  exit 3
fi
echo "No running container reports ${volume}."
