#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
dump_file="backups/bslmesh_dev-${stamp}.dump"
docker compose exec -T db pg_dump -U bslmesh_dev -d bslmesh_dev -Fc > "${dump_file}"
if [ ! -s "${dump_file}" ]; then
  echo "backup dump is empty" >&2
  exit 1
fi
printf '%s\n' "${dump_file}"
