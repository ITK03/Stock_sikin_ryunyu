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
import { Logo } from './Logo';
import { relTime } from './format';

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

export function App() {
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

  // データを取得してキャッシュに保存する。bust=true でキャッシュバスト。
  const load = (r: Region, bust = false) =>
    fetch(dataUrl(r, bust), { cache: bust ? 'no-store' : 'default' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RankingDataset>;
      })
      .then((dataset) => {
        setCache((prev) => ({ ...prev, [r]: dataset }));
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
      await load(region, true);
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
      <div className="screen">
        <div className="state">
          <p className="state-title">データを読み込めませんでした</p>
          <p className="state-sub">{error}</p>
        </div>
      </div>
    );
  }

  const data = cache[region];

  if (!data) {
    return (
      <div className="screen">
        <div className="state">
          <span className="spinner" />
          <p className="state-sub">読み込み中…</p>
        </div>
      </div>
    );
  }

  const MARKETS = region === 'US' ? MARKETS_US : MARKETS_JP;

  const base: RankRow[] =
    tab === '1'
      ? data.ranking1
      : tab === '2'
      ? data.ranking2[period]
      : tab === '3'
      ? data.ranking3[period]
      : data.ranking4[surgeHorizon];
  const byMarket = market === 'All' ? base : base.filter((r) => r.market === market);
  const viewRows = applyFilters(byMarket, filters, region);

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
    <div className="screen">
      <header className="appbar">
        <div className="brand">
          <Logo />
          <div>
            <h1>資金流入株</h1>
          </div>
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
        </div>
        <div className="asof">
          <span className="asof-date">{data.asOfDate || '—'}</span>
        </div>
      </header>

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

      <main className="list-area">
        <RankingList
          rows={viewRows}
          showTurnoverRank={tab === '3'}
          density={density}
          region={region}
          metric={tab === '4' ? 'surge' : 'ratio'}
        />
      </main>

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
