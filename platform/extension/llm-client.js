// llm-client.js · 扩展端 LLM 客户端(直连,local-first)
// ----------------------------------------------------------------------------
// 移植自 packages/repair-agent/src/llm-client.ts → 纯 JS 零依赖。
// local-first:用户自带 key 存 chrome.storage,**只把「源码片段+trace+现象」发 LLM 推理**,全量数据仍在本地。
// 支持 OpenAI 兼容(/chat/completions)+ Anthropic 协议(/v1/messages)。429/5xx 指数退避,4xx 立即抛。
// 为 ai-rca(真根因)+ ai-heal(真自愈)提供 LLM 能力 —— 淘汰规则启发式与模板白名单的基础设施。
(function (global) {
  // 预设 provider(用户可在设置改 baseUrl/model)
  const PROVIDERS = {
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'openai' },
    ark: { label: 'ARK doubao(火山)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', protocol: 'openai', modelHint: '填 endpoint id(如 ep-xxxxxxxx)' },
    minimax: { label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-Text-01', protocol: 'openai' },
    zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', protocol: 'openai' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai' },
    ollama: { label: 'Ollama(本地)', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b', protocol: 'openai' },
    custom: { label: '自定义(OpenAI 兼容)', baseUrl: '', model: '', protocol: 'openai' },
  };
  const LLM_KEY = 'inp_copilot_llm';

  function normalizeBaseUrl(baseUrl) {
    let url = (baseUrl || '').replace(/\/+$/, '');
    if (/^https?:\/\/(localhost|127\.0\.0\.1):11434$/.test(url) && !url.endsWith('/v1')) url += '/v1';
    return url;
  }
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, Object.assign({}, init, { signal: controller.signal })); }
    finally { clearTimeout(timer); }
  }

  // 核心 chat。config={baseUrl,apiKey,model,temperature,protocol,maxRetries,timeoutMs}
  async function chat(config, messages) {
    if (!config || !config.baseUrl || !config.model) throw { llmError: 'LLM 配置不完整(需 baseUrl+model+apiKey)' };
    return (config.protocol === 'anthropic') ? chatAnthropic(config, messages) : chatOpenAi(config, messages);
  }

  async function chatOpenAi(config, messages) {
    const url = normalizeBaseUrl(config.baseUrl) + '/chat/completions';
    const maxRetries = config.maxRetries != null ? config.maxRetries : 3;
    const timeoutMs = config.timeoutMs != null ? config.timeoutMs : 60000;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
          body: JSON.stringify({ model: config.model, messages, temperature: config.temperature != null ? config.temperature : 0.2, stream: false }),
        }, timeoutMs);
        if (!res.ok) {
          if (RETRYABLE.has(res.status) && attempt < maxRetries) { await sleep(Math.min(8000, 500 * Math.pow(2, attempt))); continue; }
          throw { httpStatus: res.status, llmError: 'LLM ' + res.status + ': ' + (await res.text().catch(() => res.statusText)).slice(0, 200) };
        }
        const data = await res.json();
        return { content: (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '', usage: data && data.usage };
      } catch (err) {
        if (err && err.httpStatus) throw err; // 4xx 不可重试,立即抛
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) { await sleep(500 * Math.pow(2, attempt)); continue; }
      }
    }
    throw lastErr || { llmError: 'LLM chat failed' };
  }

  async function chatAnthropic(config, messages) {
    const url = normalizeBaseUrl(config.baseUrl) + '/v1/messages';
    const maxRetries = config.maxRetries != null ? config.maxRetries : 3;
    const timeoutMs = config.timeoutMs != null ? config.timeoutMs : 60000;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const convo = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body = Object.assign({ model: config.model, max_tokens: 2048, temperature: config.temperature != null ? config.temperature : 0.2 }, system ? { system } : {}, { messages: convo.length ? convo : [{ role: 'user', content: '' }] });
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }, config.apiKey ? { 'x-api-key': config.apiKey } : {}),
          body: JSON.stringify(body),
        }, timeoutMs);
        if (!res.ok) {
          if (RETRYABLE.has(res.status) && attempt < maxRetries) { await sleep(Math.min(8000, 500 * Math.pow(2, attempt))); continue; }
          throw { httpStatus: res.status, llmError: 'LLM ' + res.status };
        }
        const data = await res.json();
        const content = Array.isArray(data && data.content) ? data.content.map((c) => c.text || '').join('') : ((data && data.content) || '');
        return { content, usage: data && data.usage ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens } : undefined };
      } catch (err) {
        if (err && err.httpStatus) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) { await sleep(500 * Math.pow(2, attempt)); continue; }
      }
    }
    throw lastErr || { llmError: 'LLM chat failed' };
  }

  function extractJson(text) {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const cand = fenced ? fenced[1] : text;
    const s = cand.indexOf('{'), e = cand.lastIndexOf('}');
    if (s === -1 || e === -1 || e <= s) return null;
    try { return JSON.parse(cand.slice(s, e + 1)); } catch { return null; }
  }
  async function chatJson(config, messages) { const r = await chat(config, messages); return extractJson(r.content); }

  async function preflight(config) {
    if (!config || !config.baseUrl) return { ok: false, error: '无 baseUrl' };
    const url = normalizeBaseUrl(config.baseUrl) + '/models';
    try {
      const res = await fetch(url, { headers: config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {} });
      return res.ok ? { ok: true } : { ok: false, error: 'models endpoint ' + res.status };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  // chrome.storage 配置读写。precedence:**用户在「设置」填的 key 优先**(本地自带 key 是 local-first 核心);
  // dev-llm-key.js 仅作「storage 无可用 apiKey 时」的兜底默认(开发开箱即用),不再无条件覆盖 UI。
  // 此前 dev-llm-key 存在即胜出 → 用户切 provider/换 key 在 UI 改了也不生效(静默被覆盖)。
  function getConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(LLM_KEY, (r) => {
          const stored = (r && r[LLM_KEY]) || null;
          if (stored && stored.apiKey) return resolve(stored);                  // 用户配置优先
          if (globalThis.__devLlmKey && globalThis.__devLlmKey.apiKey) return resolve(globalThis.__devLlmKey); // 兜底默认
          resolve(stored); // 不完整配置:交给调用方(ai-rca/ai-heal)报「未配置」
        });
      } catch {
        if (globalThis.__devLlmKey && globalThis.__devLlmKey.apiKey) return resolve(globalThis.__devLlmKey);
        resolve(null);
      }
    });
  }
  function setConfig(cfg) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [LLM_KEY]: cfg }, () => resolve(true)); } catch { resolve(false); }
    });
  }
  // 选 provider → 应用预设 baseUrl/model(保留用户已填 apiKey)
  function applyProvider(providerKey, existing) {
    const p = PROVIDERS[providerKey] || PROVIDERS.custom;
    const e = existing || {};
    return { provider: providerKey, baseUrl: p.baseUrl, model: p.model || e.model || '', protocol: p.protocol, apiKey: e.apiKey || '', temperature: e.temperature != null ? e.temperature : 0.2 };
  }

  global.__llm = { PROVIDERS, LLM_KEY, chat, chatJson, chatOpenAi, chatAnthropic, extractJson, preflight, getConfig, setConfig, applyProvider, normalizeBaseUrl };
})(typeof globalThis !== 'undefined' ? globalThis : self);
