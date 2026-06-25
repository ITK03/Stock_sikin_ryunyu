import { useEffect, useState } from 'react';
import type { PeriodKey, RankingDataset } from '../core/types';
import { PERIODS } from '../core/periods';
import { RankingTable } from './RankingTable';

type TabKey = '1' | '2' | '3';

const TABS: { key: TabKey; label: string; desc: string }[] = [
  { key: '1', label: '① 時価総額比', desc: '最新営業日。時価総額に対して売買代金が大きいほど上位。' },
  { key: '2', label: '② 連日継続', desc: '選択期間の平均で、時価総額比の売買代金が大きいほど上位。' },
  { key: '3', label: '③ 全市場上位', desc: '②に加え、全市場の売買代金(期間平均)上位に入る銘柄に絞り込み。' },
];

export function App() {
  const [data, setData] = useState<RankingDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('1');
  const [period, setPeriod] = useState<PeriodKey>('3d');

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/rankings.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="app">
        <p className="empty">データを読み込めませんでした: {error}</p>
        <p className="empty">先に <code>npm run build:data:sample</code> を実行してください。</p>
      </div>
    );
  }
  if (!data) return <div className="app"><p className="empty">読み込み中…</p></div>;

  const active = TABS.find((t) => t.key === tab)!;
  const rows =
    tab === '1' ? data.ranking1 : tab === '2' ? data.ranking2[period] : data.ranking3[period];

  return (
    <div className="app">
      <header>
        <h1>資金流入株ランキング</h1>
        <div className="meta">
          <span>最新営業日: {data.asOfDate || '—'}</span>
          <span>対象: {data.universe.toLocaleString()}銘柄</span>
          <span>データ: {data.source}</span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={t.key === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab !== '1' && (
        <nav className="periods">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              className={p.key === period ? 'period active' : 'period'}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      )}

      <p className="desc">{active.desc}</p>

      <RankingTable rows={rows} showTurnoverRank={tab === '3'} />

      <footer>
        <span>{new Date(data.generatedAt).toLocaleString('ja-JP')} 生成</span>
        {tab === '3' && <span>全市場上位 = 売買代金 上位{data.topK}位以内</span>}
      </footer>
    </div>
  );
}
