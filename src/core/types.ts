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
  /** 前日比(%)。最新営業日と前営業日の終値から算出。 */
  changePct?: number;
  /**
   * 順位変動。1つ手前の同じ長さの期間での順位と比較した差(+は上昇/-は下降)。
   * 例: 3日期間なら「3〜6日前の3日間」の順位からの変化。手前の期間で
   * ランク外(データ不足/未取引)だった場合は undefined。②③期間ランキングのみ。
   */
  rankDelta?: number;
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

// ---------------------------------------------------------------------------
// 外部データソース(他リポジトリが生成するデータの型)。
// IO非依存の型のみ。取得(fetch)は src/web 側で行う。
// ---------------------------------------------------------------------------

/** 開示の重要度。 */
export type DisclosureImpact = 'high' | 'medium' | 'low';

/** 開示の株価インパクトの向き。 */
export type DisclosureDirection = 'positive' | 'negative' | 'neutral' | 'unknown';

/** 決算開示に付与されることがある要約(任意)。 */
export interface EarningsSummary {
  period: string;
  figures: { label: string; value: string; yoy?: string }[];
  dividend?: string;
  forecast?: string;
  comment?: string;
  source: 'llm' | 'regex';
}

/**
 * 適時開示 1件(Stock_open_news 生成)。
 * code は4-5桁の証券コード文字列だが、不明な場合は空文字。
 */
export interface Disclosure {
  id: string;
  time: string; // ISO8601 (JST, +09:00)
  code: string;
  company: string;
  title: string;
  pdf_url: string;
  exchange: string;
  markets: string;
  source: string;
  category: string;
  score: number; // 0-100
  impact: DisclosureImpact;
  direction: DisclosureDirection;
  urgent: boolean;
  summary: string;
  reasons: string[];
  analyzed_by: string;
  analyzed_at: string;
  confidence: number; // 0-100
  is_correction: boolean;
  tags: string[];
  earnings?: EarningsSummary;
}

/** docs/data/disclosures.json のトップレベル形。 */
export interface DisclosuresFeed {
  updated_at: string;
  count: number;
  items: Disclosure[];
}

/** docs/data/archive/index.json(日付別アーカイブの索引)のトップレベル形。 */
export interface DisclosuresArchiveIndex {
  updated_at: string;
  dates: { date: string; count: number }[];
}

// sector-monitor データ契約 schema_version 2(2026-07時点)。
// 旧: 単一 sector.json + markets.{JP,US} + 銘柄ごとの ticker/price 埋め込み。
// 新: 地域ごとに sector_jp.json / sector_us.json を分割(数MB規模のため)。
// members は各セクター上位30件のみ(count が全構成数)。ticker/price フィールドは無い。
// JP/US はタブ切替時に遅延fetchし、初期表示では両方読み込まない。

/** セクター構成銘柄 1件(sector-monitor 生成, schema v2)。price は含まれない。 */
export interface SectorMember {
  code: string;
  name: string;
  tier: string;
  change_pct: number | null;
}

/** セクター(テーマ)1件。members は上位30件のみ、count が全構成数。 */
export interface SectorEntry {
  name: string;
  change_pct: number | null;
  count: number;
  members: SectorMember[];
  /** 構成2銘柄以下(sector-monitor側の export_snapshot.py が付与)。 */
  thin?: boolean;
}

/** sector_jp.json / sector_us.json のトップレベル形(地域ごとに1ファイル)。 */
export interface SectorFile {
  schema_version: number;
  generated_at: string;
  market: Region;
  sectors: SectorEntry[];
}

/**
 * ticker_index.json の1エントリ(銘柄コード→所属セクター逆引き)。日本株のみ・
 * 所属セクターは全件(sector_jp.json の上位30件制限を受けない)。
 * n=名称, c=騰落率(null可), p=現在値(null可), s=[セクター名, Tier] の配列。
 */
export interface TickerIndexEntry {
  n: string;
  c: number | null;
  p: number | null;
  s: [string, string][];
}

/** ticker_index.json のトップレベル形。 */
export interface TickerIndexFile {
  schema_version: number;
  generated_at: string;
  tickers: Record<string, TickerIndexEntry>;
}

// ---------------------------------------------------------------------------
// スイングスクリーナー(Twitter_Master 由来)の生成データ。
// site/data/signals.json を統合ダッシュボード用に public/data/signals.json へ出力。
// ---------------------------------------------------------------------------

