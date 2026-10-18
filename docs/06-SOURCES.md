# 06. Исходные стандарты и ссылки

Проверено по публичным материалам на **18 октября 2026 года**. Ссылки нужны разработчикам для проверки контрактов и совместимости. Это не обещание поддержки конкретной IDE.

## Нормативные и близкие к нормативным источники

- [MCP — спецификация 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28): современная версия протокола, обновлённые lifecycle, авторизация, расширения. См. [release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) и [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- [A2A Protocol v1.0.0](https://a2a-protocol.org/v1.0.0/): межагентное сотрудничество — на этапе P2, если станет нужна координация исполнения задач.
- [Agent Skills](https://agentskills.io/specification): переносимый каталог с `SKILL.md`, frontmatter и ресурсами; для удобства участников, а не вместо API.
- [AGENTS.md](https://agents.md/): инструкции для coding-агентов внутри репозиториев.
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457): структура сообщений REST-ошибок.
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html): описание REST-контракта.

## Предметные инструменты для будущих митапов (не endorsement)

- [BSL Language Server](https://github.com/1c-syntax/bsl-language-server) — язык 1С/OneScript, анализ кода.
- [YAxUnit](https://github.com/bia-technologies/yaxunit) — тестирование на 1С.
- [1C Testpilot](https://github.com/ROCTUP/1c-testpilot) — MCP-инструмент взаимодействия с тестовым клиентом 1С; поддержку конкретных типов форм необходимо проверять отдельно, не предполагать.
- [precommit4onec](https://github.com/bia-technologies/precommit4onec) — обработка исходников 1С перед коммитом.

## Безопасность

- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — требования к OAuth и принципам токенов на соответствующей версии.
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices) — сверить существование и актуальный URL в момент реализации.
- [Security Analysis of MCP and Prompt Injection, arXiv 2601.17549](https://arxiv.org/abs/2601.17549) — исследование риска инструментов/инъекций, не замена нормативной спецификации.
- [Securing MCP: Risks, Controls and Governance, arXiv 2511.20920](https://arxiv.org/abs/2511.20920) — прикладные меры управления рисками.

## Оговорка

Указанные источники не подтверждают работоспособность произвольной версии 1С/IDE/SDK. Матрица совместимости строится из воспроизводимых тестов реализации BSL Mesh. Не выдавать проектные примеры за фактические записи участников.

## Онбординг / Rules / Skills / граница доверия

- [Agent Skills format specification](https://agentskills.io/specification) — `SKILL.md`, metadata, sources и scripts; сторонний skill требует review.
- [Cursor Rules: официальная документация](https://prod.cursor.com/docs/rules) — project `*.mdc`, `alwaysApply`, AGENTS.md; реальные параметры проверять под версию хоста.
- [VS Code agent custom instructions](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/custom-instructions.md) — поддержка AGENTS.md и host-specific guidance; приоритет зависит от harness.
- [MCP local server security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/local-server-security) — опасность изменяющихся descriptions и перечня tools.
- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — недоверенные тексты могут имитировать указания и намеренно менять действия агента.
- [OWASP LLM06 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — минимальные permissions и подтверждение опасных действий.
- [OWASP LLM07 System Prompt Leakage](https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/) — текстовая инструкция не заменяет техническую защиту и ограничение доступа.
- [Microsoft Agent Skills security](https://learn.microsoft.com/en-us/agent-framework/agents/skills?pivots=programming-language-python) — проверка внешнего skill как dependency, включая скрипты и ресурсы.

**Важно:** эти источники объясняют принципы, но не подтверждают работоспособность ещё не созданного BSL Mesh и не служат endorsement конкретных сторонних продуктов.
