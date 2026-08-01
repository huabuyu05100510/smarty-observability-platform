/**
 * @monit/causal/experiment · ⚠️ experimental
 * 干预实验协议 + 统计裁决（Welch t-test，不假设等方差）。
 * 把"自愈验证"从单次 before/after 对比升级为【统计显著性实验】:
 *   假设 → 对照组基线 → 干预 → 两组采样 → Welch t 检验 → 接受/拒绝/不确定。
 * 这是 agent"测量驱动验证"的可执行科学单元(可审计、可复现、可注入)。
 *
 * 数学:Lanczos logΓ + 正则化不完全贝塔(Lentz 连分式)求 t 分布双侧 p 值。
 * 无外部依赖,纯 TS,可跨 Node/浏览器跑。
 */

export type HypothesisDirection = 'decrease' | 'increase' | 'change';

export interface Hypothesis {
  /** 因果声明,如 "屏蔽 analytics.js 降低 INP" */
  claim: string;
  /** 干预描述 */
  intervention: string;
  /** 期望方向(decrease=干预后降低,如降 INP；increase=升高；change=双向) */
  expectedDirection: HypothesisDirection;
  /** 被测指标,如 "INP" / "LCP" */
  metric: string;
}

export interface Sample {
  value: number;
  ts?: number;
}

export type Conclusion = 'accepted' | 'rejected' | 'inconclusive';

export interface SampleStats {
  mean: number;
  variance: number;
  n: number;
  samples: Sample[];
}

export interface ExperimentResult {
  hypothesis: Hypothesis;
  baseline: SampleStats;
  treated: SampleStats;
  /** treated.mean - baseline.mean */
  effectSize: number;
  /** effectSize / |baseline.mean|(相对变化,带符号) */
  relativeChange: number;
  tStatistic: number;
  /** 双侧 p 值 */
  pValue: number;
  significant: boolean;
  alpha: number;
  conclusion: Conclusion;
}

export interface ProtocolOptions {
  /** 显著性阈值,默认 0.05 */
  alpha?: number;
  /** 每组最少样本数,默认 8 */
  minSamples?: number;
}

const DEFAULTS: Required<ProtocolOptions> = { alpha: 0.05, minSamples: 8 };

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function variance(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

function stats(samples: Sample[]): SampleStats {
  const xs = samples.map((s) => s.value);
  const m = mean(xs);
  return { mean: m, variance: variance(xs, m), n: xs.length, samples };
}

/** Welch t 统计量(b - a,即干预相对基线的方向)。 */
export function welchTStatistic(a: SampleStats, b: SampleStats): number {
  if (a.n < 2 || b.n < 2) return 0;
  const denom = Math.sqrt(a.variance / a.n + b.variance / b.n);
  if (denom === 0) {
    // 零方差:均值不同 → 完全分离（t→±∞, p→0 显著）；相同 → 0（p→1 不显著）
    return b.mean === a.mean ? 0 : b.mean > a.mean ? Infinity : -Infinity;
  }
  return (b.mean - a.mean) / denom;
}

/** Welch-Satterthwaite 自由度。 */
export function welchDf(a: SampleStats, b: SampleStats): number {
  const na = a.variance / a.n;
  const nb = b.variance / b.n;
  const sum = na + nb;
  if (sum === 0) return 1;
  return (sum * sum) / (na * na / (a.n - 1) + nb * nb / (b.n - 1));
}

// Lanczos 近似 log Γ
function logGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** 正则化不完全贝塔函数 I_x(a,b)(Lentz 连分式,Numerical Recipes)。 */
function regularizedBeta(x: number, a: number, b: number): number {
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

/** t 分布双侧 p 值。 */
export function tDistributionPValueTwoSided(t: number, df: number): number {
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  const ib = regularizedBeta(x, df / 2, 0.5);
  return Math.min(1, Math.max(0, ib));
}

function conclude(effect: number, p: number, direction: HypothesisDirection, alpha: number): Conclusion {
  if (p > alpha) return 'inconclusive';
  const dirOk =
    direction === 'change' ? true : direction === 'decrease' ? effect < 0 : effect > 0;
  return dirOk ? 'accepted' : 'rejected';
}

/**
 * 干预实验协议。调用方提供 baseline(无干预)与 treated(干预后)的采样函数(各 n 次)。
 * 协议负责采样、统计、显著性裁决、结论。可注入:真实环境用真测量,demo/测试用 mock。
 *
 * 安全:采样函数在调用方控制下执行(本协议不直接注入页面)。配合录制重放场景包,
 * 可在确定性回放上跑统计,避免真实用户环境噪声。
 */
export class InterventionProtocol {
  readonly alpha: number;
  readonly minSamples: number;
  constructor(opts: ProtocolOptions = {}) {
    this.alpha = opts.alpha ?? DEFAULTS.alpha;
    this.minSamples = opts.minSamples ?? DEFAULTS.minSamples;
  }

  async run(
    hypothesis: Hypothesis,
    baseline: () => Promise<Sample>,
    treated: () => Promise<Sample>,
    n: number,
  ): Promise<ExperimentResult> {
    const nn = Math.max(n, this.minSamples);
    const bSamples: Sample[] = [];
    const tSamples: Sample[] = [];
    for (let i = 0; i < nn; i++) {
      bSamples.push(await baseline());
      tSamples.push(await treated());
    }
    const baselineStats = stats(bSamples);
    const treatedStats = stats(tSamples);
    const t = welchTStatistic(baselineStats, treatedStats);
    const df = welchDf(baselineStats, treatedStats);
    const p = tDistributionPValueTwoSided(t, df);
    const effectSize = treatedStats.mean - baselineStats.mean;
    const relativeChange = baselineStats.mean !== 0 ? effectSize / Math.abs(baselineStats.mean) : 0;
    const conclusion = conclude(effectSize, p, hypothesis.expectedDirection, this.alpha);
    return {
      hypothesis, baseline: baselineStats, treated: treatedStats,
      effectSize, relativeChange, tStatistic: t, pValue: p,
      significant: p <= this.alpha, alpha: this.alpha, conclusion,
    };
  }
}
