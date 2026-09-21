import { useMemo } from 'react';
import type { MySector, SectorScore } from '../core/mySector';
import { signedPct } from './format';
import { changeClass, displayChangePct } from './mySectorUi';

interface Props {
  sectors: MySector[];
  scores: Map<string, SectorScore>;
  onOpenSector: (id: string) => void;
  onCreateSector: () => void;
  onOpenIO: () => void;
}

interface Ranked {
  sector: MySector;
  score: SectorScore;
  chg: number | null;
}

/** changePct降順(データ無しは末尾)。既存セクタータブの sortSectors と同じ規則。 */
function rankSectors(sectors: MySector[], scores: Map<string, SectorScore>): Ranked[] {
  const ranked = sectors.map((sector) => {
    const score = scores.get(sector.id) ?? { changePct: 0, members: [], matched: 0, total: sector.members.length };
    return { sector, score, chg: displayChangePct(score) };
  });
  ranked.sort((a, b) => {
    if (a.chg === null && b.chg === null) return 0;
    if (a.chg === null) return 1;
    if (b.chg === null) return -1;
    return b.chg - a.chg;
  });
  return ranked;
}

function MoverItem({ r }: { r: Ranked }) {
  return (
    <li className="mysec-mover-item">
      <span className="mysec-mover-name">{r.sector.name}</span>
      <span className={`mysec-mover-chg ${changeClass(r.chg)}`}>{signedPct(r.chg)}</span>
    </li>
  );
}

export function MySectorList({ sectors, scores, onOpenSector, onCreateSector, onOpenIO }: Props) {
  const ranked = useMemo(() => rankSectors(sectors, scores), [sectors, scores]);

  // 上昇/下落サマリ: 実際に上昇/下落しているセクターのみを対象にする
  // (件数が少ない場合に「上昇」欄へ下落中のセクターが紛れ込まないように)。
  // ranked は changePct 降順なので、risers/fallers も降順のまま保たれる。
  const withData = ranked.filter((r) => r.chg !== null);
  const risers = withData.filter((r) => (r.chg as number) > 0);
  const fallers = withData.filter((r) => (r.chg as number) < 0);
  const best3 = risers.slice(0, 3);
  const worst3 = fallers.slice(-3).reverse();

  const maxAbs = Math.max(0.01, ...withData.map((r) => Math.abs(r.chg as number)));

  return (
    <div className="mysec-list">
      <div className="mysec-toolbar">
        <button type="button" className="chip mysec-new-btn" onClick={onCreateSector}>
          ＋ 新規セクター
        </button>
        <button type="button" className="chip" onClick={onOpenIO}>
          入出力
        </button>
      </div>

      {sectors.length === 0 ? (
        <div className="inline-state">
          <p className="state-title">マイセクターはまだありません</p>
          <p className="state-sub">好きな銘柄をレート付きで束ねて、独自の騰落率を追えます。</p>
          <button className="filter-reset" onClick={onCreateSector}>セクターを作成</button>
        </div>
      ) : (
        <>
          {(best3.length > 0 || worst3.length > 0) && (
            <div className="mysec-summary">
              <div className="mysec-summary-col">
                <span className="mysec-summary-head chg-up">上昇</span>
                <ul className="mysec-mover-list">
                  {best3.length === 0 ? (
                    <li className="mysec-mover-empty dim">該当なし</li>
                  ) : (
                    best3.map((r) => <MoverItem key={r.sector.id} r={r} />)
                  )}
                </ul>
              </div>
              <div className="mysec-summary-col">
                <span className="mysec-summary-head chg-down">下落</span>
                <ul className="mysec-mover-list">
                  {worst3.length === 0 ? (
                    <li className="mysec-mover-empty dim">該当なし</li>
                  ) : (
                    worst3.map((r) => <MoverItem key={r.sector.id} r={r} />)
                  )}
                </ul>
              </div>
            </div>
          )}

          <ul className="sector-list mysec-rank-list">
            {ranked.map((r) => {
              const barPct = r.chg === null ? 0 : (Math.abs(r.chg) / maxAbs) * 100;
              return (
                <li key={r.sector.id} className="sector-card mysec-row-card">
                  <button type="button" className="sector-row mysec-rank-row" onClick={() => onOpenSector(r.sector.id)}>
                    <div className="sector-ident">
                      <span className="sector-name">{r.sector.name}</span>
                      <span className="sector-count">{r.score.matched}/{r.score.total}銘柄</span>
                    </div>
                    <span className={`sector-chg ${changeClass(r.chg)}`}>{signedPct(r.chg)}</span>
                  </button>
                  <div className="mysec-bar-track">
                    <div className={`mysec-bar-fill ${changeClass(r.chg)}`} style={{ width: `${barPct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
