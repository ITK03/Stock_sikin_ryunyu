import { describe, expect, it } from 'vitest';
import {
  caveats,
  coverageText,
  gapVerdict,
  metrics,
  percentileFromGrid,
  percentileText,
  positionLabel,
  type ValuationProfile,
} from '../src/core/valuation';

function makeProfile(over: Partial<ValuationProfile> = {}): ValuationProfile {
  const grid = Array.from({ length: 21 }, (_, i) => 10 + i);   // 10..30
  return {
    v: 1,
    code: '7203',
    name: 'トヨタ自動車',
    as_of: '2026-07-31',
    src: 'yfinance',
    eps: 100,
    bps: 1000,
    roe: 0.1,
    per_q: grid,
    pbr_q: Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05),
    rel_q: null,
    mkt_per: null,
    per_y: [[2024, 11, 15, 19], [2025, 12, 16, 20]],
    pbr_y: [],
    roe_pbr: { fair: 1.5, gap: -20, r2: 0.7, n: 1200 },
    cov: {
      years_max: 10, span: [2022, 2026], span_years: 5.0, obs: 1225,
      price_obs: 2450, records: 5, known_from_estimated: true, missing: [],
    },
    ...over,
  };
}

// 生成側 (swing/valuation/profile.py の percentile_from_grid) と同じ結果になること。
// ここがズレると、サーバが出した分位とブラウザの表示が食い違う。
describe('percentileFromGrid — 生成側と同一の計算', () => {
  const g = [10, 12, 14, 16, 18];

  it('両端は0と100で頭打ち', () => {
    expect(percentileFromGrid(g, 5)).toBe(0);
    expect(percentileFromGrid(g, 99)).toBe(100);
    expect(percentileFromGrid(g, 10)).toBe(0);
    expect(percentileFromGrid(g, 18)).toBe(100);
  });

  it('Python側のテストと同じ値になる', () => {
    expect(percentileFromGrid(g, 14)).toBeCloseTo(50, 6);
    expect(percentileFromGrid(g, 13)).toBeCloseTo(37.5, 6);
  });

  it('グリッドが短い/値が不正なら NaN', () => {
    expect(percentileFromGrid([1], 1)).toBeNaN();
    expect(percentileFromGrid(g, NaN)).toBeNaN();
  });

  it('同値が連続するグリッドでも壊れない', () => {
    expect(percentileFromGrid([5, 5, 5, 8, 9], 5)).toBe(0);
    expect(Number.isFinite(percentileFromGrid([5, 5, 5, 8, 9], 6))).toBe(true);
  });
});

describe('metrics — 現在株価から評価を作る', () => {
  it('株価÷EPS でPERを出し、分位上の位置を返す', () => {
    const [per] = metrics(makeProfile(), 2000);
    expect(per.value).toBeCloseTo(20, 6);
    expect(per.percentile).toBeCloseTo(50, 6);
    expect(per.note).toBeNull();
  });

  it('赤字はPERを「割高」ではなく算出不可として扱う', () => {
    const [per, pbr] = metrics(makeProfile({ eps: -50 }), 2000);
    expect(per.value).toBeNull();
    expect(per.note).toBe('赤字のため算出不可');
    // PBRは引き続き出せること(赤字=評価不能にしない)
    expect(pbr.value).toBeCloseTo(2, 6);
  });

  it('純資産がマイナスならPBRを出さない', () => {
    const [, pbr] = metrics(makeProfile({ bps: -100 }), 2000);
    expect(pbr.value).toBeNull();
    expect(pbr.note).toBe('純資産がマイナス');
  });

  it('現在値が無ければ理由を残す', () => {
    const [per] = metrics(makeProfile(), null);
    expect(per.value).toBeNull();
    expect(per.note).toBe('現在値なし');
  });

  it('履歴不足でグリッドが無い場合、値は出すが位置は出さない', () => {
    const [per] = metrics(makeProfile({ per_q: null }), 2000);
    expect(per.value).toBeCloseTo(20, 6);
    expect(per.percentile).toBeNull();
    expect(per.note).toBe('履歴不足');
  });

  it('EPSが無ければデータなしと明示する', () => {
    const [per] = metrics(makeProfile({ eps: null }), 2000);
    expect(per.note).toBe('データなし');
  });
});

