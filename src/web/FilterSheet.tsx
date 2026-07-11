import { useSheetBehavior } from './useSheet';
import type { Region } from '../core/types';

interface FilterValues {
  capMin: string;
  capMax: string;
  turnoverMin: string;
}

interface Props {
  filters: FilterValues;
  onChange: (f: FilterValues) => void;
  onClose: () => void;
  region: Region;
}

export function FilterSheet({ filters, onChange, onClose, region }: Props) {
  useSheetBehavior(onClose);
  const set = (key: keyof FilterValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...filters, [key]: e.target.value });

  const reset = () => onChange({ capMin: '', capMax: '', turnoverMin: '' });

  const unit = region === 'US' ? '$M' : '億';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>フィルタ</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <div className="sheet-body">
          <section>
            <h3>時価総額</h3>
            <div className="filter-row">
              <label className="filter-label" htmlFor="f-cap-min">下限({unit})</label>
              <input
                id="f-cap-min"
                className="filter-input"
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="なし"
                value={filters.capMin}
                onChange={set('capMin')}
              />
            </div>
            <div className="filter-row">
              <label className="filter-label" htmlFor="f-cap-max">上限({unit})</label>
              <input
                id="f-cap-max"
                className="filter-input"
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="なし"
                value={filters.capMax}
                onChange={set('capMax')}
              />
            </div>
          </section>

          <section>
            <h3>売買代金</h3>
            <div className="filter-row">
              <label className="filter-label" htmlFor="f-to-min">下限({unit})</label>
              <input
                id="f-to-min"
                className="filter-input"
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="なし"
                value={filters.turnoverMin}
                onChange={set('turnoverMin')}
              />
            </div>
          </section>

          <button className="filter-reset" onClick={reset}>リセット</button>
        </div>
      </div>
    </div>
  );
}
