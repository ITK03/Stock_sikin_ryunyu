import { useEffect, useMemo, useState } from 'react';
import type { Region, SectorEntry, SectorFile } from '../core/types';
import { useLazyExternalJson } from './externalData';
import { SECTOR_JP_URL, SECTOR_US_URL } from './externalSources';
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

export function SectorTab({ onSelectCode, focus }: Props) {
  const [market, setMarket] = useState<Region>('JP');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [watchOnly, setWatchOnly] = useState(false);
  const watchlist = useWatchlist();

  // JP/USはタブ切替時に初めて取得する遅延fetch。数MB規模になり得るため、
  // 選択中の市場だけ enabled にする(両方を初期表示で読み込まない)。
  const jpState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_jp',
    urls: SECTOR_JP_URL,
    sampleData: SAMPLE_SECTOR_JP,
    enabled: market === 'JP',
  });
  const usState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_us',
    urls: SECTOR_US_URL,
    sampleData: SAMPLE_SECTOR_US,
    enabled: market === 'US',
  });
  const { data, loading, error, sample, reload } = market === 'JP' ? jpState : usState;

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

  const allSectors = useMemo(() => (data ? sortSectors(data.sectors) : []), [data]);

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
        <div className="sector-meta">
          {sample && <span className="chip sample-chip">サンプル</span>}
          {data && <span className="asof-date">{relTime(data.generated_at)}更新</span>}
        </div>
      </div>

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
