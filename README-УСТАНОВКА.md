# BSL Mesh — настройка Cursor на Linux Mint (октябрь 2026)

Этот пакет **добавляет** Rules, Skills и проверку локального окружения. Не содержит сервер BSL Mesh и не изменяет существующий `AGENTS.md`, исходники или спецификацию v0.2. Не устанавливает зависимости самостоятельно.

## Что куда положить

- `.cursor/rules/*.mdc` — правила разработки, автоматически или контекстно применяемые в Cursor.
- `.agents/skills/*/SKILL.md` — переносимые навыки; Cursor автоматически их обнаруживает, можно вызвать `/название-навыка`.
- `scripts/check-env.sh` — только диагностика, не запрашивает sudo, ничего не устанавливает.
- `templates/` — примеры, **не надо** слепо копировать поверх существующих файлов.

## 1. Подготовка Linux Mint

Определи тип системы (обычный Mint — Ubuntu-based; LMDE — Debian-based):

```bash
cat /etc/os-release | grep -E '^(NAME|VERSION|ID|ID_LIKE|VERSION_CODENAME|UBUNTU_CODENAME)='
sudo apt update
sudo apt install -y git curl ca-certificates build-essential unzip jq
```

Установи Node.js 24 LTS **через менеджер версий**, а не через системный `apt install nodejs`. Например, через официальный `nvm` v0.40.3. Это загрузка стороннего скрипта: сначала прочитай файл и убедись в адресе, а уже затем запускай:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh -o /tmp/nvm-install.sh
less /tmp/nvm-install.sh
bash /tmp/nvm-install.sh
# После открытия нового терминала проверь наличие команды nvm
command -v nvm
```

Если `nvm` уже установлен, повторная установка не нужна. После установки `nvm` в новом терминале:

```bash
nvm install 24
nvm alias default 24
node --version
npm --version
corepack enable
corepack pnpm --version
```

Если `corepack` отсутствует: `npm install -g corepack`, затем `corepack enable`. Для будущего приложения зафиксируй конкретную версию pnpm через поле `packageManager` в `package.json` и коммить lockfile. Указанные команды **не** устанавливают зависимости BSL Mesh.

## 2. Docker Engine + Compose

Для Linux Mint на базе Ubuntu см. официальную инструкцию Docker для Ubuntu:
https://docs.docker.com/engine/install/ubuntu/

Docker прямо предупреждает, что производные дистрибутивы (включая Mint) не поддерживаются официально, хотя обычно работают. При добавлении репозитория Docker нужно использовать Ubuntu codename **`$UBUNTU_CODENAME`**, а не Mint codename. Для LMDE используй инструкции Debian: https://docs.docker.com/engine/install/debian/ .

**Не удаляй уже существующие контейнеры или пакеты без проверки**. Если Docker уже работает, повторная установка не нужна. Для обычного Mint c непустым `UBUNTU_CODENAME`, при отсутствии конфликтующих Docker-пакетов пример официального способа:

```bash
. /etc/os-release
echo "Ubuntu base: ${UBUNTU_CODENAME:-NOT_FOUND}"
# Следующие команды — только для Ubuntu-based Mint; не выполнять на LMDE.
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Перед исполнением убедись в корректности `UBUNTU_CODENAME` и существующих Docker-пакетов. Если `apt` сообщает о конфликтах, не удаляй пакеты автоматически — сначала выясни последствия для уже работающих контейнеров.

После установки проверь:

```bash
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
```

Возможность запускать `docker` без `sudo` через группу `docker` равнозначна root-доступу. Для начала можно работать через `sudo`, а вариант rootless Docker рассмотреть отдельно. Никогда не добавляй Cursor-агенту безусловные права sudo.

## 3. Установка правил в существующий репозиторий

1. Размести *исходную спецификацию v0.2*: `AGENTS.md` — в корне проекта, остальные markdown-документы — в `docs/`. Её архив устроен так: `bslmesh_spec/*.md`; содержимое `AGENTS.md` нельзя терять или заменять.
2. Распакуй **этот пакет** поверх корня того же проекта. В примерах ниже используются пути распакованной директории.
3. При совпадениях имён сравни содержимое и вручную объедини файлы: правила не должны тихо перезаписывать существующие.

