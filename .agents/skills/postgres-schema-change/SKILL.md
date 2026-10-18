---
name: postgres-schema-change
description: "Design and verify PostgreSQL table changes, constraints, indexes and safe migrations with tenant boundaries and rollback strategy."
---
# PostgreSQL migration workflow

1. Locate all read/write callers, schema migration history and invariants from `docs/02-ARCHITECTURE.md`.
2. Decide whether migration is additive, backfill, or breaking. Identify lock and availability implications.
3. Model constraints, FKs, uniqueness, provenance, timestamps, owner scopes and evidence independence; create indexes justified by real filters.
4. Write migration using existing toolchain. Prefer expand-migrate-contract for live data. Reject silent destructive migrations.
5. Test clean-install migration and migration from prior state using disposable PostgreSQL container; verify constraints and query plans for search-critical paths.
6. Describe backup prerequisites, backward compatibility, rollback, risk and results. No direct production DDL without explicit owner approval.
