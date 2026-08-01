import React from 'react';
import { createRoot } from 'react-dom/client';
import { initCollector } from '@monit/collector';
import { Demo } from './Demo';

// 真实接入 @monit/collector：错误 + Web Vitals(含 LCP/CLS/INP 归因) + traceparent 注入 + 面包屑 + 回放
initCollector({
  endpoint: 'http://127.0.0.1:3921/api/events',
  release: 'demo-1.0.0',
  sampleRate: 1, // 全采
});

createRoot(document.getElementById('root')!).render(React.createElement(Demo));
