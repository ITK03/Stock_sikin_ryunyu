import { useMemo, useState } from 'react';
import type { DisclosuresArchiveIndex, DisclosuresFeed } from '../core/types';
import { useExternalJson, useLazyExternalJson, type ExternalDataState } from './externalData';
import { DISCLOSURES_ARCHIVE_INDEX_URLS, disclosuresArchiveUrls } from './externalSources';
import { dedupeDisclosures, disclosureTopics, matchesMaterial, matchesQuery, matchesTopics, toggleMaterial } from '../core/disclosures';
import type { MaterialKey } from '../core/disclosures';
import { DisclosureFilterSheet } from './DisclosureFilterSheet';
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

/** 材料フィルタ。good/bad は特大を含む。mega は特大(好悪両方)のみ。
    複数選択でき、「すべて」は選択なし(空集合)で表す。 */
const MATERIAL_FILTERS: { key: MaterialKey; label: string }[] = [
  { key: 'mega', label: '🔥特大' },
  { key: 'good', label: '好材料' },
  { key: 'bad', label: '悪材料' },
];

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
  // トピック絞り込み(複数選択はOR)。実データから候補を作るので、開示の傾向が
  // 変わっても空のチップが並ばない。
  const [topics, setTopics] = useState<Set<string>>(new Set());
  const [watchOnly, setWatchOnly] = useState(false);
  const [urgentOnly, setUrgentOnly] = useState(false);
  // 材料は複数選択。空集合が「すべて」。
  const [material, setMaterial] = useState<Set<MaterialKey>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
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
    return all
      .filter((d) => d.score >= minScore)
      .filter((d) => matchesMaterial(d, material))
      .filter((d) => (urgentOnly ? d.urgent : true))
      .filter((d) => (watchOnly ? watchlist.has(d.code) : true))
      // コード・会社名・タイトル・タグのいずれかに当たれば表示する。
      // 以前はコードとしてしか解釈しておらず、会社名を入れても何も起きなかった。
      .filter((d) => matchesQuery(d, query))
      .filter((d) => matchesTopics(d, topics))
      .slice()
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }, [data, minScore, query, topics, watchOnly, urgentOnly, material, watchlist]);

  // チップの候補と件数は、表示中の日付の全開示から作る。絞り込み後の集合から
  // 作ると、あるトピックを選んだ瞬間に他のチップが消えて選び直せなくなる。
  // フィルタボタンに出すバッジ。何かしら絞り込みが効いていることを外から分かるように。
  const activeFilters =
    topics.size + (urgentOnly ? 1 : 0) + (watchOnly ? 1 : 0) + (minScore > 0 ? 1 : 0);

  const topicChoices = useMemo(
    // ウィンドウでは全カテゴリを出す(チップ行のような12個上限は掛けない)。
    () => disclosureTopics(dedupeDisclosures(Array.isArray(data?.items) ? data!.items : []), Infinity),
    [data],
  );

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
            placeholder="コード・銘柄名・語句で検索(例: 7203 / トヨタ / 自己株式)"
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
        {/* 材料だけはウィンドウの外に置く。開示を見ながら何度も切り替えるので、
            そのたびにウィンドウを開くのは煩わしいため。複数選択できる。 */}
        <nav className="chiprow">
          <span className="row-label">材料</span>
          <button
            className={material.size === 0 ? 'chip active' : 'chip'}
            onClick={() => setMaterial(new Set())}
            aria-pressed={material.size === 0}
          >
            すべて
          </button>
          {MATERIAL_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip mat-${f.key}${material.has(f.key) ? ' active' : ''}`}
              onClick={() => setMaterial((prev) => toggleMaterial(prev, f.key))}
              aria-pressed={material.has(f.key)}
            >
              {f.label}
            </button>
          ))}
          <button
            className={activeFilters > 0 ? 'chip filter-open btn-filter-active' : 'chip filter-open'}
            onClick={() => setFilterOpen(true)}
          >
            ⚙ フィルタ
            {activeFilters > 0 && <span className="chip-count">{activeFilters}</span>}
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

      {filterOpen && (
        <DisclosureFilterSheet
          state={{ minScore, topics, urgentOnly, watchOnly }}
          topics={topicChoices}
          thresholds={THRESHOLDS}
          onChange={(next) => {
            setMinScore(next.minScore);
            setTopics(next.topics);
            setUrgentOnly(next.urgentOnly);
            setWatchOnly(next.watchOnly);
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}

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
