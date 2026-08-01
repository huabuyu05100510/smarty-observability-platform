import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  HttpRouter,
  RateLimiter,
  TokenBucket,
  readBody,
  generateSigningKeyPair,
  signPatch,
  verifyPatchSignatureNode,
  publicKeyToSpkiBase64,
  validatePatchCodeStrict,
  countChangedLines,
  createEd25519Verifier,
  type GuardConfig,
  type RouteSpec,
} from '../src/index';

function makeCfg(over: Partial<GuardConfig> = {}): GuardConfig {
  const rl = (c: number, r: number) => new RateLimiter({ capacity: c, refillPerSec: r });
  const base: GuardConfig = {
    authToken: undefined,
    sdkToken: undefined,
    allowOrigins: [],
    allowLoopbackOrigin: true,
    bodyMax: { write: 1_000_000, read: 1_000_000, sdk: 100_000, open: 10_000 },
    rateLimit: { write: rl(1000, 1000), read: rl(1000, 1000), sdk: rl(1000, 1000), open: rl(1000, 1000) },
    audit: undefined,
  };
  return { ...base, ...over, rateLimit: { ...base.rateLimit, ...(over.rateLimit ?? {}) } };
}

async function start(routes: RouteSpec[], cfg: GuardConfig): Promise<{ url: string; close: () => Promise<void> }> {
  const router = new HttpRouter(cfg, routes);
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('HttpRouter 守卫链', () => {
  it('write 端点：无 token / 错 token 401，正确 token 200', async () => {
    const routes: RouteSpec[] = [
      { method: 'POST', path: '/api/events', policy: 'write', handler: async () => ({ status: 200, body: { ok: true } }) },
    ];
    const { url, close } = await start(routes, makeCfg({ authToken: 'secret' }));
    try {
      expect((await fetch(`${url}/api/events`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(`${url}/api/events`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
      const ok = await fetch(`${url}/api/events`, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: '{}' });
      expect(ok.status).toBe(200);
    } finally { await close(); }
  });

  it('跨源（非白名单 Origin）写请求 403', async () => {
    const routes: RouteSpec[] = [
      { method: 'POST', path: '/api/events', policy: 'write', handler: async () => ({ status: 200, body: { ok: true } }) },
    ];
    const { url, close } = await start(routes, makeCfg({ authToken: 'secret' }));
    try {
      const r = await fetch(`${url}/api/events`, {
        method: 'POST',
        headers: { Origin: 'https://evil.com', Authorization: 'Bearer secret' },
        body: '{}',
      });
      expect(r.status).toBe(403);
    } finally { await close(); }
  });

  it('限流：超桶 429', async () => {
    const routes: RouteSpec[] = [
      { method: 'POST', path: '/api/events', policy: 'write', handler: async () => ({ status: 200, body: { ok: true } }) },
    ];
    const cfg = makeCfg({ authToken: 'secret' });
    cfg.rateLimit.write = new RateLimiter({ capacity: 2, refillPerSec: 0.01 });
    const { url, close } = await start(routes, cfg);
    try {
      const post = () => fetch(`${url}/api/events`, { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{}' });
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(429);
    } finally { await close(); }
  });

  it('路由优先级：精确 > 带参（/api/errors/trend 不被 :fp 吃）', async () => {
    const routes: RouteSpec[] = [
      { method: 'GET', path: '/api/errors/:fp', policy: 'read', handler: async (c) => ({ status: 200, body: { fp: c.params.fp } }) },
      { method: 'GET', path: '/api/errors/trend', policy: 'read', handler: async () => ({ status: 200, body: { trend: true } }) },
    ];
    const { url, close } = await start(routes, makeCfg());
    try {
      const trend = await (await fetch(`${url}/api/errors/trend`)).json();
      expect(trend).toEqual({ trend: true });
      const fp = await (await fetch(`${url}/api/errors/abc123`)).json();
      expect(fp).toEqual({ fp: 'abc123' });
    } finally { await close(); }
  });

  it('未注册路径 404（且不泄露 handler）', async () => {
    const { url, close } = await start([], makeCfg());
    try {
      expect((await fetch(`${url}/nope`)).status).toBe(404);
    } finally { await close(); }
  });

  it('sdk policy 用独立 sdkToken', async () => {
    const routes: RouteSpec[] = [
      { method: 'GET', path: '/heal/patches', policy: 'sdk', handler: async () => ({ status: 200, body: { patches: [] } }) },
    ];
    const { url, close } = await start(routes, makeCfg({ authToken: 'write-secret', sdkToken: 'sdk-secret' }));
    try {
      expect((await fetch(`${url}/heal/patches`, { headers: { Authorization: 'Bearer write-secret' } })).status).toBe(401);
      expect((await fetch(`${url}/heal/patches`, { headers: { Authorization: 'Bearer sdk-secret' } })).status).toBe(200);
    } finally { await close(); }
  });
});

describe('readBody（有界）', () => {
  function mockStream(): unknown {
    const ee = new EventEmitter();
    return Object.assign(ee, {
      destroy(): void { /* noop */ },
      off(ev: string, fn: (...a: unknown[]) => void): unknown { ee.removeListener(ev, fn as (...a: unknown[]) => void); return this; },
    });
  }
  it('超限 → 413', async () => {
    const s = mockStream() as never;
    const p = readBody(s as never, 100);
    (s as EventEmitter).emit('data', Buffer.alloc(150));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.status).toBe(413);
  });
  it('正常 → ok', async () => {
    const s = mockStream();
    const p = readBody(s as never, 1000);
    (s as EventEmitter).emit('data', Buffer.from('hello'));
    (s as EventEmitter).emit('end');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe('hello');
  });
});

describe('Ed25519 签名（node sign ↔ node verify ↔ WebCrypto verify）', () => {
  const patch = { id: 'p', fingerprint: 'f', patchType: 'replace', targetPath: 'a', code: '1', nonce: 'n', createdAt: 1, expiresAt: 2 };
  it('三端互通：node 签，node/WebCrypto 验均 true；篡改 false', async () => {
    const kp = generateSigningKeyPair();
    const sig = signPatch(kp.privateKey, patch);
    expect(verifyPatchSignatureNode(kp.publicKey, patch, sig)).toBe(true);
    expect(verifyPatchSignatureNode(kp.publicKey, { ...patch, code: '2' }, sig)).toBe(false);

    const verifier = createEd25519Verifier(publicKeyToSpkiBase64(kp.publicKey));
    await expect(verifier(patch, sig)).resolves.toBe(true);
    await expect(verifier({ ...patch, nonce: 'replay' }, sig)).resolves.toBe(false);
  });
});

describe('validatePatchCodeStrict（acorn AST 白名单）', () => {
  it('允许简单行为保留代码', () => {
    expect(validatePatchCodeStrict('function(x){ return x ?? [] }').ok).toBe(true);
    expect(validatePatchCodeStrict('function(orig){ return function(...a){ return orig.apply(this, a) } }').ok).toBe(true);
    expect(validatePatchCodeStrict('1').ok).toBe(true);
  });
  it('拒绝网络/全局/DOM 标识符', () => {
    for (const bad of ['fetch("/x")', 'window.location', 'document.cookie', 'eval("1")', 'localStorage.x', 'setTimeout(x,1)', 'globalThis.x']) {
      expect(validatePatchCodeStrict(bad).ok, bad).toBe(false);
    }
  });
  it('拒绝 NewExpression / 循环 / await / yield', () => {
    expect(validatePatchCodeStrict('new Function("x")').ok).toBe(false);
    expect(validatePatchCodeStrict('new Array(1)').ok).toBe(false);
    expect(validatePatchCodeStrict('for(;;){1}').ok).toBe(false);
  });
  it('拒绝原型链 / computed 动态属性访问危险字面量', () => {
    expect(validatePatchCodeStrict('x.constructor').ok).toBe(false);
    expect(validatePatchCodeStrict('this["eval"]').ok).toBe(false);
    expect(validatePatchCodeStrict('o.__proto__').ok).toBe(false);
  });
  it('★ 拒绝 Function 构造器逃逸（computed 拼字符串/变量 → RCE，曾漏洞）', () => {
    // 直接静态 .constructor 被标识符黑名单拦
    expect(validatePatchCodeStrict('(()=>{}).constructor').ok).toBe(false);
    // 拼字符串 computed 拿 Function：曾绕过字面量检查，现已禁一切 computed
    expect(validatePatchCodeStrict('(()=>{})["con"+"structor"]').ok).toBe(false);
    expect(validatePatchCodeStrict('(()=>{})["con"+"structor"]("return process.version")()').ok).toBe(false);
    // 变量 computed 同理
    expect(validatePatchCodeStrict('(()=>{})[name]').ok).toBe(false);
    // this 经 computed 拿 constructor（this 本身允许，但 computed 全禁 → 闭环）
    expect(validatePatchCodeStrict('this["con"+"structor"]').ok).toBe(false);
    // 合法 wrap 转发仍可用（静态属性 + this 调用上下文，无 computed）
    expect(validatePatchCodeStrict('function(orig){ return function(...a){ return orig.apply(this, a) } }').ok).toBe(true);
  });
  it('拒绝 URL / 协议字面量（含模板）', () => {
    expect(validatePatchCodeStrict('"https://evil.com"').ok).toBe(false);
    expect(validatePatchCodeStrict('`${"data:text/html,x"}`').ok).toBe(false);
  });
  it('拒绝语法错误 / 超长', () => {
    expect(validatePatchCodeStrict('function({').ok).toBe(false);
    expect(validatePatchCodeStrict('a'.repeat(5000)).ok).toBe(false);
  });
});

describe('countChangedLines（真实 diff）', () => {
  it('LCS 行差', () => {
    expect(countChangedLines('a\nb', 'a\nb')).toBe(0);
    expect(countChangedLines('a\nb', 'a\nc')).toBe(2);
    expect(countChangedLines('', 'a\nb')).toBe(2);
    expect(countChangedLines('a', 'a\nb\nc')).toBe(2);
    expect(countChangedLines('x\ny\nz', 'x\nz')).toBe(1); // 删 y（removed=1, added=0）
  });
});

describe('TokenBucket', () => {
  it('容量耗尽后拒绝，补充后恢复', () => {
    const b = new TokenBucket(3, 0); // 不补充
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});
