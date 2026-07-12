import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { isWatched, parseWatchlist, serializeWatchlist, toggleWatch } from '../core/watchlist';

// 横断ウォッチリストの状態管理(localStorage 永続)。純ロジックは src/core/watchlist.ts。

const STORAGE_KEY = 'watchlist:v1';

interface WatchlistApi {
  /** 正規化済みのウォッチ中コード一覧(登録順)。 */
  codes: string[];
  has: (code: string | null | undefined) => boolean;
  toggle: (code: string | null | undefined) => void;
}

const WatchlistContext = createContext<WatchlistApi>({
  codes: [],
  has: () => false,
  toggle: () => {},
});

function loadCodes(): string[] {
  try {
    return parseWatchlist(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [codes, setCodes] = useState<string[]>(loadCodes);

  const toggle = useCallback((code: string | null | undefined) => {
    setCodes((prev) => {
      const next = toggleWatch(prev, code);
      if (next !== prev) {
        try {
          localStorage.setItem(STORAGE_KEY, serializeWatchlist(next));
        } catch {
          // 保存できなくても画面上のトグルは有効のままにする。
        }
      }
      return next;
    });
  }, []);

  const api = useMemo<WatchlistApi>(
    () => ({
      codes,
      has: (code) => isWatched(codes, code),
      toggle,
    }),
    [codes, toggle],
  );

  return <WatchlistContext.Provider value={api}>{children}</WatchlistContext.Provider>;
}

export function useWatchlist(): WatchlistApi {
  return useContext(WatchlistContext);
}

/** 星マークのトグルボタン。リスト行・銘柄詳細から共用する。 */
export function WatchStar({ code, className = '' }: { code: string; className?: string }) {
  const { has, toggle } = useWatchlist();
  const watched = has(code);
  return (
    <button
      type="button"
      className={`star-btn ${watched ? 'on' : ''} ${className}`.trim()}
      aria-pressed={watched}
      aria-label={watched ? 'ウォッチ解除' : 'ウォッチに追加'}
      onClick={(e) => {
        e.stopPropagation();
        toggle(code);
      }}
    >
      {watched ? '★' : '☆'}
    </button>
  );
}