/** 戦略の検証時アウトオブサンプル成績。 */
export interface SwingOosStats {
  win_rate: number;
  profit_factor: number;
  /** 1トレードあたりの平均リターン(比率, 0.0026 = +0.26%)。掲載順の並び替えキー。 */
  avg_ret?: number;
  max_dd: number;
  period: string;
  trades: number;
}

/** 翌営業日の買い候補(指値エントリー)。 */
export interface SwingBuyCandidate {
  code: string;
  name: string;
  close: number;
  /** ランク指標の生値(戦略ごとに意味が異なる)。 */
  rank_value: number;
  /** 表示用のランクラベル(例: "RSI(2)=0.1")。 */
  rank_label: string;
  /** 1単元の概算コスト(円)。 */
  unit_cost: number;
  /** 推奨指値(円)。 */
  limit_price: number;
  /** 表示優先度(1が最優先)。 */
  priority: number;
}

/** ユニバース内の各銘柄の現在状態(entry/exit シグナル等)。 */
export interface SwingUniverseStatus {
  code: string;
  name: string;
  close: number;
  entry: boolean;
  exit: boolean;
  rank_label: string;
  trend_ok: boolean;
}

/** 戦略の手仕舞いルール(利確率・災害ストップ率・最大保有営業日)。 */
export interface SwingExitRules {
  /** 利確率(例: 0.02 = +2%)。null なら利確ルールなし。 */
  take_profit: number | null;
  /** 災害ストップ率(例: 0.15 = -15%)。 */
  stop_loss: number | null;
  /** 最大保有営業日数。 */
  max_hold: number | null;
}

/** 掲載戦略1件。 */
export interface SwingStrategy {
  id: string;
  display_name: string;
  description: string;
  oos_stats: SwingOosStats;
  validated_at: string;
  rule_note: string;
  /** 指値の前日終値からの割引率(例: 0.01 = -1%)。 */
  limit_entry: number;
  /** 手仕舞いルールの数値(保有ポジションの「今後どうするか」判定に使う)。 */
  exit_rules?: SwingExitRules;
  risks: string[];
  buy_candidates: SwingBuyCandidate[];
  universe_status: SwingUniverseStatus[];
}

/** ペーパートレード成績サマリ。 */
export interface SwingPaperLogSummary {
  closed_trades: number;
  win_rate: number;
  avg_ret: number;
  by_strategy: Record<string, { closed_trades: number; win_rate: number; avg_ret: number }>;
}

// --- 検証ログ(自動ペーパートレード paper_log.json)の明細 ---

/** 待機中: シグナルが出て翌営業日に指値発注する予定(未約定)。 */
export interface SwingPaperPending {
  id: string;
  strategy_id: string;
  code: string;
  name: string;
  signal_date: string;
  trade_date: string;
  limit_price: number;
}

/** 保有中(検証用): 約定して保有中のペーパーポジション。 */
export interface SwingPaperOpen {
  id: string;
  strategy_id: string;
  code: string;
  name: string;
  entry_date: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
  deadline_date: string;
  pending_exit: boolean;
  exit_reason: string | null;
}

/** 確定: 手仕舞い済みのペーパートレード1件。 */
export interface SwingPaperClosed {
  id: string;
  strategy_id: string;
  code: string;
  name: string;
  entry_date: string;
  entry_price: number;
  exit_date: string;
  exit_price: number;
  exit_reason: string;
  return_pct: number;
  hold_days: number;
}

/** paper_log.json のトップレベル形(自動ペーパートレードの検証ログ)。 */
export interface SwingPaperLog {
  version: number;
  updated_at: string;
  pending: SwingPaperPending[];
  open: SwingPaperOpen[];
  closed: SwingPaperClosed[];
}

/** signals.json のトップレベル形。 */
export interface SwingSignalsFeed {
  version: number;
  generated_at: string;
  /** シグナル算出に使ったデータの営業日。 */
  data_date: string;
  /** 買い候補を実際に発注する対象営業日(翌営業日)。 */
  trade_date: string;
  /** 'ok' 以外はデータ遅延・休場等で候補が不完全な可能性。 */
  status: string;
  status_reason: string;
  universe_count: number;
  strategies: SwingStrategy[];
  calendar: { future_business_days: string[] };
  paper_log_summary: SwingPaperLogSummary;
}


/**
 * 現在値(全銘柄)。data-rankings ブランチに数分おきで更新される。
 * p = 終値(または直近値)、c = 前日比(%)。
 */
export interface QuotesFile {
  generated_at?: string;
  asOf?: string;
  quotes: Record<string, { p: number | null; c: number | null }>;
}
