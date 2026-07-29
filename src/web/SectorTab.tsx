import { useEffect, useMemo, useRef, useState } from 'react';
import type { Region, SectorEntry, SectorFile } from '../core/types';
import { sortSectorsByStrength } from '../core/sectorStrength';
import { useLazyExternalJson } from './externalData';
import { sectorUrls } from './externalSources';
import { SAMPLE_SECTOR_JP, SAMPLE_SECTOR_US } from '../data/sampleSector';
import { relTime, signedPct } from './format';
import { TierBadge } from './TierBadge';
import { WatchStar, useWatchlist } from './watchlist';

/** 銘柄詳細のセクター名タップ等から「このセクターを開いて」と指示するための値。 */
export interface SectorFocus {
  name: string;
  market: Region;
  /** 同じセクターに再ジャンプしても効くよう、毎回変わる値(タイムスタンプ等)。 */
  nonce: number;
}

interface Props {
  onSelectCode: (code: string) => void;
  focus?: SectorFocus | null;
}

const PAGE_SIZE = 40;

type SectorSort = 'strength' | 'change';

const SORT_KEY = 'sectorSort';

/** アプリ復帰時の自動再取得の最短間隔。数MBのJSONなので取りに行きすぎないようにする。 */
const REFETCH_MIN_INTERVAL_MS = 20 * 60 * 1000;

function changeClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'chg-flat';
  if (v > 0) return 'chg-up';
  if (v < 0) return 'chg-down';
  return 'chg-flat';
}

