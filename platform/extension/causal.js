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

  // Lentz 连分式求 beta 连分式 betacf(a,b,x)(Numerical Recipes betacf)。
  function betacf(a, b, x) {
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let f = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
      c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 + num / d; if (Math.abs(d) < 1e-30) d = 1e-30;
      f *= c * d;
      num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
      c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 + num / d; if (Math.abs(d) < 1e-30) d = 1e-30;
      const delta = c * d;
      f *= delta;
      if (Math.abs(delta - 1) < 1e-10) break;
    }
    return f;
  }

  // 正则化不完全贝塔 I_x(a,b)。关键:越过对称点 (a+1)/(a+b+2) 时 swap 到 1-x + (b,a),
  // 否则 x→1 时连分式精度崩溃(NR betai 标准做法)。
  // ⚠ 此前缺此 swap 分支 → |t| 小(接近无差异)时 p 误算为≈0(假阳性显著):
  //   任何近乎无效的 patch 都会被判「极显著 accepted」。配对 t / Welch t 同受影响,故必先修。
  function regularizedBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
    if (x < (a + 1) / (a + b + 2)) {
      const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
      return front * betacf(a, b, x);
    }
    const front = Math.exp(Math.log(1 - x) * b + Math.log(x) * a - lbeta) / b;
    return 1 - front * betacf(b, a, 1 - x);
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

  // 诚实性披露:本引擎的样本来自「同一会话 apply 前后」的时序对照,而非随机对照实验(RCT)。
  // 行业规范(Kohavi《Trustworthy Online Controlled Experiments》)要求:非随机设计的 p 值
  // 只能作方向性参考(advisory),不得当因果 claim。caveats 把有效性边界显式写进结果,供 UI 展示。
  function buildCaveats(baseline, treated) {
    const c = [];
    c.push('时序前后对照(非 RCT):时间趋势 / 网络 / 用户交互节奏变化均为潜在 confounder');
    const minN = Math.min(baseline.n, treated.n);
    if (minN < 16) c.push('样本量偏小(N=' + minN + ' < 16):功效不足,小 effect 可能检不出,或放大噪声');
    c.push('同会话连续样本可能自相关:违反 t 检验 IID 假设,p 值倾向偏乐观');
    return c;
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
      // 实验设计元信息:诚实标注有效性边界,不把时序对照包装成因果 claim。
      design: 'sequential',           // 时序前后对照(apply 前 vs apply 后),非随机对照实验
      advisory: true,                 // p 值仅供方向参考
      n: { baseline: baseline.n, treated: treated.n },
      caveats: buildCaveats(baseline, treated),
    };
  }

  // 逆正态 CDF(分位数函数)Acklam 有理近似:p∈(0,1) → z 使 Φ(z)=p。零依赖,精度 <1e-9。
  // 功效分析用它取临界值:z_{0.975}≈1.95996(α=0.05 双尾), z_{0.8}≈0.8416(power=0.8)。
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const plow = 0.02425, phigh = 1 - plow;
    if (p < plow) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    } else if (p <= phigh) {
      const q = p - 0.5, r = q * q;
      return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
  }

  // 两样本(等样本等方差)双侧 t 检验「每组」最小样本量近似:
  //   n ≈ 2·(z_{1-α/2} + z_{1-β})²·σ² / Δ²
  // deltaAbs=想检出的均值差(>0);sigma=合并标准差;alpha=显著性;power=功效(1-β)。返回 ceil,下限 2。
  // 行业规范:实验前先定 MDE(minimum detectable effect)再算 N,避免「样本不足硬判」或「无谓过采」。
  function sampleSizeFor(deltaAbs, sigma, alpha, power) {
    alpha = alpha == null ? 0.05 : alpha;
    power = power == null ? 0.8 : power;
    if (!(deltaAbs > 0) || !(sigma > 0)) return 2;
    const z = normInv(1 - alpha / 2) + normInv(power);
    const n = 2 * z * z * sigma * sigma / (deltaAbs * deltaAbs);
    return Math.max(2, Math.ceil(n));
  }

  // CUPED (Controlled-experiment Using Pre-Experiment Data, Microsoft 2013)。
  // 用与指标 Y 相关的预实验协变量 X(同一单元的实验前值)降方差:Y' = Y - θ·(X - mean(X)),
  // θ = cov(Y,X)/var(X)。指标方差从 var(Y) 降到 var(Y)·(1-ρ²),同等显著性所需样本量随之下降约一半。
  // 强约束:Y 与 X 必须 per-unit 等长配对(同一实验单元的「期指标 + 期前协变量」)——
  // 时序对照里 baseline/treated 是不同交互无配对 → 不能直接用;配对设计(P1-8 replay)才能提供协变量。
  function cupedAdjustSeries(y, x) {
    const n = Math.min((y || []).length, (x || []).length);
    if (n < 2) return (y || []).slice(); // 配对不足 → 原样返回(不调整)
    const ys = y.slice(0, n), xs = x.slice(0, n);
    const my = mean(ys), mx = mean(xs);
    // θ = cov(Y,X)/var(X);cov/var 同除 (n-1),比值中抵消 → 可直接用 Σ 口径。
    let cov = 0, vx = 0;
    for (let i = 0; i < n; i++) { cov += (ys[i] - my) * (xs[i] - mx); vx += (xs[i] - mx) * (xs[i] - mx); }
    if (vx === 0) return ys; // 协变量无变异 → 无法估 θ → 不调整
    const theta = cov / vx;
    return ys.map((v, i) => v - theta * (xs[i] - mx));
  }

  // CUPED 调整后做 Welch t。baselineCov/treatedCov 是各自 per-unit 协变量(与 baseline/treated 等长配对)。
  // 缺协变量 → 安全退化为普通 runCausalValidation(诚实降级,标注 cuped:false,不静默冒充)。
  function runCausalValidationCuped(baselineValues, treatedValues, baselineCov, treatedCov, opts) {
    const hasCov = (baselineCov && baselineCov.length >= 2) && (treatedCov && treatedCov.length >= 2);
    if (!hasCov) {
      const r = runCausalValidation(baselineValues, treatedValues, opts);
      r.cuped = false; // 标注:未做 CUPED(缺 per-unit 协变量)
      return r;
    }
    const bAdj = cupedAdjustSeries(baselineValues, baselineCov);
    const tAdj = cupedAdjustSeries(treatedValues, treatedCov);
    const r = runCausalValidation(bAdj, tAdj, opts);
    r.cuped = true;
    r.design = 'cuped'; // CUPED 调整后:方差更低、更接近可信(仍非 RCT,但优于裸时序对照)
    r.caveats = (r.caveats || []).filter((c) => !/时序前后对照/.test(c));
    r.caveats.unshift('CUPED 协变量调整:用 per-unit 预协变量降方差(1-ρ²),样本量需求下降');
    return r;
  }

  // Holm-Bonferroni 多重比较校正:同一实验里做 m 次检验时,family-wise error rate(FWER)膨胀。
  // Holm 步降(比 Bonferroni 更强、逐步):把 p 升序,第 k 小的 p(k) 与 α/(m-k+1) 比;
  // 从最小开始,首个不拒绝处停止,其后皆不拒绝。adjustedP = (m-k)·p(k),再做单调化(非递减)。
  // 返回数组(与输入同序),每项 { originalIndex, p, adjustedP, rejected }。
  function holmCorrect(pValues, alpha) {
    alpha = alpha == null ? 0.05 : alpha;
    const ps = (pValues || []).map((p, index) => ({ p: p == null ? 1 : Math.max(0, Math.min(1, p)), index }))
      .sort((a, b) => a.p - b.p);
    const m = ps.length;
    let stop = false;
    ps.forEach((e, k) => {
      e.adjustedP = Math.min(1, (m - k) * e.p);
      if (stop) { e.rejected = false; return; }
      if (e.p <= alpha / (m - k)) e.rejected = true;
      else { e.rejected = false; stop = true; }
    });
    // adjustedP 单调化:升序 p 的调整值须非递减(否则违反 Holm 一致性)
    for (let k = 1; k < ps.length; k++) ps[k].adjustedP = Math.max(ps[k].adjustedP, ps[k - 1].adjustedP);
    const out = (pValues || []).map(() => null);
    ps.forEach((e) => { out[e.index] = { originalIndex: e.index, p: e.p, adjustedP: e.adjustedP, rejected: e.rejected }; });
    return out;
  }

  // 配对 t 检验:同一实验单元的 patch 前(b)/后(t)配对,d_i = t_i - b_i,检验 d 均值显著<0(decrease)。
  // 消除「不同单元固有难度差异」这个最大 confounder —— 配对场景下功效高于独立 Welch t。
  // 这正是 record-replay 的用武之地:同一交互序列 patch 前后各重放一次,自然形成配对。
  function pairedTTest(baseline, treated, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.05;
    const direction = opts.direction || 'decrease';
    const n = Math.min((baseline || []).length, (treated || []).length);
    if (n < 2) {
      return { conclusion: 'inconclusive', significant: false, pValue: 1, effectSize: 0, alpha, n: { baseline: n, treated: n },
        design: 'paired', advisory: true, caveats: ['配对不足(n<2):无法做配对 t'] };
    }
    const b = baseline.slice(0, n), t = treated.slice(0, n);
    const d = [];
    for (let i = 0; i < n; i++) d.push((t[i] || 0) - (b[i] || 0));
    const md = mean(d);
    const sd = Math.sqrt(variance(d, md));
    const se = sd / Math.sqrt(n);
    const tStat = se > 0 ? md / se : (md === 0 ? 0 : (md > 0 ? Infinity : -Infinity));
    const df = n - 1;
    const p = tPValueTwoSided(tStat, df);
    const effectSize = md;
    return {
      baseline: stats(b), treated: stats(t),
      pairs: { n, meanDiff: md, sdDiff: sd },
      effectSize, relativeChange: md,
      tStatistic: tStat, pValue: p, significant: p <= alpha, alpha,
      conclusion: conclude(effectSize, p, direction, alpha),
      design: 'paired', advisory: true, n: { baseline: n, treated: n },
      caveats: [
        '配对设计(同一交互 patch 前后):消除交互间固有差异,功效高于独立 Welch t',
        '仍非 RCT:重放为合成事件 handler 耗时代理,非 Event Timing INP 真值',
      ],
    };
  }

  global.__causal = { runCausalValidation, normInv, sampleSizeFor, cupedAdjustSeries, runCausalValidationCuped, holmCorrect, pairedTTest };
})(typeof globalThis !== 'undefined' ? globalThis : self);
