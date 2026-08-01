import type { Topic } from '../core/disclosures';
import { useSheetBehavior } from './useSheet';

// 開示の詳細フィルタ。フィルタボタンから開く。
//
// 材料(特大/好材料/悪材料)だけはこの外に置いている。開示を見ながら何度も
// 切り替えるものなので、そのたびにウィンドウを開くのは煩わしいため。
// 種類・重要度・その他はここへ入れる。種類はチップ行では12個に打ち切って
// いるが、ここでは全カテゴリを出す。

export interface FilterState {
  minScore: number;
  topics: Set<string>;
  urgentOnly: boolean;
  watchOnly: boolean;
}

interface Props {
  state: FilterState;
  /** 種類の候補(全件。チップ行の12個上限はここでは適用しない)。 */
  topics: Topic[];
  thresholds: { key: number; label: string }[];
  onChange: (next: FilterState) => void;
  onClose: () => void;
}

export function DisclosureFilterSheet({ state, topics, thresholds, onChange, onClose }: Props) {
  useSheetBehavior(onClose);

  const toggleTopic = (key: string) => {
    const next = new Set(state.topics);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...state, topics: next });
  };

  const activeCount =
    state.topics.size + (state.urgentOnly ? 1 : 0) + (state.watchOnly ? 1 : 0) +
    (state.minScore > 0 ? 1 : 0);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet filter-sheet" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="開示のフィルタ">
        <div className="sheet-head">
          <h2>フィルタ</h2>
          {activeCount > 0 && (
            <button
              className="filter-clear"
              onClick={() => onChange({ minScore: 0, topics: new Set(), urgentOnly: false, watchOnly: false })}
            >
              条件をクリア
            </button>
          )}
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <div className="sheet-body">
          <section className="filter-group">
            <h3>重要度</h3>
            <div className="filter-chips">
              {thresholds.map((t) => (
                <button
                  key={t.key}
                  className={t.key === state.minScore ? 'chip active' : 'chip'}
                  onClick={() => onChange({ ...state, minScore: t.key })}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="filter-group">
            <h3>
              種類
              {state.topics.size > 0 && (
                <button className="filter-sub-clear"
                  onClick={() => onChange({ ...state, topics: new Set() })}>
                  解除
                </button>
              )}
            </h3>
            {topics.length === 0 ? (
              <p className="dim">この日の開示に種類の情報がありません。</p>
            ) : (
              <div className="filter-chips">
                {topics.map((t) => (
                  <button
                    key={t.key}
                    className={state.topics.has(t.key) ? 'chip topic active' : 'chip topic'}
                    onClick={() => toggleTopic(t.key)}
                    aria-pressed={state.topics.has(t.key)}
                  >
                    {t.label}
                    <span className="chip-count">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="filter-note">複数選べます（いずれかに当たる開示を表示）</p>
          </section>

          <section className="filter-group">
            <h3>その他</h3>
            <div className="filter-chips">
              <button
                className={state.urgentOnly ? 'chip urgent-chip active' : 'chip urgent-chip'}
                onClick={() => onChange({ ...state, urgentOnly: !state.urgentOnly })}
                aria-pressed={state.urgentOnly}
              >
                速報のみ
              </button>
              <button
                className={state.watchOnly ? 'chip watch active' : 'chip watch'}
                onClick={() => onChange({ ...state, watchOnly: !state.watchOnly })}
                aria-pressed={state.watchOnly}
              >
                ★ウォッチ銘柄のみ
              </button>
            </div>
          </section>
        </div>

        <div className="filter-foot">
          <button className="filter-apply" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
