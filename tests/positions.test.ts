import { describe, expect, it } from 'vitest';
import {
  parsePositions,
  positionPnlAmount,
  positionPnlPct,
  serializePositions,
  type SwingPosition,
} from '../src/core/positions';

const base: SwingPosition = {
  id: '1-abc',
  strategyId: 'rsi2_dip',
  code: '7203',
  name: 'トヨタ自動車',
  fillDate: '2026-07-20',
  fillPrice: 3000,
  shares: 100,
};

describe('parsePositions', () => {
  it('null・空文字は空配列', () => {
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions('')).toEqual([]);
    expect(parsePositions(undefined)).toEqual([]);
  });

  it('壊れたJSON・想定外の形は空配列', () => {
    expect(parsePositions('{oops')).toEqual([]);
    expect(parsePositions('123')).toEqual([]);
    expect(parsePositions('{"v":1}')).toEqual([]);
  });

  it('v1エンベロープ形式を復元する', () => {
    const raw = JSON.stringify({ v: 1, positions: [base] });
    expect(parsePositions(raw)).toEqual([base]);
  });

  it('素の配列も受け付ける', () => {
    expect(parsePositions(JSON.stringify([base]))).toEqual([base]);
  });

  it('不正な要素(欠損フィールド・0以下の数値)は除外する', () => {
    const bad1 = { ...base, id: '2', fillPrice: 0 };
    const bad2 = { ...base, id: '3', shares: -1 };
    const bad3 = { ...base, id: '4', code: '' };
    const raw = JSON.stringify({ v: 1, positions: [base, bad1, bad2, bad3, 42, null] });
    expect(parsePositions(raw)).toEqual([base]);
  });
});

describe('serializePositions → parsePositions の往復', () => {
  it('保存・復元できる', () => {
    const s = serializePositions([base]);
    expect(parsePositions(s)).toEqual([base]);
  });
});

describe('positionPnlAmount', () => {
  it('現在値不明なら null', () => {
    expect(positionPnlAmount(base, null)).toBeNull();
  });
  it('(現在値-取得単価)×株数', () => {
    expect(positionPnlAmount(base, 3100)).toBe(10000);
    expect(positionPnlAmount(base, 2900)).toBe(-10000);
  });
});

describe('positionPnlPct', () => {
  it('現在値不明・取得単価0以下なら null', () => {
    expect(positionPnlPct(base, null)).toBeNull();
    expect(positionPnlPct({ fillPrice: 0 }, 100)).toBeNull();
  });
  it('現在値/取得単価-1', () => {
    expect(positionPnlPct(base, 3300)).toBeCloseTo(0.1);
  });
});
