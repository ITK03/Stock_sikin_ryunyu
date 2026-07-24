import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { SwingExitRules, SwingSignalsFeed } from '../core/types';
import {
  makePositionId,
  normalizePositionCode,
  parsePositions,
  positionPnlAmount,
  positionPnlPct,
  serializePositions,
  type SwingPosition,
} from '../core/positions';
import { adviseManualPosition } from '../core/swingAdvice';
import { SwingAdviceBadge } from './SwingAdviceBadge';
import { priceText } from './format';

// 保有ポジション(ユーザー手動管理)。localStorage に自己完結で保存する。
// 検証ログ(自動ペーパートレードの記録, SwingPaperLog.tsx)とは別物 —
// こちらはユーザー自身の実際の保有を自己申告で登録・管理するための機能。

const STORAGE_KEY = 'jp_swing_positions_v1';

// localStorage が使えない環境(プライベートモード等)向けのメモリfallback。
// モジュールスコープに置くことでタブの再マウントをまたいでも維持する。
let memoryFallback: string | null = null;

function loadRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryFallback;
  }
}

function saveRaw(raw: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    memoryFallback = raw;
  }
}

/** 買い候補タップ時にフォームへ前埋めする内容(SwingTab から受け取る)。 */
export interface PositionPrefill {
  strategyId: string;
  code: string;
  name: string;
  /** 条件の株価(推奨指値)。取得単価の初期値に入れる。 */
  price: number;
}

interface Props {
  /** 戦略選択肢・現在値/銘柄名の補完に使う。未取得(null)でもフォーム自体は使える。 */
  feed: SwingSignalsFeed | null;
  onSelectCode: (code: string) => void;
  /** 買い候補タップ由来の前埋め。適用後は onPrefillConsumed で親がクリアする。 */
  prefill?: PositionPrefill | null;
  onPrefillConsumed?: () => void;
}

interface FormState {
  strategyId: string;
  code: string;
  fillDate: string;
  fillPrice: string;
  shares: string;
}

const EMPTY_FORM: FormState = { strategyId: '', code: '', fillDate: '', fillPrice: '', shares: '100' };

