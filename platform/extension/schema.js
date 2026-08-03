// schema.js · 单源事件契约（Single Source of Truth）
// ----------------------------------------------------------------------------
// 设计动机:此前的 event 字段定义散落在 content.js(生产)/ data.js / diagnose.js /
// localize.js(消费)的注释里,无真理之源 → 生产者漏字段(如 live inp 漏 origin)时,
// 消费者(diagnose 的 third_party 规则)只能静默 return false,故障不可见。
//
// 本文件把「每个 event 形态需要哪些字段」集中成一份契约:
//   - 生产者(content.js sendEvent)在出口 assert → 违约即 console.warn + 计数,第一时间暴露;
//   - 消费者(data.js / diagnose.js)可按 keyOf(ev) 拿到稳定形态,不必逐字段猜存在性;
//   - 字段演进时改这一处,所有 context(content script / sidepanel / 测试)共用同一份。
//
// 兼容策略:required 只列「下游强依赖」的字段;未知 subType / 多余字段一律放行(向前兼容),
// 不做破坏性拒绝——契约是「最早上报」的探针,不是「最严卡口」。
(function (global) {
  const SCHEMA_VERSION = 1;

  // 通用必填(所有 event 共有):标识 + 归属 + 时间。type/subType 决定分派到哪条 schema。
  const COMMON = ['eventId', 'host', 'route', 'timestamp', 'sessionId', 'release', 'type', 'subType'];

  // 每个 subType 在 COMMON 之外额外强依赖的字段。optional 标注「下游会用但缺了能降级」的字段。
  const EVENT_SCHEMAS = {
    'vital.inp': {
      required: ['value', 'inputDelay', 'processingDuration', 'presentationDelay', 'interactionTarget', 'origin'],
      optional: ['loafScripts', 'resolvedScript', 'ua'],
      note: 'origin 必填:diagnose 的 third_party 规则靠它判一方/第三方,缺失则规则静默失效',
    },
    'vital.lcp': { required: ['value'], optional: ['ttfb', 'resLoad', 'resStart', 'resEnd', 'element', 'url', 'navType', 'size', 'ua'] },
    'vital.fcp': { required: ['value'], optional: ['ttfb', 'domParse', 'navType', 'ua'] },
    'vital.cls': { required: ['value'], optional: ['shifts', 'largest', 'element', 'sourceBreakdown', 'ua'] },
    'vital.memory': { required: ['value'], optional: ['used', 'total', 'limit', 'domCount', 'nav', 'ua'] },
    'vital.fps': { required: ['value'], optional: ['ua'] },
    'error.js': { required: ['origin', 'message'], optional: ['stack', 'filename', 'lineno', 'colno', 'resolvedFrames', 'ua'] },
    'error.promise': { required: ['origin', 'message'], optional: ['stack', 'ua'] },
    'error.resource': { required: ['origin', 'message', 'sourceURL'], optional: ['ua'] },
    'meta.schema_violation': { required: ['key', 'missing'], optional: [] },
  };

  // ev → 'type.subType'。无 type/subType → null(无法归类,validate 会报)。
  function keyOf(ev) {
    if (!ev || !ev.type || !ev.subType) return null;
    return ev.type + '.' + ev.subType;
  }

  // 校验单个 event。返回 { ok, key, missing[] , known }。
  //   ok=false 表示缺 required 字段;known=false 表示 subType 未登记(放行,但标记供排查)。
  let _violations = 0;
  let _lastViolations = 0;
  function validate(ev) {
    const key = keyOf(ev);
    if (!key) return { ok: false, key: null, missing: ['type', 'subType'], known: false };
    const sch = EVENT_SCHEMAS[key];
    if (!sch) return { ok: true, key, missing: [], known: false }; // 未知形态:放行(向前兼容)
    const required = COMMON.concat(sch.required || []);
    const missing = required.filter((f) => ev[f] == null);
    return { ok: missing.length === 0, key, missing, known: true };
  }

  // 断言(生产侧用):违约即 console.warn + 计数。不抛、不阻断投递——契约是探针不是卡口。
  function assert(ev) {
    const v = validate(ev);
    if (!v.ok) {
      _violations++;
      try { console.warn('[vc-schema] event 违约 ·', v.key, '· missing:', v.missing, '· eventId=' + (ev && ev.eventId)); } catch {}
    }
    return v;
  }

  // 自身可观测:返回自上次调用以来的违约增量(供 sidepanel 周期性自检)
  function violationDelta() {
    const d = _violations - _lastViolations;
    _lastViolations = _violations;
    return { total: _violations, delta: d };
  }

  global.__schema = { SCHEMA_VERSION, EVENT_SCHEMAS, COMMON, keyOf, validate, assert, violationDelta };
})(typeof globalThis !== 'undefined' ? globalThis : self);
