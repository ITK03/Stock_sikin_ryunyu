import { useEffect, useState } from 'react';
import type { PeriodKey, RankingDataset } from '../core/types';
import { PERIODS } from '../core/periods';
import { RankingList, type Density } from './RankingList';
import { relTime } from './format';

type TabKey = '1' | '2' | '3';

const TABS: { key: TabKey; short: string; label: string; desc: string }[] = [
  { key: '1', short: '①', label: '時価総額比', desc: '最新営業日。時価総額に対して売買代金が大きいほど上位。' },
  { key: '2', short: '②', label: '連日継続', desc: '選択期間の平均で、時価総額比の売買代金が大きいほど上位。資金流入が連日続く銘柄が浮上。' },
  { key: '3', short: '③', label: '全市場上位', desc: '②に加え、全市場の売買代金(期間平均)上位に入る銘柄に絞り込み。' },
];

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 40 40" role="img" aria-label="logo">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2ee6a6" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#lg)" />
      <g fill="#08151f" opacity="0.9">
        <rect x="9" y="23" width="5" height="8" rx="1.4" />
        <rect x="17.5" y="18" width="5" height="13" rx="1.4" />
        <rect x="26" y="12" width="5" height="19" rx="1.4" />
      </g>
      <path d="M8 25 L18 18.5 L25 21 L33 11" fill="none" stroke="#08151f" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <circle cx="33" cy="11" r="2.4" fill="#08151f" />
    </svg>
  );
}

export function App() {
  const [data, setData] = useState<RankingDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('1');
  const [period, setPeriod] = useState<PeriodKey>('1w');
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem('density') as Density) || 'card',
  );

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/rankings.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const changeDensity = (d: Density) => {
    setDensity(d);
    localStorage.setItem('density', d);
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

  const active = TABS.find((t) => t.key === tab)!;
  const rows =
    tab === '1' ? data.ranking1 : tab === '2' ? data.ranking2[period] : data.ranking3[period];

  return (
    <div className="screen">
      <header className="appbar">
        <div className="brand">
          <Logo />
          <div>
            <h1>資金流入株</h1>
            <p className="brand-sub">時価総額比 × 売買代金 ランキング</p>
          </div>
        </div>
        <div className="asof">
          <span className="asof-date">{data.asOfDate || '—'}</span>
          <span className="asof-meta">{data.universe.toLocaleString()}銘柄 · {data.source}</span>
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
              <span className="seg-no">{t.short}</span>
              <span className="seg-label">{t.label}</span>
            </button>
          ))}
        </nav>

        {tab !== '1' && (
          <nav className="periods">
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

        <div className="viewbar">
          <p className="desc">{active.desc}</p>
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
        </div>
      </div>

      <main className="list-area">
        <RankingList rows={rows} showTurnoverRank={tab === '3'} density={density} />
      </main>

      <footer className="foot">
        <span>更新 {relTime(data.generatedAt)}</span>
        {tab === '3' && <span>上位 = 売買代金 {data.topK}位以内</span>}
      </footer>
    </div>
  );
}
