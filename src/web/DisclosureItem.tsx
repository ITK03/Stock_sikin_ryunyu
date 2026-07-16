import type { Disclosure } from '../core/types';
import { isJpCode } from '../core/codes';
import { materialClass } from '../core/disclosures';
import { jstDate, jstTime } from './format';

interface Props {
  d: Disclosure;
  onSelectCode?: (code: string) => void;
  /** 銘柄詳細内での表示など、日付を省いて時刻のみにしたい場合。既定は日付+時刻。 */
  showDate?: boolean;
  /** ウォッチ銘柄の開示として強調表示する。 */
  watched?: boolean;
}

const DIRECTION_CLASS: Record<Disclosure['direction'], string> = {
  positive: 'dir-positive',
  negative: 'dir-negative',
  neutral: 'dir-neutral',
  unknown: 'dir-unknown',
};

const DIRECTION_LABEL: Record<Disclosure['direction'], string> = {
  positive: '好材料',
  negative: '悪材料',
  neutral: '中立',
  unknown: '判定不能',
};

const IMPACT_CLASS: Record<Disclosure['impact'], string> = {
  high: 'score-high',
  medium: 'score-medium',
  low: 'score-low',
};

/** 開示 1件の表示行。DisclosuresTab / StockDetail 双方から共有する。 */
export function DisclosureItem({ d, onSelectCode, showDate = true, watched = false }: Props) {
  // 実フィードには "Copy" のような証券コードでないゴミ値が混ざることがある。
  // 契約上コードは4-5桁の数字なので、日本株コードとして妥当な場合のみ表示・タップ可能にする。
  const hasCode = isJpCode(d.code);
  return (
    <li className={watched ? 'disc-item watched' : 'disc-item'}>
      <div className="disc-top">
        {watched && <span className="disc-watch-mark" aria-label="ウォッチ銘柄">★</span>}
        <span className="disc-time">
          {showDate && jstDate(d.time) ? `${jstDate(d.time)} ` : ''}
          {jstTime(d.time) || '—'}
        </span>
        {hasCode ? (
          onSelectCode ? (
            <button type="button" className="disc-code code-tap" onClick={() => onSelectCode(d.code)}>
              {d.code}
            </button>
          ) : (
            <span className="disc-code">{d.code}</span>
          )
        ) : (
          <span className="disc-code disc-code-empty">—</span>
        )}
        <span className="disc-company">{d.company || '会社名不明'}</span>
        <span className={`score-badge ${IMPACT_CLASS[d.impact]}`}>{d.score}</span>
      </div>
      <p className="disc-title">{d.title}</p>
      <div className="disc-bottom">
        {(() => {
          const mc = materialClass(d);
          if (mc === 'mega-positive')
            return <span className="dir-badge dir-mega-positive">🔥特大好材料</span>;
          if (mc === 'mega-negative')
            return <span className="dir-badge dir-mega-negative">⚠特大悪材料</span>;
          return <span className={`dir-badge ${DIRECTION_CLASS[d.direction]}`}>{DIRECTION_LABEL[d.direction]}</span>;
        })()}
        <span className="disc-category">{d.category}</span>
        {d.urgent && <span className="urgent-badge">速報</span>}
        {d.pdf_url && (
          <a className="disc-link" href={d.pdf_url} target="_blank" rel="noreferrer">
            PDF
          </a>
        )}
      </div>
      {d.summary && <p className="disc-summary">{d.summary}</p>}
    </li>
  );
}
