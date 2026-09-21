import { useMemo, useState, type FormEvent } from 'react';
import type { TickerIndexFile } from '../core/types';
import { normalizeCode } from '../core/codes';
import { searchStocks } from '../core/search';

// マイセクターへの銘柄追加(コード/銘柄名オートコンプリート)。
// マッチングは既存の横断検索(src/core/search.ts)をそのまま使う
// (コード前方一致 or 銘柄名部分一致。日本株の名称辞書は ticker_index.json)。

const MAX_SUGGESTIONS = 8;

interface Props {
  tickerIndex: TickerIndexFile | null;
  /** 追加済みのコード(正規化済み)。候補・Enter追加から除外する。 */
  existingCodes: Set<string>;
  onAdd: (code: string, name: string) => void;
}

export function MySectorAddInput({ tickerIndex, existingCodes, onAdd }: Props) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (query.trim() === '') return [];
    return searchStocks(query, { tickerIndex })
      .filter((r) => !existingCodes.has(r.code))
      .slice(0, MAX_SUGGESTIONS);
  }, [query, tickerIndex, existingCodes]);

  const select = (code: string, name: string) => {
    onAdd(code, name);
    setQuery('');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeCode(query);
    // 候補の中に完全一致するコードがあればそれを追加。
    const exact = results.find((r) => r.code === code);
    if (exact) {
      select(exact.code, exact.name);
      return;
    }
    // 候補が1件も無い場合のみ、入力をコードとして直接追加する
    // (ticker_index は日本株のみのため、米国ティッカー等は候補に出ないことがある)。
    // 候補が出ている途中で Enter しても、まだ確定していない前方一致文字列を
    // 誤って追加しないようにする。
    if (results.length === 0 && code && !existingCodes.has(code)) {
      select(code, code);
    }
  };

  return (
    <form className="mysec-add" onSubmit={handleSubmit}>
      <input
        className="disc-search mysec-add-input"
        type="search"
        inputMode="search"
        placeholder="コード or 銘柄名で追加(例: 7203 / トヨタ)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="mysec-suggest">
          {results.map((r) => (
            <li key={r.code}>
              <button type="button" className="mysec-suggest-row" onClick={() => select(r.code, r.name)}>
                <span className="search-result-code">{r.code}</span>
                <span className="search-result-name">{r.name}</span>
                <span className="search-result-region">{r.region}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
