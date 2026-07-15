import type { RankRow, Region } from '../core/types';
import { MARKET_LABEL, money, pct, signedPct1 } from './format';
import { WatchStar } from './watchlist';

export type Density = 'card' | 'compact';

interface Props {
  rows: RankRow[];
  showTurnoverRank?: boolean;
  density: Density;
  region: Region;
  metric?: 'ratio' | 'surge';
  onSelectCode?: (code: string) => void;
}

const segClass: Record<string, string> = {
  Prime: 'seg-prime',
  Standard: 'seg-standard',
  Growth: 'seg-growth',
  NYSE: 'seg-nyse',
  NASDAQ: 'seg-nasdaq',
  AMEX: 'seg-amex',
  Other: 'seg-other',
};

const medalClass = (rank: number) => (rank <= 3 ? `medal-${rank}` : '');

const surgeText = (surge: number | undefined) => {
  if (surge === undefined) return '-';
  const pctInc = Math.round((surge - 1) * 100);
  return `${pctInc >= 0 ? '+' : ''}${pctInc.toLocaleString()}%`;
};

const chgClass = (v: number | undefined) =>
  v === undefined ? '' : v > 0 ? 'chg-up' : v < 0 ? 'chg-down' : 'chg-flat';

export function RankingList({ rows, showTurnoverRank, density, region, metric = 'ratio', onSelectCode }: Props) {
  if (rows.length === 0) {
    return <p className="empty">該当する銘柄がありません。</p>;
  }

  const isSurge = metric === 'surge';

  if (density === 'compact') {
    return (
      <ol className="rows">
        {rows.map((r, i) => (
          <li
            key={r.code}
            className={onSelectCode ? 'row row-tap' : 'row'}
            role={onSelectCode ? 'button' : undefined}
            tabIndex={onSelectCode ? 0 : undefined}
            onClick={onSelectCode ? () => onSelectCode(r.code) : undefined}
            onKeyDown={onSelectCode ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(r.code) : undefined}
          >
            <span className={`r-rank ${medalClass(i + 1)}`}>{i + 1}</span>
            <WatchStar code={r.code} />
            <span className="r-code">{r.code}</span>
            <span className="r-name">{r.name}</span>
            <span className={`r-chg ${chgClass(r.changePct)}`}>{signedPct1(r.changePct)}</span>
            <span className="r-sub">{money(r.turnover, region)}</span>
            <span className="r-ratio">{isSurge ? surgeText(r.surge) : pct(r.ratio)}</span>
          </li>
        ))}
      </ol>
    );
  }

  const maxRatio = Math.max(...rows.map((r) => r.ratio), 1e-9);
  const maxSurge = Math.max(...rows.map((r) => r.surge ?? 0), 1e-9);

  return (
    <ul className="cards">
      {rows.map((r, i) => {
        const strength = isSurge
          ? Math.max(0.04, Math.min(1, (r.surge ?? 0) / maxSurge))
          : Math.max(0.04, Math.min(1, r.ratio / maxRatio));
        return (
          <li
            key={r.code}
            className={onSelectCode ? 'card card-tap' : 'card'}
            role={onSelectCode ? 'button' : undefined}
            tabIndex={onSelectCode ? 0 : undefined}
            onClick={onSelectCode ? () => onSelectCode(r.code) : undefined}
            onKeyDown={onSelectCode ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(r.code) : undefined}
          >
            <div className="card-top">
              <span className={`rankbadge ${medalClass(i + 1)}`}>{i + 1}</span>
              <div className="ident">
                <div className="name">{r.name}</div>
                <div className="sub">
                  <WatchStar code={r.code} />
                  <span className="code">{r.code}</span>
                  <span className={`seg ${segClass[r.market] ?? 'seg-other'}`}>
                    {MARKET_LABEL[r.market]}
                  </span>
                  <span className={`chg-inline ${chgClass(r.changePct)}`}>{signedPct1(r.changePct)}</span>
                </div>
              </div>
              <div className="hero">
                <div className="hero-val">{isSurge ? surgeText(r.surge) : pct(r.ratio)}</div>
                <div className="hero-cap">
                  {isSurge ? '売買代金 増加率(平常比)' : '代金 / 時価総額'}
                </div>
              </div>
            </div>

            <div className="strength" aria-hidden>
              <span className="strength-fill" style={{ width: `${strength * 100}%` }} />
            </div>

            <div className="stats">
              {isSurge ? (
                <>
                  <div className="stat">
                    <span className="stat-label">直近代金</span>
                    <span className="stat-val">{money(r.turnover, region)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">平常代金</span>
                    <span className="stat-val">{money(r.baseline ?? 0, region)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">時価総額</span>
                    <span className="stat-val">
                      {r.marketCap > 0 ? money(r.marketCap, region) : '—'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="stat">
                    <span className="stat-label">売買代金</span>
                    <span className="stat-val">{money(r.turnover, region)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">時価総額</span>
                    <span className="stat-val">{money(r.marketCap, region)}</span>
                  </div>
                  {showTurnoverRank ? (
                    <div className="stat">
                      <span className="stat-label">全市場 代金順位</span>
                      <span className="stat-val accent">{r.turnoverRank ?? '-'}<i>位</i></span>
                    </div>
                  ) : (
                    <div className="stat">
                      <span className="stat-label">データ被覆</span>
                      <span className="stat-val">{Math.round(r.coverage * 100)}<i>%</i></span>
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