/** ローカルタイムの今日(YYYY-MM-DD)。toISOString はUTCで日付がずれるため自前で組む。 */
function todayLocalISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function SwingPositions({ feed, onSelectCode, prefill, onPrefillConsumed }: Props) {
  const [positions, setPositions] = useState<SwingPosition[]>(() => parsePositions(loadRaw()));
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const persist = useCallback((next: SwingPosition[]) => {
    setPositions(next);
    saveRaw(serializePositions(next));
  }, []);

  const strategies = feed?.strategies ?? [];
  const asOfDate = feed?.data_date ?? null;

  // 買い候補タップ由来の前埋め: 銘柄・戦略・条件株価・今日の日付をフォームに入れ、
  // フォームまでスクロールする。適用後は親にクリアを通知する(再適用の暴発を防ぐ)。
  useEffect(() => {
    if (!prefill) return;
    setForm({
      strategyId: prefill.strategyId,
      code: prefill.code,
      fillDate: todayLocalISO(),
      fillPrice: prefill.price > 0 ? String(prefill.price) : '',
      shares: '100',
    });
    setFormError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // code → { close, name, exit }。universe_status を優先し、買い候補の値でも補う。
  const priceMap = useMemo(() => {
    const m = new Map<string, { close: number; name: string; exit: boolean }>();
    for (const s of strategies) {
      for (const u of s.universe_status) {
        if (!m.has(u.code)) m.set(u.code, { close: u.close, name: u.name, exit: u.exit });
      }
      for (const c of s.buy_candidates) {
        if (!m.has(c.code)) m.set(c.code, { close: c.close, name: c.name, exit: false });
      }
    }
    return m;
  }, [strategies]);

  // strategyId → 手仕舞いルール(利確/損切/最大保有)。助言判定に使う。
  const rulesByStrat = useMemo(() => {
    const m = new Map<string, SwingExitRules | undefined>();
    for (const s of strategies) m.set(s.id, s.exit_rules);
    return m;
  }, [strategies]);

  const strategyName = useCallback(
    (id: string): string => {
      if (!id) return '';
      const s = strategies.find((x) => x.id === id);
      return s ? s.display_name.replace(/（.*$/, '') : id;
    },
    [strategies],
  );

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const code = normalizePositionCode(form.code);
    if (!code) {
      setFormError('証券コードを入力してください。');
      return;
    }
    if (!form.fillDate) {
      setFormError('取得日を入力してください。');
      return;
    }
    const fillPrice = Number(form.fillPrice);
    if (!(fillPrice > 0)) {
      setFormError('取得単価は0より大きい数値を入力してください。');
      return;
    }
    let shares = Number(form.shares);
    if (!(shares > 0)) shares = 100;

    const info = priceMap.get(code);
    const pos: SwingPosition = {
      id: makePositionId(),
      strategyId: form.strategyId,
      code,
      name: info?.name ?? code,
      fillDate: form.fillDate,
      fillPrice,
      shares,
    };
    persist([...positions, pos]);
    setForm((prev) => ({ ...EMPTY_FORM, strategyId: prev.strategyId }));
  };

  const handleRemove = (id: string) => {
    persist(positions.filter((p) => p.id !== id));
  };

  const totalPnl = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const p of positions) {
      const amt = positionPnlAmount(p, priceMap.get(p.code)?.close ?? null);
      if (amt !== null) {
        sum += amt;
        any = true;
      }
    }
    return any ? sum : null;
  }, [positions, priceMap]);

  return (
    <div className="swing-positions">
      <form ref={formRef} className="card swing-pos-form" onSubmit={handleAdd}>
        <div className="swing-pos-form-title">ポジションを追加</div>
        <div className="swing-pos-form-grid">
          <label className="swing-pos-field">
            <span>戦略</span>
            <select
              value={form.strategyId}
              onChange={(e) => setForm((prev) => ({ ...prev, strategyId: e.target.value }))}
            >
              <option value="">(未選択・任意)</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name.replace(/（.*$/, '')}
                </option>
              ))}
            </select>
          </label>
          <label className="swing-pos-field">
            <span>証券コード</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="例: 7203"
              value={form.code}
              onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value }))}
            />
          </label>
          <label className="swing-pos-field">
            <span>取得日</span>
            <input
              type="date"
              value={form.fillDate}
              onChange={(e) => setForm((prev) => ({ ...prev, fillDate: e.target.value }))}
            />
          </label>
          <label className="swing-pos-field">
            <span>取得単価(円)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              placeholder="例: 3000"
              value={form.fillPrice}
              onChange={(e) => setForm((prev) => ({ ...prev, fillPrice: e.target.value }))}
            />
          </label>
          <label className="swing-pos-field">
            <span>株数</span>
            <input
              type="number"
              min="1"
              step="1"
              value={form.shares}
              onChange={(e) => setForm((prev) => ({ ...prev, shares: e.target.value }))}
            />
          </label>
        </div>
        {formError && <p className="swing-pos-form-error">{formError}</p>}
        <button type="submit" className="swing-pos-add-btn">追加する</button>
      </form>

      <div className="swing-pos-summary">
        <span className="swing-section-title">保有ポジション({positions.length})</span>
        {totalPnl !== null && (
          <span className={`swing-pos-total ${totalPnl >= 0 ? 'chg-up' : 'chg-down'}`}>
            合計評価損益 {totalPnl >= 0 ? '+' : ''}
            {Math.round(totalPnl).toLocaleString('ja-JP')}円
          </span>
        )}
      </div>

      {positions.length === 0 ? (
        <p className="empty">保有ポジションはありません。上のフォームから登録してください。</p>
      ) : (
        <ul className="cards">
          {positions.map((p) => {
            const info = priceMap.get(p.code);
            const currentPrice = info?.close ?? null;
            const pnlAmount = positionPnlAmount(p, currentPrice);
            const pnlPct = positionPnlPct(p, currentPrice);
            const pnlCls = pnlAmount === null ? '' : pnlAmount >= 0 ? 'chg-up' : 'chg-down';
            const advice = adviseManualPosition({
              fillPrice: p.fillPrice,
              fillDate: p.fillDate,
              currentPrice,
              rules: p.strategyId ? rulesByStrat.get(p.strategyId) : null,
              exitSignal: info?.exit ?? false,
              asOfDate,
            });
            return (
              <li key={p.id} className="card card-tap swing-pos-card">
                <button
                  type="button"
                  className="swing-pos-del"
                  aria-label="削除"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(p.id);
                  }}
                >
                  ×
                </button>
                <div
                  className="card-top"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectCode(p.code)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectCode(p.code)}
                >
                  <div className="ident">
                    <div className="name">{p.name}</div>
                    <div className="sub">
                      <span className="code">{p.code}</span>
                      {p.strategyId && <span className="swing-rank-label">{strategyName(p.strategyId)}</span>}
                    </div>
                  </div>
                  <div className="hero">
                    <div className={`hero-val ${pnlCls}`}>
                      {pnlAmount === null
                        ? '—'
                        : `${pnlAmount >= 0 ? '+' : ''}${Math.round(pnlAmount).toLocaleString('ja-JP')}円`}
                    </div>
                    <div className={`hero-cap ${pnlCls}`}>
                      {pnlPct === null ? '評価損益' : `${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%`}
                    </div>
                  </div>
                </div>
                <div className="stats">
                  <div className="stat">
                    <span className="stat-label">取得単価</span>
                    <span className="stat-val">{priceText(p.fillPrice, 'JP')}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">株数</span>
                    <span className="stat-val">{p.shares.toLocaleString('ja-JP')}株</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">現在値</span>
                    <span className="stat-val">{currentPrice === null ? '—' : priceText(currentPrice, 'JP')}</span>
                  </div>
                </div>
                <div className="swing-pos-foot">
                  <span className="swing-pos-date">取得日 {p.fillDate}</span>
                  <SwingAdviceBadge advice={advice} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
