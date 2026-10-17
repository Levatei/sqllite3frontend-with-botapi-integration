import { config } from './config';
import { logInfo, logWarn } from './logger';

export interface Nameplate {
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  production_date: string | null;
  article_number: string | null;
}

/** Схема ответа модели (structured output). */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    manufacturer: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    serial_number: { type: ['string', 'null'] },
    production_date: { type: ['string', 'null'] },
    article_number: { type: ['string', 'null'] },
  },
  required: [
    'manufacturer',
    'model',
    'serial_number',
    'production_date',
    'article_number',
  ],
} as const;

const PROMPT =
  'Ты распознаёшь заводскую табличку (шильдик) промышленного оборудования по фотографии. ' +
  'Верни только поля схемы. Дату изготовления приведи к формату YYYY-MM-DD, если это возможно. ' +
  'Если поле не читается — верни null. Не придумывай данные.';

function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'null' || s === '—' || s === '-' || s === 'n/a') return null;
  return s;
}

function parseJsonLoose(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    /* пробуем вытащить объект из произвольного текста */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

/** Стоит ли повторять запрос: сетевые сбои, таймауты и ошибки сервера (5xx). */
function isRetriable(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
    if (/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|other side closed/i.test(error.message)) {
      return true;
    }
    const http = /HTTP (\d{3})/.exec(error.message);
    if (http) return Number(http[1]) >= 500;
  }
  return false;
}

/** Один запрос к конкретному эндпоинту Ollama. */
async function ollamaChatOnce(url: string, imageBase64: string, timeoutMs: number): Promise<string> {
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llm.ollamaModel,
      stream: false,
      think: false, // без "размышлений" — в разы быстрее
      keep_alive: config.llm.ollamaKeepAlive, // не выгружать модель из памяти
      format: RESPONSE_SCHEMA,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: PROMPT, images: [imageBase64] }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

/**
 * Вызывает Ollama с failover по списку адресов (config.llm.ollamaUrls) и
 * ретраями на каждый адрес, не выходя за общий бюджет времени.
 * По умолчанию адрес один — поведение как раньше.
 * Возвращает текст ответа и адрес, который ответил.
 */
async function callOllama(imageBase64: string): Promise<{ content: string; url: string }> {
  const urls = config.llm.ollamaUrls;
  const deadline = Date.now() + config.llm.totalBudgetMs;
  let lastError: unknown;

  for (const url of urls) {
    try {
      const content = await withRetry(
        `Ollama ${url}`,
        () =>
          ollamaChatOnce(
            url,
            imageBase64,
            Math.min(config.llm.timeoutMs, Math.max(1000, deadline - Date.now()))
          ),
        config.llm.retries,
        deadline
      );
      if (urls.length > 1) logInfo(`Ollama ответила: ${url}`);
      return { content, url };
    } catch (e) {
      lastError = e;
      if (Date.now() >= deadline) break;
      if (url !== urls[urls.length - 1]) {
        logWarn(`Ollama недоступна на ${url} — пробую следующий адрес`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callOpenAI(imageBase64: string): Promise<string> {
  const res = await fetch(`${config.llm.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.openaiModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Повторяет операцию при разовых сетевых сбоях (например, "fetch failed",
 * когда модель ещё поднимается). Пауза растёт: retryDelayMs, 2×, ...
 * При не-восстановимой ошибке (например 4xx) повторять бессмысленно — выходим.
 * Опционально ограничена дедлайном (общий бюджет времени LLM).
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts: number,
  deadline = Number.POSITIVE_INFINITY
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const cause = (e as { cause?: unknown }).cause;
      logWarn(`${label}: попытка ${attempt}/${attempts} не удалась`, {
        error: String(e),
        cause: cause ? String(cause) : undefined,
      });
      if (!isRetriable(e)) break;
      const remaining = deadline - Date.now();
      if (attempt < attempts && remaining > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(config.llm.retryDelayMs * attempt, remaining))
        );
      }
    }
  }
  throw lastError;
}

/**
 * Прогрев: заранее загружает модель в память и продлевает keep_alive,
 * чтобы первое фото пользователя не ждало холодного старта.
 */
export async function warmupModel(): Promise<void> {
  if (config.llm.provider !== 'ollama') return;
  // Прогреваем все адреса из списка (локальный dev + удалённый prod по Tailscale).
  for (const url of config.llm.ollamaUrls) {
    try {
      const startedAt = Date.now();
      await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.llm.ollamaModel,
          stream: false,
          think: false,
          keep_alive: config.llm.ollamaKeepAlive,
          options: { num_predict: 1, temperature: 0 },
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(config.llm.timeoutMs),
      });
      logInfo(`Прогрев модели завершён за ${Date.now() - startedAt}ms`, { url });
    } catch (e) {
      logWarn('Прогрев модели не удался (не критично)', { url, error: String(e) });
    }
  }
}

export interface OllamaHealth {
  url: string;
  ok: boolean;
  modelPresent: boolean;
  error?: string;
}

/**
 * Проверка доступности эндпоинта Ollama и наличия нужной модели (GET /api/tags).
 * Никогда не бросает исключение — используется как диагностика при старте.
 */
export async function pingOllama(url: string, model: string): Promise<OllamaHealth> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(config.llm.healthcheckTimeoutMs),
    });
    if (!res.ok) return { url, ok: false, modelPresent: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
    const base = model.split(':')[0];
    const modelPresent = names.some((n) => n === model || n.split(':')[0] === base);
    return { url, ok: true, modelPresent };
  } catch (e) {
    return { url, ok: false, modelPresent: false, error: String(e) };
  }
}

/** Распознаёт данные шильдика через выбранный провайдер (Ollama или OpenAI). */
export async function extractNameplate(imageBase64: string): Promise<Nameplate> {
  const startedAt = Date.now();
  let raw: string;
  let usedProvider = config.llm.provider;
  let usedEndpoint: string;

  if (config.llm.provider === 'openai') {
    raw = await withRetry('OpenAI', () => callOpenAI(imageBase64), config.llm.retries);
    usedEndpoint = config.llm.openaiBaseUrl;
  } else {
    try {
      // callOllama сам делает failover по адресам и ретраи.
      const viaOllama = await callOllama(imageBase64);
      raw = viaOllama.content;
      usedEndpoint = viaOllama.url;
    } catch (e) {
      const canFallback = config.llm.fallbackToOpenAI && Boolean(config.llm.openaiApiKey);
      if (!canFallback) throw e;
      logWarn('Ollama недоступна — переключаюсь на OpenAI', { error: String(e) });
      raw = await withRetry('OpenAI (fallback)', () => callOpenAI(imageBase64), config.llm.retries);
      usedProvider = 'openai';
      usedEndpoint = config.llm.openaiBaseUrl;
    }
  }

  const parsed = parseJsonLoose(raw);
  const result: Nameplate = {
    manufacturer: normalize(parsed.manufacturer),
    model: normalize(parsed.model),
    serial_number: normalize(parsed.serial_number),
    production_date: normalize(parsed.production_date),
    article_number: normalize(parsed.article_number),
  };
  logInfo(`Распознавание заняло ${Date.now() - startedAt}ms`, {
    provider: usedProvider,
    endpoint: usedEndpoint,
    model: usedProvider === 'openai' ? config.llm.openaiModel : config.llm.ollamaModel,
    result,
  });
  return result;
}
