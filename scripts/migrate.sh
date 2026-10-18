#!/usr/bin/env bash
#
# migrate.sh — перенос и развёртывание MBA-Garant.
#
# Подкоманды:
#   check            Проверить окружение (Node, node:sqlite, .env, БД)
#   export [zip|tar] [tag]  Упаковать КОД + СОСТОЯНИЕ (БД, .env, whitelist, медиа); tag → mba-garant-<tag>-*
#   deploy           Установить зависимости и собрать (npm ci + npm run build)
#   serve            Запустить веб-консоль (next start)
#   bot              Запустить Telegram-бота
#   install-service  Сгенерировать systemd-юниты (нужен root)
#   doctor           Быстрая проверка, что веб и БД отвечают
#
# Адрес и порт веб-консоли берутся из .env (WEB_HOST/WEB_PORT). Переменные
# окружения WEB_HOST/WEB_PORT перекрывают значения из .env.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_NODE_MAJOR=24

# read_env KEY [DEFAULT] — значение из .env (последнее вхождение) или DEFAULT.
read_env() {
  local key="$1" def="${2:-}" line
  [ -f "$ROOT/.env" ] || { printf '%s' "$def"; return; }
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ROOT/.env" 2>/dev/null | tail -n1 || true)"
  line="${line#*=}"                                       # всё после первого '='
  line="${line%$'\r'}"                                    # снять CR (если .env в CRLF)
  line="${line#"${line%%[![:space:]]*}"}"                 # ltrim
  line="${line%"${line##*[![:space:]]}"}"                 # rtrim
  line="${line#\"}"; line="${line%\"}"; line="${line#\'}"; line="${line%\'}"
  printf '%s' "${line:-$def}"
}

# Приоритет: переменная окружения > .env > значение по умолчанию
WEB_HOST="${WEB_HOST:-$(read_env WEB_HOST "$(read_env HOST '127.0.0.1')")}"
WEB_PORT="${WEB_PORT:-$(read_env WEB_PORT "$(read_env PORT '3000')")}"
OUT_DIR="${OUT_DIR:-$ROOT/migrate-out}"

# ---------- вывод ----------
c_reset=$'\033[0m'; c_blue=$'\033[1;34m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_green=$'\033[1;32m'
log()  { printf '%s==>%s %s\n' "$c_blue"   "$c_reset" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_green"  "$c_reset" "$*"; }
warn() { printf '%s[!]%s %s\n'  "$c_yellow" "$c_reset" "$*" >&2; }
die()  { printf '%s[x]%s %s\n'  "$c_red"    "$c_reset" "$*" >&2; exit 1; }

usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
  exit 0
}

# ---------- проверки ----------
need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js не найден. Смотрите REQUIREMENTS.md"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    warn "Node v$major < $MIN_NODE_MAJOR. Нужен Node $MIN_NODE_MAJOR+ (для node:sqlite)."
  fi
  node -e "new (require('node:sqlite').Database)(':memory:')" >/dev/null 2>&1 \
    || die "node:sqlite недоступен. На Node 22.x нужен флаг --experimental-sqlite; лучше Node $MIN_NODE_MAJOR+."
}

list_dbs() {
  find "$ROOT" -maxdepth 2 -name '*.db' -not -path '*/node_modules/*' 2>/dev/null | sort
}

# Консистентный снимок SQLite-базы (VACUUM INTO) без остановки приложения.
snapshot_db() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  rm -f "$dst"
  DB_SRC="$src" DB_DST="$dst" node -e '
    const { Database } = require("node:sqlite");
    const db = new Database(process.env.DB_SRC, { readOnly: true });
    const out = process.env.DB_DST.replace(/\x27/g, "\x27\x27");
    db.exec("VACUUM INTO \x27" + out + "\x27");
    db.close();
  '
}

# ---------- check ----------
cmd_check() {
  log "Проверка окружения"
  need_node;            ok "Node $(node -p 'process.version')"
  command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || die "npm не найден"

  if [ -f .env ]; then ok ".env найден"
  else warn ".env отсутствует — скопируйте .env.example → .env и заполните"; fi

  if [ -f whitelist.json ]; then ok "whitelist.json найден"
  else warn "whitelist.json отсутствует — скопируйте whitelist.example.json"; fi

  local dbs; dbs="$(list_dbs)"
  if [ -n "$dbs" ]; then
    ok "Найдены базы данных:"
    printf '     %s\n' $dbs
  else
    warn "Базы данных не найдены. Положите *.db в корень проекта."
  fi

  if [ -f dblist.json ]; then ok "dblist.json найден (активная БД: $(node -p 'require("./dblist.json").active' 2>/dev/null || echo '?'))"
  else warn "dblist.json отсутствует — будет создан по умолчанию (mba_data.db)"; fi

  [ -d bot/storage ] && ok "bot/storage на месте" || warn "bot/storage отсутствует — медиафайлы не найдутся"

  ok "Веб-консоль: http://$WEB_HOST:$WEB_PORT"

  if command -v tailscale >/dev/null 2>&1; then
    tailscale status >/dev/null 2>&1 && ok "Tailscale подключён" || warn "Tailscale установлен, но не подключён (tailscale up)"
  else
    warn "Tailscale не установлен (опционально)"
  fi
}

