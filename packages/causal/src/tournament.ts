/**
 * @monit/causal/tournament · ⚠️ experimental
 * 多候选对抗锦标赛:N 个候选 patch 各自跑独立干预实验,按【统计显著性】排名。
 * 胜出基于统计证据而非单次;每个候选实验独立(可注入独立采样/verifier = 真对抗)。
 * 这是 agent 从"试一个 patch"升级为"科学选拔"。
 */

import { InterventionProtocol, type ExperimentResult, type Hypothesis } from './experiment';

export interface Candidate {
  id: string;
  label: string;
  /** 应用候选(注入 patch/屏蔽脚本);须可逆 */
  apply: () => Promise<void>;
  /** 回滚到 baseline 状态 */
  revert: () => Promise<void>;
}

export interface TournamentOptions {
  metric: string;
  direction: 'decrease' | 'increase';
  /** 单次测量(在当前 baseline 状态下)。controlMeasure 自身可注入(mock/真测) */
  controlMeasure: () => Promise<number>;
  alpha?: number;
  samplesPerCandidate?: number;
}

export interface CandidateResult {
  candidate: Candidate;
  experiment: ExperimentResult;
  rank: number;
}

export interface TournamentResult {
  winner: CandidateResult | null;
  ranking: CandidateResult[];
  /** 非显著(p > alpha)或方向错的候选 → 诚实排除,不静默丢弃 */
  inconclusive: Candidate[];
}

export class Tournament {
  private protocol: InterventionProtocol;
  constructor(private opts: TournamentOptions) {
    this.protocol = new InterventionProtocol({
      alpha: opts.alpha,
      minSamples: opts.samplesPerCandidate ?? 8,
    });
  }

  async run(candidates: Candidate[], n: number = this.opts.samplesPerCandidate ?? 8): Promise<TournamentResult> {
    const results: CandidateResult[] = [];

    for (const cand of candidates) {
      const hypothesis: Hypothesis = {
        claim: `${cand.label} ${this.opts.direction === 'decrease' ? '降低' : '升高'} ${this.opts.metric}`,
        intervention: cand.label,
        expectedDirection: this.opts.direction,
        metric: this.opts.metric,
      };
      // baseline = 原状测量;treated = 应用候选后测量,再回滚(保证候选间互不污染)
      const baseline = async () => ({ value: await this.opts.controlMeasure() });
      const treated = async () => {
        await cand.apply();
        const v = await this.opts.controlMeasure();
        await cand.revert();
        return { value: v };
      };
      const experiment = await this.protocol.run(hypothesis, baseline, treated, n);
      results.push({ candidate: cand, experiment, rank: 0 });
    }

    // 排名:仅显著且方向对者参与;decrease 时降幅大者(effectSize 更负)靠前
    const accepted = results.filter((r) => r.experiment.conclusion === 'accepted');
    accepted.sort((a, b) =>
      this.opts.direction === 'decrease'
        ? a.experiment.effectSize - b.experiment.effectSize
        : b.experiment.effectSize - a.experiment.effectSize,
    );
    accepted.forEach((r, i) => (r.rank = i + 1));

    const nonAccepted = results.filter((r) => r.experiment.conclusion !== 'accepted');
    return {
      winner: accepted[0] ?? null,
      ranking: accepted,
      inconclusive: nonAccepted.map((r) => r.candidate),
    };
  }
}
