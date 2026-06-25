import type {
  DailyBar,
  PeriodKey,
  RankRow,
  RankingDataset,
} from './types';
import { PERIODS } from './periods';

export interface RankingOptions {
  /** 各リストの最大表示件数。 */
  topN: number;
  /** ランキング③で「全市場上位」とみなす売買代金順位の閾値。 */
  topK: number;
  /**
   * 期間内でデータが存在すべき最小割合(0..1)。
   * 上場間もない/出来高が薄く欠損が多い銘柄を除外する。
   */
  minCoverage: number;
  source: string;
  generatedAt?: string;
}

const DEFAULTS = {
  topN: 100,
  topK: 100,
  minCoverage: 0.6,
  source: 'unknown',
};

interface CodeSeries {
  code: string;
  name: string;
  bars: DailyBar[]; // 日付昇順
}

/** 銘柄ごとに日付昇順の時系列へ整理する。 */
function groupByCode(bars: DailyBar[]): Map<string, CodeSeries> {
  const byCode = new Map<string, CodeSeries>();
  for (const bar of bars) {
    let s = byCode.get(bar.code);
    if (!s) {
      s = { code: bar.code, name: bar.name, bars: [] };
      byCode.set(bar.code, s);
    }
    s.name = bar.name; // 最新名称を採用
    s.bars.push(bar);
  }
  for (const s of byCode.values()) {
    s.bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return byCode;
}

/** 全データに現れる営業日を昇順ユニークで返す。 */
function tradingDates(bars: DailyBar[]): string[] {
  const set = new Set<string>();
  for (const b of bars) set.add(b.date);
  return [...set].sort();
}

const ratio = (b: DailyBar): number =>
  b.marketCap > 0 ? b.turnover / b.marketCap : 0;

/** ① 最新営業日のスナップショット。時価総額比の売買代金が大きい順。 */
function buildRanking1(
  byCode: Map<string, CodeSeries>,
  latestDate: string,
  topN: number,
): RankRow[] {
  const rows: Omit<RankRow, 'rank'>[] = [];
  for (const s of byCode.values()) {
    const bar = s.bars[s.bars.length - 1];
    if (!bar || bar.date !== latestDate) continue; // 最新営業日に取引のある銘柄のみ
    if (bar.marketCap <= 0) continue;
    rows.push({
      code: s.code,
      name: s.name,
      market: bar.market,
      ratio: ratio(bar),
      turnover: bar.turnover,
      marketCap: bar.marketCap,
      coverage: 1,
    });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  return rows.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

interface WindowStat {
  code: string;
  name: string;
  market: DailyBar['market'];
  avgRatio: number;
  avgTurnover: number;
  marketCap: number; // 期間内の最新時価総額
  coverage: number;
}

/**
 * 期間(直近 tradingDays 営業日)について、銘柄ごとの平均比率・平均売買代金を算出。
 * 最新営業日に取引があり、かつ被覆率が minCoverage 以上の銘柄のみ対象。
 */
function windowStats(
  byCode: Map<string, CodeSeries>,
  dates: string[],
  tradingDays: number,
  latestDate: string,
  minCoverage: number,
): WindowStat[] {
  const window = dates.slice(-tradingDays);
  const windowSet = new Set(window);
  const denom = window.length || 1;
  const stats: WindowStat[] = [];

  for (const s of byCode.values()) {
    let sumRatio = 0;
    let sumTurnover = 0;
    let count = 0;
    let latestBar: DailyBar | undefined;
    let presentOnLatest = false;

    for (const bar of s.bars) {
      if (!windowSet.has(bar.date)) continue;
      if (bar.marketCap <= 0) continue;
      sumRatio += ratio(bar);
      sumTurnover += bar.turnover;
      count += 1;
      latestBar = bar; // bars は昇順なので最後が期間内最新
      if (bar.date === latestDate) presentOnLatest = true;
    }

    if (!presentOnLatest || !latestBar) continue;
    const coverage = count / denom;
    if (coverage < minCoverage) continue;

    stats.push({
      code: s.code,
      name: s.name,
      market: latestBar.market,
      avgRatio: sumRatio / count,
      avgTurnover: sumTurnover / count,
      marketCap: latestBar.marketCap,
      coverage,
    });
  }
  return stats;
}

function toRows(stats: WindowStat[]): Omit<RankRow, 'rank'>[] {
  return stats.map((s) => ({
    code: s.code,
    name: s.name,
    market: s.market,
    ratio: s.avgRatio,
    turnover: s.avgTurnover,
    marketCap: s.marketCap,
    coverage: s.coverage,
  }));
}

/** ② 期間平均の比率が大きい順(連日続いている)。 */
function buildRanking2(stats: WindowStat[], topN: number): RankRow[] {
  const rows = toRows(stats);
  rows.sort((a, b) => b.ratio - a.ratio);
  return rows.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * ③ ②に加えて、全市場の売買代金(期間平均)上位 topK に入る銘柄のみを対象に、
 * 期間平均の比率が大きい順で並べる。各行に全市場での売買代金順位を付与。
 */
function buildRanking3(
  stats: WindowStat[],
  topK: number,
  topN: number,
): RankRow[] {
  // 全市場の売買代金順位(期間平均ベース)を確定。
  const byTurnover = [...stats].sort((a, b) => b.avgTurnover - a.avgTurnover);
  const turnoverRank = new Map<string, number>();
  byTurnover.forEach((s, i) => turnoverRank.set(s.code, i + 1));

  const eligible = stats.filter((s) => (turnoverRank.get(s.code) ?? Infinity) <= topK);
  const rows = toRows(eligible).map((r) => ({
    ...r,
    turnoverRank: turnoverRank.get(r.code),
  }));
  rows.sort((a, b) => b.ratio - a.ratio);
  return rows.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

export function computeRankings(
  bars: DailyBar[],
  options: Partial<RankingOptions> = {},
): RankingDataset {
  const opts = { ...DEFAULTS, ...options };
  const byCode = groupByCode(bars);
  const dates = tradingDates(bars);
  const latestDate = dates[dates.length - 1] ?? '';

  const ranking2 = {} as Record<PeriodKey, RankRow[]>;
  const ranking3 = {} as Record<PeriodKey, RankRow[]>;

  for (const period of PERIODS) {
    const stats = windowStats(
      byCode,
      dates,
      period.tradingDays,
      latestDate,
      opts.minCoverage,
    );
    ranking2[period.key] = buildRanking2(stats, opts.topN);
    ranking3[period.key] = buildRanking3(stats, opts.topK, opts.topN);
  }

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    asOfDate: latestDate,
    universe: byCode.size,
    topK: opts.topK,
    topN: opts.topN,
    source: opts.source,
    ranking1: buildRanking1(byCode, latestDate, opts.topN),
    ranking2,
    ranking3,
  };
}
