import { describe, expect, it } from 'vitest';
import { buildQuotes, buildPeriodReturns } from '../src/core/feed';
import type { DailyBar, MarketSegment } from '../src/core/types';

// 連続営業日(土日を無視した単純連番)を生成。
function dates(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`2026-01-${String(i + 1).padStart(2, '0')}`);
  }
  return out;
}

function bar(date: string, code: string, close: number, market: MarketSegment = 'Prime'): DailyBar {
  return { date, code, name: `銘柄${code}`, market, close, turnover: 100, marketCap: 1000 };
}

describe('buildQuotes', () => {
  it('p は最新barのclose、c は直近2barからの騰落率%(小数1桁)', () => {
    const bars: DailyBar[] = [bar('2026-01-01', 'A', 100), bar('2026-01-02', 'A', 124)];
    const res = buildQuotes(bars, '2026-01-02T00:00:00.000Z');
    expect(res.quotes['A'].p).toBe(124);
    // (124-100)/100*100 = 24.0
    expect(res.quotes['A'].c).toBeCloseTo(24.0, 5);
    expect(res.asOf).toBe('2026-01-02');
    expect(res.generated_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('bar が1本しかない銘柄は c を省略', () => {
    const bars: DailyBar[] = [bar('2026-01-01', 'ONLY', 100)];
    const res = buildQuotes(bars);
    expect(res.quotes['ONLY'].p).toBe(100);
    expect(res.quotes['ONLY'].c).toBeUndefined();
  });

  it('前日barの close<=0 のときは c を省略', () => {
    const bars: DailyBar[] = [bar('2026-01-01', 'ZERO', 0), bar('2026-01-02', 'ZERO', 100)];
    const res = buildQuotes(bars);
    expect(res.quotes['ZERO'].p).toBe(100);
    expect(res.quotes['ZERO'].c).toBeUndefined();
  });

  it('小数1桁に丸められる', () => {
    const bars: DailyBar[] = [bar('2026-01-01', 'B', 3), bar('2026-01-02', 'B', 3.1)];
    const res = buildQuotes(bars);
    // (3.1-3)/3*100 = 3.333...
    expect(res.quotes['B'].c).toBe(3.3);
  });

  it('複数銘柄をそれぞれ計算する', () => {
    const bars: DailyBar[] = [
      bar('2026-01-01', 'A', 100),
      bar('2026-01-02', 'A', 110),
      bar('2026-01-01', 'B', 50),
      bar('2026-01-02', 'B', 45),
    ];
    const res = buildQuotes(bars);
    expect(Object.keys(res.quotes).sort()).toEqual(['A', 'B']);
    expect(res.quotes['A'].c).toBe(10.0);
    expect(res.quotes['B'].c).toBeCloseTo(-10.0, 5);
  });
});

describe('buildPeriodReturns', () => {
  it('PERIODS の各期間で close[last]/close[last-tradingDays]-1 を%(小数2桁)で計算', () => {
    const ds = dates(10);
    const bars: DailyBar[] = ds.map((d, i) => bar(d, 'A', 100 + i)); // close: 100..109
    const res = buildPeriodReturns(bars, '2026-01-10T00:00:00.000Z');
    // 3d: close[9]=109, close[9-3]=close[6]=106 -> (109/106-1)*100
    const expected3d = Math.round((109 / 106 - 1) * 100 * 100) / 100;
    expect(res.returns['A']['3d']).toBeCloseTo(expected3d, 5);
    // 1w(5d): close[9]=109, close[4]=104
    const expected1w = Math.round((109 / 104 - 1) * 100 * 100) / 100;
    expect(res.returns['A']['1w']).toBeCloseTo(expected1w, 5);
    expect(res.asOf).toBe('2026-01-10');
    expect(res.generated_at).toBe('2026-01-10T00:00:00.000Z');
  });

  it('遡り先のbarが無い期間はキーを省略する', () => {
    const ds = dates(4); // 4本しかない → 3dのみ算出可能(1w以降は不足)
    const bars: DailyBar[] = ds.map((d, i) => bar(d, 'SHORT', 100 + i));
    const res = buildPeriodReturns(bars);
    expect(res.returns['SHORT']).toHaveProperty('3d');
    expect(res.returns['SHORT']).not.toHaveProperty('1w');
    expect(res.returns['SHORT']).not.toHaveProperty('2w');
    expect(res.returns['SHORT']).not.toHaveProperty('1m');
    expect(res.returns['SHORT']).not.toHaveProperty('3m');
    expect(res.returns['SHORT']).not.toHaveProperty('6m');
  });

  it('全期間で算出不可(bar 1本のみ)の銘柄は returns に含めない', () => {
    const bars: DailyBar[] = [bar('2026-01-01', 'ONLY', 100)];
    const res = buildPeriodReturns(bars);
    expect(res.returns).not.toHaveProperty('ONLY');
  });

  it('遡り先bar の close<=0 の場合はそのキーを省略する', () => {
    const ds = dates(4);
    const closes = [0, 50, 60, 70]; // idx0(3日前)が0
    const bars: DailyBar[] = ds.map((d, i) => bar(d, 'ZERO', closes[i]));
    const res = buildPeriodReturns(bars);
    expect(res.returns['ZERO'] ?? {}).not.toHaveProperty('3d');
  });
});
