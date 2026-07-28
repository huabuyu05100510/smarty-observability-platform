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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 同步 chat completion（非流式）。429/5xx 指数退避重试。
 */
export async function chat(config: LLMConfig, messages: ChatMessage[]): Promise<ChatResult> {
  const url = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
  const maxRetries = config.maxRetries ?? 3;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
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
      });

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          const backoff = Math.min(8000, 500 * Math.pow(2, attempt));
          await sleep(backoff);
          continue;
        }
        throw new Error(`LLM ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return { content, usage: data?.usage };
    } catch (err) {
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