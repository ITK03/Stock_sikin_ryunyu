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

/** 騰落率(%単位の値, 例 2.1)を符号付きで表記。null/undefined は「—」。 */
export function signedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 価格を地域通貨で簡潔に表記。null/undefined は「—」。 */
export function priceText(v: number | null | undefined, region: Region): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return region === 'US' ? `$${v.toFixed(2)}` : `${v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`;
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

/**
 * "+09:00" 付きの ISO8601 文字列から時刻(HH:MM)部分だけを、タイムゾーン変換せず
 * 文字列operationで取り出す(開示データは常にJST表記のため、閲覧者のローカルTZに
 * 依存させたくない)。形式が想定外の場合は空文字。
 */
export function jstTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : '';
}

/** 同様に日付(MM/DD)部分だけを取り出す。 */
export function jstDate(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}/${m[2]}` : '';
}

/**
 * ISO時刻を「◯分前 / ◯時間前」表記へ。
 * パース不能な値は空文字("NaN分前"を出さない)。生成時刻が端末時計より未来の場合
 * (時計ずれ・TZオフセット無し表記)は「たった今」に丸める。
 */
export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  return `${day}日前`;
}
