import { useMemo, useState } from 'react';
import type { SwingSignalsFeed, SwingStrategy } from '../core/types';
import { useExternalJson } from './externalData';
import { SWING_SIGNALS_URLS } from './externalSources';
import { priceText, relTime } from './format';
import { SwingPaperLogView } from './SwingPaperLog';
import { SwingPositions, type PositionPrefill } from './SwingPositions';
import { WatchStar } from './watchlist';

// スイングタブ。Twitter_Master 由来のスクリーナーが出力する signals.json を表示する。
// 銘柄名タップで横断の銘柄詳細を開く(既存タブと同じ onSelectCode 連携)。
// 上部のサブ切替で「シグナル(買い候補・手仕舞い)」「保有ポジション(ユーザー手動管理)」
// 「検証ログ(自動ペーパートレードの明細)」の3ビューを切り替える。

interface Props {
  onSelectCode: (code: string) => void;
}

type SwingView = 'signals' | 'positions' | 'paperlog';

const VIEW_LABEL: Record<SwingView, string> = {
  signals: 'シグナル',
  positions: '保有ポジション',
  paperlog: '検証ログ',
};

const EMPTY_FEED: SwingSignalsFeed = {
  version: 1,
  generated_at: '',
  data_date: '',
  trade_date: '',
  status: 'empty',
  status_reason: '',
  universe_count: 0,
  strategies: [],
  calendar: { future_business_days: [] },
  paper_log_summary: { closed_trades: 0, win_rate: 0, avg_ret: 0, by_strategy: {} },
};

const pctText = (v: number, digits = 0): string =>
  `${(v * 100).toFixed(digits)}%`;

