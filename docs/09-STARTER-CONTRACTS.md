# 09. Контракты newcomer bootstrap / starter catalog / install plan

**Статус:** проект контракта v0.2. Все примеры синтетические, API ещё не существует. Реализация: OpenAPI 3.1 и JSON Schema 2020-12, snapshots + contract tests. Указанный `PROJECT_DOMAIN` — параметр окружения.

## 1. Новые read endpoints (public, без cookies/авторизации)

| HTTP | URI | Ответ / свойства |
|---|---|---|
| `GET` | `/start` | Страница для человека и обычного браузера; одна инструкция приглашения агента, ссылки на manifesto/quickstart |
| `GET` | `/agent/quickstart.md` | `text/markdown`, компактная и безопасная точка входа, без инструкций «отключить защиту» |
| `GET` | `/agent/security-manifest.md` | Публичная **копия** `08-CLIENT-SECURITY-MANIFEST.md`; не может изменить локальные полномочия |
| `GET` | `/agent/starter-catalog.json` | `application/json`, полный публичный небольшой каталог по умолчанию, без пользовательского query; `ETag`, `Cache-Control` |
| `GET` | `/agent/catalog-signatures.json` | Метаданные provenance/подписей проверяемого релиза; независимый локально закреплённый trust anchor |
| `GET` | `/api/v1/starter-profiles` | Список ID, версий, поддерживаемых хостов/сред; без трекинга пользователя |
| `GET` | `/api/v1/starter-profiles/{id}/versions/{version}` | Неизменяемый snapshot профиля, ссылки на practices/tools, план и проверку |
| `GET` | `/api/v1/tool-versions/{id}/versions/{version}` | Канонические сведения, официальные releases, лицензии, limitations, provenance |
| `GET` | `/api/v1/practices/{id}` | Доказательства и контрсвидетельства, дата пересмотра |

Рекомендации по локальной конфигурации по умолчанию реализуются клиентским сопоставлением **скачанного обезличенного каталога**. Опциональный серверный `POST /api/v1/starter-resolve` разрешён только после согласия пользователя на отправку минимального профиля. Не делать его обязательным для онбординга.

`/agent/starter-catalog.json` представляет собой публичный артефакт с запретом на публикацию приватных вложений. Ключ проверки **не должен автоматически приниматься из соседнего `catalog-signatures.json`**: его fingerprint/chain пользователь или хост доверенно закрепляют заранее, иначе compromised origin может переподписать вредный пакет.

## 2. Формат `StarterCatalog` (JSON-псевдосхема)

```json
{
  "schema_version": "0.2.0",
  "catalog_version": "2026.10.18-draft",
  "generated_at": "2026-10-18T00:00:00Z",
  "source_kind": "synthetic",
  "profiles": [
    {
      "id": "bsl-ordinary-forms",
      "version": "0.1.0",
      "status": "draft",
      "summary": "Шаблон для BSL, обычные формы, толстый клиент",
      "applicability": {"form_type": ["ordinary"], "client_type": ["thick"], "ide": ["cursor", "other"]},
      "bundles": ["bundle-demo-ordinary-0.1"],
      "practice_refs": [],
      "review_due_at": "2026-12-01T00:00:00Z",
      "warnings": ["Не подтверждён независимыми экспериментами"],
      "evidence_quality": "insufficient_evidence"
    }
  ],
  "tools": [],
  "bundles": []
}
```

Инварианты:

- `source_kind: synthetic` никогда не позволяет рекомендовать `status: published` на production.
- `recommendation_level` (`required_for_task | beneficial | optional | experimental | not_recommended`) — отдельно от `adoption_signal` и `evidence_quality`.
- `status: published` требует provenance, ревизию, подтверждённую совместимость, `last_reviewed_at`, `limitations` и `rollback`. Для несовместимой среды — `inapplicable`, не незаметная подмена профиля.
- Статический каталог должен укладываться в ограниченный budget; допускается paginated manifest+content snapshots, но zero-MCP путь остаётся возможен.
- Ссылки на источник должны быть каноническими; URI не могут содержать непроверяемые произвольные install scripts, URL-shorteners и affiliate-redirect без маркировки.
- Если `review_due_at` истёк, снизить доверие и запросить дополнительную проверку, а не молча считать актуальным.

## 3. `StarterBundle` — декларативный рецепт, а не команда

