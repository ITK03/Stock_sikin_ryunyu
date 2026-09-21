// マイセクター表示用の小さな純ヘルパー(List/Detail で共用)。IO非依存。

import type { SectorScore } from '../core/mySector';
import type { TickerIndexFile } from '../core/types';

/** 騰落率の色クラス(既存 SectorTab と同じ規則: 正=up、負=down、0/null=flat)。 */
export function changeClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'chg-flat';
  if (v > 0) return 'chg-up';
  if (v < 0) return 'chg-down';
  return 'chg-flat';
}

/**
 * 表示用の騰落率。scoreMySector は matched=0(空/全銘柄欠損)のとき合成のため
 * changePct=0 を返すが、UIでは「変化なし」と「データが無い」を混同しないよう
 * null(=「—」表示)に変換する。
 */
export function displayChangePct(score: Pick<SectorScore, 'changePct' | 'matched'>): number | null {
  return score.matched === 0 ? null : score.changePct;
}

/** 銘柄名の解決。ticker_index(日本株のみ)に無ければコードをそのまま表示名にする。 */
export function resolveStockName(code: string, tickerIndex: TickerIndexFile | null | undefined): string {
  return tickerIndex?.tickers?.[code]?.n ?? code;
}
