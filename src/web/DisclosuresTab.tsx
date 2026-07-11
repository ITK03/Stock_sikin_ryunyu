import { useMemo, useState } from 'react';
import type { DisclosuresFeed } from '../core/types';
import type { ExternalDataState } from './externalData';
import { normalizeCode } from '../core/codes';
import { relTime } from './format';
import { DisclosureItem } from './DisclosureItem';

interface Props {
  onSelectCode: (code: string) => void;
  /** App側で一度だけ取得した開示データの状態(タブ切替のたびの再フェッチを避ける)。 */
  state: ExternalDataState<DisclosuresFeed>;
}

const THRESHOLDS = [
  { key: 0, label: 'すべて' },
  { key: 50, label: '50+' },
  { key: 70, label: '70+' },
  { key: 85, label: '85+' },
];

export function DisclosuresTab({ onSelectCode, state }: Props) {
  const { data, loading, error, sample, reload } = state;
  const [minScore, setMinScore] = useState(0);
  const [query, setQuery] = useState('');

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const qCode = normalizeCode(query);
    return all
      .filter((d) => d.score >= minScore)
      .filter((d) => (qCode ? normalizeCode(d.code) === qCode : true))
      .slice()
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }, [data, minScore, query]);

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
          <p className="state-title">開示データを取得できませんでした</p>
          <p className="state-sub">{error}</p>
          <button className="filter-reset" onClick={reload}>再試行</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-pane">
      <div className="disc-controls">
        <input
          className="disc-search"
          type="search"
          inputMode="numeric"
          placeholder="銘柄コードで検索(例: 7203)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <nav className="chiprow">
          <span className="row-label">重要度</span>
          {THRESHOLDS.map((t) => (
            <button
              key={t.key}
              className={t.key === minScore ? 'chip active' : 'chip'}
              onClick={() => setMinScore(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="disc-meta">
          {sample && <span className="chip sample-chip">サンプル</span>}
          {data && <span className="asof-date">{relTime(data.updated_at)}更新・{items.length}件</span>}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="empty">該当する開示がありません。</p>
      ) : (
        <ul className="disc-list">
          {items.map((d) => (
            <DisclosureItem key={d.id} d={d} onSelectCode={onSelectCode} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="disc-list">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="disc-item skeleton" aria-hidden>
          <div className="skel-line skel-w30" />
          <div className="skel-line skel-w80" />
        </li>
      ))}
    </ul>
  );
}
