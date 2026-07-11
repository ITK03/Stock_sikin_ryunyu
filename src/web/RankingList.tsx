import type { RankRow, Region } from '../core/types';
import { MARKET_LABEL, money, pct } from './format';

export type Density = 'card' | 'compact';

interface Props {
  rows: RankRow[];
  /** ③のとき全市場の売買代金順位を表示。 */
  showTurnoverRank?: boolean;
  density: Density;
  region: Region;
  /** ④のとき 'surge'(急増倍率表示)。既定は 'ratio'(比率%表示)。 */
  metric?: 'ratio' | 'surge';
  /** 指定時、銘柄コードをタップ可能にして銘柄詳細を開く。 */
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

/** 急増を増加率(SBIと同形式)「+5,317%」のように整形。未定義時は「-」。 */
const surgeText = (surge: number | undefined) => {
  if (surge === undefined) return '-';
  const pctInc = Math.round((surge - 1) * 100);
  return `${pctInc >= 0 ? '+' : ''}${pctInc.toLocaleString()}%`;
};

export function RankingList({ rows, showTurnoverRank, density, region, metric = 'ratio', onSelectCode }: Props) {
  if (rows.length === 0) {
    return <p className="empty">該当する銘柄がありません。</p>;
  }

  const isSurge = metric === 'surge';

  const CodeTag = ({ code, className }: { code: string; className: string }) =>
    onSelectCode ? (
      <button type="button" className={`${className} code-tap`} onClick={() => onSelectCode(code)}>
        {code}
      </button>
    ) : (
      <span className={className}>{code}</span>
    );

  if (density === 'compact') {
    return (
      <ol className="rows">
        {rows.map((r, i) => (
          <li key={r.code} className="row">
            <span className={`r-rank ${medalClass(i + 1)}`}>{i + 1}</span>
            <CodeTag code={r.code} className="r-code" />
            <span className="r-name">{r.name}</span>
            <span className="r-ratio">{isSurge ? surgeText(r.surge) : pct(r.ratio)}</span>
            <span className="r-sub">
              {isSurge
                ? money(r.turnover, region)
                : showTurnoverRank
                ? `代金#${r.turnoverRank ?? '-'}`
                : money(r.turnover, region)}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  // 強度バーは表示中リストの最大値(比率 or 急増倍率)を基準にした相対値。
  const maxRatio = Math.max(...rows.map((r) => r.ratio), 1e-9);
  const maxSurge = Math.max(...rows.map((r) => r.surge ?? 0), 1e-9);

  return (
    <ul className="cards">
      {rows.map((r, i) => {
        const strength = isSurge
          ? Math.max(0.04, Math.min(1, (r.surge ?? 0) / maxSurge))
          : Math.max(0.04, Math.min(1, r.ratio / maxRatio));
        return (
          <li key={r.code} className="card">
            <div className="card-top">
              <span className={`rankbadge ${medalClass(i + 1)}`}>{i + 1}</span>
              <div className="ident">
                <div className="name">{r.name}</div>
                <div className="sub">
                  <CodeTag code={r.code} className="code" />
                  <span className={`seg ${segClass[r.market] ?? 'seg-other'}`}>
                    {MARKET_LABEL[r.market]}
                  </span>
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
