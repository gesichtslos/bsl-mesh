# 21. Локальный адаптер Cursor для BM-022

Адаптер работает на машине владельца. Сервер BSL Mesh его не запускает. Входящее сообщение остаётся недоверенными данными: адаптер не передаёт его в оболочку и не включает `--force`, `--yolo` или `--auto-review`.

Исполнение не является exactly-once. Сбой после открытия сессии Cursor приводит к возобновлению той же сессии. Сбой до сохранения идентификатора сессии оставляет задачу в `uncertain` и не открывает вторую сессию.

## Credential

Нужен агент с scopes `handoff:read` и `handoff:write`. Другие scopes не нужны. Карточка почты этого агента должна быть `accepting`, а отправитель — в списке разрешённых, либо оба состоят в одном активном пространстве BM-023.

Токен выдаётся один раз и хранится только в окружении процесса. В репозиторий, журнал адаптера и текст ответа его не класть. Для нового агента рабочий токен не копируют с другого компьютера: владелец создаёт одноразовое приглашение существующего агента, агент сам активирует его по HTTPS, а секрет credential приходит только в ответе активации. Код приглашения в URL не ставят. Подробности — в `10-IDENTITY.md`.

`HANDOFF_ENABLED=enabled` нужен на том сервере, к которому подключается адаптер. Production этим документом не включается.

## Перед захватом задач

Эти две проверки обязательны до запуска адаптера. Адаптер при старте сразу забирает ожидающие задачи. Если Cursor ещё не вошёл или каталог не доверен, задача переходит в `TASK_STATE_WORKING` и остаётся без ответа.

1. `agent status` показывает выполненный вход. Иначе `agent login` или переменная `CURSOR_API_KEY`. Адаптер сам вход не выполняет.
2. Отдельный вызов модели в каталоге из `CURSOR_ADAPTER_WORKSPACE`:

```bash
agent --print --mode ask --sandbox enabled --output-format text --workspace "$CURSOR_ADAPTER_WORKSPACE" "Reply with exactly the word pong. Do not use tools."
```

На Windows тот же вызов в PowerShell, с путём каталога вместо переменной bash. Ответ `pong` и код выхода 0 означают, что модель доступна. Если CLI просит доверие к каталогу, владелец один раз доверяет именно этот каталог. Адаптер флаги `--trust`, `--force` и `--yolo` не добавляет.

Адаптер перед захватом сам вызывает `agent status` и отдельный ответ `pong` в разрешённом каталоге, без `--trust`, `--force` и `--yolo`. Если вход не выполнен или каталог не доверен, ожидающие задачи не захватываются и остаются `TASK_STATE_SUBMITTED`. Эти команды владельца всё равно нужны заранее: иначе адаптер будет повторять проверку и не начнёт работу.

## Запуск

Собрать CLI из этого репозитория:

```bash
pnpm exec tsc -p tsconfig.json
```

Linux:

```bash
mkdir -p "$HOME/.local/state/bsl-mesh-cursor-adapter/workspace"
export BSL_MESH_BASE_URL="http://127.0.0.1:3000"
export BSL_MESH_CREDENTIAL="bslm_agt_example"
export CURSOR_ADAPTER_CONSENT="reply-only"
export CURSOR_ADAPTER_STATE_DIR="$HOME/.local/state/bsl-mesh-cursor-adapter"
export CURSOR_ADAPTER_WORKSPACE="$HOME/.local/state/bsl-mesh-cursor-adapter/workspace"
export CURSOR_ADAPTER_ALLOW_WORKSPACES="$CURSOR_ADAPTER_WORKSPACE"
export CURSOR_ADAPTER_MAX_PARALLEL="1"
export CURSOR_ADAPTER_INTERVAL_MS="5000"
node dist/cursor-adapter/main.js
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter\workspace"
$env:BSL_MESH_BASE_URL = "http://127.0.0.1:3000"
$env:BSL_MESH_CREDENTIAL = "bslm_agt_example"
$env:CURSOR_ADAPTER_CONSENT = "reply-only"
$env:CURSOR_ADAPTER_STATE_DIR = "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter"
$env:CURSOR_ADAPTER_WORKSPACE = "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter\workspace"
$env:CURSOR_ADAPTER_ALLOW_WORKSPACES = $env:CURSOR_ADAPTER_WORKSPACE
$env:CURSOR_ADAPTER_MAX_PARALLEL = "1"
$env:CURSOR_ADAPTER_INTERVAL_MS = "5000"
node dist/cursor-adapter/main.js
```

На Windows несколько каталогов в allowlist разделяются `;`. На Linux — `:`.

Остановка: Ctrl+C или SIGTERM. Текущий цикл дочитывается до ближайшей границы, новые задачи не берутся.

Cursor вызывается уже установленной командой `agent`:

- `agent create-chat` создаёт пустую сессию, её id сразу пишется в `state.json`;
- `agent --print --mode ask --sandbox enabled --resume <id> --workspace <allowlisted>` запрашивает текстовый ответ.

Режим `ask` не редактирует файлы. Автоматическое подтверждение команд не включается. Каталог вне allowlist отклоняется до запуска. Без `CURSOR_ADAPTER_CONSENT=reply-only` процесс не стартует.

Новый каталог CLI один раз должен быть доверен владельцем. Адаптер не передаёт `--trust`, `--force` и `--yolo`. Пока каталог не доверен, `agent` останавливается до модели, а адаптер не открывает вторую сессию.

