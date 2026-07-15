import type {
  DailyBar,
  PeriodKey,
  RankRow,
  RankingDataset,
  Region,
  SurgeHorizon,
} from './types';
import { PERIODS, SURGE_BASELINE_DAYS, SURGE_HORIZONS } from './periods';

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
  region: Region;
  generatedAt?: string;
  /** 場中ビルド情報。date=当日(取引所ローカル 'YYYY-MM-DD')、progress=セッション経過率(0..1]。 */
  intraday?: { date: string; progress: number };
}

const DEFAULTS = {
  topN: 100,
  topK: 100,
  minCoverage: 0.6,
  source: 'unknown',
  region: 'JP' as Region,
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

function buildChangePctMap(byCode: Map<string, CodeSeries>): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of byCode.values()) {
    if (s.bars.length < 2) continue;
    const cur = s.bars[s.bars.length - 1];
    const prev = s.bars[s.bars.length - 2];
    if (prev.close > 0) {
      m.set(s.code, Math.round(((cur.close - prev.close) / prev.close) * 1000) / 10);
    }
  }
  return m;
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * ウィンザライズ平均: 各値を「中央値×3」で上限クリップしてから平均する。
 * 出来高が1日だけ異常に多い等の単発スパイクが平均を底上げするのを抑える。
 */
function winsorMean(vals: number[]): number {
  if (vals.length === 0) return 0;
  const cap = median(vals) * 3;
  let sum = 0;
  for (const v of vals) sum += cap > 0 ? Math.min(v, cap) : v;
  return sum / vals.length;
}

/**
 * 期間スコア(②③の順位付けの基準)。
 * 「単発の急増では上がらず、毎日コンスタントに資金が入っているほど高い」よう設計:
 *  - ウィンザライズ平均で単発スパイクの影響を抑制
 *  - 継続性(普段の水準=中央値付近を毎日維持できているか)を重みとして掛ける
 */
function continuityScore(ratios: number[]): number {
  const n = ratios.length;
  if (n === 0) return 0;
  const med = median(ratios);
  const base = winsorMean(ratios);
  const threshold = 0.6 * med;
  let sustained = 0;
  for (const r of ratios) if (r >= threshold) sustained += 1;
  const consistency = sustained / n; // 0..1
  // 継続的な銘柄ほど満点(×1.0)、ムラのある銘柄は最大でも×0.6まで減衰。
  return base * (0.6 + 0.4 * consistency);
}

