import type { RankRow } from '../core/types';
import { MARKET_LABEL, pct, yen } from './format';

interface Props {
  rows: RankRow[];
  /** ③のとき全市場の売買代金順位の列を表示。 */
  showTurnoverRank?: boolean;
}

export function RankingTable({ rows, showTurnoverRank }: Props) {
  if (rows.length === 0) {
    return <p className="empty">該当する銘柄がありません。</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>銘柄</th>
            <th className="num">代金/時価総額</th>
            <th className="num">売買代金</th>
            <th className="num">時価総額</th>
            {showTurnoverRank && <th className="num">代金順位</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td className="num rank">{r.rank}</td>
              <td>
                <div className="name">{r.name}</div>
                <div className="sub">
                  <span className="code">{r.code}</span>
                  <span className={`seg seg-${r.market.toLowerCase()}`}>
                    {MARKET_LABEL[r.market]}
                  </span>
                </div>
              </td>
              <td className="num ratio">{pct(r.ratio)}</td>
              <td className="num">{yen(r.turnover)}</td>
              <td className="num">{yen(r.marketCap)}</td>
              {showTurnoverRank && <td className="num">{r.turnoverRank ?? '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
