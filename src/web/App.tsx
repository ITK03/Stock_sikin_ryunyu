import { useState } from 'react';
import type { DisclosuresFeed, RankingDataset, Region } from '../core/types';
import { Logo } from './Logo';
import { InflowTab } from './InflowTab';
import { SectorTab } from './SectorTab';
import { DisclosuresTab } from './DisclosuresTab';
import { StockDetail } from './StockDetail';
import { BottomTabBar, type MainTabKey } from './BottomTabBar';
import { useExternalJson } from './externalData';
import { DISCLOSURES_URLS, DISCLOSURE_RADAR_URL, SECTOR_MONITOR_STREAMLIT_URL } from './externalSources';
import { SAMPLE_DISCLOSURES } from '../data/sampleDisclosures';

const TITLE: Record<MainTabKey, string> = {
  inflow: '資金流入株',
  sector: 'セクター騰落',
  disclosures: '適時開示',
};

function loadMainTab(): MainTabKey {
  const v = localStorage.getItem('mainTab');
  return v === 'sector' || v === 'disclosures' || v === 'inflow' ? v : 'inflow';
}

export function App() {
  const [mainTab, setMainTab] = useState<MainTabKey>(loadMainTab);
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
    localStorage.setItem('mainTab', t);
  };

  const onDatasetLoaded = (region: Region, dataset: RankingDataset) => {
    setRankingsCache((prev) => ({ ...prev, [region]: dataset }));
  };

  return (
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
        {mainTab === 'inflow' && (
          <InflowTab onSelectCode={setSelectedCode} onDatasetLoaded={onDatasetLoaded} />
        )}
        {mainTab === 'sector' && <SectorTab onSelectCode={setSelectedCode} />}
        {mainTab === 'disclosures' && (
          <DisclosuresTab onSelectCode={setSelectedCode} state={disclosuresState} />
        )}
      </main>

      <BottomTabBar active={mainTab} onChange={changeTab} />

      {selectedCode && (
        <StockDetail
          code={selectedCode}
          rankingsJP={rankingsCache.JP}
          rankingsUS={rankingsCache.US}
          disclosures={disclosuresState.data}
          onClose={() => setSelectedCode(null)}
        />
      )}
    </div>
  );
}
