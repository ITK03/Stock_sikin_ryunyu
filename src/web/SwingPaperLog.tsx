import { useState } from 'react';
import type { SwingPaperLog } from '../core/types';
import { useExternalJson } from './externalData';
import { SWING_PAPER_LOG_URLS } from './externalSources';
import { priceText, relTime } from './format';

// 検証ログ(自動ペーパートレード paper_log.json)の明細表示。データ駆動・表示のみ
// (ユーザー操作なし)。保有ポジション(SwingPositions.tsx, ユーザー手動管理)とは別物。

interface Props {
  onSelectCode: (code: string) => void;
}

const EMPTY_LOG: SwingPaperLog = { version: 1, updated_at: '', pending: [], open: [], closed: [] };

const EXIT_REASON_LABEL: Record<string, string> = {
  take_profit: '利確',
  stop_loss: '損切',
  deadline: '期限',
  timeout: '期限',
  rsi_exit: 'シグナル手仕舞い',
  sell_signal: 'シグナル手仕舞い',
  signal_exit: 'シグナル手仕舞い',
};

function exitReasonText(reason: string): string {
  return EXIT_REASON_LABEL[reason] ?? reason;
}

export function SwingPaperLogView({ onSelectCode }: Props) {
  const { data, loading, error, sample, reload } = useExternalJson<SwingPaperLog>({
    cacheKey: 'ext:swing-paper-log',
    urls: [...SWING_PAPER_LOG_URLS, `${import.meta.env.BASE_URL}data/paper_log.json`],
    sampleData: EMPTY_LOG,
  });

  const [showPending, setShowPending] = useState(false);

  if (loading && !data) {
    return (
      <div className="inline-state">
        <span className="spinner" />
        <p className="state-sub">読み込み中…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="inline-state">
        <p className="state-title">検証ログを取得できませんでした</p>
        <p className="state-sub">{error}</p>
        <button className="filter-reset" onClick={reload}>再試行</button>
      </div>
    );
  }

  const log = data ?? EMPTY_LOG;

  return (
    <div className="swing-paperlog">
      <div className="swing-status">
        {sample && <span className="chip sample-chip">サンプル</span>}
        <span className="asof-date">更新 {log.updated_at ? relTime(log.updated_at) : '—'}</span>
      </div>

      <h3 className="swing-section-title">保有中(検証用)({log.open.length})</h3>
      {log.open.length === 0 ? (
        <p className="empty">検証用の保有ポジションはありません。</p>
      ) : (
        <ul className="cards">
          {log.open.map((o) => (
            <li
              key={o.id}
              className="card card-tap"
              role="button"
              tabIndex={0}
              onClick={() => onSelectCode(o.code)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(o.code)}
            >
              <div className="card-top">
                <div className="ident">
                  <div className="name">{o.name}</div>
                  <div className="sub">
                    <span className="code">{o.code}</span>
                    <span className="swing-rank-label">エントリー {o.entry_date}</span>
                  </div>
                </div>
                <div className="hero">
                  <div className="hero-val">{priceText(o.entry_price, 'JP')}</div>
                  <div className="hero-cap">建値</div>
                </div>
              </div>
              <div className="stats">
                <div className="stat">
                  <span className="stat-label">利確</span>
                  <span className="stat-val">{priceText(o.target_price, 'JP')}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">損切</span>
                  <span className="stat-val">{priceText(o.stop_price, 'JP')}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">期限</span>
                  <span className="stat-val">{o.deadline_date}</span>
                </div>
              </div>
              {o.pending_exit && <div className="swing-pos-date">手仕舞い待ち{o.exit_reason ? `(${exitReasonText(o.exit_reason)})` : ''}</div>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="swing-section-title">確定ログ({log.closed.length})</h3>
      {log.closed.length === 0 ? (
        <p className="empty">確定した検証トレードはまだありません。</p>
      ) : (
        <ul className="cards">
          {log.closed.map((c) => {
            const pnlCls = c.return_pct >= 0 ? 'chg-up' : 'chg-down';
            return (
              <li
                key={c.id}
                className="card card-tap"
                role="button"
                tabIndex={0}
                onClick={() => onSelectCode(c.code)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(c.code)}
              >
                <div className="card-top">
                  <div className="ident">
                    <div className="name">{c.name}</div>
                    <div className="sub">
                      <span className="code">{c.code}</span>
                      <span className="swing-rank-label">{exitReasonText(c.exit_reason)}</span>
                    </div>
                  </div>
                  <div className="hero">
                    <div className={`hero-val ${pnlCls}`}>
                      {c.return_pct >= 0 ? '+' : ''}
                      {c.return_pct.toFixed(2)}%
                    </div>
                    <div className="hero-cap">損益率</div>
                  </div>
                </div>
                <div className="stats">
                  <div className="stat">
                    <span className="stat-label">建値→手仕舞い</span>
                    <span className="stat-val">
                      {priceText(c.entry_price, 'JP')} → {priceText(c.exit_price, 'JP')}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">保有日数</span>
                    <span className="stat-val">{c.hold_days}日</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="swing-pending-head">
        <h3 className="swing-section-title">待機中({log.pending.length})</h3>
        {log.pending.length > 0 && (
          <button className="swing-exp-btn" onClick={() => setShowPending((v) => !v)} aria-expanded={showPending}>
            {showPending ? '閉じる ▲' : '表示 ▼'}
          </button>
        )}
      </div>
      {log.pending.length === 0 ? (
        <p className="empty">待機中の発注はありません。</p>
      ) : showPending ? (
        <ol className="rows">
          {log.pending.map((p) => (
            <li
              key={p.id}
              className="row row-tap"
              role="button"
              tabIndex={0}
              onClick={() => onSelectCode(p.code)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(p.code)}
            >
              <span className="r-code">{p.code}</span>
              <span className="r-name">{p.name}</span>
              <span className="swing-rank-label">{p.trade_date} 発注</span>
              <span className="r-ratio">{priceText(p.limit_price, 'JP')}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
