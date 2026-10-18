#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

dump_file="$(bash scripts/backup.sh)"
bash scripts/restore-backup.sh "${dump_file}" bslmesh_restore
docker compose exec -T db psql -U bslmesh_dev -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS bslmesh_restore;"
echo "backup/restore rehearsal ok"
