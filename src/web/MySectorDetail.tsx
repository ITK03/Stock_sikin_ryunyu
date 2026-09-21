import { useEffect, useState } from 'react';
import type { Region, TickerIndexFile } from '../core/types';
import type { MySector, Rate, SectorScore } from '../core/mySector';
import { priceText, signedPct } from './format';
import { changeClass, displayChangePct, resolveStockName } from './mySectorUi';
import { MySectorAddInput } from './MySectorAddInput';

interface Props {
  sector: MySector;
  score: SectorScore;
  market: Region;
  tickerIndex: TickerIndexFile | null;
  /** 新規作成直後は編集モードで開く(名前を付けてもらうため)。 */
  startEditing?: boolean;
  onBack: () => void;
  onSelectCode: (code: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddMember: (sectorId: string, code: string, name: string) => void;
  onRemoveMember: (sectorId: string, code: string) => void;
  onSetRate: (sectorId: string, code: string, rate: Rate) => void;
}

interface RowData {
  code: string;
  rate: Rate;
  price: number | null;
  changePct: number | null;
  contribution: number | null;
}

const RATE_LABEL: Record<Rate, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };

function RateBadge({ rate }: { rate: Rate }) {
  return <span className={`rate-badge rate-${rate}`}>{RATE_LABEL[rate]}</span>;
}

function RateStepper({ value, onChange }: { value: Rate; onChange: (r: Rate) => void }) {
  return (
    <div className="rate-stepper" role="group" aria-label="レート">
      <button
        type="button"
        className="rate-step-btn"
        disabled={value <= 1}
        aria-label="レートを下げる"
        onClick={() => onChange((value - 1) as Rate)}
      >
        −
      </button>
      <span className="rate-step-val">{value}</span>
      <button
        type="button"
        className="rate-step-btn"
        disabled={value >= 5}
        aria-label="レートを上げる"
        onClick={() => onChange((value + 1) as Rate)}
      >
        +
      </button>
    </div>
  );
}

export function MySectorDetail({
  sector,
  score,
  market,
  tickerIndex,
  startEditing,
  onBack,
  onSelectCode,
  onRename,
  onDelete,
  onAddMember,
  onRemoveMember,
  onSetRate,
}: Props) {
  const [editing, setEditing] = useState(!!startEditing);
  const [nameDraft, setNameDraft] = useState(sector.name);

  // セクターを切り替えたら編集下書きをリセットする。
  useEffect(() => {
    setNameDraft(sector.name);
    setEditing(!!startEditing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sector.id]);

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== sector.name) onRename(sector.id, trimmed);
    else setNameDraft(sector.name);
  };

  const toggleEditing = () => {
    if (editing) commitName();
    setEditing((v) => !v);
  };

  const handleDelete = () => {
    if (window.confirm(`「${sector.name}」を削除しますか?この操作は取り消せません。`)) {
      onDelete(sector.id);
    }
  };

  const existingCodes = new Set(sector.members.map((m) => m.code));

  // 表示行: 現在値が取れた銘柄は |寄与度| 降順(scoreMySectorの順)を維持し、
  // 現在値が無い銘柄(編集で削除できるよう見えている必要がある)は末尾に足す。
  const matchedCodes = new Set(score.members.map((m) => m.code));
  const rows: RowData[] = [
    ...score.members.map((m) => ({
      code: m.code,
      rate: m.rate,
      price: m.price,
      changePct: m.changePct,
      contribution: m.contribution,
    })),
    ...sector.members
      .filter((m) => !matchedCodes.has(m.code))
      .map((m) => ({ code: m.code, rate: m.rate, price: null, changePct: null, contribution: null })),
  ];

  const chgVal = displayChangePct(score);

  return (
    <div className="mysec-detail">
      <div className="mysec-detail-head">
        <button type="button" className="mysec-back" onClick={onBack} aria-label="一覧に戻る">
          ‹ 戻る
        </button>
        <div className="mysec-detail-actions">
          <button type="button" className={editing ? 'chip active' : 'chip'} onClick={toggleEditing}>
            {editing ? '完了' : '編集'}
          </button>
          <button type="button" className="mysec-delete-btn" onClick={handleDelete}>
            削除
          </button>
        </div>
      </div>

      {editing ? (
        <input
          className="mysec-name-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          placeholder="セクター名"
          maxLength={40}
          autoFocus
        />
      ) : (
        <h2 className="mysec-detail-name">{sector.name}</h2>
      )}

      <div className="mysec-detail-hero">
        <span className={`mysec-detail-chg ${changeClass(chgVal)}`}>{signedPct(chgVal)}</span>
        <span className="mysec-detail-count">
          {score.total}銘柄
          {score.matched < score.total && (
            <span className="dim"> (現在値あり {score.matched}件)</span>
          )}
        </span>
      </div>

      {editing && (
        <MySectorAddInput
          tickerIndex={tickerIndex}
          existingCodes={existingCodes}
          onAdd={(code, name) => onAddMember(sector.id, code, name)}
        />
      )}

      {rows.length === 0 ? (
        <p className="empty">構成銘柄がありません。{editing ? '上の欄から追加してください。' : '「編集」から追加できます。'}</p>
      ) : (
        <ul className="mysec-member-list">
          {rows.map((row) => {
            const name = resolveStockName(row.code, tickerIndex);
            return (
              <li key={row.code} className="mysec-member-row">
                <RateBadge rate={row.rate} />
                <button
                  type="button"
                  className="mysec-member-id code-tap"
                  onClick={() => onSelectCode(row.code)}
                >
                  <span className="mysec-member-name">{name}</span>
                  <span className="mysec-member-code">{row.code}</span>
                </button>
                <span className="mysec-member-price">
                  {row.price === null ? '—' : priceText(row.price, market)}
                </span>
                <span className={`mysec-member-chg ${changeClass(row.changePct)}`}>{signedPct(row.changePct)}</span>
                <span className={`mysec-member-contrib ${changeClass(row.contribution)}`}>
                  {row.contribution === null ? '—' : signedPct(row.contribution)}
                </span>
                {editing && (
                  <div className="mysec-row-edit">
                    <RateStepper value={row.rate} onChange={(r) => onSetRate(sector.id, row.code, r)} />
                    <button
                      type="button"
                      className="mysec-remove-btn"
                      aria-label={`${name}を削除`}
                      onClick={() => onRemoveMember(sector.id, row.code)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
