import { describe, expect, it } from 'vitest';
import { sectorStrength, sortSectorsByStrength } from '../src/core/sectorStrength';
import type { SectorEntry, SectorMember } from '../src/core/types';

function member(change_pct: number | null): SectorMember {
  return { code: 'X', name: 'x', tier: 'other', change_pct };
}

function sector(overrides: Partial<SectorEntry> & { name: string }): SectorEntry {
  return {
    change_pct: null,
    count: 0,
    members: [],
    ...overrides,
  };
}

describe('sectorStrength', () => {
  it('1銘柄+15%の極小セクターより、15銘柄平均+4%のセクターが上位になる', () => {
    // 実例: 「魚群探知機」= 古野電気1銘柄のみ +15.7%
    const tiny = sector({
      name: '魚群探知機',
      change_pct: 15.7,
      count: 1,
      members: [member(15.7)],
    });
    // ドローン/DRAM型: 15銘柄が平均+4%超、大半が上昇。
    const broad = sector({
      name: 'ドローン',
      change_pct: 4,
      count: 15,
      members: [
        ...Array.from({ length: 12 }, () => member(4)),
        ...Array.from({ length: 3 }, () => member(-1)),
      ],
    });

    const tinyScore = sectorStrength(tiny);
    const broadScore = sectorStrength(broad);
    expect(tinyScore).not.toBeNull();
    expect(broadScore).not.toBeNull();
    expect(broadScore as number).toBeGreaterThan(tinyScore as number);
  });

  it('change_pct が null なら null を返す(ランキング末尾行き)', () => {
    const s = sector({
      name: '不明',
      change_pct: null,
      count: 10,
      members: [member(1), member(-1)],
    });
    expect(sectorStrength(s)).toBeNull();
  });

  it('count<=30 では広がり(breadth)が効く', () => {
    const allUp = sector({
      name: '全銘柄上昇',
      change_pct: 5,
      count: 10,
      members: Array.from({ length: 10 }, () => member(5)),
    });
    const halfUp = sector({
      name: '半分上昇',
      change_pct: 5,
      count: 10,
      members: [
        ...Array.from({ length: 5 }, () => member(5)),
        ...Array.from({ length: 5 }, () => member(-3)),
      ],
    });

    const allUpScore = sectorStrength(allUp) as number;
    const halfUpScore = sectorStrength(halfUp) as number;
    expect(allUpScore).toBeGreaterThan(halfUpScore);

    // 具体値も検証: base = 5 × (10/18)、breadth 1.0 → ×1.0
    expect(allUpScore).toBeCloseTo(5 * (10 / 18), 6);
    // breadth 0.5 → ×(0.4+0.6×0.5)=0.7
    expect(halfUpScore).toBeCloseTo(5 * (10 / 18) * 0.7, 6);
  });

  it('count>30 では members(上位サンプル)の広がりを無視する', () => {
    // count=50 だが members は上位30件のみで大半が上昇(サンプルバイアス)。
    // breadth を適用すると常に≈1になってしまうため、無視して規模シュリンクのみ。
    const big = sector({
      name: 'IT関連',
      change_pct: 3,
      count: 50,
      members: [
        ...Array.from({ length: 10 }, () => member(3)),
        ...Array.from({ length: 20 }, () => member(-2)),
      ],
    });
    const score = sectorStrength(big) as number;
    expect(score).toBeCloseTo(3 * (50 / 58), 6);
  });

  it('count<3 は極小セクター減衰(×0.25)がかかる', () => {
    const pair = sector({
      name: '2銘柄セクター',
      change_pct: 10,
      count: 2,
      members: [member(10), member(10)],
    });
    // base = 10×(2/10) = 2、breadth(全上昇)= ×1.0、tiny減衰 ×0.25 → 0.5
    expect(sectorStrength(pair) as number).toBeCloseTo(0.5, 6);
  });

  it('members が空/全null でも breadth 補正なしで安全に計算できる', () => {
    const noMembers = sector({ name: '空', change_pct: 6, count: 20, members: [] });
    const nullMembers = sector({
      name: '全null',
      change_pct: 6,
      count: 20,
      members: [member(null), member(null)],
    });
    const expected = 6 * (20 / 28);
    expect(sectorStrength(noMembers) as number).toBeCloseTo(expected, 6);
    expect(sectorStrength(nullMembers) as number).toBeCloseTo(expected, 6);
  });
});

describe('sortSectorsByStrength', () => {
  it('勢いスコア降順でソートし、null は末尾に置く', () => {
    const a = sector({ name: 'A', change_pct: null, count: 5, members: [] });
    const b = sector({ name: 'B', change_pct: 4, count: 15, members: Array.from({ length: 15 }, () => member(4)) });
    const c = sector({ name: 'C', change_pct: 15.7, count: 1, members: [member(15.7)] });

    const sorted = sortSectorsByStrength([a, b, c]).map((s) => s.name);
    expect(sorted).toEqual(['B', 'C', 'A']);
  });
});