describe('positionLabel — 断定しない表現', () => {
  it('位置に応じたラベル', () => {
    expect(positionLabel(3)).toBe('過去最安圏');
    expect(positionLabel(50)).toBe('中位');
    expect(positionLabel(97)).toBe('過去最高圏');
    expect(positionLabel(null)).toBe('—');
  });

  it('「割安」「買い」などの断定語を使わない', () => {
    const banned = ['割安', '割高', '買い', '売り', '推奨'];
    for (const p of [0, 10, 25, 45, 55, 75, 90, 100]) {
      for (const w of banned) expect(positionLabel(p)).not.toContain(w);
    }
  });
});

describe('gapVerdict — ROEで説明できるかの判定', () => {
  it('閾値', () => {
    expect(gapVerdict(-30)).toBe('cheap');
    expect(gapVerdict(-5)).toBe('fair');
    expect(gapVerdict(0)).toBe('fair');
    expect(gapVerdict(30)).toBe('rich');
  });
});

describe('coverage と caveats — 実測を出し、弱点を隠さない', () => {
  it('収録期間は要求窓ではなく実測を出す', () => {
    expect(coverageText(makeProfile())).toContain('2022〜2026年');
    expect(coverageText(makeProfile())).toContain('約5.0年');
  });

  it('本当に履歴が無いときだけ「履歴なし」とする', () => {
    // span が null でも年次レンジがあれば、そちらから収録期間を導く
    const withYears = makeProfile({ cov: { ...makeProfile().cov, span: null, span_years: 0 } });
    expect(coverageText(withYears)).toContain('2024〜2025年');
    // 年次レンジも無ければ履歴なし
    expect(coverageText({ ...withYears, per_y: [], pbr_y: [] })).toBe('履歴なし');
  });

  it('5年しか無いこと・公表日が推定であることを注意書きに出す', () => {
    const c = caveats(makeProfile());
    expect(c.some((s) => s.includes('5.0年'))).toBe(true);
    expect(c.some((s) => s.includes('推定'))).toBe(true);
  });

  it('十分な履歴かつ公表日が実測なら注意書きは出ない', () => {
    const p = makeProfile({
      cov: { ...makeProfile().cov, span_years: 10, known_from_estimated: false },
    });
    expect(caveats(p)).toEqual([]);
  });

  it('ROE回帰が成立していなければその旨を出す', () => {
    const c = caveats(makeProfile({ roe_pbr: null }));
    expect(c.some((s) => s.includes('ROEとPBR'))).toBe(true);
  });
});

// 配信中には span を持たない旧世代のプロファイルが混ざりうる(生成側の修正前に
// 作られたもの)。フィールドが無いだけで「履歴なし」と出すと、データが有るのに
// 無いと誤解させる。
describe('スキーマ差の吸収', () => {
  const legacy = () => {
    const p = makeProfile();
    // 旧世代: span / span_years が無く、years だけを持っていた
    const cov = { ...p.cov } as Record<string, unknown>;
    delete cov.span;
    delete cov.span_years;
    cov.years = 10;
    return { ...p, cov: cov as ValuationProfile['cov'] };
  };

  it('spanが無ければ年次レンジから収録期間を導く', () => {
    const t = coverageText(legacy());
    expect(t).not.toBe('履歴なし');
    expect(t).toContain('2024〜2025年');
  });

  it('導いた期間でも「5年しかない」注意書きが出る', () => {
    expect(caveats(legacy()).some((s) => s.includes('遡れていません'))).toBe(true);
  });

  it('年次レンジも無ければ正直に履歴なしとする', () => {
    const p = legacy();
    expect(coverageText({ ...p, per_y: [], pbr_y: [] })).toBe('履歴なし');
  });
});

// 「下位99%」のような書き方は、レンジ上端にいるのに下位と読めてしまう。
describe('percentileText — 誤読しない表現', () => {
  it('何と比べて高いのかを明示する', () => {
    expect(percentileText(99)).toBe('過去の99%より高い');
    expect(percentileText(8)).toBe('過去の8%より高い');
  });

  it('上端の表現が「下位」と読めないこと', () => {
    const s = `${positionLabel(99)}・${percentileText(99)}`;
    expect(s).toContain('過去最高圏');
    expect(s).not.toContain('下位');
  });

  it('値が無ければ空文字', () => {
    expect(percentileText(null)).toBe('');
    expect(percentileText(NaN)).toBe('');
  });
});
