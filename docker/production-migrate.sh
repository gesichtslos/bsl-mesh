#!/bin/sh
set -eu
admin_user="${PGUSER:?PGUSER is required.}"
admin_password="${PGPASSWORD:?PGPASSWORD is required.}"
node dist/production-privileges.js
export PGUSER=bslmesh_migrator
export PGPASSWORD="${MIGRATE_PASSWORD:?MIGRATE_PASSWORD is required.}"
node dist/migrate.js
export PGUSER="${admin_user}"
export PGPASSWORD="${admin_password}"
node dist/production-privileges.js
