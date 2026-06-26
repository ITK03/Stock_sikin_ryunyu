import type { MarketSegment, Region } from '../core/types';

const OKU = 1e8;
const CHO = 1e12;

/** 円を「億円/兆円」表記へ(モバイル向けに簡潔)。 */
export function yen(v: number): string {
  if (v >= CHO) return `${(v / CHO).toFixed(2)}兆`;
  if (v >= OKU) return `${(v / OKU).toFixed(0)}億`;
  return `${(v / 1e4).toFixed(0)}万`;
}

/** 地域通貨で金額をフォーマット。JP=兆/億/万(円)、US=T/B/M/K($)。 */
export function money(v: number, region: Region): string {
  if (region === 'US') {
    if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    if (v >= 1e10) return `$${(v / 1e9).toFixed(0)}B`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    return `$${(v / 1e3).toFixed(1)}K`;
  }
  return `${yen(v)}円`;
}

/** 比率(0..1)を%表記へ。 */
export function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

export const MARKET_LABEL: Record<MarketSegment, string> = {
  Prime: 'プライム',
  Standard: 'スタンダード',
  Growth: 'グロース',
  NYSE: 'NYSE',
  NASDAQ: 'NASDAQ',
  AMEX: 'AMEX',
  Other: 'その他',
};

/** ISO時刻を「◯分前 / ◯時間前」表記へ。 */
export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  return `${day}日前`;
}
