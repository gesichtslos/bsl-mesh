---
name: implement-fastify-route
description: "Implement or refactor Fastify REST API routes with schema-first validation, application services, security scopes and Vitest tests for the BSL Mesh modular monolith."
---
# Fastify API implementation

1. Read relevant API contracts in `docs/03-CONTRACTS.md` and `docs/09-STARTER-CONTRACTS.md` and existing route/service conventions.
2. Specify method/path, input/output JSON schema, status/error codes, visibility, required owner scope, rate limits and idempotency behavior; write contract tests first when feasible.
3. Implement a thin Fastify v5 route adapter. Decode/validate inputs at the boundary, enforce access and call domain service. Avoid application logic in the handler.
4. Use strict TypeScript and ESM conventions. Prefer shared schema definitions and typed response structures; ensure runtime validation.
5. Test with `Fastify.inject()` for success, invalid payloads, unauthorized/forbidden, cross-owner data, empty pagination and idempotent retry.
6. Run project scripts for lint, typecheck, build and tests; report exact results and update API docs if contracts changed.

Reference: https://fastify.dev/docs/latest/
