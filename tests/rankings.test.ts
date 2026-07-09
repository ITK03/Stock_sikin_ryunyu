import { describe, expect, it } from 'vitest';
import { computeRankings } from '../src/core/rankings';
import type { DailyBar, MarketSegment } from '../src/core/types';

// 連続営業日(土日を無視した単純連番)を生成。
function dates(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`2026-01-${String(i + 1).padStart(2, '0')}`);
  }
  return out;
}

function bar(
  date: string,
  code: string,
  turnover: number,
  marketCap: number,
  market: MarketSegment = 'Prime',
): DailyBar {
  return { date, code, name: `銘柄${code}`, market, close: 100, turnover, marketCap };
}

describe('computeRankings ①', () => {
  it('最新営業日の 売買代金/時価総額 が大きい順に並ぶ', () => {
    const ds = dates(3);
    const bars: DailyBar[] = [];
    // A: 比率 0.10、B: 比率 0.50、C: 比率 0.01
    for (const d of ds) {
      bars.push(bar(d, 'A', 10, 100));
      bars.push(bar(d, 'B', 50, 100));
      bars.push(bar(d, 'C', 1, 100));
    }
    const res = computeRankings(bars, { source: 'test' });
    expect(res.ranking1.map((r) => r.code)).toEqual(['B', 'A', 'C']);
    expect(res.ranking1[0].ratio).toBeCloseTo(0.5);
    expect(res.asOfDate).toBe(ds[ds.length - 1]);
  });

  it('最新営業日に取引が無い銘柄は ① に含めない', () => {
    const ds = dates(3);
    const bars: DailyBar[] = [];
    bars.push(bar(ds[0], 'STALE', 99, 100));
    for (const d of ds) bars.push(bar(d, 'LIVE', 5, 100));
    const res = computeRankings(bars, { source: 'test' });
    expect(res.ranking1.map((r) => r.code)).toEqual(['LIVE']);
  });
});

describe('computeRankings ② (期間平均)', () => {
  it('期間平均の比率でランキングされ、期間ごとに結果が変わる', () => {
    const ds = dates(20);
    const bars: DailyBar[] = [];
    // SURGE: 直近3日だけ比率が跳ねる。LONG: 常に中程度。
    ds.forEach((d, i) => {
      const recent = i >= ds.length - 3;
      bars.push(bar(d, 'SURGE', recent ? 80 : 2, 100));
      bars.push(bar(d, 'LONG', 20, 100));
    });
    const res = computeRankings(bars, { source: 'test', minCoverage: 0.5 });
    // 3日平均では SURGE が上、20日平均では LONG が上になるはず。
    expect(res.ranking2['3d'][0].code).toBe('SURGE');
    expect(res.ranking2['1m'][0].code).toBe('LONG');
  });

  it('被覆率が低い銘柄は除外される', () => {
    const ds = dates(20);
    const bars: DailyBar[] = [];
    ds.forEach((d) => bars.push(bar(d, 'FULL', 30, 100)));
    // SPARSE は最新日にだけ存在(20日窓では被覆率1/20)。
    bars.push(bar(ds[ds.length - 1], 'SPARSE', 90, 100));
    const res = computeRankings(bars, { source: 'test', minCoverage: 0.6 });
    const codes = res.ranking2['1m'].map((r) => r.code);
    expect(codes).toContain('FULL');
    expect(codes).not.toContain('SPARSE');
  });
});

describe('computeRankings ③ (全市場上位フィルタ)', () => {
  it('売買代金が上位 topK 以内の銘柄だけに絞り、順位を付与する', () => {
    const ds = dates(5);
    const bars: DailyBar[] = [];
    // SMALL: 比率は高いが売買代金は小さい(時価総額も小さい)。
    // BIG: 比率は中程度だが売買代金が大きい。
    ds.forEach((d) => {
      bars.push(bar(d, 'SMALL', 5, 10)); // 比率0.5, 代金5
      bars.push(bar(d, 'BIG', 5000, 1e5)); // 比率0.05, 代金5000
      bars.push(bar(d, 'MID', 100, 1e4)); // 比率0.01, 代金100
    });
    // topK=2 なら 代金上位2(BIG, MID)のみ対象。SMALL は比率最大でも除外。
    const res = computeRankings(bars, { source: 'test', topK: 2, minCoverage: 0.5 });
    const codes = res.ranking3['1w'].map((r) => r.code);
    expect(codes).not.toContain('SMALL');
    expect(codes).toContain('BIG');
    // BIG は比率(0.05) > MID(0.01) なので先頭。
    expect(res.ranking3['1w'][0].code).toBe('BIG');
    // turnoverRank が付与されている。
    expect(res.ranking3['1w'][0].turnoverRank).toBe(1);
  });
});

