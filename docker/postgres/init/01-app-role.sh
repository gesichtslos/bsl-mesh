#!/bin/sh
set -eu

if [ -z "${APP_PASSWORD:-}" ]; then
  echo "APP_PASSWORD is required to create the application role." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$APP_PASSWORD" \
  -v admin_password="$POSTGRES_PASSWORD" <<'SQL'
SELECT format(
  '%s %I LOGIN SUPERUSER CREATEDB CREATEROLE PASSWORD %L',
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bslmesh_admin') THEN 'ALTER ROLE' ELSE 'CREATE ROLE' END,
  'bslmesh_admin',
  :'admin_password'
) \gexec
SELECT format(
  '%s %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bslmesh_app') THEN 'ALTER ROLE' ELSE 'CREATE ROLE' END,
  'bslmesh_app',
  :'app_password'
) \gexec
SELECT format(
  'CREATE DATABASE %I OWNER %I',
  'bslmesh_dev',
  'bslmesh_app'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'bslmesh_dev') \gexec
ALTER DATABASE bslmesh_dev OWNER TO bslmesh_app;
REVOKE ALL ON DATABASE bslmesh_dev FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE bslmesh_dev TO bslmesh_app;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname bslmesh_dev <<'SQL'
ALTER SCHEMA public OWNER TO bslmesh_app;
GRANT ALL ON SCHEMA public TO bslmesh_app;
SQL

if [ -n "${MIGRATE_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v migrate_password="$MIGRATE_PASSWORD" <<'SQL'
SELECT format(
  '%s %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bslmesh_migrator') THEN 'ALTER ROLE' ELSE 'CREATE ROLE' END,
  'bslmesh_migrator',
  :'migrate_password'
) \gexec
SQL
fi
