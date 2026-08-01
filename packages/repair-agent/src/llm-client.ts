/**
 * @monit/repair-agent/llm-client - OpenAI 兼容 LLM 客户端（含 Ollama 本地）
 *
 * 吸收 sentinel-x llm-client 的核心：URL 归一化（localhost:11434 -> /v1）、
 * SSE 流式、429/503 指数退避。简化为干净抽象。
 *
 * 支持 OpenAI 兼容端点（OpenAI / DeepSeek / Moonshot / Ollama / vLLM）。
 */

export interface LLMConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  /** 最大重试 */
  maxRetries?: number;
  /** 单次请求超时 ms（默认 30000）。超时视为可重试错误。*/
  timeoutMs?: number;
  /** 协议格式：openai（/chat/completions）| anthropic（/v1/messages）。默认 openai。 */
  provider?: 'openai' | 'anthropic';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** 把 localhost:11434 这类 Ollama base 归一为 OpenAI 兼容的 /v1 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1):11434$/.test(url) && !url.endsWith('/v1')) {
    url += '/v1';
  }
  return url;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 不可重试的 HTTP 错误（4xx 鉴权/参数等）。命中即抛，不烧退避重试。 */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** fetch + 超时（AbortController）。无超时则挂起的 socket 会拖死整条 pipeline。 */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 同步 chat completion（非流式）。429/5xx 指数退避重试。
 */
export async function chat(config: LLMConfig, messages: ChatMessage[]): Promise<ChatResult> {
  // Anthropic 协议端点（如 Volcengine ARK 的 Claude 兼容网关）走 /v1/messages
  if (config.provider === 'anthropic') return chatAnthropic(config, messages);
  return chatOpenAi(config, messages);
}

async function chatOpenAi(config: LLMConfig, messages: ChatMessage[]): Promise<ChatResult> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const maxRetries = config.maxRetries ?? 3;
  const timeoutMs = config.timeoutMs ?? 30_000;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: config.temperature ?? 0.2,
          stream: false,
        }),
      }, timeoutMs);

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
          continue;
        }
        // 不可重试（4xx 鉴权/参数错误等）：立即抛 HttpError，catch 不再重试，避免白白烧退避
        throw new HttpError(res.status, `LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return { content, usage: data?.usage };
    } catch (err) {
      // 不可重试 HTTP 错误（401/403/400…）直接抛；仅对网络错误/超时这类瞬态错误重试
      if (err instanceof HttpError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError ?? new Error('LLM chat failed');
}

/**
 * Anthropic 协议（/v1/messages，如 Volcengine ARK Claude 兼容网关）。
 * 消息里 system 角色抽成顶层 system 字段，user/assistant 保留为 messages。
 * 响应取 content[0].text。
 */
async function chatAnthropic(config: LLMConfig, messages: ChatMessage[]): Promise<ChatResult> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/v1/messages`;
  const maxRetries = config.maxRetries ?? 3;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const convo = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 2048,
          temperature: config.temperature ?? 0.2,
          ...(system ? { system } : {}),
          messages: convo.length > 0 ? convo : [{ role: 'user', content: '' }],
        }),
      }, timeoutMs);

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
          continue;
        }
        throw new HttpError(res.status, `LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }

      const data = await res.json();
      const content = Array.isArray(data?.content)
        ? data.content.map((c: { text?: string }) => c.text ?? '').join('')
        : (data?.content ?? '');
      return { content, usage: data?.usage ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens } : undefined };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError ?? new Error('LLM chat failed');
}

/**
 * chat + JSON 解析。失败时返回 null（调用方决定降级策略）。
 * 用于 Verifier / Diagnoser 的结构化输出。
 */
export async function chatJson<T = unknown>(config: LLMConfig, messages: ChatMessage[]): Promise<T | null> {
  const { content } = await chat(config, messages);
  return extractJson<T>(content);
}

/** 从可能含 markdown fence / 前后噪声的文本中提取 JSON */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  // 去 markdown fence
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // 找第一个 { 到最后一个 }（容忍前后噪声）
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 预检 LLM 可达性（probe /models 或 /chat/completions ping） */
export async function preflight(config: LLMConfig): Promise<{ ok: boolean; error?: string }> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/models`;
  try {
    const res = await fetch(url, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `models endpoint ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}