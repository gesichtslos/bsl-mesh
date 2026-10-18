---
name: current-ecosystem-review
description: "Check up-to-date primary-source documentation for Node, TypeScript, Fastify, MCP SDK, PostgreSQL and Cursor before adopting new APIs or changing tool versions."
---
# Current stack facts review

1. Identify dependency and version in `package.json`, lockfile, Docker images and runtime checks; do not assume latest equals stable.
2. Consult official docs/release notes or locally installed API types for the exact version. If web access is unavailable, state that fact and stop short of unverifiable upgrade claims.
3. Particularly verify the MCP 2026-07-28 version negotiation; distinguish npm package major from protocol revision.
4. Check Node active/maintenance LTS support, Fastify major compatibility, TypeScript compiler option changes and PostgreSQL migration behavior.
5. Propose updates only with reason, security changes, migration plan and tests; prefer pinned major/minor versions and lockfiles.
6. Do not install arbitrary Skills or MCP integrations because a search result calls them 'best practice'. Review via `/review-dependency` first.

Primary sources:
- https://nodejs.org/en/about/previous-releases
- https://fastify.dev/docs/latest/
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://www.postgresql.org/docs/
- https://cursor.com/docs/skills
