// 株価フィード配信(GitHub Pages経由で本体sector-monitorを救済)用の純粋関数群。
// IO非依存: build.ts が bars 取得後にこれらを呼び、writeFileSync で出力する。
// 既存の rankings 生成(rankings.ts)には一切依存・影響しない独立モジュール。

import type { DailyBar, PeriodKey } from './types';
import { PERIODS } from './periods';

/** quotes_{jp|us}.json の1銘柄分。p=最新close、c=前日比%(小数1桁, 省略可)。 */
export interface QuoteEntry {
  p: number;
  c?: number;
}

/** quotes_{jp|us}.json のトップレベル形。 */
export interface QuotesFile {
  generated_at: string;
  asOf: string;
  quotes: Record<string, QuoteEntry>;
}

/** period_returns_{jp|us}.json の1銘柄分。キーは PERIODS の key、値は%(小数2桁)。遡り先が無い期間は省略。 */
export type PeriodReturnEntry = Partial<Record<PeriodKey, number>>;

/** period_returns_{jp|us}.json のトップレベル形。 */
export interface PeriodReturnsFile {
  generated_at: string;
  asOf: string;
  returns: Record<string, PeriodReturnEntry>;
}

interface CodeSeries {
  code: string;
  bars: DailyBar[]; // 日付昇順
}

/** 銘柄ごとに日付昇順の時系列へ整理する(rankings.ts の groupByCode と同等の独立実装)。 */
function groupByCode(bars: DailyBar[]): Map<string, CodeSeries> {
  const byCode = new Map<string, CodeSeries>();
  for (const bar of bars) {
    let s = byCode.get(bar.code);
    if (!s) {
      s = { code: bar.code, bars: [] };
      byCode.set(bar.code, s);
    }
    s.bars.push(bar);
  }
  for (const s of byCode.values()) {
    s.bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return byCode;
}

/** 全データに現れる営業日のうち最新のものを返す(無ければ空文字)。 */
function latestTradingDate(bars: DailyBar[]): string {
  let latest = '';
  for (const b of bars) if (b.date > latest) latest = b.date;
  return latest;
}

/**
 * quotes_{jp|us}.json の中身を計算する。
 * p = 最新barのclose、c = 直近2barのcloseから求めた騰落率%(小数1桁丸め)。
 * bar が1本しかない銘柄は c を省略。前日barの close<=0 の場合も c を省略。
 */
export function buildQuotes(bars: DailyBar[], generatedAt: string = new Date().toISOString()): QuotesFile {
  const byCode = groupByCode(bars);
  const quotes: Record<string, QuoteEntry> = {};

  for (const s of byCode.values()) {
    if (s.bars.length === 0) continue;
    const cur = s.bars[s.bars.length - 1];
    const entry: QuoteEntry = { p: cur.close };

    if (s.bars.length >= 2) {
      const prev = s.bars[s.bars.length - 2];
      if (prev.close > 0) {
        entry.c = Math.round(((cur.close - prev.close) / prev.close) * 1000) / 10;
      }
    }

    quotes[s.code] = entry;
  }

  return {
    generated_at: generatedAt,
    asOf: latestTradingDate(bars),
    quotes,
  };
}

/**
 * period_returns_{jp|us}.json の中身を計算する。
 * PERIODS(key: tradingDays)ごとに close[last] / close[last - tradingDays] - 1 を%(小数2桁)で求める。
 * 遡り先のbarが無い(履歴不足)、または遡り先の close<=0 の場合はそのキーを省略。
 */
export function buildPeriodReturns(
  bars: DailyBar[],
  generatedAt: string = new Date().toISOString(),
): PeriodReturnsFile {
  const byCode = groupByCode(bars);
  const returns: Record<string, PeriodReturnEntry> = {};

  for (const s of byCode.values()) {
    if (s.bars.length === 0) continue;
    const lastIdx = s.bars.length - 1;
    const cur = s.bars[lastIdx];
    const entry: PeriodReturnEntry = {};

    for (const period of PERIODS) {
      const pastIdx = lastIdx - period.tradingDays;
      if (pastIdx < 0) continue;
      const past = s.bars[pastIdx];
      if (past.close <= 0) continue;
      entry[period.key] = Math.round(((cur.close / past.close - 1) * 100) * 100) / 100;
    }

    if (Object.keys(entry).length > 0) {
      returns[s.code] = entry;
    }
  }

  return {
    generated_at: generatedAt,
    asOf: latestTradingDate(bars),
    returns,
  };
}
