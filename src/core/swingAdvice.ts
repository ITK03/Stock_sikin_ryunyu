// スイングの「今後どうしたらいいか」(保有継続 / 利確 / 損切り / 期限 / 手仕舞い)を
// 判定する純ロジック。保有ポジション(ユーザー手動管理)と検証ログの保有中(検証用)の
// 両方で使う。判定の優先順位はスクリーナー(swing/screener/paper_log.py)と同一に揃える:
//   損切り(stop_loss) > 利確(take_profit) > 期限(max_hold) > シグナル手仕舞い(exit_signal)
// これにより「アプリの助言」と「検証で実際に執行される手仕舞い」が食い違わない。

import type { SwingExitRules, SwingPaperClosed, SwingPaperOpen } from './types';

export type SwingAdviceKind =
  | 'hold' // 保有継続
  | 'take_profit' // 利確
  | 'stop_loss' // 損切り
  | 'deadline' // 期限(最大保有到達)
  | 'signal_exit' // シグナル手仕舞い
  | 'unknown'; // 現在値待ちなど判定不能

export interface SwingAdvice {
  kind: SwingAdviceKind;
  /** 見出しラベル(保有継続 / 利確 / 損切り / 期限 / 手仕舞い / —)。 */
  label: string;
  /** 色調(up=緑・down=赤・warn=橙・neutral=灰)。 */
  tone: 'up' | 'down' | 'warn' | 'neutral';
  /** 補足(利確まで+1.2% など)。 */
  detail?: string;
}

const HOLD_LABEL = '保有継続';

