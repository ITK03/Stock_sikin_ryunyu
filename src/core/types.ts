// 中核データモデル。ここはIO非依存の純粋な型のみ。

/** 対象地域。JP=日本株(円建て)、US=米国株(ドル建て)。 */
export type Region = 'JP' | 'US';

// 市場区分。JPは東証区分、USは上場取引所を区分として使う。
export type MarketSegment =
  | 'Prime'
  | 'Standard'
  | 'Growth'
  | 'NYSE'
  | 'NASDAQ'
  | 'AMEX'
  | 'Other';

/** 1銘柄・1営業日の足。金額は地域通貨建て(JP=円, US=ドル)。 */
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
  /** 売買代金(地域通貨)。期間指定時は期間平均、急増は直近N日平均。 */
  turnover: number;
  /** 時価総額(地域通貨)。期間内の最新値。 */
  marketCap: number;
  /** 期間内でデータが存在した割合(0..1)。 */
  coverage: number;
  /** ランキング③用: 全市場の売買代金順位(期間平均ベース, 1始まり)。 */
  turnoverRank?: number;
  /** 急増ランキング用: 直近N日平均売買代金 ÷ 過去25営業日平均(倍)。 */
  surge?: number;
  /** 急増ランキング用: 過去25営業日平均の売買代金(平常時の水準)。 */
  baseline?: number;
}

export type PeriodKey = '3d' | '1w' | '2w' | '1m' | '3m' | '6m';

/** 売買代金急増の集計期間(直近N営業日)。 */
export type SurgeHorizon = '1d' | '2d' | '3d';

export interface RankingDataset {
  /** 生成時刻(ISO8601)。 */
  generatedAt: string;
  /** データの最新営業日。 */
  asOfDate: string;
  /** 対象地域。 */
  region: Region;
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
  /** ④ 売買代金急増(初動)。直近N日平均 ÷ 過去25営業日平均 が大きい順。 */
  ranking4: Record<SurgeHorizon, RankRow[]>;
  /** 場中ビルド時のセッション経過率(0..1)。1=引け後/完全な日足。 */
  sessionProgress?: number;
}
