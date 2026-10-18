#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

dump_file="${1:-}"
target="${2:-}"
if [ -z "${dump_file}" ] || [ -z "${target}" ]; then
  echo "usage: scripts/restore-backup.sh <dump-file> <target-database>" >&2
  exit 1
fi
if ! [[ "${target}" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "Refusing an unexpected target database name." >&2
  exit 1
fi
if [ "${target}" = "bslmesh_dev" ] || [ "${target}" = "postgres" ] || [ "${target}" = "template0" ] || [ "${target}" = "template1" ]; then
  if [ "${CONFIRM_RESTORE_APP_DATABASE:-}" != "yes" ] || [ "${target}" != "bslmesh_dev" ]; then
    echo "Refusing to restore into ${target}. Restore is not an application rollback and does not replace the running database unless CONFIRM_RESTORE_APP_DATABASE=yes and the target is bslmesh_dev." >&2
    exit 1
  fi
fi
if [ ! -s "${dump_file}" ]; then
  echo "backup dump is missing or empty" >&2
  exit 1
fi

exists="$(docker compose exec -T db psql -U bslmesh_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${target}'")"
if [ "${exists}" != "1" ]; then
  docker compose exec -T db psql -U bslmesh_admin -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${target} OWNER bslmesh_admin;"
fi
docker compose exec -T db pg_restore -U bslmesh_admin -d "${target}" --no-owner --clean --if-exists --exit-on-error < "${dump_file}"
service_name="$(docker compose exec -T db psql -U bslmesh_admin -d "${target}" -tAc "SELECT service_name FROM app_meta WHERE id = 1;")"
service_name="$(printf '%s' "${service_name}" | tr -d '[:space:]')"
if [ "${service_name}" != "bsl-mesh" ]; then
  echo "restored app_meta row was not found" >&2
  exit 1
fi
echo "restored ${target}"