const signedPctText = (v: number, digits = 1): string =>
  `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

export function SwingTab({ onSelectCode }: Props) {
  const { data, loading, error, sample, reload } = useExternalJson<SwingSignalsFeed>({
    cacheKey: 'ext:swing-signals',
    // raw を優先(スクリーナーの commit 直後に反映)し、失敗時は本サイトにバンドル
    // された public/data/signals.json(前回デプロイ時点)へフォールバックする。
    urls: [...SWING_SIGNALS_URLS, `${import.meta.env.BASE_URL}data/signals.json`],
    sampleData: EMPTY_FEED,
  });

  const [view, setView] = useState<SwingView>('signals');
  const [stratId, setStratId] = useState<string | null>(null);
  const [showRule, setShowRule] = useState(false);
  const [showRisks, setShowRisks] = useState(false);
  // 買い候補タップで保有ポジションフォームへ前埋めする受け渡し用。
  const [prefill, setPrefill] = useState<PositionPrefill | null>(null);

  // 「＋保有に追加」: 条件の株価(推奨指値)・銘柄・戦略・今日の日付を前埋めして
  // 保有ポジションビューへ切り替える。ユーザーはそこから手動で編集できる。
  const startAddPosition = (p: PositionPrefill) => {
    setPrefill(p);
    setView('positions');
  };

  const strategies = data?.strategies ?? [];
  const selected: SwingStrategy | undefined = useMemo(() => {
    if (strategies.length === 0) return undefined;
    return strategies.find((s) => s.id === stratId) ?? strategies[0];
  }, [strategies, stratId]);

  const viewSwitcher = (
    <nav className="segmented swing-view-seg" role="tablist" aria-label="表示切替">
      {(Object.keys(VIEW_LABEL) as SwingView[]).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={v === view}
          className={v === view ? 'seg-btn active' : 'seg-btn'}
          onClick={() => setView(v)}
        >
          {VIEW_LABEL[v]}
        </button>
      ))}
    </nav>
  );

  const renderSignals = () => {
    if (loading && !data) {
      return <div className="inline-state"><span className="spinner" /><p className="state-sub">読み込み中…</p></div>;
    }

    if (error && !data) {
      return (
        <div className="inline-state">
          <p className="state-title">スイングデータを取得できませんでした</p>
          <p className="state-sub">{error}</p>
          <button className="filter-reset" onClick={reload}>再試行</button>
        </div>
      );
    }

    if (!selected) {
      return <p className="empty">スイングのシグナルがまだありません。</p>;
    }

    const oos = selected.oos_stats;
    const exits = selected.universe_status.filter((u) => u.exit);
    const paperByStrat = data?.paper_log_summary.by_strategy[selected.id];

    return (
      <>
        {/* 戦略の概要とバックテスト成績 */}
        <div className="swing-meta">
          <div className="swing-meta-name">{selected.display_name}</div>
          <p className="swing-desc">{selected.description}</p>
          <div className="swing-stats">
            {oos.avg_ret !== undefined && (
              <div className="swing-stat">
                <span className={`swing-stat-val ${oos.avg_ret >= 0 ? 'chg-up' : 'chg-down'}`}>
                  {signedPctText(oos.avg_ret, 2)}
                </span>
                <span className="swing-stat-lab">期待値/回</span>
              </div>
            )}
            <div className="swing-stat">
              <span className="swing-stat-val">{pctText(oos.win_rate)}</span>
              <span className="swing-stat-lab">勝率</span>
            </div>
            <div className="swing-stat">
              <span className="swing-stat-val">{oos.profit_factor.toFixed(2)}</span>
              <span className="swing-stat-lab">PF</span>
            </div>
            <div className="swing-stat">
              <span className="swing-stat-val chg-down">{signedPctText(oos.max_dd)}</span>
              <span className="swing-stat-lab">最大DD</span>
            </div>
            <div className="swing-stat">
              <span className="swing-stat-val">{oos.trades.toLocaleString()}</span>
              <span className="swing-stat-lab">検証取引</span>
            </div>
          </div>
          <div className="swing-oos-period">
            検証OOS: {oos.period}・検証日 {selected.validated_at}
            {strategies.length > 1 && '・タブは期待値の高い順'}
          </div>
          {paperByStrat && paperByStrat.closed_trades > 0 && (
            <div className="swing-paper">
              実運用ペーパー: {paperByStrat.closed_trades}件確定・勝率{pctText(paperByStrat.win_rate, 0)}
              ・平均{signedPctText(paperByStrat.avg_ret / 100, 2)}
            </div>
          )}
          <div className="swing-expanders">
            <button className="swing-exp-btn" onClick={() => setShowRule((v) => !v)} aria-expanded={showRule}>
              売買ルール {showRule ? '▲' : '▼'}
            </button>
            <button className="swing-exp-btn" onClick={() => setShowRisks((v) => !v)} aria-expanded={showRisks}>
              リスク {showRisks ? '▲' : '▼'}
            </button>
          </div>
          {showRule && <p className="swing-rule">{selected.rule_note}</p>}
          {showRisks && (
            <ul className="swing-risks">
              {selected.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>

        {/* 翌営業日の買い候補 */}
        <h3 className="swing-section-title">
          買い候補({selected.buy_candidates.length}) ・ {data?.trade_date} に指値
        </h3>
        {selected.buy_candidates.length === 0 ? (
          <p className="empty">本日は条件を満たす買い候補がありません。</p>
        ) : (
          <ul className="cards">
            {selected.buy_candidates.map((c) => (
              <li
                key={c.code}
                className="card card-tap"
                role="button"
                tabIndex={0}
                onClick={() => onSelectCode(c.code)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(c.code)}
              >
                <div className="card-top">
                  <span className="rankbadge">{c.priority}</span>
                  <div className="ident">
                    <div className="name">{c.name}</div>
                    <div className="sub">
                      <WatchStar code={c.code} />
                      <span className="code">{c.code}</span>
                      <span className="swing-rank-label">{c.rank_label}</span>
                    </div>
                  </div>
                  <div className="hero">
                    <div className="hero-val">{priceText(c.limit_price, 'JP')}</div>
                    <div className="hero-cap">推奨指値</div>
                  </div>
                </div>
                <div className="stats">
                  <div className="stat">
                    <span className="stat-label">現在値</span>
                    <span className="stat-val">{priceText(c.close, 'JP')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">1単元コスト</span>
                    <span className="stat-val">{priceText(c.unit_cost, 'JP')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">指値幅</span>
                    <span className="stat-val">{signedPctText(-selected.limit_entry, 0)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="swing-add-pos-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    startAddPosition({
                      strategyId: selected.id,
                      code: c.code,
                      name: c.name,
                      // 条件の株価 = 推奨指値(無ければ現在値)。ここから手動編集できる。
                      price: c.limit_price ?? c.close,
                    });
                  }}
                >
                  ＋ 保有に追加(指値 {priceText(c.limit_price ?? c.close, 'JP')})
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 手仕舞いシグナル(保有中なら翌寄りで利確/売り) */}
        {exits.length > 0 && (
          <>
            <h3 className="swing-section-title">手仕舞いシグナル({exits.length})</h3>
            <ol className="rows">
              {exits.map((u) => (
                <li
                  key={u.code}
                  className="row row-tap"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectCode(u.code)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(u.code)}
                >
                  <span className="r-code">{u.code}</span>
                  <span className="r-name">{u.name}</span>
                  <span className="swing-rank-label">{u.rank_label}</span>
                  <span className="r-ratio">{priceText(u.close, 'JP')}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </>
    );
  };

  return (
    <div className="tab-pane">
      <div className="controls">
        {viewSwitcher}

        {view === 'signals' && (
          <>
            <div className="swing-status">
              {sample && <span className="chip sample-chip">サンプル</span>}
              {data && data.status !== 'ok' && (
                <span className="swing-badge warn">
                  データ遅延の可能性{data.status_reason ? `(${data.status_reason})` : ''}
                </span>
              )}
              <span className="asof-date">
                {data?.data_date || '—'} 基準 ・ {data?.trade_date || '—'} 発注 ・ {data?.universe_count ?? 0}銘柄
              </span>
            </div>

            {strategies.length > 0 && (
              <nav className="segmented" role="tablist" aria-label="戦略">
                {strategies.map((s) => (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={selected ? s.id === selected.id : false}
                    className={selected && s.id === selected.id ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setStratId(s.id)}
                  >
                    {s.display_name.replace(/（.*$/, '')}
                  </button>
                ))}
              </nav>
            )}
          </>
        )}
      </div>

      <div className="list-area">
        {view === 'signals' && renderSignals()}
        {view === 'positions' && (
          <SwingPositions
            feed={data}
            onSelectCode={onSelectCode}
            prefill={prefill}
            onPrefillConsumed={() => setPrefill(null)}
          />
        )}
        {view === 'paperlog' && <SwingPaperLogView feed={data} onSelectCode={onSelectCode} />}
      </div>

      <footer className="foot">
        {view === 'signals' && <span>更新 {data ? relTime(data.generated_at) : '—'}</span>}
        <span className="swing-foot-note">投資助言ではありません。自己責任で。</span>
      </footer>
    </div>
  );
}
