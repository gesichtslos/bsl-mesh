# ADR 0001 — runtime P0.1

## Контекст

P0.1 поднимает модульный монолит без доменных сущностей и без MCP. Версии сверены с npm и официальными образами 18 октября 2026.

## Решения

- Компилятор — TypeScript 7.0.2 через зависимость `@typescript/native` (`npm:typescript@7.0.2`), бинарь `tsc`. Пакет `typescript` указывает на `@typescript/typescript6@6.0.2`: у TypeScript 7.0 нет стабильного compiler API, а `typescript-eslint@8.71.2` принимает только `typescript >=4.8.4 <6.1.0`. `pnpm toolchain` проверяет Node `24.22.0`, pnpm `12.14.0`, lockfile и это разделение до lint и сборки.
- ESLint остаётся на линии 9 (`eslint@9.39.5`). Актуальный major 10.13.0 совместим с typescript-eslint, но план P0.1 фиксирует flat config ESLint 9.
- HTTP — Fastify 5.12.7. Ветка Fastify 6 на эту дату только alpha. Клиент PostgreSQL — `pg@8.23.1` плюс `@types/pg@8.23.1`: пакет `pg` не указывает types в `exports` для NodeNext.
- PostgreSQL — образ `postgres:18.6`. Том данных смонтирован в `/var/lib/postgresql`: так устроен официальный образ начиная с PostgreSQL 18. Пример в `templates/` с `postgres:17` и путём `/var/lib/postgresql/data` не использован.
- Миграции — свои SQL-файлы и раннер на `pg`. Отдельный CLI миграций не добавлялся.
- Отдельный worker-процесс не запущен. Правило контейнеров предполагает worker рядом с приложением, но в P0.1 нет фоновой задачи. Пустой процесс не добавляется; worker появится вместе с первой реальной работой очереди.
- В контейнере приложение слушает `0.0.0.0:3000`, а Compose публикует его только на `127.0.0.1:3000`. Локальный запуск без Docker по-прежнему задаёт `HOST=127.0.0.1`.
- Staging Caddy (`caddy:2.11.7`) описан в `compose.staging.yaml` и использует `tls internal`. Файл не запускается и не запрашивает публичный сертификат, пока оператор не утвердит домен.
- `pnpm test:integration` работает только при `NODE_ENV=test` и `TEST_DATABASE_URL`. Имя базы должно оканчиваться на `_test` и отличаться от `DATABASE_URL`. Роль должна оканчиваться на `_tester`, не быть суперпользователем, не создавать базы и не иметь `CONNECT` к базе приложения. Сброс схемы выполняется после этих проверок. Подготовка роли: `pnpm prepare:test-db`.
- Пароль `ci-disposable` и `ci-disposable-test` в workflow — учётные данные одноразовой базы GitHub Actions, не секрет развёртывания. Локальный пароль живёт только в неотслеживаемом `.env`.

## Откат

Обычный откат описан в `docs/ops/rollback.md` и состоит из трёх отдельных команд: `scripts/stop.sh`, `scripts/rollback-app.sh <image>` и `scripts/restore-backup.sh <dump> <target-database>`. Удаление томов выполняет только `scripts/destroy-test-env.sh` при `CONFIRM_DESTROY_TEST_ENV=yes`; это уничтожение локального тестового окружения, а не откат версии.
