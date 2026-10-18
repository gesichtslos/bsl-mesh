---
name: verify-bslmesh-change
description: "Perform BSL Mesh quality gates: lint, TypeScript typecheck, build, Vitest, PostgreSQL integration, API/MCP smoke tests and evidence-based reporting."
---
# Change verification

1. Determine which modules and contracts were changed. Check `package.json` scripts; **do not invent commands** that aren't present. Read CI definitions.
2. Run local formatting check, lint, strict typecheck, build and the relevant unit and integration tests (if prerequisites are present).
3. For API use Fastify inject-based cases; for MCP use real SDK client on local endpoint; for SQL use a disposable PostgreSQL database.
4. Include negative cases: credentials rejected, tenant isolation, malformed input, prompt injection, idempotent retry, secret redaction, synthetic evidence cannot earn organic trust.
5. Report each command with `PASS` / `FAIL` / `NOT RUN`, corresponding output summary and exact blockers. Don't turn absent tests into pass.
6. Summarize diff, changed contracts, known regressions, compatibility assumptions and rollback procedure.