/** 符号つき百分率(比率入力, 0.012 → "+1.2%")。 */
function pctStr(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

/**
 * 平日(月〜金)ベースの概算保有営業日数。祝日は考慮しない近似(フロントに
 * 祝日カレンダーを持たせないため)。max_hold 到達の目安表示にのみ使う。
 */
export function approxBusinessDaysHeld(fromISO: string, toISO: string): number | null {
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  let count = 0;
  const d = new Date(from);
  while (d < to) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

/**
 * 保有ポジション(ユーザー手動)の助言。戦略の exit_rules(利確/損切/最大保有)と
 * 現在値・当日データ日から「今後どうするか」を返す。exit_rules や現在値が
 * 無い場合はできる範囲で(シグナル手仕舞い or 保有継続)判定する。
 */
export function adviseManualPosition(args: {
  fillPrice: number;
  fillDate: string;
  currentPrice: number | null;
  rules?: SwingExitRules | null;
  /** universe_status の exit フラグ(当日終値ベースのシグナル手仕舞い)。 */
  exitSignal?: boolean;
  /** 判定基準日(signals.json の data_date)。max_hold 判定に使う。 */
  asOfDate?: string | null;
}): SwingAdvice {
  const { fillPrice, fillDate, currentPrice, rules, exitSignal, asOfDate } = args;

  if (currentPrice === null || !Number.isFinite(currentPrice) || !(fillPrice > 0)) {
    return { kind: 'unknown', label: '—', tone: 'neutral', detail: '現在値待ち' };
  }
  const ret = currentPrice / fillPrice - 1;
  const sl = rules?.stop_loss ?? null;
  const tp = rules?.take_profit ?? null;
  const maxHold = rules?.max_hold ?? null;
  const held = fillDate && asOfDate ? approxBusinessDaysHeld(fillDate, asOfDate) : null;

  // スクリーナーと同一の優先順位で判定する。
  if (sl != null && ret <= -sl) {
    return {
      kind: 'stop_loss',
      label: '損切り',
      tone: 'down',
      detail: `災害ストップ-${(sl * 100).toFixed(0)}%到達(${pctStr(ret)})`,
    };
  }
  if (tp != null && ret >= tp) {
    return {
      kind: 'take_profit',
      label: '利確',
      tone: 'up',
      detail: `+${(tp * 100).toFixed(0)}%到達(${pctStr(ret)})・翌寄りで利確`,
    };
  }
  if (maxHold != null && held != null && held >= maxHold) {
    return {
      kind: 'deadline',
      label: '期限',
      tone: 'warn',
      detail: `最大保有${maxHold}営業日到達・手仕舞い検討`,
    };
  }
  if (exitSignal) {
    return { kind: 'signal_exit', label: '手仕舞い', tone: 'warn', detail: 'シグナル手仕舞い(翌寄り)' };
  }

  // 保有継続: 利確/損切りまでの距離を補足に出す(規律の維持を助ける)。
  const parts: string[] = [];
  if (tp != null) parts.push(`利確まで${pctStr(tp - ret)}`);
  if (sl != null) parts.push(`損切りまで${pctStr(-sl - ret)}`);
  if (maxHold != null && held != null) parts.push(`保有${held}/${maxHold}営業日`);
  if (parts.length === 0) parts.push(`含み${pctStr(ret)}`);
  return { kind: 'hold', label: HOLD_LABEL, tone: 'neutral', detail: parts.join(' / ') };
}

/**
 * 検証ログの保有中(検証用)ポジションの助言。スクリーナーが既に手仕舞いを
 * 決定済み(pending_exit)ならその理由を、そうでなければ現在値と建値/損切/利確/
 * 期限から「今後どうするか」を返す。
 */
export function advisePaperOpen(
  o: SwingPaperOpen,
  currentPrice: number | null,
  asOfDate?: string | null,
): SwingAdvice {
  if (o.pending_exit) {
    const byReason: Record<string, SwingAdvice> = {
      stop_loss: { kind: 'stop_loss', label: '損切り', tone: 'down', detail: '翌寄りで手仕舞い予定' },
      take_profit: { kind: 'take_profit', label: '利確', tone: 'up', detail: '翌寄りで手仕舞い予定' },
      max_hold: { kind: 'deadline', label: '期限', tone: 'warn', detail: '翌寄りで手仕舞い予定' },
      exit_signal: { kind: 'signal_exit', label: '手仕舞い', tone: 'warn', detail: '翌寄りで手仕舞い予定' },
    };
    return (
      byReason[o.exit_reason ?? ''] ?? {
        kind: 'signal_exit',
        label: '手仕舞い',
        tone: 'warn',
        detail: '翌寄りで手仕舞い予定',
      }
    );
  }
  if (currentPrice === null || !Number.isFinite(currentPrice)) {
    return { kind: 'unknown', label: '—', tone: 'neutral', detail: '現在値待ち' };
  }
  if (currentPrice <= o.stop_price) {
    return { kind: 'stop_loss', label: '損切り', tone: 'down', detail: `損切値${o.stop_price}以下` };
  }
  if (o.target_price != null && currentPrice >= o.target_price) {
    return { kind: 'take_profit', label: '利確', tone: 'up', detail: `目標${o.target_price}到達` };
  }
  if (asOfDate && asOfDate >= o.deadline_date) {
    return { kind: 'deadline', label: '期限', tone: 'warn', detail: '保有期限到達' };
  }
  const parts: string[] = [];
  if (o.target_price != null && currentPrice > 0) parts.push(`利確まで${pctStr(o.target_price / currentPrice - 1)}`);
  if (currentPrice > 0) parts.push(`損切りまで${pctStr(o.stop_price / currentPrice - 1)}`);
  return { kind: 'hold', label: HOLD_LABEL, tone: 'neutral', detail: parts.join(' / ') };
}

// --- 検証ログの集計(手法を洗練するための実データ分析) ---

/** 手仕舞い理由ごとの成績。 */
export interface ClosedReasonStat {
  reason: string;
  n: number;
  /** 勝率(0〜1)。 */
  winRate: number;
  /** 平均損益率(百分率・return_pct と同じ単位, 2.0 = +2%)。 */
  avgRet: number;
}

/** 確定した検証トレードの集計。 */
export interface ClosedSummary {
  n: number;
  winRate: number;
  avgRet: number;
  /** 件数降順の理由別内訳。 */
  byReason: ClosedReasonStat[];
}

/**
 * 確定ログ(closed)を集計する。return_pct は百分率(2.0 = +2%)。
 * 手仕舞い理由ごとの内訳は「利確が薄く損切りが深い」等の手法の癖を可視化し、
 * 実データに基づく改善(利確幅・ストップ・保有期間の見直し)の材料にする。
 */
export function summarizeClosed(closed: SwingPaperClosed[]): ClosedSummary {
  const n = closed.length;
  let wins = 0;
  let sum = 0;
  const byReasonMap = new Map<string, { n: number; wins: number; sum: number }>();
  for (const c of closed) {
    const win = c.return_pct > 0;
    if (win) wins += 1;
    sum += c.return_pct;
    const m = byReasonMap.get(c.exit_reason) ?? { n: 0, wins: 0, sum: 0 };
    m.n += 1;
    if (win) m.wins += 1;
    m.sum += c.return_pct;
    byReasonMap.set(c.exit_reason, m);
  }
  const byReason: ClosedReasonStat[] = [...byReasonMap.entries()]
    .map(([reason, m]) => ({
      reason,
      n: m.n,
      winRate: m.n ? m.wins / m.n : 0,
      avgRet: m.n ? m.sum / m.n : 0,
    }))
    .sort((a, b) => b.n - a.n);
  return {
    n,
    winRate: n ? wins / n : 0,
    avgRet: n ? sum / n : 0,
    byReason,
  };
}
