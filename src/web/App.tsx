import { useEffect, useState } from 'react';
import type { MarketSegment, PeriodKey, RankRow, RankingDataset } from '../core/types';
import { PERIODS } from '../core/periods';
import { RankingList, type Density } from './RankingList';
import { HelpSheet } from './HelpSheet';
import { Logo } from './Logo';
import { relTime } from './format';

type TabKey = '1' | '2' | '3';
type MarketFilter = 'All' | MarketSegment;

const TABS: { key: TabKey; label: string }[] = [
  { key: '1', label: '時価総額比' },
  { key: '2', label: '連日継続' },
  { key: '3', label: '全市場上位' },
];

const MARKETS: { key: MarketFilter; label: string }[] = [
  { key: 'All', label: '全市場' },
  { key: 'Prime', label: 'プライム' },
  { key: 'Standard', label: 'スタンダード' },
  { key: 'Growth', label: 'グロース' },
];

export function App() {
  const [data, setData] = useState<RankingDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('1');
  const [period, setPeriod] = useState<PeriodKey>('1w');
  const [market, setMarket] = useState<MarketFilter>('All');
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem('density') as Density) || 'card',
  );
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  const base: RankRow[] =
    tab === '1' ? data.ranking1 : tab === '2' ? data.ranking2[period] : data.ranking3[period];
  const viewRows = market === 'All' ? base : base.filter((r) => r.market === market);

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
            <p className="brand-sub">日本株ランキング</p>
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
              {t.label}
            </button>
          ))}
        </nav>

        {tab !== '1' && (
          <nav className="chiprow">
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

        <nav className="chiprow markets">
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
            <button className="btn-help" onClick={() => setHelp(true)} aria-label="ヘルプ">?</button>
            <button className="btn-copy" onClick={copyTop20}>
              <span className="copy-ico" aria-hidden />上位20コピー
            </button>
          </div>
        </div>
      </div>

      <main className="list-area">
        <RankingList rows={viewRows} showTurnoverRank={tab === '3'} density={density} />
      </main>

      <footer className="foot">
        <span>更新 {relTime(data.generatedAt)}</span>
        <button className="link" onClick={() => setHelp(true)}>指標の説明</button>
      </footer>

      {help && <HelpSheet topK={data.topK} onClose={() => setHelp(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
