/**
 * @monit/causal/model · ⚠️ experimental
 * 世界模型接口（预测 + 校准）+ 版本化。model-based agent 的核心:
 * patch 注入前用模型预测效果,注入后用实测校准残差。模型随经验收敛。
 * 当前奠基:可解释线性模型(在线 SGD)+ 残差日志。完整 model-based RL 是后续工作。
 *
 * 非黑盒 —— 权重可解释,符合"确定性优先、可审计"的开源契约。
 */

export interface PerfModelSerialized {
  schema: 'perf-model';
  version: 1;
  metric: string;
  features: string[];
  weights: Record<string, number>;
  bias: number;
  residualLog: Array<{ predicted: number; observed: number; ts: number }>;
}

export interface PerfModel {
  /** 预测给定特征下的指标值（不真注入即可预估 patch 效果） */
  predict(features: Record<string, number>): number;
  /** 用观测校准模型（在线更新） */
  update(features: Record<string, number>, observed: number): void;
  /** 残差统计（MAE + 样本数），用于判断模型可信度 */
  residual(): { mae: number; n: number };
  serialize(): PerfModelSerialized;
}

/**
 * 最小可解释线性模型（在线 SGD）。可序列化、版本化、可审计。
 */
export class LinearPerfModel implements PerfModel {
  readonly metric: string;
  readonly features: string[];
  private weights: Record<string, number>;
  private bias: number;
  private residualLog: Array<{ predicted: number; observed: number; ts: number }> = [];
  private readonly lr: number;

  constructor(metric: string, features: string[], opts: { learningRate?: number; initial?: PerfModelSerialized } = {}) {
    this.metric = metric;
    this.features = features;
    this.lr = opts.learningRate ?? 0.05;
    if (opts.initial && opts.initial.features.join() === features.join()) {
      this.weights = { ...opts.initial.weights };
      this.bias = opts.initial.bias;
      this.residualLog = opts.initial.residualLog.slice(-1000);
    } else {
      this.weights = Object.fromEntries(features.map((f) => [f, 0]));
      this.bias = 0;
    }
  }

  predict(features: Record<string, number>): number {
    let sum = this.bias;
    for (const f of this.features) sum += (this.weights[f] ?? 0) * (features[f] ?? 0);
    return sum;
  }

  update(features: Record<string, number>, observed: number): void {
    const predicted = this.predict(features);
    const err = predicted - observed;
    // 梯度裁剪:大特征值/大误差会致步长爆炸 → NaN。clip 单次梯度,保证数值稳健。
    const clipErr = Math.max(-50, Math.min(50, err));
    this.bias -= this.lr * clipErr;
    for (const f of this.features) {
      const grad = clipErr * (features[f] ?? 0);
      const clipped = Math.max(-1000, Math.min(1000, grad));
      this.weights[f] = (this.weights[f] ?? 0) - this.lr * clipped;
    }
    if (!Number.isFinite(this.bias)) this.bias = 0;
    this.residualLog.push({ predicted, observed, ts: Date.now() });
    if (this.residualLog.length > 1000) this.residualLog.shift();
  }

  residual(): { mae: number; n: number } {
    const n = this.residualLog.length;
    if (n === 0) return { mae: 0, n: 0 };
    const mae = this.residualLog.reduce((s, r) => s + Math.abs(r.predicted - r.observed), 0) / n;
    return { mae, n };
  }

  serialize(): PerfModelSerialized {
    return {
      schema: 'perf-model', version: 1, metric: this.metric,
      features: this.features.slice(), weights: { ...this.weights }, bias: this.bias,
      residualLog: this.residualLog.slice(),
    };
  }
}
