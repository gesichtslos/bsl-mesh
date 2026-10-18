#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "${CONFIRM_DESTROY_TEST_ENV:-}" != "yes" ]; then
  echo "Refusing to delete volumes. This command destroys the local test environment; it is not rollback." >&2
  echo "Stop containers with scripts/stop.sh, roll back the app image with scripts/rollback-app.sh, or restore a dump with scripts/restore-backup.sh." >&2
  exit 1
fi

docker compose down -v
echo "Destroyed local compose containers and volumes."
