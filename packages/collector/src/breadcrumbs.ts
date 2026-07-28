/**
 * @monit/collector/breadcrumbs - 面包屑采集（click / input / route）
 *
 * 对标 Sentry breadcrumbs / monitor-sdk @monit/breadcrumb。
 * 环形缓冲（默认 50 条），错误发生时附在错误事件上，还原用户操作路径。
 */

export interface Breadcrumb {
  type: 'click' | 'input' | 'route' | 'navigation';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export class BreadcrumbCollector {
  private buffer: Breadcrumb[] = [];
  private readonly capacity: number;
  private cleanups: Array<() => void> = [];

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  install(): void {
    // click（capture，带选择器摘要）
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      this.push({
        type: 'click',
        message: target ? describeElement(target) : 'click',
        timestamp: Date.now(),
        data: { x: e.clientX, y: e.clientY },
      });
    };
    document.addEventListener('click', onClick, true);
    this.cleanups.push(() => document.removeEventListener('click', onClick, true));

    // input（防抖，仅记类型与字段名，不记值--PII 安全）
    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    const onInput = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        this.push({
          type: 'input',
          message: `input on ${describeElement(target)}`,
          timestamp: Date.now(),
        });
      }, 500);
    };
    document.addEventListener('input', onInput, true);
    this.cleanups.push(() => {
      document.removeEventListener('input', onInput, true);
      if (inputTimer) clearTimeout(inputTimer);
    });

    // route（history patch + popstate）
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    const onRoute = (kind: 'push' | 'replace' | 'pop') => {
      this.push({
        type: 'route',
        message: `${kind} -> ${location.pathname}`,
        timestamp: Date.now(),
      });
    };
    history.pushState = (...args: Parameters<typeof pushState>) => {
      const r = pushState(...args);
      onRoute('push');
      return r;
    };
    history.replaceState = (...args: Parameters<typeof replaceState>) => {
      const r = replaceState(...args);
      onRoute('replace');
      return r;
    };
    const onPop = () => onRoute('pop');
    window.addEventListener('popstate', onPop);
    this.cleanups.push(() => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener('popstate', onPop);
    });
  }

  push(b: Breadcrumb): void {
    this.buffer.push(b);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  recent(): Breadcrumb[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  uninstall(): void {
    this.cleanups.forEach(fn => fn());
    this.cleanups = [];
    this.buffer = [];
  }
}

function describeElement(el: Element): string {
  const tag = el.tagName?.toLowerCase() ?? 'unknown';
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${tag}${id}${cls}`;
}