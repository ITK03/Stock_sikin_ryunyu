import { describe, expect, it } from 'vitest';
import { barsFromChart, toSymbol } from '../src/data/yahoo';
import type { UniverseEntry } from '../src/data/yahoo';

const entry: UniverseEntry = { code: '7203', name: 'トヨタ自動車', market: 'Prime' };

// Yahoo chart API v8 の代表的なレスポンス形(2営業日 + 欠損1日)。
const sample = {
  chart: {
    result: [
      {
        timestamp: [
          1717372800, // 2024-06-03
          1717459200, // 2024-06-04
          1717545600, // 2024-06-05 (欠損)
        ],
        indicators: {
          quote: [
            {
              close: [3000, 3100, null],
              volume: [1_000_000, 2_000_000, null],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe('yahoo barsFromChart', () => {
  it('終値/出来高から売買代金・時価総額を組み立てる', () => {
    const bars = barsFromChart(sample, entry, 1_000_000_000, 130);
    expect(bars).toHaveLength(2); // 欠損日は除外
    expect(bars[0]).toMatchObject({
      code: '7203',
      name: 'トヨタ自動車',
      market: 'Prime',
      close: 3000,
      turnover: 3000 * 1_000_000, // ≈ 売買代金
      marketCap: 3000 * 1_000_000_000,
    });
    expect(bars[1].turnover).toBe(3100 * 2_000_000);
  });

  it('直近 lookbackDays 件に絞る', () => {
    const bars = barsFromChart(sample, entry, 1_000_000_000, 1);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(3100); // 最新側を残す
  });

  it('壊れた/空レスポンスは空配列', () => {
    expect(barsFromChart({}, entry, 1_000_000_000, 130)).toEqual([]);
    expect(barsFromChart({ chart: { result: [] } }, entry, 1e9, 130)).toEqual([]);
  });

  it('toSymbol は東証サフィックスを付ける', () => {
    expect(toSymbol('7203')).toBe('7203.T');
  });
});
