/**
 * 启动后端（ingest + 面板）。
 * 用法：node scripts/start-backend.mjs [port]
 * 默认 http://127.0.0.1:3921  -> 浏览器打开看面板
 */
import { createBackendServer } from '../packages/backend/dist/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 3921);
const h = createBackendServer({
  port,
  dashboardFile: join(__dirname, '..', 'platform', 'frontend', 'index.html'),
});
await new Promise(r => h.server.once('listening', r));
console.log(`\n smarty-observability-platform backend 已启动`);
console.log(`  面板:    http://127.0.0.1:${port}`);
console.log(`  ingest:  POST http://127.0.0.1:${port}/api/events`);
console.log(`  查询:    GET  http://127.0.0.1:${port}/api/errors | /api/vitals | /api/sessions`);
console.log(`\n  Ctrl+C 退出\n`);

process.on('SIGINT', () => { h.close().then(() => process.exit(0)); });