```bash
# Пример: если ZIP находится в ~/Downloads, а проект в ~/projects/bslmesh
mkdir -p ~/projects/bslmesh
cd ~/projects/bslmesh
# Если спецификация v0.2 ещё не разложена — один раз извлеки её:
mkdir -p docs
mkdir -p /tmp/bslmesh-v02-import
unzip -n ~/Downloads/BSL_Mesh_Спецификация_для_агентов_v0.2.zip -d /tmp/bslmesh-v02-import
cp -n /tmp/bslmesh-v02-import/bslmesh_spec/AGENTS.md ./AGENTS.md
find /tmp/bslmesh-v02-import/bslmesh_spec -maxdepth 1 -name '*.md' ! -name AGENTS.md -exec cp -n -t docs {} +
# Теперь добавь новые Cursor Rules/Skills:
unzip -n ~/Downloads/BSL_Mesh_Cursor_Starter_v1.zip
bash scripts/check-env.sh
```

`unzip -n` не перезаписывает существующие файлы. Для проекта в другой директории замени путь. **Не делай `git init`, если репозиторий уже существует.**

## 4. Настройка Cursor

Открой **папку проекта**, а не отдельный файл: `File → Open Folder…` или `cursor ~/projects/bslmesh` (если команду `cursor` добавили в PATH).

- Открой Customize → Rules: убедись, что правила из `.cursor/rules` обнаружены.
- Открой Customize → Skills: увидишь навыки из `.agents/skills`.
- В `Settings → Agents → Approvals & Execution` выбери **Auto-review** либо строгий **Allowlist**. Не используй Run Everything для проекта, к которому доступны рабочие учётные записи и исходники.
- В `Read Access` (если функция есть в твоей версии Cursor) выбери **Workspace**, чтобы агент не читал файлы вне проекта без разрешения.
- Сохраняй ручное подтверждение внешних MCP, сетевых обращений, скачивания и выполнения сторонних скриптов.
- Добавь `.env*`, ключи, дампы и локальные данные в `.cursorignore` и `.gitignore`, объединив с собственными правилами; предлагаемые записи в `templates/`.

Манифест BSL Mesh v0.2 для **агентов-посетителей сайта** — отдельная политика. Это набор для **разработчиков сервера BSL Mesh**. Не путай эти два слоя.

## 5. Проверка навыков

В чате Cursor:

```text
Перечисли правила проекта, которые применяются сейчас, и доступные Skills. Прочитай AGENTS.md и docs/README.md, если такие файлы существуют. Не меняй код. Затем выполни scripts/check-env.sh и опиши фактическое состояние окружения. Назови недостающие инструменты и предложи безопасный план установки. Не запускай sudo и не скачивай сторонние скрипты без моего согласия.
```

Можно вручную вызвать `/bootstrap-bslmesh-dev`, `/implement-fastify-route`, `/implement-mcp-v2-tool`, `/review-dependency` и другие навыки.

## 6. Первый инженерный тикет

После проверки окружения попроси Cursor реализовать **P0.1 из исходной спецификации**: модульный монолит, skeleton Fastify, Postgres в Docker Compose, миграции, health endpoint, typecheck/lint/test, smoke tests и подготовку CI. Сначала план, затем выполнение и реальная проверка.

## Почему нет автоподключения сторонних MCP и Skills

Доверенные знания и инструменты нужно отличать от непроверенных инструкций из интернета. Автоматическая установка сторонних Skills/MCP небезопасна; до ознакомления с кодом и разрешениями мы предоставляем лишь прозрачные локальные файлы правил и процедур. Для MCP SDK v2 использовать `@modelcontextprotocol/server` и опционально `@modelcontextprotocol/fastify`, а не примеры старого v1 SDK. Внимание: новый wire protocol 2026-07-28 необходимо включить и протестировать явно — наличие SDK v2 само по себе не означает использования современного handshake.

## Первоисточники

- Rules: https://cursor.com/docs/rules
- Agent Skills: https://cursor.com/docs/skills
- Cursor Run Modes: https://cursor.com/docs/agent/security/run-modes
- Docker для Ubuntu/Mint: https://docs.docker.com/engine/install/ubuntu/
- MCP SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP protocol migrations: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- Node releases: https://nodejs.org/en/about/previous-releases
- Fastify: https://fastify.dev/docs/latest/
- pnpm: https://pnpm.io/