/** ① 最新営業日のスナップショット。時価総額比の売買代金が大きい順。 */
function buildRanking1(
  byCode: Map<string, CodeSeries>,
  latestDate: string,
  topN: number,
  changePctMap: Map<string, number>,
): RankRow[] {
  const rows: Omit<RankRow, 'rank'>[] = [];
  for (const s of byCode.values()) {
    const bar = s.bars[s.bars.length - 1];
    if (!bar || bar.date !== latestDate) continue;
    if (bar.marketCap <= 0) continue;
    rows.push({
      code: s.code,
      name: s.name,
      market: bar.market,
      ratio: ratio(bar),
      turnover: bar.turnover,
      marketCap: bar.marketCap,
      coverage: 1,
      changePct: changePctMap.get(s.code),
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
  marketCap: number;
  coverage: number;
  changePct?: number;
}

/**
 * 期間(直近 tradingDays 営業日)について、銘柄ごとの期間スコア(継続性重視)と
 * 売買代金(スパイク耐性のあるウィンザライズ平均)を算出。
 * 最新営業日に取引があり、かつ被覆率が minCoverage 以上の銘柄のみ対象。
 * avgRatio は継続性スコア、avgTurnover はウィンザライズ平均売買代金。
 */
function windowStats(
  byCode: Map<string, CodeSeries>,
  dates: string[],
  tradingDays: number,
  latestDate: string,
  minCoverage: number,
  changePctMap: Map<string, number>,
): WindowStat[] {
  const window = dates.slice(-tradingDays);
  const windowSet = new Set(window);
  const denom = window.length || 1;
  const stats: WindowStat[] = [];

  for (const s of byCode.values()) {
    const ratios: number[] = [];
    const turnovers: number[] = [];
    let latestBar: DailyBar | undefined;
    let presentOnLatest = false;

    for (const bar of s.bars) {
      if (!windowSet.has(bar.date)) continue;
      if (bar.marketCap <= 0) continue;
      ratios.push(ratio(bar));
      turnovers.push(bar.turnover);
      latestBar = bar; // bars は昇順なので最後が期間内最新
      if (bar.date === latestDate) presentOnLatest = true;
    }

    if (!presentOnLatest || !latestBar) continue;
    const coverage = ratios.length / denom;
    if (coverage < minCoverage) continue;

    stats.push({
      code: s.code,
      name: s.name,
      market: latestBar.market,
      avgRatio: continuityScore(ratios),
      avgTurnover: winsorMean(turnovers),
      marketCap: latestBar.marketCap,
      coverage,
      changePct: changePctMap.get(s.code),
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
    changePct: s.changePct,
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

/**
 * ④ 売買代金急増(初動)。SBI等の「売買代金急増率」に相当。
 * 直近N営業日(1/2/3)の平均売買代金を、その手前の過去25営業日平均(平常時)で割った
 * 倍率で降順。分母(平常時)は全期間共通なので、2日/3日で上位=連日で急増が継続=初動。
 */
function buildSurge(
  byCode: Map<string, CodeSeries>,
  dates: string[],
  latestDate: string,
  topN: number,
  changePctMap: Map<string, number>,
  intraday?: { date: string; progress: number },
): Record<SurgeHorizon, RankRow[]> {
  const minBaseline = Math.ceil(SURGE_BASELINE_DAYS * 0.6);
  const result = {} as Record<SurgeHorizon, RankRow[]>;

  // 場中ビルドでは当日の累計売買代金を終日ペースに換算してから急増判定する
  // (寄り直後は分母(経過率)を0.15で床止めし、換算値が極端に膨らむのを防ぐ)。
  const projectedTurnover = (b: DailyBar): number => {
    if (!intraday || b.date !== intraday.date) return b.turnover;
    return b.turnover / Math.max(intraday.progress, 0.15);
  };

  for (const def of SURGE_HORIZONS) {
    // 基準(平常時)の窓は集計期間ごとに手前へずらす: 1日なら昨日まで、
    // 3日なら3日前までを基準に含めることで、数日前から噴いている銘柄の
    // 基準が上がり(=急増率が下がり)、当日始まった銘柄(初動)が浮かぶ。
    const baselineDates = dates.slice(-(SURGE_BASELINE_DAYS + def.days), -def.days);
    const recentDates = dates.slice(-def.days); // 直近N営業日
    const rows: Omit<RankRow, 'rank'>[] = [];

    for (const s of byCode.values()) {
      const byDate = new Map(s.bars.map((b) => [b.date, b]));

      // 平常時基準: 手前25営業日の平均売買代金(時価総額は不要=ETF等も対象)。
      let bSum = 0;
      let bCnt = 0;
      for (const d of baselineDates) {
        const b = byDate.get(d);
        if (b && b.turnover > 0) {
          bSum += b.turnover;
          bCnt += 1;
        }
      }
      if (bCnt < minBaseline) continue;
      const baseline = bSum / bCnt;
      if (baseline <= 0) continue;

      // 直近N日はすべて取引がある必要(連日性を担保)。
      let rSum = 0;
      let ok = true;
      let latestBar: DailyBar | undefined;
      for (const d of recentDates) {
        const b = byDate.get(d);
        if (!b || b.turnover <= 0) {
          ok = false;
          break;
        }
        rSum += projectedTurnover(b);
        if (d === latestDate) latestBar = b;
      }
      if (!ok || !latestBar) continue;

      const recentAvg = rSum / def.days;
      rows.push({
        code: s.code,
        name: s.name,
        market: latestBar.market,
        ratio: latestBar.marketCap > 0 ? latestBar.turnover / latestBar.marketCap : 0,
        turnover: recentAvg,
        marketCap: latestBar.marketCap,
        coverage: bCnt / SURGE_BASELINE_DAYS,
        surge: recentAvg / baseline,
        baseline,
        changePct: changePctMap.get(s.code),
      });
    }

    rows.sort((a, b) => (b.surge ?? 0) - (a.surge ?? 0));
    result[def.key] = rows.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
  }
  return result;
}

export function computeRankings(
  bars: DailyBar[],
  options: Partial<RankingOptions> = {},
): RankingDataset {
  const opts = { ...DEFAULTS, ...options };
  const byCode = groupByCode(bars);
  const dates = tradingDates(bars);
  const latestDate = dates[dates.length - 1] ?? '';
  const changePctMap = buildChangePctMap(byCode);

  const ranking2 = {} as Record<PeriodKey, RankRow[]>;
  const ranking3 = {} as Record<PeriodKey, RankRow[]>;

  for (const period of PERIODS) {
    const stats = windowStats(
      byCode,
      dates,
      period.tradingDays,
      latestDate,
      opts.minCoverage,
      changePctMap,
    );
    ranking2[period.key] = buildRanking2(stats, opts.topN);
    ranking3[period.key] = buildRanking3(stats, opts.topK, opts.topN);
  }

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    asOfDate: latestDate,
    region: opts.region,
    universe: byCode.size,
    topK: opts.topK,
    topN: opts.topN,
    source: opts.source,
    ranking1: buildRanking1(byCode, latestDate, opts.topN, changePctMap),
    ranking2,
    ranking3,
    ranking4: buildSurge(byCode, dates, latestDate, opts.topN, changePctMap, opts.intraday),
    sessionProgress: opts.intraday?.progress ?? 1,
  };
}
