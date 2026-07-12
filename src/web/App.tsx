import { Suspense, lazy, useState } from 'react';
import type { DisclosuresFeed, RankingDataset, Region } from '../core/types';
import { Logo } from './Logo';
import { InflowTab } from './InflowTab';
import type { SectorFocus } from './SectorTab';
import { BottomTabBar, type MainTabKey } from './BottomTabBar';
import { useExternalJson } from './externalData';
import { DISCLOSURES_URLS, DISCLOSURE_RADAR_URL, SECTOR_MONITOR_STREAMLIT_URL } from './externalSources';
import { SAMPLE_DISCLOSURES } from '../data/sampleDisclosures';
import { WatchlistProvider } from './watchlist';

// 初期表示は資金流入タブのみでよいため、セクター/開示タブと銘柄詳細は
// タブ単位で遅延読み込みして初期バンドルを小さくする(モバイル回線での体感改善)。
const SectorTab = lazy(() => import('./SectorTab').then((m) => ({ default: m.SectorTab })));
const DisclosuresTab = lazy(() => import('./DisclosuresTab').then((m) => ({ default: m.DisclosuresTab })));
const StockDetail = lazy(() => import('./StockDetail').then((m) => ({ default: m.StockDetail })));

function LazyFallback() {
  return (
    <div className="inline-state">
      <span className="spinner" />
      <p className="state-sub">読み込み中…</p>
    </div>
  );
}

const TITLE: Record<MainTabKey, string> = {
  inflow: '資金流入株',
  sector: 'セクター騰落',
  disclosures: '適時開示',
};

function loadMainTab(): MainTabKey {
  // localStorage はプライベートモード等で例外を投げうるため防御する。
  try {
    const v = localStorage.getItem('mainTab');
    return v === 'sector' || v === 'disclosures' || v === 'inflow' ? v : 'inflow';
  } catch {
    return 'inflow';
  }
}

export function App() {
  const [mainTab, setMainTab] = useState<MainTabKey>(loadMainTab);
  // 一度でも表示したタブはアンマウントせず hidden で隠す(タブ切替のたびに
  // 状態(選択中の期間・スクロール等)が失われ、データを再フェッチするのを防ぐ)。
  const [visited, setVisited] = useState<Set<MainTabKey>>(() => new Set([loadMainTab()]));
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [rankingsCache, setRankingsCache] = useState<Partial<Record<Region, RankingDataset>>>({});

  // 開示は数百件〜1千件程度で小さいため、ここで一度だけ取得し各タブ・銘柄詳細(横断連携)へ
  // 状態として配る(タブごとに個別フェッチすると二重リクエストになるため)。
  // セクター/ticker_index は数MB規模になり得るため、各タブ・銘柄詳細側で個別に遅延fetchする
  // (SectorTab.tsx / StockDetail.tsx 内、モジュールスコープのメモリキャッシュで重複取得を防ぐ)。
  const disclosuresState = useExternalJson<DisclosuresFeed>({
    cacheKey: 'ext:disclosures',
    urls: DISCLOSURES_URLS,
    sampleData: SAMPLE_DISCLOSURES,
  });

  const changeTab = (t: MainTabKey) => {
    setMainTab(t);
    setVisited((prev) => (prev.has(t) ? prev : new Set(prev).add(t)));
    try {
      localStorage.setItem('mainTab', t);
    } catch {
      // 保存できなくても動作には影響しない。
    }
  };

  const onDatasetLoaded = (region: Region, dataset: RankingDataset) => {
    setRankingsCache((prev) => ({ ...prev, [region]: dataset }));
  };

  // 銘柄詳細の所属セクター名タップ → セクタータブの該当セクターへジャンプ。
  const [sectorFocus, setSectorFocus] = useState<SectorFocus | null>(null);
  const openSector = (name: string, market: Region) => {
    setSelectedCode(null);
    setSectorFocus({ name, market, nonce: Date.now() });
    changeTab('sector');
  };

  return (
    <WatchlistProvider>
    <div className="screen">
      <header className="appbar">
        <div className="brand">
          <Logo />
          <div>
            <h1>{TITLE[mainTab]}</h1>
          </div>
        </div>
      </header>

      <nav className="ext-links">
        <a className="link" href={DISCLOSURE_RADAR_URL} target="_blank" rel="noreferrer">
          開示レーダー本家
        </a>
        {SECTOR_MONITOR_STREAMLIT_URL && (
          <a className="link" href={SECTOR_MONITOR_STREAMLIT_URL} target="_blank" rel="noreferrer">
            セクターモニター(リアルタイム)
          </a>
        )}
      </nav>

      <main className="main-area">
        {visited.has('inflow') && (
          <div className="tab-host" hidden={mainTab !== 'inflow'}>
            <InflowTab onSelectCode={setSelectedCode} onDatasetLoaded={onDatasetLoaded} />
          </div>
        )}
        {visited.has('sector') && (
          <div className="tab-host" hidden={mainTab !== 'sector'}>
            <Suspense fallback={<LazyFallback />}>
              <SectorTab onSelectCode={setSelectedCode} focus={sectorFocus} />
            </Suspense>
          </div>
        )}
        {visited.has('disclosures') && (
          <div className="tab-host" hidden={mainTab !== 'disclosures'}>
            <Suspense fallback={<LazyFallback />}>
              <DisclosuresTab onSelectCode={setSelectedCode} state={disclosuresState} />
            </Suspense>
          </div>
        )}
      </main>

      <BottomTabBar active={mainTab} onChange={changeTab} />

      {selectedCode && (
        <Suspense fallback={null}>
          <StockDetail
            code={selectedCode}
            rankingsJP={rankingsCache.JP}
            rankingsUS={rankingsCache.US}
            disclosures={disclosuresState.data}
            onClose={() => setSelectedCode(null)}
            onOpenSector={openSector}
          />
        </Suspense>
      )}
    </div>
    </WatchlistProvider>
  );
}
