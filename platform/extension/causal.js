// causal.js · 扩展端统计验证（移植自 @monit/causal/experiment，零依赖纯 JS）
// 把"自愈验证"从单次 before/after 升级为 Welch t 统计显著性裁决。
// 提供 runCausalValidation(baselineValues[], treatedValues[], opts) → { conclusion, effectSize, pValue, ... }
// 在 sidepanel 跑,样本来自 content.js 采集的真实 INP。
(function (global) {
  function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
  function variance(xs, m) { return xs.length < 2 ? 0 : xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1); }
  function stats(vals) { const m = mean(vals); return { mean: m, variance: variance(vals, m), n: vals.length }; }

  function welchT(a, b) {
    if (a.n < 2 || b.n < 2) return 0;
    const denom = Math.sqrt(a.variance / a.n + b.variance / b.n);
    if (denom === 0) return b.mean === a.mean ? 0 : (b.mean > a.mean ? Infinity : -Infinity);
    return (b.mean - a.mean) / denom;
  }
  function welchDf(a, b) {
    const na = a.variance / a.n, nb = b.variance / b.n, sum = na + nb;
    if (sum === 0) return 1;
    return (sum * sum) / (na * na / (a.n - 1) + nb * nb / (b.n - 1));
  }

  // Lanczos 近似 log Γ
  function logGamma(z) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // 正则化不完全贝塔（Lentz 连分式）
  function regularizedBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    let f = 1, c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    f = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
      c = 1 + num / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 + num / d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      f *= c * d;
      num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
      c = 1 + num / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 + num / d;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      const delta = c * d;
      f *= delta;
      if (Math.abs(delta - 1) < 1e-10) break;
    }
    return front * f;
  }

  function tPValueTwoSided(t, df) {
    if (df <= 0) return 1;
    const x = df / (df + t * t);
    return Math.min(1, Math.max(0, regularizedBeta(x, df / 2, 0.5)));
  }

  function conclude(effect, p, direction, alpha) {
    if (p > alpha) return 'inconclusive';
    const dirOk = direction === 'change' ? true : direction === 'decrease' ? effect < 0 : effect > 0;
    return dirOk ? 'accepted' : 'rejected';
  }

  // 主入口:baseline/treated 各一组样本值,返回统计裁决。
  function runCausalValidation(baselineValues, treatedValues, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.05;
    const direction = opts.direction || 'decrease';
    const baseline = stats(baselineValues || []);
    const treated = stats(treatedValues || []);
    const t = welchT(baseline, treated);
    const df = welchDf(baseline, treated);
    const p = tPValueTwoSided(t, df);
    const effectSize = treated.mean - baseline.mean;
    const relativeChange = baseline.mean !== 0 ? effectSize / Math.abs(baseline.mean) : 0;
    return {
      baseline, treated, effectSize, relativeChange,
      tStatistic: t, pValue: p, significant: p <= alpha, alpha,
      conclusion: conclude(effectSize, p, direction, alpha),
    };
  }

  global.__causal = { runCausalValidation };
})(typeof globalThis !== 'undefined' ? globalThis : self);