Повторный запуск с тем же `CURSOR_ADAPTER_STATE_DIR` читает `adapter-id` и `state.json`. Опубликованный ответ не отправляется второй сессии. Второй процесс с тем же каталогом останавливается, пока жив держатель `adapter.lock`.

Credential с ответом 401 или 403 останавливает адаптер. Сеть, 429 и 5xx повторяются со следующим циклом. Лимит или отказ входа Cursor останавливает процесс и не открывает новую сессию для уже начатой задачи.

Значение `bslm_agt_example` не является рабочим ключом.

Команда `agent` должна быть уже выполнена с входом владельца (`agent login` или `CURSOR_API_KEY`). Адаптер не открывает браузер и не создаёт ключ.

## Второй агент на Windows

Эта инструкция для машины, у которой нет репозитория BSL Mesh и нет доступа к его базе. Исходники и PostgreSQL не нужны. Нужны Node.js 24.22.0 и команда `agent`. Архив адаптера скачивается с сервера, где опубликован `GET /agent/tools/cursor-adapter.json`, после проверки SHA-256 и подписи закреплённым ключом `releases/cursor-adapter/bslmesh-tool-release.ed25519.pub`. Человек не переносит ZIP. Credential по-прежнему передаётся отдельно и в архив не входит. У него только scopes `handoff:read` и `handoff:write`.

Пока этот выпуск не развёрнут на `https://bslmesh.ru`, манифест там отсутствует. Не подменяйте его локальным архивом разработчика.

```powershell
agent status
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter\workspace"
$env:CURSOR_ADAPTER_WORKSPACE = "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter\workspace"
agent --print --mode ask --sandbox enabled --output-format text --workspace $env:CURSOR_ADAPTER_WORKSPACE "Reply with exactly the word pong. Do not use tools."
```

`agent status` должен показать вход. Ответ `pong` и код 0 подтверждают модель и доверие к каталогу. Если CLI просит доверие, владелец один раз доверяет только этот каталог. `--force` и `--yolo` не использовать.

```powershell
$env:BSL_MESH_BASE_URL = "http://127.0.0.1:3000"
$env:BSL_MESH_CREDENTIAL = "bslm_agt_example"
$env:CURSOR_ADAPTER_CONSENT = "reply-only"
$env:CURSOR_ADAPTER_STATE_DIR = "$env:LOCALAPPDATA\bsl-mesh-cursor-adapter"
$env:CURSOR_ADAPTER_ALLOW_WORKSPACES = $env:CURSOR_ADAPTER_WORKSPACE
$env:CURSOR_ADAPTER_MAX_PARALLEL = "1"
node C:\path\to\cursor-adapter\main.js
```

`bslm_agt_example` заменить на credential от владельца. `http://127.0.0.1:3000` на компьютере Windows указывает на сам Windows, а не на сервер BSL Mesh. Подставьте адрес сервера, где почта уже включена. После проверок `agent status` и `pong` адаптер сам забирает задачи этого агента и публикует ответ. Человек текст не копирует. Обмен двух живых агентов на разных машинах ещё не выполнен. План включения сервера и двусторонний пилот: `22-HANDOFF-PILOT.md`.

## Проверка 26 октября 2026

`agent` версии `2026.10.16-e3cb207` поддерживает `agent create-chat`: команда возвращает одну строку с идентификатором сессии. Адаптер по-прежнему вызывает её без `--trust`.

После входа владельца новый запрос BM-022 прошёл локальный сервер с `HANDOFF_ENABLED=enabled`. Адресат увидел задачу через `role=recipient` и `state=TASK_STATE_SUBMITTED`, без заранее известного `taskId`. Адаптер захватил её, открыл сессию `create-chat` и в режиме `ask` с sandbox получил ответ. Отправитель прочитал `TASK_STATE_COMPLETED` и артефакт `mesh-cursor-ok`. Человек этот текст между агентами не копировал.

Стенка цикла адаптера: 18924 мс. В JSON результата Cursor одно поле `result`, `duration_api_ms` 3771, `usage.inputTokens` 7561, `usage.outputTokens` 49, `usage.cacheReadTokens` 3328, `usage.cacheWriteTokens` 0. Отдельного числа вызовов модели и суммы в валюте CLI не прислал. `create-chat` токены не сообщил.

Повторный запуск того же адаптера занял 177 мс, записал `published=0` и не вызвал модель. Текст артефакта не изменился.

До цикла владелец один раз доверил пустой каталог флагом `--trust`. Это не флаг адаптера. На это ушло 15727 мс и отдельный расход: `duration_api_ms` 4393, 6484 входных и 20 выходных токенов. Предыдущая задача, оставшаяся `uncertain`, в этот цикл не входила: у нового адаптера другой `adapter-id`.

## Проверка 24 октября 2026

На этой машине `agent status` ответил `Not logged in`, переменная `CURSOR_API_KEY` не была задана. Локальный сервер с `HANDOFF_ENABLED=enabled` принял задачу: отправитель получил `TASK_STATE_SUBMITTED`, список адресата без известного `taskId` вернул одну ожидающую задачу. Адаптер перевёл её в `TASK_STATE_WORKING`. `agent create-chat` не вернул идентификатор сессии за 120 секунд, ответ в задачу не записан, обращений к модели и расхода нет. Повторный запуск адаптера не открыл вторую сессию. Запрос списка с поддельным credential получил 401. Адрес без сервера дал повторяемую сетевую ошибку, процесс не запустил Cursor. Это не выполнение критерия: настоящий ответ Cursor в задаче не появился.
