import { useEffect, useState } from 'react';
import type {
  MarketSegment,
  PeriodKey,
  RankRow,
  RankingDataset,
  Region,
  SurgeHorizon,
} from '../core/types';
import { PERIODS, SURGE_HORIZONS } from '../core/periods';
import { RankingList, type Density } from './RankingList';
import { HelpSheet } from './HelpSheet';
import { FilterSheet } from './FilterSheet';
import { relTime } from './format';
import { useWatchlist } from './watchlist';

// 「資金流入」タブ本体。既存の資金流入ランキング機能そのもの(挙動は変更しない)。
// 統合ダッシュボード化にあたり、Logo/アプリ名の表示は上位の App シェルへ移した。

type TabKey = '1' | '2' | '3' | '4';
type MarketFilter = 'All' | MarketSegment;

interface Filters {
  capMin: string;
  capMax: string;
  turnoverMin: string;
}

const EMPTY_FILTERS: Filters = { capMin: '', capMax: '', turnoverMin: '' };

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem('filters');
    if (!raw) return { ...EMPTY_FILTERS };
    const parsed = JSON.parse(raw);
    return {
      capMin: typeof parsed.capMin === 'string' ? parsed.capMin : '',
      capMax: typeof parsed.capMax === 'string' ? parsed.capMax : '',
      turnoverMin: typeof parsed.turnoverMin === 'string' ? parsed.turnoverMin : '',
    };
  } catch {
    return { ...EMPTY_FILTERS };
  }
}

const TABS: { key: TabKey; label: string }[] = [
  { key: '1', label: '時価総額比' },
  { key: '2', label: '連日継続' },
  { key: '3', label: '全市場上位' },
  { key: '4', label: '急増' },
];

const MARKETS_JP: { key: MarketFilter; label: string }[] = [
  { key: 'All', label: '全市場' },
  { key: 'Prime', label: 'プライム' },
  { key: 'Standard', label: 'スタンダード' },
  { key: 'Growth', label: 'グロース' },
];

const MARKETS_US: { key: MarketFilter; label: string }[] = [
  { key: 'All', label: '全市場' },
  { key: 'NYSE', label: 'NYSE' },
  { key: 'NASDAQ', label: 'NASDAQ' },
  { key: 'AMEX', label: 'AMEX' },
];

function parseUnit(s: string, region: Region): number | null {
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return region === 'US' ? n * 1e6 : n * 1e8;
}

function isFilterActive(f: Filters): boolean {
  return f.capMin !== '' || f.capMax !== '' || f.turnoverMin !== '';
}

function applyFilters(rows: RankRow[], f: Filters, region: Region): RankRow[] {
  const capMin = parseUnit(f.capMin, region);
  const capMax = parseUnit(f.capMax, region);
  const turnoverMin = parseUnit(f.turnoverMin, region);
  if (capMin === null && capMax === null && turnoverMin === null) return rows;
  return rows.filter(
    (r) =>
      (capMin === null || r.marketCap >= capMin) &&
      (capMax === null || r.marketCap <= capMax) &&
      (turnoverMin === null || r.turnover >= turnoverMin),
  );
}

function dataUrl(region: Region, bust = false): string {
  const file = region === 'US' ? 'rankings.us.json' : 'rankings.json';
  return `${import.meta.env.BASE_URL}data/${file}${bust ? `?t=${Date.now()}` : ''}`;
}

interface Props {
  /** 銘柄コードタップ時に横断詳細を開く。 */
  onSelectCode: (code: string) => void;
  /** データセットを読み込むたびに、上位(App)へ最新値を伝える(銘柄詳細の順位計算用)。 */
  onDatasetLoaded: (region: Region, dataset: RankingDataset) => void;
}

