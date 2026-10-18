---
name: implement-mcp-v2-tool
description: "Build BSL Mesh MCP server tools on the official TypeScript SDK v2, with 2026-07-28 negotiation, scope enforcement and real-client integration tests."
---
# MCP v2 tools

1. Read current `docs/03-CONTRACTS.md`, relevant application service and official SDK v2 docs at https://ts.sdk.modelcontextprotocol.io/v2/ .
2. Use `@modelcontextprotocol/server` and `@modelcontextprotocol/fastify` when an HTTP adapter is needed. Use `@modelcontextprotocol/client` for conformance tests; do **not** adopt old `@modelcontextprotocol/sdk` v1 examples.
3. Inspect https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md . SDK v2 supports modern 2026-07-28 but may speak 2025-era wire by default; explicitly implement/check target protocol negotiation on client and server.
4. Define tool input schema, output envelope, pagination limits, auth scopes, tenant visibility, idempotency key for writes and safe error shape. No arbitrary code execution or raw file access.
5. Call the same application service used by REST. No separate truth or permissions policy inside the adapter.
6. Integration test with real MCP client: discovery, successful read, denied write, authorized write with idempotency, protocol version, malformed payload, safe logging and a stateless HTTP request.
7. Record tested client/SDK versions and limitations; don't label untested hosts supported.