# ---------- export ----------
cmd_export() {
  local fmt="${1:-tar}"
  local tag="${2:-}"
  need_node
  local stamp name dir
  stamp="$(date +%F-%H%M%S)"
  name="mba-garant${tag:+-$tag}-$stamp"
  dir="$OUT_DIR/$name"

  log "Собираю пакет переноса в $dir"
  mkdir -p "$dir"

  # 1. Код и конфиги, кроме состояния и артефактов
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude 'node_modules' --exclude '.next' --exclude '.git' \
      --exclude 'logs' --exclude '*.tsbuildinfo' \
      --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
      --exclude 'migrate-out' --exclude '*.zip' --exclude '*.tgz' --exclude '*.tar.gz' \
      "$ROOT"/ "$dir"/
  else
    tar -C "$ROOT" \
      --exclude='./node_modules' --exclude='./.next' --exclude='./.git' \
      --exclude='./logs' --exclude='*.tsbuildinfo' \
      --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
      --exclude='./migrate-out' --exclude='*.zip' --exclude='*.tgz' --exclude='*.tar.gz' \
      -cf - . | tar -C "$dir" -xf -
  fi

  # 2. Консистентные снимки баз (без WAL-обломков)
  local db rel
  while IFS= read -r db; do
    [ -n "$db" ] || continue
    rel="${db#"$ROOT"/}"
    log "  снимок БД: $rel"
    snapshot_db "$db" "$dir/$rel"
  done < <(list_dbs)

  # 3. Архив
  local archive
  if [ "$fmt" = "zip" ]; then
    command -v zip >/dev/null 2>&1 || die "zip не установлен"
    archive="$OUT_DIR/$name.zip"
    ( cd "$OUT_DIR" && zip -qr "$archive" "$name" )
  else
    archive="$OUT_DIR/$name.tar.gz"
    tar czf "$archive" -C "$OUT_DIR" "$name"
  fi
  rm -rf "$dir"

  ok "Готово: $archive"
  echo
  echo "Содержимое включает СЕКРЕТЫ (.env, whitelist.json) и БД — передавайте приватно."
  echo "Пример передачи по Tailscale:  tailscale file cp \"$archive\" <target>:"
}

# ---------- deploy ----------
cmd_deploy() {
  need_node
  if [ ! -f .env ]; then
    warn ".env не найден — копирую из .env.example (не забудьте заполнить!)"
    cp .env.example .env
  fi
  [ -f whitelist.json ] || { cp whitelist.example.json whitelist.json; warn "создан whitelist.json из примера — впишите chat_id"; }

  log "Устанавливаю зависимости (npm ci)"
  npm ci
  log "Сборка (npm run build)"
  npm run build
  ok "Развёртывание завершено. Запуск: ./scripts/migrate.sh serve"
}

# ---------- serve / bot ----------
cmd_serve() {
  need_node
  log "Запуск веб-консоли на http://$WEB_HOST:$WEB_PORT"
  exec npx next start -H "$WEB_HOST" -p "$WEB_PORT"
}

cmd_bot() {
  need_node
  log "Запуск Telegram-бота"
  exec npm run bot
}

# ---------- doctor ----------
cmd_doctor() {
  local url="http://$WEB_HOST:$WEB_PORT"
  log "Проверка $url"
  for p in / /api/tables; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url$p" || echo 000)"
    printf '  %-14s -> %s\n' "$p" "$code"
  done
}

# ---------- install-service ----------
cmd_install_service() {
  [ "$(id -u)" -eq 0 ] || die "Запустите с sudo"
  local runner; runner="$(id -un)"
  command -v systemctl >/dev/null 2>&1 || die "systemd не найден"
  local node_bin; node_bin="$(command -v node)"

  log "Создаю systemd-юниты (WorkingDirectory=$ROOT, порт $WEB_PORT)"
  cat > /etc/systemd/system/mba-web.service <<EOF
[Unit]
Description=MBA-Garant web console
After=network-online.target

[Service]
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
ExecStart=$node_bin $ROOT/node_modules/.bin/next start -H $WEB_HOST -p $WEB_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/mba-bot.service <<EOF
[Unit]
Description=MBA-Garant Telegram bot
After=network-online.target

[Service]
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
ExecStart=$node_bin $ROOT/node_modules/.bin/tsx $ROOT/bot/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  ok "Юниты созданы: mba-web.service, mba-bot.service"
  echo "Включить:  sudo systemctl enable --now mba-web mba-bot"
  echo "HTTPS:     sudo tailscale serve --bg $WEB_PORT"
}

# ---------- диспетчер ----------
case "${1:-}" in
  check)            cmd_check ;;
  export)           shift; cmd_export "${1:-tar}" "${2:-}" ;;
  deploy)           cmd_deploy ;;
  serve)            cmd_serve ;;
  bot)              cmd_bot ;;
  doctor)           cmd_doctor ;;
  install-service)  cmd_install_service ;;
  -h|--help|help|"") usage ;;
  *) die "Неизвестная команда: $1 (запустите без аргументов для справки)" ;;
esac
