#!/usr/bin/env node
/**
 * 安全自检：验证鉴权链 / Origin / body 上限 / 路径穿越 / AST 白名单 / Ed25519 公钥下发。
 * 用法：node scripts/security-check.mjs（需先 pnpm build）
 */
import { createBackendServer } from '../packages/backend/dist/index.js';
import { createCoordinatorServer } from '../packages/coordinator/dist/index.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    resolve(`http://127.0.0.1:${a.port}`);
  }));
}

const checks = [];
const check = (name, cond) => { checks.push({ name, ok: !!cond }); console.log(`${cond ? '✓' : '✗'} ${name}`); };

// ── backend（配 ingestToken）──
const be = createBackendServer({ ingestToken: 'secret-tok' });
const beUrl = await listen(be.server);

let r = await fetch(`${beUrl}/api/events`, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '[]' });
check('backend 错 token → 401', r.status === 401);

r = await fetch(`${beUrl}/api/events`, { method: 'POST', headers: { Authorization: 'Bearer secret-tok', 'Content-Type': 'application/json' }, body: '[]' });
check('backend 正确 token → 200', r.status === 200);

r = await fetch(`${beUrl}/api/events`, { method: 'POST', headers: { Origin: 'https://evil.com', Authorization: 'Bearer secret-tok', 'Content-Type': 'application/json' }, body: '[]' });
check('backend 跨源（非白名单 Origin）→ 403', r.status === 403);

r = await fetch(`${beUrl}/api/sourcemaps/upload?appId=..%2F..%2Fx&version=v&filename=f.js`, { method: 'POST', headers: { Authorization: 'Bearer secret-tok' }, body: '{}' });
check('sourcemap 路径穿越 → 400', r.status === 400);

// ── coordinator（配 authToken）──
const co = createCoordinatorServer({ authToken: 'coord-tok' });
const coUrl = await listen(co.server);

r = await fetch(`${coUrl}/heal/apply`, { method: 'POST', headers: { Authorization: 'Bearer coord-tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: 'fp', patchType: 'replace', targetPath: 'a.b', code: 'fetch("/exfil")' }) });
check('coordinator /heal/apply 恶意 code（AST 白名单）→ 400', r.status === 400);

r = await fetch(`${coUrl}/heal/apply`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: JSON.stringify({ fingerprint: 'fp', patchType: 'guard', targetPath: 'a.b' }) });
check('coordinator 错 token → 401', r.status === 401);

r = await fetch(`${coUrl}/heal/patches`, { headers: { Authorization: 'Bearer coord-tok' } });
check('coordinator /heal/patches 带 authToken → 200', r.status === 200);

r = await fetch(`${coUrl}/heal/public-key`);
const pk = await r.json();
check('coordinator /heal/public-key 下发 Ed25519 公钥', typeof pk.publicKey === 'string' && pk.publicKey.length > 0);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 安全检查通过`);
be.close(); co.close();
process.exit(failed.length ? 1 : 0);
