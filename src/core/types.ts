// 中核データモデル。ここはIO非依存の純粋な型のみ。

export type MarketSegment = 'Prime' | 'Standard' | 'Growth' | 'Other';

/** 1銘柄・1営業日の足。売買代金・時価総額は円建て。 */
export interface DailyBar {
  date: string; // 'YYYY-MM-DD'
  code: string; // 証券コード 例 '7203'
  name: string;
  market: MarketSegment;
  close: number; // 終値(円)
  turnover: number; // 売買代金(円)
  marketCap: number; // 時価総額(円) = 終値 × 発行済株式数
}

/** ランキング1行。期間指定のものは ratio/turnover は期間平均。 */
export interface RankRow {
  rank: number;
  code: string;
  name: string;
  market: MarketSegment;
  /** 売買代金 / 時価総額(比率, 0..1)。期間指定時は期間平均。 */
  ratio: number;
  /** 売買代金(円)。期間指定時は期間平均。 */
  turnover: number;
  /** 時価総額(円)。期間内の最新値。 */
  marketCap: number;
  /** 期間内でデータが存在した割合(0..1)。 */
  coverage: number;
  /** ランキング③用: 全市場の売買代金順位(期間平均ベース, 1始まり)。 */
  turnoverRank?: number;
}

export type PeriodKey = '3d' | '1w' | '2w' | '1m' | '3m' | '6m';

export interface RankingDataset {
  /** 生成時刻(ISO8601)。 */
  generatedAt: string;
  /** データの最新営業日。 */
  asOfDate: string;
  /** 対象銘柄数。 */
  universe: number;
  /** ランキング③で「全市場上位」とみなす売買代金順位の閾値。 */
  topK: number;
  /** 各リストの最大表示件数。 */
  topN: number;
  /** データ取得元の識別子(例 'sample', 'jquants')。 */
  source: string;
  /** ① 時価総額比の売買代金が大きい順(最新営業日スナップショット)。 */
  ranking1: RankRow[];
  /** ② 時価総額比の売買代金が大きく連日続いている順(期間平均)。 */
  ranking2: Record<PeriodKey, RankRow[]>;
  /** ③ ②に加えて全市場の売買代金上位に入っている順。 */
  ranking3: Record<PeriodKey, RankRow[]>;
}
