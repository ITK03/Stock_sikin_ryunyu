import { useEffect, useMemo, useState } from 'react';
import type { DisclosuresFeed, RankingDataset, Region, SectorFile } from '../core/types';
import type { MainTabKey } from './BottomTabBar';
import { dedupeDisclosures } from '../core/disclosures';
import { isJpCode } from '../core/codes';
import { useLazyExternalJson } from './externalData';
import { SECTOR_JP_URL } from './externalSources';
import { SAMPLE_SECTOR_JP } from '../data/sampleSector';
import { relTime, signedPct, pct } from './format';
import { DisclosureItem } from './DisclosureItem';
import { WatchStar, useWatchlist } from './watchlist';

interface Props {
  onSelectCode: (code: string) => void;
  onGoTab: (tab: MainTabKey) => void;
  onOpenSector: (name: string, market: Region) => void;
  disclosuresState: { data: DisclosuresFeed | null; loading: boolean };
  rankingsCache: Partial<Record<Region, RankingDataset>>;
  onDatasetLoaded: (region: Region, dataset: RankingDataset) => void;
}

function dataUrl(region: Region): string {
  const file = region === 'US' ? 'rankings.us.json' : 'rankings.json';
  return `${import.meta.env.BASE_URL}data/${file}?t=${Date.now()}`;
}

/**
 * 起動時に1画面で「今日の概況」を見せるホームタブ。
 * - 資金流入Top5(① 時価総額比)
 * - 重要開示Top5(urgent優先 → スコア降順)
 * - ウォッチ銘柄の状況
 * - セクターTop5(データがあれば。sector-monitor の data ブランチが未生成の間は非表示)
 * 各項目タップで該当タブ/銘柄詳細へ遷移する。
 */
export function HomeTab({ onSelectCode, onGoTab, onOpenSector, disclosuresState, rankingsCache, onDatasetLoaded }: Props) {
  const [jpError, setJpError] = useState<string | null>(null);
  const watchlist = useWatchlist();

  // 資金流入Top5(JP): App側キャッシュに無ければここで取得し、以後は資金流入タブとも共有する。
  useEffect(() => {
    if (rankingsCache.JP) return;
    fetch(dataUrl('JP'), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RankingDataset>;
      })
      .then((dataset) => onDatasetLoaded('JP', dataset))
      .catch((e) => setJpError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // セクターTop5: 数MB規模になり得るため遅延fetch(セクタータブと同じキャッシュを共有)。
  const sectorState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_jp',
    urls: SECTOR_JP_URL,
    sampleData: SAMPLE_SECTOR_JP,
    enabled: true,
  });

  const inflowTop5 = rankingsCache.JP?.ranking1?.slice(0, 5) ?? [];

  const topDisclosures = useMemo(() => {
    const items = disclosuresState.data?.items;
    if (!Array.isArray(items)) return [];
    return dedupeDisclosures(items)
      .slice()
      .sort((a, b) => {
        if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
        if (a.score !== b.score) return b.score - a.score;
        return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
      })
      .slice(0, 5);
  }, [disclosuresState.data]);

  const sectorTop5 = useMemo(() => {
    const sectors = sectorState.data?.sectors;
    if (!Array.isArray(sectors)) return [];
    return sectors
      .filter((s) => s.change_pct !== null)
      .slice()
      .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
      .slice(0, 5);
  }, [sectorState.data]);

  // ウォッチ銘柄: 名称・順位は資金流入データにあれば付与(無ければコードのみ表示)。
  const watchRows = useMemo(() => {
    const jp = rankingsCache.JP?.ranking1 ?? [];
    const us = rankingsCache.US?.ranking1 ?? [];
    return watchlist.codes.slice(0, 8).map((code) => {
      const hit = jp.find((r) => r.code === code) ?? us.find((r) => r.code === code);
      return { code, name: hit?.name ?? null, ratio: hit?.ratio ?? null };
    });
  }, [watchlist.codes, rankingsCache.JP, rankingsCache.US]);

  return (
    <div className="tab-pane home-pane">
      <section className="home-section">
        <div className="home-section-head">
          <h2>資金流入 Top5</h2>
          <button className="link" onClick={() => onGoTab('inflow')}>すべて見る</button>
        </div>
        {inflowTop5.length === 0 ? (
          jpError ? (
            <p className="dim">取得できませんでした。</p>
          ) : (
            <HomeSkeleton rows={5} />
          )
        ) : (
          <ol className="rows home-inflow-rows">
            {inflowTop5.map((r, i) => (
              <li
                key={r.code}
                className="row row-tap"
                role="button"
                tabIndex={0}
                onClick={() => onSelectCode(r.code)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(r.code)}
              >
                <span className={`r-rank ${i < 3 ? `medal-${i + 1}` : ''}`}>{i + 1}</span>
                <WatchStar code={r.code} />
                <span className="r-code">{r.code}</span>
                <span className="r-name">{r.name}</span>
                <span className="r-ratio">{pct(r.ratio)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2>重要開示</h2>
          <button className="link" onClick={() => onGoTab('disclosures')}>すべて見る</button>
        </div>
        {topDisclosures.length === 0 ? (
          disclosuresState.loading ? (
            <HomeSkeleton rows={3} />
          ) : (
            <p className="dim">重要な開示はまだありません。</p>
          )
        ) : (
          <ul className="disc-list home-disc-list">
            {topDisclosures.map((d) => (
              <DisclosureItem
                key={d.id}
                d={d}
                onSelectCode={isJpCode(d.code) ? onSelectCode : undefined}
                watched={watchlist.has(d.code)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="home-section">
        <div className="home-section-head">
          <h2>ウォッチ銘柄</h2>
          {watchlist.codes.length > 0 && <span className="home-section-count">{watchlist.codes.length}件</span>}
        </div>
        {watchRows.length === 0 ? (
          <p className="dim">☆をタップして銘柄をウォッチリストに追加すると、ここに表示されます。</p>
        ) : (
          <ol className="rows home-watch-rows">
            {watchRows.map((w) => (
              <li
                key={w.code}
                className="row row-tap"
                role="button"
                tabIndex={0}
                onClick={() => onSelectCode(w.code)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(w.code)}
              >
                <WatchStar code={w.code} />
                <span className="r-code">{w.code}</span>
                <span className="r-name">{w.name ?? '(名称未取得)'}</span>
                {w.ratio !== null && <span className="r-ratio">{pct(w.ratio)}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {(sectorTop5.length > 0 || sectorState.loading) && (
        <section className="home-section">
          <div className="home-section-head">
            <h2>セクター Top5</h2>
            <button className="link" onClick={() => onGoTab('sector')}>すべて見る</button>
          </div>
          {sectorTop5.length === 0 ? (
            <HomeSkeleton rows={3} />
          ) : (
            <ul className="home-sector-rows">
              {sectorTop5.map((s) => (
                <li key={s.name}>
                  <button type="button" className="home-sector-row" onClick={() => onOpenSector(s.name, 'JP')}>
                    <span className="sector-name">{s.name}</span>
                    <span className={`sector-chg ${(s.change_pct ?? 0) > 0 ? 'chg-up' : (s.change_pct ?? 0) < 0 ? 'chg-down' : 'chg-flat'}`}>
                      {signedPct(s.change_pct)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sectorState.data && (
            <p className="home-section-foot dim">{relTime(sectorState.data.generated_at)}更新</p>
          )}
        </section>
      )}
    </div>
  );
}

function HomeSkeleton({ rows }: { rows: number }) {
  return (
    <div className="home-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-line skel-w80" />
      ))}
    </div>
  );
}