describe('computeRankings メタ情報', () => {
  it('topN で件数が制限される', () => {
    const ds = dates(3);
    const bars: DailyBar[] = [];
    for (let i = 0; i < 50; i++) {
      for (const d of ds) bars.push(bar(d, `C${i}`, i + 1, 100));
    }
    const res = computeRankings(bars, { source: 'test', topN: 10 });
    expect(res.ranking1).toHaveLength(10);
    expect(res.universe).toBe(50);
  });
});

describe('computeRankings ④ 売買代金急増(初動)', () => {
  it('直近が過去25日平均に対して急増した銘柄が上位、連日急増は2日/3日でも残る', () => {
    const ds = dates(30);
    const bars: DailyBar[] = [];
    ds.forEach((d, i) => {
      const last3 = i >= ds.length - 3;
      const lastDay = i === ds.length - 1;
      // FLAT: 常に一定(急増なし)。
      bars.push(bar(d, 'FLAT', 100, 1e6));
      // ONE: 最終日だけ急増(1日では上位、2日/3日では薄まる)。
      bars.push(bar(d, 'ONE', lastDay ? 3000 : 100, 1e6));
      // CONT: 直近3日連続で急増(初動)。
      bars.push(bar(d, 'CONT', last3 ? 3000 : 100, 1e6));
    });
    const res = computeRankings(bars, { source: 'test' });

    // 1日: 最終日が急増している ONE と CONT が FLAT より上。
    expect(res.ranking4['1d'][0].code === 'ONE' || res.ranking4['1d'][0].code === 'CONT').toBe(true);
    expect(res.ranking4['1d'].find((r) => r.code === 'FLAT')!.surge).toBeCloseTo(1, 1);

    // 3日: 連日急増の CONT が単発の ONE より上位。
    const surge3 = (c: string) => res.ranking4['3d'].find((r) => r.code === c)!.surge!;
    expect(surge3('CONT')).toBeGreaterThan(surge3('ONE'));
    // baseline(平常時)が付与される。
    expect(res.ranking4['3d'][0].baseline).toBeGreaterThan(0);
  });

  it('場中はペース換算で早期検知できる(sessionProgress投影)', () => {
    const ds = dates(30);
    const lastDate = ds[ds.length - 1];
    const bars: DailyBar[] = [];
    ds.forEach((d) => {
      const isLast = d === lastDate;
      // FLAT: 普段100。最終日は場中20%経過なりの実額(20)しかまだ無い(=通常ペース、急増なし)。
      bars.push(bar(d, 'FLAT', isLast ? 20 : 100, 1e6));
      // PACE: 普段は100だが、最終日は場中20%経過ですでに100(=終日ペースなら500、初動)。
      bars.push(bar(d, 'PACE', 100, 1e6));
    });

    const plain = computeRankings(bars, { source: 'test' });
    const projected = computeRankings(bars, {
      source: 'test',
      intraday: { date: lastDate, progress: 0.2 },
    });

    // 投影なし: 最終日も普段通りの100なので急増なし(≈1.0)。
    const surgePlain = plain.ranking4['1d'].find((r) => r.code === 'PACE')!.surge!;
    expect(surgePlain).toBeCloseTo(1.0, 1);

    // 投影あり: 100 / 0.2 = 500 を過去25日平均100と比較 → 5倍。
    const surgeProjected = projected.ranking4['1d'].find((r) => r.code === 'PACE')!.surge!;
    expect(surgeProjected).toBeCloseTo(5.0, 1);

    // 投影ありでは PACE が FLAT より上位に来る。
    expect(projected.ranking4['1d'][0].code).toBe('PACE');

    // 場中の経過率がデータセットに反映される。
    expect(projected.sessionProgress).toBe(0.2);
  });
});

describe('computeRankings ② 継続性(単発スパイク耐性)', () => {
  it('1日だけの出来高急増では順位が底上げされず、毎日コンスタントな銘柄が上位', () => {
    const ds = dates(10);
    const bars: DailyBar[] = [];
    ds.forEach((d, i) => {
      // SPIKE: 普段は比率0.05、1日だけ比率50の異常値。
      bars.push(bar(d, 'SPIKE', i === 5 ? 5000 : 5, 100));
      // CONST: 毎日 比率0.30 で安定。
      bars.push(bar(d, 'CONST', 30, 100));
    });
    const res = computeRankings(bars, { source: 'test', minCoverage: 0.5 });
    // 単純平均なら SPIKE(≈0.55) が CONST(0.30) に勝つが、継続性重視で逆転する。
    expect(res.ranking2['2w'][0].code).toBe('CONST');
    const spike = res.ranking2['2w'].find((r) => r.code === 'SPIKE')!;
    const cnst = res.ranking2['2w'].find((r) => r.code === 'CONST')!;
    expect(cnst.ratio).toBeGreaterThan(spike.ratio);
  });
});
