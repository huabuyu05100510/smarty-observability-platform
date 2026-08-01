import React from 'react';
import { createRoot } from 'react-dom/client';
import { initCollector } from '@monit/collector';
import { Demo } from './Demo';

// 立即渲染（采集/热修异步起，不阻塞 UI）
createRoot(document.getElementById('root')!).render(React.createElement(Demo));

const COLLECTOR_ENDPOINT = 'http://127.0.0.1:3921/api/events';
const COORDINATOR_URL = 'http://127.0.0.1:3920';

// 真实接入 @monit/collector：错误 + Web Vitals(含 LCP/CLS/INP 归因) + traceparent 注入 + 面包屑 + 回放
// + 轨道 A 运行时热修：coordinator 可达时拉取 Ed25519 公钥 → 启用 HotfixClient
//   （验签 + 防重放/过期 + 指纹匹配后应用签名 patch，保留 rollback 句柄）。
// coordinator 未启动 → 仅采集（热修静默跳过；demo 不强依赖 coordinator）。
const startCollector = (hotfix?: { registryUrl: string; publicKey: string }) =>
  initCollector({
    endpoint: COLLECTOR_ENDPOINT,
    release: 'demo-1.0.0',
    sampleRate: 1, // 全采
    ...(hotfix ? { hotfix } : {}),
  });

fetch(`${COORDINATOR_URL}/heal/public-key`)
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => (d && d.publicKey ? { registryUrl: `${COORDINATOR_URL}/heal/patches`, publicKey: d.publicKey as string } : undefined))
  .then((hf) => startCollector(hf))
  .catch(() => startCollector()); // coordinator 拒连 → 仅采集
