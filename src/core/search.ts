// 横断銘柄検索の純粋関数。IO非依存(fetch等は呼び出し側の責務)。
// コード前方一致 or 銘柄名部分一致で、資金流入ランキング・ticker_index(セクター)・
// 適時開示の3ソースを横断して候補を集める。

import { isJpCode, normalizeCode } from './codes';
import type { DisclosuresFeed, RankingDataset, Region, TickerIndexFile } from './types';

export interface SearchResult {
  code: string;
  name: string;
  /** JP=日本株コード(4-5桁)らしい、US=それ以外(米国ティッカー等)。 */
  region: Region;
}

export interface SearchSources {
  rankingsJP?: RankingDataset;
  rankingsUS?: RankingDataset;
  tickerIndex?: TickerIndexFile | null;
  disclosures?: DisclosuresFeed | null;
}

const MAX_RESULTS = 30;

function addCandidate(
  map: Map<string, SearchResult>,
  code: string | null | undefined,
  name: string | null | undefined,
) {
  const normalized = normalizeCode(code);
  if (!normalized || !name) return;
  if (!map.has(normalized)) {
    map.set(normalized, { code: normalized, name, region: isJpCode(normalized) ? 'JP' : 'US' });
  }
}

/**
 * クエリ(コードの一部 または 銘柄名の一部)に一致する銘柄を検索する。
 * 空クエリ・1文字未満は空配列(全件マッチによる大量表示を避ける)。
 */
export function searchStocks(rawQuery: string, sources: SearchSources): SearchResult[] {
  const query = rawQuery.trim();
  if (query.length === 0) return [];

  const qCode = normalizeCode(query); // コードとして解釈できる場合のみ非null
  const qLower = query.toLowerCase();

  // 候補プール(コード→名称)を全ソースから収集する。名称が空/不明なものは除外。
  const pool = new Map<string, SearchResult>();

  for (const row of sources.rankingsJP?.ranking1 ?? []) addCandidate(pool, row.code, row.name);
  for (const row of sources.rankingsUS?.ranking1 ?? []) addCandidate(pool, row.code, row.name);

  const tickers = sources.tickerIndex?.tickers;
  if (tickers) {
    for (const [code, e] of Object.entries(tickers)) addCandidate(pool, code, e.n);
  }

  for (const d of sources.disclosures?.items ?? []) {
    if (isJpCode(d.code) && d.company) addCandidate(pool, d.code, d.company);
  }

  const matches = Array.from(pool.values()).filter((r) => {
    if (qCode && r.code.startsWith(qCode)) return true;
    return r.name.toLowerCase().includes(qLower);
  });

  // コード完全一致 > コード前方一致 > 名称一致、の順で並べる。
  matches.sort((a, b) => {
    const rank = (r: SearchResult) => (r.code === qCode ? 0 : qCode && r.code.startsWith(qCode) ? 1 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.code.localeCompare(b.code);
  });

  return matches.slice(0, MAX_RESULTS);
}