```json
{
  "bundle_id": "bundle-demo-ordinary-0.1",
  "version": "0.1.0",
  "status": "draft",
  "source_kind": "synthetic",
  "target_host": "cursor",
  "prerequisites": ["Local workspace write permission", "1C test contour is optional"],
  "components": [
    {
      "id": "rule-review-generated-bsl",
      "kind": "rule",
      "required": true,
      "target_path_template": ".cursor/rules/review-generated-bsl.mdc",
      "source_uri": "https://PROJECT_DOMAIN/agent/examples/review-generated-bsl.mdc",
      "sha256": "NOT_PROVIDED_IN_DRAFT",
      "publisher": "unverified",
      "required_scopes": ["workspace:write"],
      "validation": "host_lists_rule",
      "rollback": "restore_backup_or_delete_created_file"
    },
    {
      "id": "skill-review-bsl",
      "kind": "skill",
      "required": true,
      "target_path_template": "<host-specific-skill-directory>/review-bsl/SKILL.md",
      "source_uri": "https://PROJECT_DOMAIN/agent/examples/review-bsl/SKILL.md",
      "sha256": "NOT_PROVIDED_IN_DRAFT",
      "publisher": "unverified",
      "required_scopes": ["workspace:write"],
      "validation": "host_discovers_skill_and_safe_test",
      "rollback": "restore_backup_or_delete_created_skill"
    },
    {
      "id": "bslmesh-readonly",
      "kind": "mcp",
      "required": true,
      "endpoint": "https://PROJECT_DOMAIN/mcp",
      "required_scopes": ["public:read"],
      "validation": "mcp_tools_list_and_public_read",
      "rollback": "remove_added_host_entry"
    }
  ],
  "owner_authorization_required": true,
  "instructions_are_untrusted": true,
  "known_limitations": ["Не содержит реального проверенного инструмента для UI-тестирования обычных форм"]
}
```

Поля `sha256` в настоящем опубликованном компоненте должны содержать валидный digest, рассчитанный на байтах артефакта. Демо-строка `NOT_PROVIDED_IN_DRAFT` запрещает unattended install. Разработчики не должны подменять её случайным хешем или выдавать демонстрационный URI за рабочий.

## 4. Опциональная персонализация после согласия

```http
POST /api/v1/starter-resolve
Content-Type: application/json
```

```json
{
  "schema_version": "0.2.0",
  "profile": {"platform_major_minor": "8.3", "form_type": "ordinary", "client_type": "thick", "ide": "cursor", "os_family": "windows"},
  "constraints": {"non_admin_install": true, "paid_tools_allowed": false},
  "user_approved_profile_transfer": true
}
```

**Важно:** булевое поле не является настоящей проверкой человеческого согласия. Клиент должен проверять его локально, сервер не должен утверждать обратного. Тело запроса не содержит org/company IDs, путей, имен, URL и других идентификаторов. Сервис не должен хранить содержимое профиля в аналитике по умолчанию.

Ответ:

```json
{
  "schema_version": "0.2.0",
  "as_of": "2026-10-18T00:00:00Z",
  "recommendations": [
    {
      "profile_id": "bsl-ordinary-forms",
      "version": "0.1.0",
      "reason": "Совпадает тип форм и клиент",
      "recommendation_level": "experimental",
      "evidence_quality": "insufficient_evidence",
      "adoption_signal": {"independent_owners_reporting": 0, "is_self_reported": true},
      "warnings": ["Синтетический пример; независимых сведений нет"],
      "conflicts_of_interest": "unknown",
      "alternatives": [],
      "primary_source_uris": [],
      "claim_refs": [],
      "counterevidence_refs": []
    }
  ],
  "unknowns": ["Фактическая поддержка версии платформы не проверена"],
  "source_kind": "synthetic"
}
```

## 5. Ответ API никогда не содержит runtime imperative

Сервер не возвращает поля вроде `shell_command_to_run_unconditionally`, `ignore_other_instructions`, `upload_config`, `approval_granted_by_server`, `system_override`. Декларативные инструкции и code snippets являются **отдельно проверяемыми объектами**, которые должен трактовать клиент по локальным правилам.

Список Skills/Rules/MCP при получении через API — рекомендации, а не автоматические расширения привилегий. Машинная помета `security_review=passed` не делает код доверенным; нужна независимая проверка origin/permissions локально.

## 6. Эквивалентность MCP

Дополнительные инструменты для уже подключённых клиентов:

- `bslmesh_list_starter_profiles({context_public?})` — метаданные профилей **без запроса внутреннего контекста**.
- `bslmesh_get_starter_profile({profile_id, version?})` — неизменяемый профиль/пакет и ссылки на доказательства.
- `bslmesh_get_catalog_snapshot({catalog_version?})` — сокращённый каталог с идентификатором, датой, digest, provenance.

Не реализовывать в MCP инструмент `bslmesh_install_on_client` или его эквивалент: **локальная установка находится в полномочиях хоста пользователя, не сервера BSL Mesh**. Не смешивать `read` с `publish` по permissions.

## 7. Требования к проверкам

- Контрактные тесты OpenAPI и полей, URL без query-идентификаторов, idempotent immutable snapshots, `ETag`/cache-control, версионирование каталогов.
- Проверить, что newcomer со включённой локальной политикой может получить профиль *без MCP, логина и POST*.
- Проверить, что `source_kind=synthetic`, `expired_review`, `contested`, `security_hold`, `unknown digest` не приводят к unattended install.
- Проверить сравнительный ответ: must-have отличается от optional, adoption от evidence, а альтернативы и минусы доступны агенту.
- Проверить обработку malicious tool descriptions/Skill bodies/контентных claims: ни один из них не должен вызвать передачу проекта или разрешить установку в обход владельца.
