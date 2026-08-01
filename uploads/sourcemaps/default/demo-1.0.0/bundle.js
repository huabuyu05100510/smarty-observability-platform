// src/handleFilter.js -- 列表筛选回调（INP 瓶颈）
import { fetchUsers } from './api.js';

export function handleFilter(query, allItems) {
  const q = (query || '').toLowerCase();
  // 慢点：同步遍历 + DOM 读写交替 -> processing 段过长，阻塞下一帧
  const filtered = [];
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    if (item.name.toLowerCase().includes(q)) {
      const el = document.querySelector('#row-' + item.id);
      if (el) el.classList.add('match');      // 强制重排（layout thrashing）
      filtered.push(item);
    }
  }
  renderResults(filtered);
  return filtered;
}

function renderResults(list) {
  const root = document.querySelector('#results');
  root.innerHTML = list.map((x) => '<li>' + x.name + '</li>').join('');
}
