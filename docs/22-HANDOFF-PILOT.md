# 22. Межмашинный пилот BM-022

Production не включается этим документом. `https://bslmesh.ru` почту не обслуживает, пока владелец отдельно не разрешит выкладку.

`main` на момент подготовки не содержит ветку адаптера. Работа идёт от `feature/cursor-handoff-adapter`.

## 1. План включения на bslmesh.ru

Включать только после отдельного разрешения. Не пересоздавать базу и Caddy.

1. Убедиться, что публикуемый коммит содержит миграции `011_handoff.sql` и `012_workspaces.sql`.
2. Снять резервную копию базы существующей процедурой до миграции.
3. На сервере обновить дерево до этого коммита и запустить только службу `migrate` из `docs/18-PRODUCTION.md`. Миграции добавляют таблицы почты и пространств и расширяют список scopes. Они не удаляют данные.
4. В файле окружения production, не в git, добавить `HANDOFF_ENABLED=enabled`. TLS и сертификат не меняются: сайт уже отвечает по HTTPS.
5. Пересоздать только контейнер приложения. Анонимный `GET /api/v1/handoff/tasks` должен ответить 401, а не 404. `GET /health/ready` остаётся 200.
6. Создать двух агентов отдельными владельцами и выдать каждому только `handoff:read` и `handoff:write`. Токены не записывать в репозиторий, тикет или отчёт. Скрипт `scripts/prepare-handoff-credentials.mjs` отказывается работать, если адрес — `bslmesh.ru`.
7. Проверить изоляцию: чужой credential получает ту же 404, что и для несуществующей задачи. Журнал хранит идентификаторы и действие, без текста сообщения и без токена.

Откат: убрать `HANDOFF_ENABLED` или поставить `disabled` и пересоздать только контейнер приложения. Маршруты снова отвечают как отсутствующие. Таблицы не удалять. Удаление таблиц без копии базы не является откатом.

## 2. Credentials

Для локальной подготовки, не для production:

```bash
BSL_MESH_BASE_URL=http://127.0.0.1:3017 node scripts/prepare-handoff-credentials.mjs
```

Скрипт пишет `linux-agent.json` и `windows-agent.json` в `~/.local/state/bsl-mesh-handoff-credentials` с правами `0600`. В стандартный вывод попадают только каталог и идентификаторы агентов.

На сервере bslmesh.ru те же scopes выдаёт владелец после включения почты, через уже существующие маршруты credentials. Готовые токены передаются каждому компьютеру отдельно.

## 3. Пакет для Windows

Сборка на машине, где есть исходники:

```bash
pnpm exec tsc -p tsconfig.json
node scripts/pack-cursor-adapter.mjs
node build/bsl-mesh-cursor-adapter/verify.mjs
```

Архив `build/bsl-mesh-cursor-adapter.zip` и его sha256 не коммитятся. На Windows проверяют `node verify.mjs` в распакованном каталоге. Дальше действует раздел «Второй агент на Windows» в `21-CURSOR-ADAPTER.md`. Исходники и база на тот компьютер не копируются.

`127.0.0.1` в `BSL_MESH_BASE_URL` на Windows — это сам Windows. Для пилота нужен адрес достижимого сервера.

## 4. Двусторонний пилот

Оба компьютера заранее проходят `agent status` и ответ `pong` в своём каталоге. Адаптер не захватывает ожидающую задачу, если проверка не прошла.

1. Linux отправляет задачу агенту Windows:

```bash
node scripts/handoff-exchange.mjs send --base https://server.example --credential-file ~/.local/state/bsl-mesh-handoff-credentials/linux-agent.json --recipient <windows-agent-id> --text "Reply with exactly mesh-from-linux. Do not use tools or edit files."
```

2. Адаптер на Windows публикует ответ. Linux ждёт:

```bash
node scripts/handoff-exchange.mjs wait --base https://server.example --credential-file ~/.local/state/bsl-mesh-handoff-credentials/linux-agent.json --task <task-id>
```

3. Windows отправляет ответную задачу агенту Linux тем же `send`, с credential Windows и `--recipient` агента Linux. Адаптер Linux публикует ответ. Windows выполняет `wait`.

Человек не копирует текст. Повторный запуск адаптера не создаёт второй ответ. Обрыв сети до захвата оставляет задачу в `TASK_STATE_SUBMITTED`. Повтор той же отправки с тем же `messageId` не создаёт вторую задачу; скрипт каждый раз берёт новый идентификатор, поэтому повторный `send` — это новая задача.

## 5. Критерии проверки

Пилот готов к запуску на двух машинах, когда:

- сервер с включённой почтой отвечает 401 на анонимный список задач и 200 на `/health/ready`;
- у двух агентов есть только `handoff:read` и `handoff:write`, токены не лежат в git;
- пакет Windows проходит `node verify.mjs`;
- на обеих машинах `agent status` показывает вход, а `pong` проходит в разрешённом каталоге;
- Linux получает артефакт от Windows, затем Windows получает артефакт от Linux;
- второй запуск адаптера не меняет уже опубликованный артефакт;
- при недоступном сервере или неготовном CLI новая задача не переходит в `TASK_STATE_WORKING`.

Пока production не включён, последний пункт про две физические машины не выполнен.
