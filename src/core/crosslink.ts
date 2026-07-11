// 3データソース(資金流入ランキング・セクター騰落率・適時開示)を
// 銘柄コードをキーに横断結合する純粋関数。IO非依存(fetch等は呼び出し側の責務)。
//
// セクター側は sector-monitor の schema_version 2 契約に基づく:
//  - ticker_index.json: 日本株のみ・所属セクターは全件(横断表示の主ソース)。
//  - sector_us.json: 地域ごとに分割されたファイル。members は各セクター上位30件のみ。
//    米国株には ticker_index が無いため、sector_us.json の構成銘柄一覧から
//    ベストエフォートで所属セクター/騰落率を拾う(現在値は含まれないため取得不可)。

import { normalizeCode } from './codes';
import { PERIOD_KEYS } from './periods';
import type {
  Disclosure,
  DisclosuresFeed,
  PeriodKey,
  RankingDataset,
  Region,
  SectorFile,
  TickerIndexFile,
} from './types';

/** ②③(期間別ランキング)で銘柄が入っていた期間と順位。 */
export interface RankingHit {
  period: PeriodKey;
  rank: number;
}

/** 1地域(JP/US)分のランキング内順位まとめ。 */
export interface RegionRankingInfo {
  region: Region;
  /** ① 時価総額比(最新営業日)での順位。入っていなければ undefined。 */
  ranking1?: number;
  /** ② 連日継続。入っていた期間ごとの順位。 */
  ranking2: RankingHit[];
  /** ③ 全市場上位。入っていた期間ごとの順位。 */
  ranking3: RankingHit[];
}

/** 銘柄の所属セクター/テーマ1件。 */
export interface StockSectorMembership {
  name: string;
  tier: string;
  market: Region;
}

/** 銘柄詳細ビュー用に3ソースを結合した1銘柄分のプロフィール。 */
export interface StockProfile {
  code: string;
  /** 表示名。ticker_index → sector_us.json → ランキングデータの順で埋める。無ければ null。 */
  name: string | null;
  /** 現在値。ticker_index(日本株のみ)由来。無ければ null。 */
  price: number | null;
  /** 騰落率(%)。ticker_index または sector_us.json 由来。無ければ null。 */
  changePct: number | null;
  /** 所属セクター/テーマ(Tier 付き)。 */
  sectors: StockSectorMembership[];
  /** 地域ごとの資金流入ランキング順位(入っている地域のみ)。 */
  rankings: RegionRankingInfo[];
  /** 最新の開示一覧(新しい順)。 */
  disclosures: Disclosure[];
}

function findRegionRankingInfo(
  code: string,
  region: Region,
  ds: RankingDataset | undefined,
): RegionRankingInfo | null {
  if (!ds) return null;

  const row1 = ds.ranking1?.find((r) => r.code === code);
  const ranking1 = row1?.rank;

  const ranking2: RankingHit[] = [];
  const ranking3: RankingHit[] = [];
  for (const period of PERIOD_KEYS) {
    const row2 = ds.ranking2?.[period]?.find((r) => r.code === code);
    if (row2) ranking2.push({ period, rank: row2.rank });
    const row3 = ds.ranking3?.[period]?.find((r) => r.code === code);
    if (row3) ranking3.push({ period, rank: row3.rank });
  }

  if (ranking1 === undefined && ranking2.length === 0 && ranking3.length === 0) return null;
  return { region, ranking1, ranking2, ranking3 };
}

/** ランキングデータセットの中から、その銘柄コードの名称を探す(どのリストでもよい)。 */
function nameFromRankings(code: string, ds: RankingDataset | undefined): string | null {
  if (!ds) return null;
  const direct = ds.ranking1?.find((r) => r.code === code);
  if (direct) return direct.name;
  for (const period of PERIOD_KEYS) {
    const row2 = ds.ranking2?.[period]?.find((r) => r.code === code);
    if (row2) return row2.name;
    const row3 = ds.ranking3?.[period]?.find((r) => r.code === code);
    if (row3) return row3.name;
  }
  return null;
}

interface SectorLookup {
  name: string | null;
  price: number | null;
  changePct: number | null;
  sectors: StockSectorMembership[];
}

/** ticker_index.json(日本株のみ・所属セクター全件)から検索する。 */
function fromTickerIndex(code: string, tickerIndex: TickerIndexFile | null | undefined): SectorLookup | null {
  const e = tickerIndex?.tickers?.[code];
  if (!e) return null;
  return {
    name: e.n,
    price: e.p,
    changePct: e.c,
    sectors: e.s.map(([name, tier]) => ({ name, tier, market: 'JP' as Region })),
  };
}

/**
 * sector_us.json(members は各セクター上位30件のみ)からベストエフォートで検索する。
 * 現在値(price)は含まれないため常に null。
 */
function fromSectorFileMembers(
  code: string,
  region: Region,
  sectorFile: SectorFile | null | undefined,
): SectorLookup | null {
  if (!sectorFile) return null;
  const sectors: StockSectorMembership[] = [];
  let name: string | null = null;
  let changePct: number | null = null;
  for (const sec of sectorFile.sectors) {
    const m = sec.members.find((mm) => mm.code === code);
    if (m) {
      sectors.push({ name: sec.name, tier: m.tier, market: region });
      name = name ?? m.name;
      changePct = changePct ?? m.change_pct;
    }
  }
  if (sectors.length === 0) return null;
  return { name, price: null, changePct, sectors };
}

export interface CrosslinkSources {
  rankingsJP?: RankingDataset;
  rankingsUS?: RankingDataset;
  /** 日本株の横断インデックス(所属セクター全件)。銘柄詳細を開いたときに遅延fetchされる想定。 */
  tickerIndex?: TickerIndexFile | null;
  /** 米国株の所属セクター(ベストエフォート、上位30件のみ)。 */
  sectorUS?: SectorFile | null;
  disclosures?: DisclosuresFeed | null;
}

/**
 * 銘柄コードをキーに、資金流入ランキング(JP/US)・セクター騰落率・適時開示を
 * 1つの StockProfile へ結合する。どのソースも欠けていて構わない
 * (該当フィールドは null / 空配列になる)。
 */
export function buildStockProfile(rawCode: string, sources: CrosslinkSources): StockProfile | null {
  const code = normalizeCode(rawCode);
  if (!code) return null;

  const jp = fromTickerIndex(code, sources.tickerIndex);
  const us = fromSectorFileMembers(code, 'US', sources.sectorUS);
  const sectors = [...(jp?.sectors ?? []), ...(us?.sectors ?? [])];

  const rankingInfoJP = findRegionRankingInfo(code, 'JP', sources.rankingsJP);
  const rankingInfoUS = findRegionRankingInfo(code, 'US', sources.rankingsUS);
  const rankings = [rankingInfoJP, rankingInfoUS].filter(
    (x): x is RegionRankingInfo => x !== null,
  );

  const name =
    jp?.name ??
    us?.name ??
    nameFromRankings(code, sources.rankingsJP) ??
    nameFromRankings(code, sources.rankingsUS) ??
    null;

  const disclosures = (sources.disclosures?.items ?? [])
    .filter((d) => normalizeCode(d.code) === code)
    .slice()
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

  return {
    code,
    name,
    price: jp?.price ?? null,
    changePct: jp?.changePct ?? us?.changePct ?? null,
    sectors,
    rankings,
    disclosures,
  };
}
