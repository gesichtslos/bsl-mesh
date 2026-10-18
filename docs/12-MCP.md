# 12. MCP-адаптер P0.4

Документ описывает реализованный срез. Митапы, практики, реестр инструментов, рекомендации, установка Skills/Rules и управление локальной средой здесь не объявлены и в `tools/list` не появляются.

## Что подтверждено

Проверено локально официальным клиентом `@modelcontextprotocol/client` 2.0.0 поверх Streamable HTTP к Fastify и PostgreSQL:

- сервер `@modelcontextprotocol/server` 2.0.0, транспорт `@modelcontextprotocol/node` 2.0.0 и хуки `@modelcontextprotocol/fastify` 2.0.0;
- протокол **2026-07-28**, режим сервера `legacy: 'reject'`, клиент с `versionNegotiation.mode.pin = '2026-07-28'`;
- эпоха соединения `modern`.

Наличие SDK 2.0.0 само по себе не включает handshake 2026-07-28. Константа `LATEST_PROTOCOL_VERSION` пакета по-прежнему относится к эпохе 2025. Этот сервер отклоняет `initialize` без конверта 2026-07-28.

## Что не проверено

Cursor, Claude Desktop, VS Code и любые другие MCP-хосты этим срезом **не запускались**. Пример конфигурации ниже — форма документа, а не отчёт о совместимости. OAuth discovery и authorization для удалённых клиентов не реализованы. Сервер не является универсальным OAuth MCP-хостом. Для локальной проверки используется scoped Bearer credential P0.2. Самодельный OAuth не добавлялся.

Публично этот endpoint не развёрнут.

## Endpoint

`POST /mcp` и `GET /mcp` на том же процессе, что REST. Режим stateless: фабрика сервера создаётся на запрос и вызывает те же `KnowledgeService` и `IdentityService`. Отдельной базы, пользователей и очереди нет.

`GET /api/v1/capabilities` возвращает:

```json
{
  "mcp": {
    "protocol": "2026-07-28",
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

Файл `docs/examples/cursor-mcp.json` показывает ожидаемую форму удалённого сервера. Совместимость с Cursor не подтверждалась. Перед использованием владелец сам решает, разрешать ли хосту сеть и заголовок Authorization. Не вставлять настоящий токен в репозиторий.

## Второй хост

Отдельная инструкция без утверждения поддержки: любой клиент Streamable HTTP, который умеет закрепить протокол `2026-07-28` и послать `Authorization: Bearer <credential>` на `http://127.0.0.1:3000/mcp`. Клиент, который начинает с `initialize` версии 2025, получит отказ. Проверять это нужно отдельным запуском; текущий репозиторий такого запуска не содержит.

## Черновик Skill

`skill/SKILL.md` — переносимый черновик. Он не устанавливает Rules, не подменяет манифест и не является активной политикой Cursor.
