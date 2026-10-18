---
name: review-architecture
description: "Review BSL Mesh changes for architectural fit, module boundaries, API/MCP consistency, MVP scope and performance without premature microservices."
---
# Architecture review

1. Read `docs/00-VISION.md`, `docs/02-ARCHITECTURE.md`, `docs/03-CONTRACTS.md`, `docs/05-ROADMAP.md` from the original specification.
2. Check modular-monolith boundaries, dependencies, DB transactions, shared domain services, consistent REST/MCP authorization and tenant isolation.
3. Challenge new infrastructure (Redis, message broker, vector store, SSR framework, microservice, GPU/LLM) unless user requirements and measurements justify it.
4. Consider operational issues: deploy/rollback, migrations, indexing, recovery, rate limiting, statelessness, observability and backward compatibility.
5. Provide findings sorted by severity with file references; if changes are necessary, propose minimal reversible fixes and capture key decisions as ADR.
6. No implementation change without task authorization.
