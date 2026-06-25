import type { RankRow } from '../core/types';
import { MARKET_LABEL, pct, yen } from './format';

export type Density = 'card' | 'compact';

interface Props {
  rows: RankRow[];
  /** ③のとき全市場の売買代金順位を表示。 */
  showTurnoverRank?: boolean;
  density: Density;
}

const segClass: Record<string, string> = {
  Prime: 'seg-prime',
  Standard: 'seg-standard',
  Growth: 'seg-growth',
  Other: 'seg-other',
};

const medalClass = (rank: number) => (rank <= 3 ? `medal-${rank}` : '');

export function RankingList({ rows, showTurnoverRank, density }: Props) {
  if (rows.length === 0) {
    return <p className="empty">該当する銘柄がありません。</p>;
  }

  if (density === 'compact') {
    return (
      <ol className="rows">
        {rows.map((r) => (
          <li key={r.code} className="row">
            <span className={`r-rank ${medalClass(r.rank)}`}>{r.rank}</span>
            <span className="r-ident">
              <span className="r-name">{r.name}</span>
              <span className="r-code">{r.code}</span>
            </span>
            <span className="r-ratio">{pct(r.ratio)}</span>
            <span className="r-sub">
              {showTurnoverRank ? `代金#${r.turnoverRank ?? '-'}` : `${yen(r.turnover)}円`}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  // 強度バーは表示中リストの最大比率を基準にした相対値。
  const maxRatio = Math.max(...rows.map((r) => r.ratio), 1e-9);

  return (
    <ul className="cards">
      {rows.map((r) => {
        const strength = Math.max(0.04, Math.min(1, r.ratio / maxRatio));
        return (
          <li key={r.code} className="card">
            <div className="card-top">
              <span className={`rankbadge ${medalClass(r.rank)}`}>{r.rank}</span>
              <div className="ident">
                <div className="name">{r.name}</div>
                <div className="sub">
                  <span className="code">{r.code}</span>
                  <span className={`seg ${segClass[r.market] ?? 'seg-other'}`}>
                    {MARKET_LABEL[r.market]}
                  </span>
                </div>
              </div>
              <div className="hero">
                <div className="hero-val">{pct(r.ratio)}</div>
                <div className="hero-cap">代金 / 時価総額</div>
              </div>
            </div>

            <div className="strength" aria-hidden>
              <span className="strength-fill" style={{ width: `${strength * 100}%` }} />
            </div>

            <div className="stats">
              <div className="stat">
                <span className="stat-label">売買代金</span>
                <span className="stat-val">{yen(r.turnover)}<i>円</i></span>
              </div>
              <div className="stat">
                <span className="stat-label">時価総額</span>
                <span className="stat-val">{yen(r.marketCap)}<i>円</i></span>
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
            </div>
          </li>
        );
      })}
    </ul>
  );
}
