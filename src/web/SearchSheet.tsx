import { useMemo, useState } from 'react';
import type { DisclosuresFeed, RankingDataset, TickerIndexFile } from '../core/types';
import { searchStocks } from '../core/search';
import { useLazyExternalJson } from './externalData';
import { TICKER_INDEX_URL } from './externalSources';
import { SAMPLE_TICKER_INDEX } from '../data/sampleSector';
import { useSheetBehavior } from './useSheet';

interface Props {
  rankingsJP?: RankingDataset;
  rankingsUS?: RankingDataset;
  disclosures: DisclosuresFeed | null;
  onSelectCode: (code: string) => void;
  onClose: () => void;
}

/** ヘッダーの検索アイコンから開く横断銘柄検索。コード/銘柄名で資金流入・セクター・開示を横断検索する。 */
export function SearchSheet({ rankingsJP, rankingsUS, disclosures, onSelectCode, onClose }: Props) {
  useSheetBehavior(onClose);
  const [query, setQuery] = useState('');

  // ticker_index(日本株の銘柄名辞書)は数MB規模になり得るため、検索シートを開いたときのみ
  // 遅延fetchする(既にセクタータブ/銘柄詳細で取得済みならメモリキャッシュを再利用)。
  const tickerIndexState = useLazyExternalJson<TickerIndexFile>({
    cacheKey: 'ext:ticker_index',
    urls: TICKER_INDEX_URL,
    sampleData: SAMPLE_TICKER_INDEX,
    enabled: true,
  });

  const results = useMemo(
    () =>
      searchStocks(query, {
        rankingsJP,
        rankingsUS,
        tickerIndex: tickerIndexState.data,
        disclosures,
      }),
    [query, rankingsJP, rankingsUS, tickerIndexState.data, disclosures],
  );

  const select = (code: string) => {
    onSelectCode(code);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet search-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>銘柄検索</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="sheet-body">
          <input
            className="disc-search search-sheet-input"
            type="search"
            inputMode="search"
            autoFocus
            placeholder="コード or 銘柄名で検索(例: 7203 / トヨタ)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() === '' ? (
            <p className="dim search-hint">証券コードの一部、または銘柄名の一部を入力してください。</p>
          ) : results.length === 0 ? (
            <p className="empty">該当する銘柄が見つかりませんでした。</p>
          ) : (
            <ul className="search-results">
              {results.map((r) => (
                <li key={r.code}>
                  <button type="button" className="search-result-row" onClick={() => select(r.code)}>
                    <span className="search-result-code">{r.code}</span>
                    <span className="search-result-name">{r.name}</span>
                    <span className="search-result-region">{r.region}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tickerIndexState.loading && <p className="dim search-hint">セクター横断データを読み込み中…(見つかる件数が増える場合があります)</p>}
        </div>
      </div>
    </div>
  );
}
