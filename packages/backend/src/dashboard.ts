/**
 * @monit/backend/dashboard - 内置面板 HTML（vanilla，零构建）
 *
 * 展示错误收件箱（指纹分组）/ Web Vitals 聚合 / Session 列表。
 * 点错误分组下钻看 stack + breadcrumbs。
 */

export const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>smarty-observability-platform · dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #0b0e14; color: #e6e6e6; }
  .header { padding: 16px 24px; background: #11151c; border-bottom: 1px solid #1f2630; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .header .sub { color: #8b95a5; font-size: 13px; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 24px; }
  .panel { background: #11151c; border: 1px solid #1f2630; border-radius: 8px; padding: 16px; }
  .panel h2 { margin: 0 0 12px; font-size: 14px; color: #c9d1d9; }
  .row { padding: 8px 0; border-bottom: 1px solid #1f2630; cursor: pointer; }
  .row:hover { background: #161b24; }
  .row:last-child { border-bottom: none; }
  .count { display: inline-block; min-width: 32px; padding: 2px 8px; border-radius: 4px; background: #2d1b1b; color: #ff6b6b; font-size: 12px; font-weight: 600; margin-right: 8px; text-align: center; }
  .msg { color: #d1d5db; font-size: 13px; }
  .meta { color: #6b7280; font-size: 11px; margin-top: 2px; }
  .vital { display: flex; justify-content: space-between; padding: 6px 0; }
  .vital .name { font-weight: 600; }
  .good { color: #3fb950; } .ni { color: #d29922; } .poor { color: #f85149; }
  .detail { grid-column: 1 / -1; }
  pre { background: #0b0e14; padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; border: 1px solid #1f2630; }
  .empty { color: #6b7280; font-size: 13px; padding: 16px 0; text-align: center; }
  button { background: #1f2630; color: #e6e6e6; border: 1px solid #2d3748; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
</style>
</head>
<body>
<div class="header">
  <h1>smarty-observability-platform</h1>
  <div class="sub">端到端可观测 + 自愈 · 确定性×AI · <button onclick="refresh()">refresh</button></div>
</div>
<div class="grid">
  <div class="panel"><h2>错误收件箱（指纹分组）</h2><div id="errors"><div class="empty">loading...</div></div></div>
  <div class="panel"><h2>Web Vitals（p75 / p99）</h2><div id="vitals"><div class="empty">loading...</div></div></div>
  <div class="panel"><h2>Sessions</h2><div id="sessions"><div class="empty">loading...</div></div></div>
  <div class="panel detail" id="detail-panel" style="display:none"><h2>错误详情</h2><div id="detail"></div></div>
</div>
<script>
async function get(path) {
  const r = await fetch(path);
  return r.json();
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }
function ratingClass(r) { return r === 'good' ? 'good' : r === 'poor' ? 'poor' : 'ni'; }

async function refresh() {
  try {
    const [errData, vitData, sessData] = await Promise.all([
      get('/api/errors'), get('/api/vitals'), get('/api/sessions')
    ]);
    renderErrors(errData.groups || []);
    renderVitals(vitData.vitals || []);
    renderSessions(sessData.sessions || []);
  } catch (e) { console.error(e); }
}

function renderErrors(groups) {
  const el = document.getElementById('errors');
  if (groups.length === 0) { el.innerHTML = '<div class="empty">无错误事件</div>'; return; }
  el.innerHTML = groups.map(g =>
    '<div class="row" onclick="showDetail(\\''+g.fingerprint+'\\')">' +
      '<span class="count">'+g.count+'</span>' +
      '<span class="msg">'+escapeHtml(g.message.slice(0,80))+'</span>' +
      '<div class="meta">'+g.subType+' · '+g.sessionsAffected.size+' sessions · last '+fmtTime(g.lastSeen)+'</div>' +
    '</div>'
  ).join('');
}

function renderVitals(vitals) {
  const el = document.getElementById('vitals');
  if (vitals.length === 0) { el.innerHTML = '<div class="empty">无 vital 数据</div>'; return; }
  el.innerHTML = vitals.map(v =>
    '<div class="vital">' +
      '<span class="name">'+v.name+' <span class="'+ratingClass(v.worstRating)+'">('+v.worstRating+')</span></span>' +
      '<span>p75='+v.p75.toFixed(0)+' / p99='+v.p99.toFixed(0)+'</span>' +
    '</div>'
  ).join('');
}

function renderSessions(sessions) {
  const el = document.getElementById('sessions');
  if (sessions.length === 0) { el.innerHTML = '<div class="empty">无 session</div>'; return; }
  el.innerHTML = sessions.slice(0, 20).map(s =>
    '<div class="row">' +
      '<span class="msg">'+s.sessionId.slice(0,16)+'</span>' +
      '<div class="meta">'+s.release+' · '+s.eventCount+' events · '+s.errorCount+' errors · '+fmtTime(s.lastSeen)+'</div>' +
    '</div>'
  ).join('');
}

async function showDetail(fp) {
  const data = await get('/api/errors/'+encodeURIComponent(fp));
  const el = document.getElementById('detail');
  document.getElementById('detail-panel').style.display = '';
  const g = data.group;
  const sample = g ? g.sample.payload : {};
  el.innerHTML = '<pre>'+escapeHtml(JSON.stringify(sample, null, 2))+'</pre>' +
    '<div class="meta" style="margin-top:8px">'+(data.events||[]).length+' events with this fingerprint</div>';
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;