export function InflowTab({ onSelectCode, onDatasetLoaded }: Props) {
  const [cache, setCache] = useState<Partial<Record<Region, RankingDataset>>>({});
  const [region, setRegion] = useState<Region>(
    () => (localStorage.getItem('region') as Region) || 'JP',
  );
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('1');
  const [period, setPeriod] = useState<PeriodKey>('1w');
  const [surgeHorizon, setSurgeHorizon] = useState<SurgeHorizon>('1d');
  const [market, setMarket] = useState<MarketFilter>('All');
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem('density') as Density) || 'card',
  );
  const [help, setHelp] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [watchOnly, setWatchOnly] = useState(false);
  const watchlist = useWatchlist();

  // データを取得してキャッシュに保存する。データは日中に複数回更新されるため、
  // 常に最新を取得する(古いデータと新しいアプリ本体の不整合による表示崩れを防ぐ)。
  const load = (r: Region) =>
    fetch(dataUrl(r, true), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RankingDataset>;
      })
      .then((dataset) => {
        setCache((prev) => ({ ...prev, [r]: dataset }));
        onDatasetLoaded(r, dataset);
      });

  // 起動時に現在のリージョンを読み込む。
  useEffect(() => {
    load(region).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRegion = (r: Region) => {
    setRegion(r);
    localStorage.setItem('region', r);
    setMarket('All');
    // まだキャッシュがない場合のみフェッチ。
    if (!cache[r]) {
      load(r).catch((e) => setError(String(e)));
    }
  };

  const changeFilters = (f: Filters) => {
    setFilters(f);
    localStorage.setItem('filters', JSON.stringify(f));
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load(region);
      flash('最新データに更新しました');
    } catch {
      flash('更新に失敗しました');
    } finally {
      setRefreshing(false);
    }
  };

  const changeDensity = (d: Density) => {
    setDensity(d);
    localStorage.setItem('density', d);
  };

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  if (error) {
    return (
      <div className="inline-state">
        <p className="state-title">データを読み込めませんでした</p>
        <p className="state-sub">{error}</p>
      </div>
    );
  }

  const data = cache[region];

  if (!data) {
    return (
      <div className="tab-pane">
        <RankingSkeleton />
      </div>
    );
  }

  const MARKETS = region === 'US' ? MARKETS_US : MARKETS_JP;

  // 各ランキングは欠損しても落ちないよう防御的に参照する(古いデータ互換)。
  const base: RankRow[] =
    (tab === '1'
      ? data.ranking1
      : tab === '2'
      ? data.ranking2?.[period]
      : tab === '3'
      ? data.ranking3?.[period]
      : data.ranking4?.[surgeHorizon]) ?? [];
  const byMarket = market === 'All' ? base : base.filter((r) => r.market === market);
  const filteredRows = applyFilters(byMarket, filters, region);
  const viewRows = watchOnly ? filteredRows.filter((r) => watchlist.has(r.code)) : filteredRows;

  const filterActive = isFilterActive(filters);

  const copyTop20 = async () => {
    const text = viewRows
      .slice(0, 20)
      .map((r, i) => `${i + 1}. ${r.code} ${r.name}`)
      .join('\n');
    if (!text) {
      flash('対象がありません');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      flash(`上位${Math.min(20, viewRows.length)}件をコピーしました`);
    } catch {
      // クリップボードAPIが使えない場合のフォールバック。
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flash(`上位${Math.min(20, viewRows.length)}件をコピーしました`);
    }
  };

  return (
    <div className="tab-pane">
      <div className="inflow-subbar">
        <div className="region-toggle" role="group" aria-label="地域切替">
          <button
            className={region === 'JP' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeRegion('JP')}
            aria-pressed={region === 'JP'}
          >
            JP
          </button>
          <button
            className={region === 'US' ? 'region-btn active' : 'region-btn'}
            onClick={() => changeRegion('US')}
            aria-pressed={region === 'US'}
          >
            US
          </button>
        </div>
        <span className="asof-date">{data.asOfDate || '—'}</span>
      </div>

      <div className="controls">
        <nav className="segmented" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === tab}
              className={t.key === tab ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {(tab === '2' || tab === '3') && (
          <nav className="chiprow">
            <span className="row-label">期間</span>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                className={p.key === period ? 'chip active' : 'chip'}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </nav>
        )}

        {tab === '4' && (
          <nav className="chiprow">
            <span className="row-label">急増</span>
            {SURGE_HORIZONS.map((h) => (
              <button
                key={h.key}
                className={h.key === surgeHorizon ? 'chip active' : 'chip'}
                onClick={() => setSurgeHorizon(h.key)}
              >
                {h.label}
              </button>
            ))}
          </nav>
        )}

        {tab === '4' && data.sessionProgress !== undefined && data.sessionProgress < 1 && (
          <p className="session-note">場中データ: 当日の売買代金は終日ペースに換算しています</p>
        )}

        <nav className="chiprow markets">
          <span className="row-label">市場</span>
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className={m.key === market ? 'chip mkt active' : 'chip mkt'}
              onClick={() => setMarket(m.key)}
            >
              {m.label}
            </button>
          ))}
          <button
            className={watchOnly ? 'chip watch active' : 'chip watch'}
            onClick={() => setWatchOnly((v) => !v)}
            aria-pressed={watchOnly}
          >
            ★ウォッチ
          </button>
        </nav>

        <div className="actions">
          <div className="density" role="group" aria-label="表示切替">
            <button
              className={density === 'card' ? 'den-btn active' : 'den-btn'}
              onClick={() => changeDensity('card')}
              aria-pressed={density === 'card'}
            >
              <span className="den-ico den-card" aria-hidden />カード
            </button>
            <button
              className={density === 'compact' ? 'den-btn active' : 'den-btn'}
              onClick={() => changeDensity('compact')}
              aria-pressed={density === 'compact'}
            >
              <span className="den-ico den-list" aria-hidden />一覧
            </button>
          </div>
          <div className="act-right">
            <button
              className={refreshing ? 'btn-icon spin' : 'btn-icon'}
              onClick={refresh}
              disabled={refreshing}
              aria-label="最新データに更新"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" />
                <path d="M20 4v5h-5" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className={filterActive ? 'btn-icon btn-filter-active' : 'btn-icon'}
              onClick={() => setFilterOpen(true)}
              aria-label="フィルタ"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path d="M3 5h18M7 12h10M10 19h4" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" />
              </svg>
              {filterActive && <span className="filter-dot" aria-hidden />}
            </button>
            <button className="btn-icon" onClick={copyTop20} aria-label="上位20をコピー">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <rect x="9" y="9" width="11" height="13" rx="2" fill="none"
                  stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
                <path d="M15 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4"
                  fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="list-area">
        <RankingList
          rows={viewRows}
          showTurnoverRank={tab === '3'}
          density={density}
          region={region}
          metric={tab === '4' ? 'surge' : 'ratio'}
          onSelectCode={onSelectCode}
        />
      </div>

      <footer className="foot">
        <span>更新 {relTime(data.generatedAt)}</span>
        <button className="link" onClick={() => setHelp(true)}>指標の説明</button>
      </footer>

      {help && <HelpSheet topK={data.topK} onClose={() => setHelp(false)} />}
      {filterOpen && (
        <FilterSheet
          filters={filters}
          onChange={changeFilters}
          onClose={() => setFilterOpen(false)}
          region={region}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/** 初回読み込み中のカード形スケルトン(セクター/開示タブと同じ視覚言語に統一)。 */
function RankingSkeleton() {
  return (
    <ul className="cards" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="card skeleton">
          <div className="skel-line skel-w60" />
          <div className="skel-line skel-w30" />
          <div className="skel-line skel-w80" />
        </li>
      ))}
    </ul>
  );
}
