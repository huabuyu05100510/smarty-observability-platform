import React, { useState } from 'react';

// 故意含 bug 的函数：未防御 null，调用 renderList(null) 会抛 TypeError（采集到真实堆栈 → sourcemap 还原到本文件）
function renderList(items: string[] | null): React.ReactNode {
  // items! 仅编译期断言非空；运行时仍为 null.map → 抛 TypeError（演示采集用，勿加 ?? 兜底）
  return items!.map((x) => <li key={x}>{x}</li>);
}

// 触发慢请求（采集 request 监控 + traceparent 注入 → 跨层 trace join）
function slowRequest() {
  fetch('https://jsonplaceholder.typicode.com/todos/1').then(
    (r) => r.json().then((d) => alert('收到响应（慢请求会被采集）: ' + JSON.stringify(d).slice(0, 80))),
    () => alert('网络错误会被采集为 request 事件'),
  );
}

export function Demo() {
  const [items, setItems] = useState<string[] | null>(null);
  return (
    <div style={{ fontFamily: 'system-ui,sans-serif', maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
      <h1>@monit/collector 真实采集演示</h1>
      <p>所有操作的真实数据会采集到 backend（http://127.0.0.1:3921 面板）。</p>

      <h3>1. 触发错误（→ 错误收件箱 + sourcemap 还原源码）</h3>
      <button onClick={() => setItems(['a', 'b', 'c'])}>渲染列表（首次为 null → TypeError）</button>{' '}
      <button onClick={() => { (null as unknown as { map: (cb: (x: string) => string) => string[] }).map((x) => x); }}>
        直接触发 null.map
      </button>

      <h3>2. Web Vitals 归因</h3>
      <p>切换标签页/滚动几下产生 INP/CLS，LCP 首屏自动采集（带归因：LCP 资源/元素、CLS 目标、INP 三段）。</p>

      <h3>3. 慢请求 / traceparent</h3>
      <button onClick={slowRequest}>发送请求（采集 request + traceparent 注入）</button>

      <h3>列表输出</h3>
      <ul>{renderList(items)}</ul>
    </div>
  );
}
