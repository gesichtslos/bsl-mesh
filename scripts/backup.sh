#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/private-file.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/private-file.sh"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="backups/bslmesh_dev-${stamp}.dump"
docker compose exec -T db pg_dump -U bslmesh_admin -d bslmesh_dev -Fc | write_private_dump "${dump_file}"
chmod 700 backups
find backups -type f -name '*.dump' -exec chmod 600 {} +
if [ ! -s "${dump_file}" ]; then
  echo "backup dump is empty" >&2
  exit 1
fi
printf '%s\n' "${dump_file}"
