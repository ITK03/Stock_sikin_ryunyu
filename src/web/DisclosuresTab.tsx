import { useMemo, useState } from 'react';
import type { DisclosuresArchiveIndex, DisclosuresFeed } from '../core/types';
import { useExternalJson, useLazyExternalJson, type ExternalDataState } from './externalData';
import { DISCLOSURES_ARCHIVE_INDEX_URLS, disclosuresArchiveUrls } from './externalSources';
import { normalizeCode } from '../core/codes';
import { dedupeDisclosures } from '../core/disclosures';
import { relTime } from './format';
import { DisclosureItem } from './DisclosureItem';
import { useWatchlist } from './watchlist';

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

/** 日付セレクタの「ライブ(最新)」を表す特別な値。 */
const LIVE = 'live';

const EMPTY_INDEX: DisclosuresArchiveIndex = { updated_at: '', dates: [] };
const EMPTY_FEED: DisclosuresFeed = { updated_at: '', count: 0, items: [] };

/** "YYYY-MM-DD" → "MM/DD" 表示。 */
function dayLabel(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[1]}/${m[2]}` : date;
}

export function DisclosuresTab({ onSelectCode, state }: Props) {
  const [minScore, setMinScore] = useState(0);
  const [query, setQuery] = useState('');
  const [watchOnly, setWatchOnly] = useState(false);
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [day, setDay] = useState<string>(LIVE);
  const watchlist = useWatchlist();

  // 日付別アーカイブの索引(小さいJSON)。サンプルモードでは空=セレクタ非表示。
  const indexState = useExternalJson<DisclosuresArchiveIndex>({
    cacheKey: 'ext:disc-archive-index',
    urls: DISCLOSURES_ARCHIVE_INDEX_URLS,
    sampleData: EMPTY_INDEX,
  });
  const archiveDates = Array.isArray(indexState.data?.dates) ? indexState.data!.dates : [];

  // 過去日を選択したときだけ該当日のアーカイブを遅延fetchする(日付ごとにメモリキャッシュ)。
  const archiveState = useLazyExternalJson<DisclosuresFeed>({
    cacheKey: `ext:disclosures:${day}`,
    urls: day === LIVE ? [] : disclosuresArchiveUrls(day),
    sampleData: EMPTY_FEED,
    enabled: day !== LIVE,
  });

  const isLive = day === LIVE;
  const { data, loading, error, sample, reload } = isLive ? state : archiveState;

  const items = useMemo(() => {
    const raw = Array.isArray(data?.items) ? data!.items : [];
    // 実データでは複数ソース(yanoshin/scraper)から同一開示が別idで重複混入することがあるため、
    // (time, code, title) が完全一致する行は1件に統合してから表示する。
    const all = dedupeDisclosures(raw);
    const qCode = normalizeCode(query);
    return all
      .filter((d) => d.score >= minScore)
      .filter((d) => (urgentOnly ? d.urgent : true))
      .filter((d) => (watchOnly ? watchlist.has(d.code) : true))
      .filter((d) => {
        if (!qCode) return true;
        // 前方一致にする(「72」まで入力した時点で 7203 等が出るように)。
        const dc = normalizeCode(d.code);
        return dc !== null && dc.startsWith(qCode);
      })
      .slice()
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }, [data, minScore, query, watchOnly, urgentOnly, watchlist]);

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
          {!isLive && (
            <button className="filter-reset" onClick={() => setDay(LIVE)}>ライブに戻る</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tab-pane">
      <div className="disc-controls">
        <div className="disc-toprow">
          <input
            className="disc-search"
            type="search"
            inputMode="numeric"
            placeholder="銘柄コードで検索(例: 7203)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {archiveDates.length > 0 && (
            <select
              className="disc-day"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              aria-label="日付切替"
            >
              <option value={LIVE}>ライブ</option>
              {archiveDates.map((d) => (
                <option key={d.date} value={d.date}>
                  {dayLabel(d.date)}({d.count}件)
                </option>
              ))}
            </select>
          )}
        </div>
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
          <button
            className={urgentOnly ? 'chip urgent-chip active' : 'chip urgent-chip'}
            onClick={() => setUrgentOnly((v) => !v)}
            aria-pressed={urgentOnly}
          >
            速報のみ
          </button>
          <button
            className={watchOnly ? 'chip watch active' : 'chip watch'}
            onClick={() => setWatchOnly((v) => !v)}
            aria-pressed={watchOnly}
          >
            ★ウォッチ
          </button>
        </nav>
        <div className="disc-meta">
          {sample && <span className="chip sample-chip">サンプル</span>}
          {data && (
            <span className="asof-date">
              {isLive ? `${relTime(data.updated_at)}更新` : `${dayLabel(day)}のアーカイブ`}・{items.length}件
            </span>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="empty">該当する開示がありません。</p>
      ) : (
        <ul className="disc-list">
          {items.map((d) => (
            <DisclosureItem key={d.id} d={d} onSelectCode={onSelectCode} watched={watchlist.has(d.code)} />
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
