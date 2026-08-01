/**
 * 有界请求体读取 —— 取代无上限的 `data += chunk`。
 *
 * 按【字节】累计（非字符数），超 maxBytes 立即 413 + `req.destroy()`，防 OOM。
 * 支持 gzip-base64 解码（沿用 platform 既有上报约定：Content-Encoding: gzip-base64）。
 */
import { gunzipSync } from 'node:zlib';

export interface ReadStreamLike {
  // listener 用 any[] 参数以兼容 Node EventEmitter（避免与具体回调逆变冲突）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'data' | 'end' | 'error', listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): unknown;
}

export interface BodyResult {
  ok: boolean;
  status: number;
  bytes?: string;
  error?: string;
}

export function readBody(req: ReadStreamLike, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (r: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(r);
    };

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        finish({ ok: false, status: 413, error: 'payload too large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, status: 200, bytes: Buffer.concat(chunks).toString('utf-8') });
    const onError = (): void => finish({ ok: false, status: 400, error: 'request stream error' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 解码上报体：支持 Content-Encoding: gzip-base64（collector compress 通道）。
 * @param raw 原始文本
 * @param encoding content-encoding 头值
 */
export function decodeBody(raw: string, encoding?: string): string {
  if (!raw) return raw;
  const enc = (encoding ?? '').toLowerCase();
  if (enc.includes('gzip')) {
    try {
      const compressed = Buffer.from(raw, 'base64');
      return gunzipSync(compressed).toString('utf-8');
    } catch {
      return raw; // 解码失败返回原样，让上层 JSON.parse 自然失败返 400
    }
  }
  return raw;
}
