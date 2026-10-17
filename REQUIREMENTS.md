# Требования к серверу (REQUIREMENTS)

Список того, что нужно установить на машине, куда переносится проект.

## 1. Минимальные требования к железу

| Параметр | Значение |
|---|---|
| ОС | Linux x86_64/arm64 (Debian/Ubuntu) или Windows 10/11, Windows Server 2016+ |
| RAM | от 1 ГБ (с Ollama — ориентируйтесь на модель) |
| Диск | от 1 ГБ (проект + БД + медиа) |
| CPU | любой; GPU нужен только для Ollama |

## 2. Обязательное ПО

| ПО | Зачем | Версия |
|---|---|---|
| **Node.js** | рантайм веб-консоли и бота | **≥ 24 LTS** (обязательно: БД работает через `node:sqlite`) |
| **npm** | установка зависимостей (идёт с Node) | ≥ 10 |
| **tar** / **unzip** | распаковка архива переноса | любые |
| **git** | клонирование репозитория (если перенос не архивом) | ≥ 2.30 |

Установка Node.js (NodeSource, Debian/Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git tar unzip
```

Либо через nvm (без sudo):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
```

> ⚠️ На Node 22.x модуль `node:sqlite` может требовать флаг `--experimental-sqlite`.
> На Node 24+ и 26 работает без флага. Проверка:
> ```bash
> node -e "new (require('node:sqlite').Database)(':memory:'); console.log('node:sqlite OK')"
> ```

## 3. Опциональное ПО

| ПО | Зачем | Установка |
|---|---|---|
| **Tailscale** | доступ к вебу по tailnet + HTTPS без домена (`tailscale serve`), связь с Ollama | `curl -fsSL https://tailscale.com/install.sh \| sh` затем `sudo tailscale up` |
| **Ollama** | распознавание шильдиков в боте (Vision) | `curl -fsSL https://ollama.com/install.sh \| sh` затем `ollama pull qwen3.5:4b` |
| **sqlite3** CLI | инспекция БД, чекпоинт WAL | `sudo apt-get install -y sqlite3` |
| **systemd** | автозапуск веба и бота как служб | обычно уже есть |

> OLLAMA не обязательна, если она уже работает на другой машине в tailnet — тогда просто
> укажите её адрес в `OLLAMA_URL` (см. ниже).

## 4. Что НЕ требуется

- Компиляторы/C++ (все зависимости — чистый JS). `build-essential` не нужен.
- Docker (можно, но не обязательно).
- Веб-сервер (nginx и т.п.) — не нужен, если используете `tailscale serve`.

## 5. Переменные окружения (`.env`)

Скопируйте `.env.example` → `.env` и заполните. Ключевые:

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
| `LLM_PROVIDER` | `ollama` (по умолчанию) или `openai` |
| `OLLAMA_URL` | адрес Ollama; допускает список через запятую (failover) |
| `OLLAMA_MODEL` | модель, например `qwen3.5:4b` |
| `ORDER_STATUS` | статус новых заявок (по умолчанию `Новая Заявка`) |
| `MEDIA_DIR` | папка медиа (по умолчанию `bot/storage/media`) |
| `WHITELIST_FILE` | файл доступа бота (по умолчанию `whitelist.json`) |

Пример для Ollama на другой машине в tailnet:

```env
OLLAMA_URL=http://100.x.y.z:11434
# или с фолбэком на локальную:
OLLAMA_URL=http://127.0.0.1:11434,http://100.x.y.z:11434
```

## 6. Сеть и порты

| Порт | Назначение | Доступ |
|---|---|---|
| 3000 | веб-консоль (`next start`) | только loopback + `tailscale serve` |
| 11434 | Ollama | только внутри tailnet |

Проверка после установки:

```bash
node -p "process.version"
node -e "new (require('node:sqlite').Database)(':memory:'); console.log('sqlite OK')"
tailscale status   # если используется Tailscale
```

## 7. Windows (кратко)

Шаги те же; отличия от Linux:

| Задача | Windows |
|---|---|
| Node.js 24+ | `winget install OpenJS.NodeJS.LTS` |
| Скрипты переноса | `scripts\migrate.ps1` (обёртка `scripts\migrate.cmd`), команды те же |
| Автозапуск | `install-service` — Task Scheduler (по умолчанию) или `-Method Nssm` (служба) вместо systemd |
| Упаковка/распаковка | встроенные `robocopy` / `Expand-Archive` / `ZipFile` — ставить ничего не нужно |
| sqlite3 CLI | опционально: `winget install SQLite.SQLite` |
| Ollama / Tailscale | те же продукты, ставятся через winget или с сайта |

```powershell
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 check
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 deploy
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 install-service
```

> Пути к медиа в БД хранятся относительно корня проекта, поэтому «источник правды»
> держите на одной ОС и переносите проект целиком вместе с `bot\storage`.
