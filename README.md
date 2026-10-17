# MBA-Garant

Веб-консоль учёта ремонтов оборудования (приёмка насосов) + Telegram-бот для быстрого
занесения техники по фото шильдика. Один SQLite-файл как база данных, без внешнего сервера БД.

## Для чего нужен

- Вести учёт клиентов, оборудования и заявок на ремонт в одной веб-панели.
- Видеть заявки на канбан-доске по статусам (Новая → Диагностика → В работе → Готово → Выдано).
- Заносить технику «с колёс»: сотрудник фотографирует шильдик в Telegram — бот распознаёт
  производителя, модель и серийный номер и создаёт заявку.
- Хранить медиафайлы (фото/видео) по клиентам и оборудованию.
- Переключаться между несколькими базами прямо из интерфейса.

## Как это работает

```
┌──────────────────────┐        ┌───────────────────────────────┐
│  Telegram (grammy)   │        │   Веб-консоль (Next.js)       │
│  бот: фото шильдика  │        │   канбан, таблицы, медиа      │
└─────────┬────────────┘        └──────────────┬────────────────┘
          │  Node API (lib/db.ts)               │  HTTP /api/*
          │                                     │
          └──────────────┬──────────────────────┘
                         ▼
              ┌──────────────────────┐      ┌──────────────────┐
              │  SQLite  (*.db)      │      │  Ollama (Vision) │
              │  clients/equipment/  │      │  распознавание   │
              │  orders/media        │      │  шильдиков       │
              └──────────────────────┘      └──────────────────┘
```

- **Веб и бот работают с одним и тем же SQLite-файлом** напрямую (через `lib/db.ts`), поэтому
  запускать их надо из корня проекта (все пути — от текущего каталога).
- **Ollama** нужна только боту и только для распознавания фото. Без неё веб-консоль работает полностью.
- **Медиа** хранятся на диске (`bot/storage/...`), в базе — только пути.

## Стек

| Слой | Технологии |
|---|---|
| Веб | Next.js 13 (App Router), React 18, TypeScript |
| Стили | собственный CSS + Tailwind (preflight) |
| БД | SQLite через встроенный `node:sqlite` |
| Бот | grammy (long polling) |
| Распознавание | Ollama (Vision) или любой OpenAI-совместимый API |
| Рантайм | Node.js ≥ 24 |

## Структура проекта

```
app/                 Next.js: страницы и API-роуты (/api/tables, /api/kanban, /api/media, …)
components/          UI-компоненты (канбан, таблицы, модалки, медиа)
hooks/               Хуки данных (databases, orders, records, kanban, media, form)
lib/                 Ядро: db.ts (SQLite), api.ts (клиент), logger.ts, media-store.ts
bot/                 Telegram-бот: index.ts, db.ts, vision.ts, config.ts, whitelist.ts
scripts/             build-mva-dataset.js (генерация датасета), migrate.sh (перенос/развёртывание)
.env.example         Шаблон переменных окружения
REQUIREMENTS.md      Что установить на сервере
```

## Быстрый старт (локально)

> Требуется **Node.js ≥ 24**. Подробнее — в [REQUIREMENTS.md](REQUIREMENTS.md).

**1. Установить зависимости**

```bash
npm ci
```

**2. Настроить окружение**

```bash
cp .env.example .env          # заполнить TELEGRAM_BOT_TOKEN и др.
cp whitelist.example.json whitelist.json   # вписать chat_id сотрудников
```

**3. Положить базу данных**

Поместите файл `mba_data.db` в корень проекта. Если базы ещё нет — она создаётся
через интерфейс (кнопка добавления БД). Пути к базам хранит `dblist.json` (генерируется сам).

**4. Собрать и запустить веб-консоль**

```bash
npm run build     # сборка
npm start         # запуск (по умолчанию http://localhost:3000)
```

Для разработки с горячей перезагрузкой: `npm run dev`.

**5. (Опционально) Запустить Telegram-бота**

```bash
ollama pull qwen3.5:4b   # если используете Ollama
npm run bot              # или npm run bot:dev — с авто-перезапуском
```

> ⚠️ Бот использует **long polling**: нельзя запускать два процесса с одним токеном
> (Telegram вернёт конфликт). Держите только один экземпляр.

## Переменные окружения

Полный список — в `.env.example`. Основные:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | токен бота от @BotFather |
| `LLM_PROVIDER` | `ollama` | `ollama` или `openai` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | адрес Ollama (можно список через запятую) |
| `OLLAMA_MODEL` | `qwen3.5:4b` | модель распознавания |
| `ORDER_STATUS` | `Новая Заявка` | статус новых заявок из бота |
| `MEDIA_DIR` | `bot/storage/media` | папка медиафайлов |
| `WHITELIST_FILE` | `whitelist.json` | файл доступа бота |

## Развёртывание на сервере

Коротко: скопировать проект и состояние → установить зависимости → собрать → запустить.

```bash
npm ci
npm run build
npx next start -H 127.0.0.1 -p 3000
tailscale serve --bg 3000        # HTTPS без домена, доступ только из tailnet
```

Полезные скрипты:

```bash
npm run typecheck   # проверка типов
npm run lint        # линтер
```

Автозапуск (systemd) и полный сценарий переноса — см. `scripts/migrate.sh` и
[REQUIREMENTS.md](REQUIREMENTS.md).

## Перенос на другой сервер

Готовый помощник: `scripts/migrate.sh`.

```bash
# 1. На исходной машине — упаковать код + состояние (БД, .env, whitelist, медиа)
./scripts/migrate.sh export

# 2. Передать архив на целевой сервер (например, по Tailscale)
tailscale file cp migrate-out/*.tar.gz <target>:

# 3. На целевом сервере — распаковать и развернуть
tar xzf mba-garant-*.tar.gz -C /opt/mba-garant
cd /opt/mba-garant
./scripts/migrate.sh check     # проверить окружение и БД
./scripts/migrate.sh deploy    # npm ci + npm run build
./scripts/migrate.sh serve     # запустить веб
```

### Windows

На Windows — тот же помощник на PowerShell: `scripts\migrate.ps1` (или обёртка
`scripts\migrate.cmd`). Команды: `check`, `export`, `deploy`, `serve`, `bot`, `doctor`,
`install-service [-Method Task|Nssm]`.

```powershell
# упаковать код + состояние в migrate-out\*.zip
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 export

# на целевой машине:
Expand-Archive mba-garant-*.zip -DestinationPath C:\mba-garant
cd C:\mba-garant
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 check
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 deploy
powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 serve
```

Автозапуск: `install-service` — по умолчанию через Task Scheduler, либо `-Method Nssm`
(настоящая служба с автостартом). Нужен Node.js 24+ (`winget install OpenJS.NodeJS.LTS`).

## Безопасность и данные

- `.env`, `whitelist.json`, все `*.db`, медиа и логи **не попадают в git** (см. `.gitignore`).
- Для переноса секреты передаются отдельно (архивом `migrate.sh export`), предпочтительно
  по приватному каналу (Tailscale).
- SQLite не любит одновременную запись из нескольких копий приложения: держите **один**
  экземпляр веба и **один** экземпляр бота на одной базе.