function sortSectors(sectors: SectorEntry[]): SectorEntry[] {
  return [...sectors].sort((a, b) => {
    const av = a.change_pct;
    const bv = b.change_pct;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}

/** count<3 のセクターに表示する補助バッジ(誇大な騰落率の理由が一目で分かるように)。 */
function tinySectorLabel(count: number): string | null {
  if (count === 1) return '単一銘柄';
  if (count === 2) return '2銘柄';
  return null;
}

export function SectorTab({ onSelectCode, focus }: Props) {
  const [market, setMarket] = useState<Region>('JP');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [watchOnly, setWatchOnly] = useState(false);
  const [sectorSort, setSectorSort] = useState<SectorSort>(
    () => (localStorage.getItem(SORT_KEY) as SectorSort) || 'strength',
  );
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastFetchRef = useRef<Partial<Record<Region, number>>>({});
  const watchlist = useWatchlist();

  // JP/USはタブ切替時に初めて取得する遅延fetch。数MB規模になり得るため、
  // 選択中の市場だけ enabled にする(両方を初期表示で読み込まない)。
  const jpState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_jp',
    urls: (bust) => sectorUrls('JP', bust),
    sampleData: SAMPLE_SECTOR_JP,
    enabled: market === 'JP',
  });
  const usState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_us',
    urls: (bust) => sectorUrls('US', bust),
    sampleData: SAMPLE_SECTOR_US,
    enabled: market === 'US',
  });
  const { data, loading, error, sample, reload, refresh } = market === 'JP' ? jpState : usState;

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  // 更新ボタン: 生成側(sector-monitor)は決まった時刻にしかスナップショットを作らない。
  // 押せば必ず新しい値が出る、という誤解を与えないよう、取得後に「更新できたのか
  // すでに最新だったのか」を事実として出す(資金流入タブと同じ方針)。
  const onRefresh = async () => {
    setRefreshing(true);
    lastFetchRef.current[market] = Date.now();
    const before = data?.generated_at;
    try {
      const next = await refresh();
      if (!next) flash('更新に失敗しました');
      else if (next.generated_at && next.generated_at !== before) flash('最新データに更新しました');
      else flash(`すでに最新です(${relTime(next.generated_at)}時点)`);
    } finally {
      setRefreshing(false);
    }
  };

  // アプリに戻ってきたときに取り直す(モバイルで開きっぱなしにしたまま翌日見る使い方でも
  // 前日の値を掴んだままにならないように)。
  // ただしセクターJSONは数MBあるため、復帰のたびに再取得すると通信量が無駄になる。
  // 「生成時刻の古さ」ではなく「自分が最後に取りに行ってからの経過時間」で間引く
  // (生成は1日3回なので、生成時刻で判定するとほぼ常に古い扱いになってしまう)。
  useEffect(() => {
    lastFetchRef.current[market] = Date.now();
  }, [market]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - (lastFetchRef.current[market] ?? 0) < REFETCH_MIN_INTERVAL_MS) return;
      lastFetchRef.current[market] = Date.now();
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [market, refresh]);

  // 銘柄詳細からのジャンプ指示: 市場を合わせ、該当セクターで絞り込み+展開する。
  useEffect(() => {
    if (!focus) return;
    setMarket(focus.market);
    setQuery(focus.name);
    setWatchOnly(false);
    setVisibleCount(PAGE_SIZE);
    setExpanded(new Set([focus.name]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const changeMarket = (m: Region) => {
    setMarket(m);
    setQuery('');
    setVisibleCount(PAGE_SIZE);
    // 市場をまたいで同名セクターが誤って展開済みにならないようリセットする。
    setExpanded(new Set());
  };

  const changeSort = (v: SectorSort) => {
    setSectorSort(v);
    localStorage.setItem(SORT_KEY, v);
  };

  const allSectors = useMemo(() => {
    if (!data) return [];
    return sectorSort === 'strength' ? sortSectorsByStrength(data.sectors) : sortSectors(data.sectors);
  }, [data, sectorSort]);

  const byQuery = useMemo(() => {
    const q = query.trim();
    if (!q) return allSectors;
    return allSectors.filter((s) => s.name.includes(q));
  }, [allSectors, query]);

  // 「ウォッチのみ」: ウォッチ銘柄を含むセクターだけを、構成銘柄もウォッチ分に絞って表示。
  const filtered = useMemo(() => {
    if (!watchOnly) return byQuery;
    return byQuery
      .map((s) => ({ ...s, members: s.members.filter((m) => watchlist.has(m.code)) }))
      .filter((s) => s.members.length > 0);
  }, [byQuery, watchOnly, watchlist]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (loading && !data) {
    return (
      <div className="tab-pane">
        <SkeletonList />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="tab-pane">
        <div className="inline-state">
          <p className="state-title">セクターデータを取得できませんでした</p>
          <p className="state-sub">{error}</p>
          <button className="filter-reset" onClick={reload}>再試行</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-pane">
      <div className="sector-head">
        <nav className="region-toggle" role="group" aria-label="市場切替">
          <button
            className={market === 'JP' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeMarket('JP')}
            aria-pressed={market === 'JP'}
          >
            JP
          </button>
          <button
            className={market === 'US' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeMarket('US')}
            aria-pressed={market === 'US'}
          >
            US
          </button>
        </nav>
        <button
          className={watchOnly ? 'chip watch active' : 'chip watch'}
          onClick={() => setWatchOnly((v) => !v)}
          aria-pressed={watchOnly}
        >
          ★ウォッチ
        </button>
        <nav className="region-toggle sector-sort-toggle" role="group" aria-label="並び順">
          <button
            className={sectorSort === 'strength' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeSort('strength')}
            aria-pressed={sectorSort === 'strength'}
          >
            勢い
          </button>
          <button
            className={sectorSort === 'change' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeSort('change')}
            aria-pressed={sectorSort === 'change'}
          >
            騰落率
          </button>
        </nav>
        <div className="sector-meta">
          {sample && <span className="chip sample-chip">サンプル</span>}
          {data && <span className="asof-date">{relTime(data.generated_at)}更新</span>}
          <button
            className={refreshing ? 'btn-icon spin' : 'btn-icon'}
            onClick={onRefresh}
            disabled={refreshing || sample}
            aria-label="最新データに更新"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" />
              <path d="M20 4v5h-5" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}

      {(allSectors.length > 15 || query !== '') && (
        <input
          className="disc-search sector-search"
          type="search"
          placeholder="セクター/テーマ名で絞り込み"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisibleCount(PAGE_SIZE);
          }}
        />
      )}

      {filtered.length === 0 ? (
        <p className="empty">
          {watchOnly
            ? 'ウォッチ銘柄を含むセクターがありません。'
            : market === 'US' && allSectors.length === 0
            ? 'US市場のセクターデータはまだありません。'
            : '該当するセクター/テーマがありません。'}
        </p>
      ) : (
        <>
          <ul className="sector-list">
            {visible.map((s) => {
              // ウォッチのみ表示中は絞り込んだ結果を常に展開して見せる。
              const isOpen = watchOnly || expanded.has(s.name);
              return (
                <li key={s.name} className="sector-card">
                  <button className="sector-row" onClick={() => toggle(s.name)} aria-expanded={isOpen}>
                    <div className="sector-ident">
                      <span className="sector-name">{s.name}</span>
                      <span className="sector-count">{s.count}銘柄</span>
                      {tinySectorLabel(s.count) && (
                        <span className="sector-tiny-badge">{tinySectorLabel(s.count)}</span>
                      )}
                    </div>
                    <div className="sector-right">
                      <span className={`sector-chg ${changeClass(s.change_pct)}`}>{signedPct(s.change_pct)}</span>
                      <span className={isOpen ? 'chevron open' : 'chevron'} aria-hidden>
                        ▾
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <ul className="member-list">
                      {s.members.map((m) => (
                        <li key={m.code} className="member-row">
                          <WatchStar code={m.code} />
                          <TierBadge tier={m.tier} />
                          <button
                            type="button"
                            className="member-code code-tap"
                            onClick={() => onSelectCode(m.code)}
                          >
                            {m.code}
                          </button>
                          <span className="member-name">{m.name}</span>
                          <span className={`member-chg ${changeClass(m.change_pct)}`}>{signedPct(m.change_pct)}</span>
                        </li>
                      ))}
                      {!watchOnly && s.count > s.members.length && (
                        <li className="member-more dim">他 {s.count - s.members.length} 銘柄(上位{s.members.length}件のみ表示)</li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <button className="filter-reset sector-more" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
              もっと見る({filtered.length - visible.length}件)
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="sector-list">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="sector-card skeleton" aria-hidden>
          <div className="skel-line skel-w60" />
          <div className="skel-line skel-w30" />
        </li>
      ))}
    </ul>
  );
}
