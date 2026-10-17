import fs from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger';

/**
 * Простой загрузчик .env (без внешних зависимостей).
 * Значения из реального окружения имеют приоритет над файлом.
 */
function loadEnvFile(): void {
  const file = path.join(process.cwd(), '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // .env не обязателен
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export type LlmProviderName = 'ollama' | 'openai';

function env(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function envInt(key: string, fallback: number): number {
  const n = Number(env(key, String(fallback)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Целое >= 0 (0 допустим — например, «без ретраев»). */
function envCount(key: string, fallback: number): number {
  const raw = env(key, '');
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = env(key, '').toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

/** Список значений через запятую; пустые элементы отбрасываются. */
function envList(key: string, fallback: string[]): string[] {
  const raw = env(key, '');
  if (raw === '') return fallback;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// OLLAMA_URL допускает список через запятую — для failover между площадками
// (например, локальный хост для разработки и удалённый хост ребят по Tailscale).
const ollamaUrls = envList('OLLAMA_URL', ['http://127.0.0.1:11434']).map(normalizeUrl);

export const config = {
  telegramToken: env('TELEGRAM_BOT_TOKEN'),
  llm: {
    provider: (env('LLM_PROVIDER', 'ollama').toLowerCase() === 'openai'
      ? 'openai'
      : 'ollama') as LlmProviderName,
    // Локальная модель (Ollama, native API).
    // Важно: 127.0.0.1, а не localhost — Ollama слушает только IPv4,
    // иначе Node иногда пытается уйти в ::1 и падает с "fetch failed".
    ollamaUrls,
    // Обратная совместимость: основной (первый) адрес.
    ollamaUrl: ollamaUrls[0] ?? 'http://127.0.0.1:11434',
    ollamaModel: env('OLLAMA_MODEL', 'qwen3.5:4b'),
    // Держим модель в памяти, чтобы не платить холодную загрузку на каждом фото.
    ollamaKeepAlive: env('OLLAMA_KEEP_ALIVE', '30m'),
    // Внешний OpenAI-совместимый API
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiApiKey: env('OPENAI_API_KEY'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
    // Надёжность (по умолчанию поведение как раньше: один адрес, без фолбэка)
    timeoutMs: envInt('LLM_TIMEOUT_MS', 180000),
    totalBudgetMs: envInt('LLM_TOTAL_BUDGET_MS', 180000),
    retries: envCount('LLM_RETRIES', 3),
    retryDelayMs: envInt('LLM_RETRY_DELAY_MS', 1000),
    fallbackToOpenAI: envBool('LLM_FALLBACK_TO_OPENAI', false),
    healthcheckOnStart: envBool('LLM_HEALTHCHECK', true),
    healthcheckTimeoutMs: envInt('LLM_HEALTHCHECK_TIMEOUT_MS', 5000),
  },
  photoDir: path.resolve(process.cwd(), env('PHOTO_DIR', 'bot/storage/photos')),
  mediaDir: path.resolve(process.cwd(), env('MEDIA_DIR', 'bot/storage/media')),
  whitelistFile: path.resolve(process.cwd(), env('WHITELIST_FILE', 'whitelist.json')),
  orderStatus: env('ORDER_STATUS', 'Новая Заявка'),
};

export function assertConfig(): void {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан. Укажите токен в .env');
  }
  if (config.llm.provider === 'openai' && !config.llm.openaiApiKey) {
    throw new Error('LLM_PROVIDER=openai, но OPENAI_API_KEY не задан. Укажите ключ в .env');
  }
  if (config.llm.provider === 'ollama' && config.llm.fallbackToOpenAI && !config.llm.openaiApiKey) {
    logWarn('LLM_FALLBACK_TO_OPENAI=true, но OPENAI_API_KEY не задан — фолбэк отключён.');
  }
}
