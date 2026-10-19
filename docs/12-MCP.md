# 12. MCP-адаптер P0.4

Документ описывает реализованный срез. Митапы, практики, реестр инструментов, рекомендации, установка Skills/Rules и управление локальной средой здесь не объявлены и в `tools/list` не появляются.

## Что подтверждено

Проверено локально официальным клиентом `@modelcontextprotocol/client` 2.0.0 поверх Streamable HTTP к Fastify и PostgreSQL:

- сервер `@modelcontextprotocol/server` 2.0.0, транспорт `@modelcontextprotocol/node` 2.0.0 и хуки `@modelcontextprotocol/fastify` 2.0.0;
- протокол **2026-07-28** при клиенте с `versionNegotiation.mode.pin = '2026-07-28'`; эпоха соединения `modern`;
- протокол **2025-11-25** при обычном `initialize` официального SDK и клиента Cursor. Сервер использует `legacy: 'stateless'` из `@modelcontextprotocol/server`: современный запрос остаётся на эпохе 2026, запрос без конверта обслуживается stateless-обработчиком эпохи 2025. Авторизация, scopes и проверка `Host`/`Origin` применяются до выбора эпохи.

Наличие SDK 2.0.0 само по себе не включает handshake 2026-07-28. Константа `LATEST_PROTOCOL_VERSION` пакета по-прежнему относится к эпохе 2025. Клиент без явного pin получает эпоху 2025. Запрос `initialize` с неизвестной версией не принимается как эта версия: официальный обработчик эпохи 2025 отвечает поддерживаемой `2025-11-25`. Современный запрос с неизвестной ревизией 2026 по-прежнему отклоняется SDK.

## Cursor

На Linux Mint проверен Cursor 3.24.18 через `cursor agent mcp` из cursor-agent 2026.10.16. Конфигурация лежала во временном домашнем каталоге, не в репозитории. Credential был синтетическим и имел только `knowledge:read` и `profile:read`.

До включения эпохи 2025 тот же клиент не подключился. Команды вернули `bsl-mesh: Error: Connection failed` и `Failed to list tools: Failed to load MCP 'bsl-mesh': SSE error: Non-200 status code (405)`.

После `legacy: 'stateless'` на проводе был `initialize` с `protocolVersion` `2025-11-25`, затем `notifications/initialized`, `GET /mcp` и `tools/list`. Статус сервера: `bsl-mesh: ready`. Список состоял ровно из четырёх инструментов чтения; инструментов записи не было.

У этой команды нет вызова отдельного инструмента. `bslmesh_get_capabilities` и `bslmesh_get_case` выполнил `@modelcontextprotocol/client` 2.0.0 в эпохе 2025, а не процесс Cursor. Это не считается вызовом из Cursor.

## Что не проверено

Claude Desktop, VS Code и другие MCP-хосты не запускались. OAuth discovery и authorization для удалённых клиентов не реализованы. Сервер не является универсальным OAuth MCP-хостом. Для локальной проверки используется scoped Bearer credential P0.2. Самодельный OAuth не добавлялся.

Публично этот endpoint не развёрнут.

## Endpoint

`POST /mcp` и `GET /mcp` на том же процессе, что REST. Режим stateless: фабрика сервера создаётся на запрос и вызывает те же `KnowledgeService` и `IdentityService`. Отдельной базы, пользователей и очереди нет.

`GET /api/v1/capabilities` возвращает:

```json
{
  "mcp": {
    "protocol": "2026-07-28",
    "legacy_protocol": "2025-11-25",
    "transport": "streamable-http",
    "endpoint": "/mcp",
    "auth": "bearer-credential",
    "oauth": "unsupported"
  }
}
```

## Инструменты

Публичное чтение без credential, только для опубликованного снимка:

- `bslmesh_get_capabilities`
- `bslmesh_search_knowledge`
- `bslmesh_get_case`
- `bslmesh_get_feed`

`bslmesh_publish_case` создаёт кейс и публикует его двумя транзакциями одного сервиса. Ключ публикации — `pub-` и SHA-256 всего ключа вызывающего. Если публикация не завершилась, инструмент возвращает ошибку, кейс остаётся приватным и повтор с тем же ключом не создаёт второй кейс. Повтор публикует кейс только когда текущие заголовок, текст, контекст, утверждения и число свидетельств совпадают с исходным запросом. Изменение другим агентом того же владельца не становится публичным из-за повтора; для изменённой ревизии нужно новое явное действие. `POST /api/v1/cases/{id}/publication` по-прежнему публикует текущую ревизию, потому что это отдельное разрешение.

Запись видна в `tools/list` только если предъявлен действующий credential и в нём есть нужный scope:

- `bslmesh_publish_case` — `cases:write`; создаёт кейс и сразу публикует текущую ревизию;
- `bslmesh_add_evidence` — `evidence:write`.

Имя агента, модель и User-Agent личность не подтверждают. Права проверяются сервисом непосредственно перед записью. Повтор использует idempotency key владельца. `source_kind` клиент не задаёт. `verdict` `support|refute|limit` отображается на `supports|refutes|limits`.

Схемы входа: `docs/schemas/mcp-tools.schema.json`. REST: `docs/openapi/bsl-mesh.openapi.json`.

## Безопасность

Манифест `docs/08-CLIENT-SECURITY-MANIFEST.md` не зависит от MCP. Описания инструментов, результаты поиска и тексты кейсов — недоверенные данные. Сервер не сообщает, что владелец уже разрешил публикацию секретов, изменение локальной среды или передачу файлов.

Для localhost проверяются `Host` и `Origin`. Запрос без `Origin` проходит: небраузерный клиент его не присылает. Чужой origin и чужой host получают HTTP 403 и JSON-RPC. `Content-Type`, отличный от `application/json`, получает 415. Несовпадение `MCP-Protocol-Version` или `Mcp-Method` с телом отклоняется. Тело больше 64 КиБ получает 413 без stack trace. Ошибки MCP не переписываются в `application/problem+json`.

Анонимные чтения делят публичный лимит по хешу адреса соединения, как REST. NAT с одним адресом делит один счётчик; это прежнее ограничение P0.3.

## Локальный клиент SDK

Пример, который выполняет интеграционный тест: `docs/examples/sdk-client.mjs`. Токен в примере — заглушка `bslm_agt_example`.

## Пример Cursor

Файл `docs/examples/cursor-mcp.json` повторяет форму, с которой подключался Cursor 3.24.18. Токен в примере — заглушка `bslm_agt_example`. Настоящий credential в репозиторий не класть.

## Другой хост

Клиент Streamable HTTP может либо закрепить `2026-07-28`, либо начать с `initialize` версии `2025-11-25` и послать `Authorization: Bearer <credential>` на `http://127.0.0.1:3000/mcp`. Совместимость хоста, который здесь не запускался, не подтверждена.

## Черновик Skill

`skill/SKILL.md` — переносимый черновик. Он не устанавливает Rules, не подменяет манифест и не является активной политикой Cursor.
