import { describe, it, expect } from 'vitest';
import { assessGate, localityOk, AUTO_MR_MAX_FILES, AUTO_MR_MAX_LINES } from '../src/gate';
import type { GateVector } from '@monit/contracts';

function base(over: Partial<GateVector> = {}): GateVector {
  return {
    verifier: 'pass',
    verifierConfident: true,
    reproRedBefore: true,
    reproGreenAfter: true,
    suiteGreen: true,
    typecheck: true,
    locality: { files: 1, lines: 12 },
    contamination: 'clean',
    behaviorPreserving: true,
    ...over,
  };
}

describe('assessGate (GateVector 向量门禁，替加权 score)', () => {
  it('全闸通过 -> auto-mr', () => {
    const d = assessGate(base());
    expect(d.delivery).toBe('auto-mr');
  });

  it('Verifier refuted -> 硬阻断 human（无论其他闸）', () => {
    const d = assessGate(base({ verifier: 'refuted' }));
    expect(d.delivery).toBe('human');
  });

  it('repro 未在打补丁前失败（复现无效）-> human', () => {
    expect(assessGate(base({ reproRedBefore: false })).delivery).toBe('human');
  });

  it('repro 打补丁后未通过 -> human', () => {
    expect(assessGate(base({ reproGreenAfter: false })).delivery).toBe('human');
  });

  it('现有套件被破坏 -> human', () => {
    expect(assessGate(base({ suiteGreen: false })).delivery).toBe('human');
  });

  it('改动非局部（>1 文件）-> auto-mr 不可达（行为保留则降为 hotfix）', () => {
    const d = assessGate(base({ locality: { files: 3, lines: 12 } }));
    expect(d.delivery).not.toBe('auto-mr');
    expect(d.delivery).toBe('hotfix'); // 行为保留 + 其余全过 -> 可逆热修
  });

  it('数据污染命中 -> 全档位阻断（auto-mr 与 hotfix 均不可达）-> human', () => {
    const d = assessGate(base({ contamination: 'detected' }));
    expect(d.delivery).toBe('human');
  });

  it('污染命中即便行为保留 + 局部也转 human（不可绕过）', () => {
    const d = assessGate(base({ contamination: 'detected', behaviorPreserving: true, locality: { files: 1, lines: 5 } }));
    expect(d.delivery).toBe('human');
  });

  it('Verifier skipped（未配独立模型）-> 自动交付不可达 -> human（强制配独立模型）', () => {
    const d = assessGate(base({ verifier: 'skipped' }));
    expect(d.delivery).toBe('human');
  });

  it('Verifier pass 但低置信（verifierConfident=false）-> human（弱验证不放行）', () => {
    const d = assessGate(base({ verifierConfident: false }));
    expect(d.delivery).toBe('human');
  });

  it('hotfix 要求 behaviorPreserving（非 masking 吞错）', () => {
    // 非局部 + 非行为保留 -> 既非 auto-mr 也非 hotfix -> human
    expect(assessGate(base({ locality: { files: 3, lines: 12 }, behaviorPreserving: false })).delivery).toBe('human');
  });

  it('localityOk 阈值正确', () => {
    expect(localityOk({ files: 1, lines: 50 })).toBe(true);
    expect(localityOk({ files: 1, lines: 51 })).toBe(false);
    expect(localityOk({ files: 2, lines: 10 })).toBe(false);
    expect(AUTO_MR_MAX_FILES).toBe(1);
    expect(AUTO_MR_MAX_LINES).toBe(50);
  });

  it('reasons 非空且含判定依据', () => {
    const d = assessGate(base({ verifier: 'refuted' }));
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.some(r => r.includes('REFUTED'))).toBe(true);
  });
});
