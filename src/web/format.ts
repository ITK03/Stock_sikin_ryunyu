import type { MarketSegment } from '../core/types';

const OKU = 1e8; // 億
const CHO = 1e12; // 兆

/** 円を「億円/兆円」表記へ。 */
export function yen(v: number): string {
  if (v >= CHO) return `${(v / CHO).toFixed(2)}兆円`;
  if (v >= OKU) return `${(v / OKU).toFixed(1)}億円`;
  return `${Math.round(v / 1e4).toLocaleString()}万円`;
}

/** 比率(0..1)を%表記へ。 */
export function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

export const MARKET_LABEL: Record<MarketSegment, string> = {
  Prime: 'プライム',
  Standard: 'スタンダード',
  Growth: 'グロース',
  Other: 'その他',
};
