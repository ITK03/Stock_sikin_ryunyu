import { describe, expect, it } from 'vitest';
import {
  adviseManualPosition,
  advisePaperOpen,
  approxBusinessDaysHeld,
  summarizeClosed,
} from '../src/core/swingAdvice';
import type { SwingExitRules, SwingPaperClosed, SwingPaperOpen } from '../src/core/types';

const rules: SwingExitRules = { take_profit: 0.02, stop_loss: 0.15, max_hold: 10 };

describe('approxBusinessDaysHeld', () => {
  it('経過営業日数を数える(起点翌日から, 土日除外)', () => {
    // 月(7/20)→翌月(7/27): 火水木金(4) + 翌月(1) = 経過5営業日(起点当日は含めない)
    expect(approxBusinessDaysHeld('2026-07-20', '2026-07-27')).toBe(5);
  });
  it('同日は0、未来→過去は null', () => {
    expect(approxBusinessDaysHeld('2026-07-20', '2026-07-20')).toBe(0);
    expect(approxBusinessDaysHeld('2026-07-21', '2026-07-20')).toBeNull();
  });
});

describe('adviseManualPosition', () => {
  const base = { fillPrice: 1000, fillDate: '2026-07-20', asOfDate: '2026-07-21', rules };

  it('現在値なしは unknown', () => {
    expect(adviseManualPosition({ ...base, currentPrice: null }).kind).toBe('unknown');
  });

  it('-15%以下は損切り(利確より優先)', () => {
    const a = adviseManualPosition({ ...base, currentPrice: 850 });
    expect(a.kind).toBe('stop_loss');
    expect(a.tone).toBe('down');
  });

  it('+2%以上は利確', () => {
    const a = adviseManualPosition({ ...base, currentPrice: 1020 });
    expect(a.kind).toBe('take_profit');
    expect(a.tone).toBe('up');
  });

  it('最大保有到達は期限(損切/利確でない場合)', () => {
    const a = adviseManualPosition({
      ...base,
      currentPrice: 1005,
      fillDate: '2026-07-01',
      asOfDate: '2026-07-24', // 十分な営業日経過
    });
    expect(a.kind).toBe('deadline');
  });

  it('シグナル手仕舞い(利確/損切/期限に該当せず exit フラグ)', () => {
    const a = adviseManualPosition({ ...base, currentPrice: 1005, exitSignal: true });
    expect(a.kind).toBe('signal_exit');
  });

  it('いずれも該当しなければ保有継続・距離を補足に出す', () => {
    const a = adviseManualPosition({ ...base, currentPrice: 1005 });
    expect(a.kind).toBe('hold');
    expect(a.detail).toContain('利確まで');
    expect(a.detail).toContain('損切りまで');
  });

  it('rules なしでも exit フラグで手仕舞い/なしで保有継続', () => {
    expect(adviseManualPosition({ fillPrice: 1000, fillDate: '', currentPrice: 1010, exitSignal: true }).kind).toBe(
      'signal_exit',
    );
    expect(adviseManualPosition({ fillPrice: 1000, fillDate: '', currentPrice: 1010 }).kind).toBe('hold');
  });
});

describe('advisePaperOpen', () => {
  const open: SwingPaperOpen = {
    id: 'p1',
    strategy_id: 'rsi2_dip',
    code: '7203',
    name: 'トヨタ',
    entry_date: '2026-07-20',
    entry_price: 1000,
    stop_price: 850,
    target_price: 1020,
    deadline_date: '2026-08-03',
    pending_exit: false,
    exit_reason: null,
  };

  it('pending_exit は理由をそのまま反映(現在値不要)', () => {
    const a = advisePaperOpen({ ...open, pending_exit: true, exit_reason: 'take_profit' }, null);
    expect(a.kind).toBe('take_profit');
  });
  it('現在値が損切値以下→損切り', () => {
    expect(advisePaperOpen(open, 840, '2026-07-21').kind).toBe('stop_loss');
  });
  it('現在値が目標以上→利確', () => {
    expect(advisePaperOpen(open, 1025, '2026-07-21').kind).toBe('take_profit');
  });
  it('期限到達→期限', () => {
    expect(advisePaperOpen(open, 1005, '2026-08-03').kind).toBe('deadline');
  });
  it('通常は保有継続', () => {
    expect(advisePaperOpen(open, 1005, '2026-07-21').kind).toBe('hold');
  });
  it('現在値なし(pending_exitでない)は unknown', () => {
    expect(advisePaperOpen(open, null, null).kind).toBe('unknown');
  });
});

describe('summarizeClosed', () => {
  const mk = (reason: string, ret: number): SwingPaperClosed => ({
    id: Math.random().toString(),
    strategy_id: 'rsi2_dip',
    code: '0000',
    name: 'x',
    entry_date: '2026-07-01',
    entry_price: 100,
    exit_date: '2026-07-05',
    exit_price: 100,
    exit_reason: reason,
    return_pct: ret,
    hold_days: 3,
  });

  it('空は0件', () => {
    const s = summarizeClosed([]);
    expect(s.n).toBe(0);
    expect(s.byReason).toEqual([]);
  });

  it('全体勝率・平均・理由別内訳を集計(件数降順)', () => {
    const s = summarizeClosed([
      mk('take_profit', 2),
      mk('take_profit', 2),
      mk('stop_loss', -15),
      mk('max_hold', 1),
    ]);
    expect(s.n).toBe(4);
    expect(s.winRate).toBeCloseTo(3 / 4);
    expect(s.avgRet).toBeCloseTo((2 + 2 - 15 + 1) / 4);
    expect(s.byReason[0].reason).toBe('take_profit');
    expect(s.byReason[0].n).toBe(2);
    expect(s.byReason[0].winRate).toBe(1);
  });
});
