---
name: release-staging
description: "Prepare a reviewed BSL Mesh staging deployment with Docker Compose, migration planning, HTTPS, health checks, backup restore and approval gates."
---
# Staging release — approval required

1. Confirm target is staging, never silently substitute production. Show git SHA, container image digest, environment and release plan.
2. Verify clean tests, migration compatibility, lockfile, secrets via safe injection, backup and tested restore procedure.
3. Check Compose service health, loopback binding for DB/admin interfaces, Caddy TLS and minimal network/volume permissions. Never mount Docker socket into app.
4. Show expected changed files, DB migration impact, downtime, smoke tests and exact rollback. Ask explicit permission before connecting to server, applying migrations or changing DNS.
5. After permission, follow only approved commands and verify live health/API/MCP. No private data in chat/logs. Summarize successes and remaining failures truthfully.
6. Separate staging and production credentials; production always has its own approval and backup gate.
