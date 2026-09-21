import { describe, expect, it } from 'vitest';
import {
  RATE_WEIGHT,
  clampRate,
  makeSectorId,
  parseMySectors,
  parseMySectorsForImport,
  scoreMySector,
  scoreMySectors,
  serializeMySectors,
  type MySector,
  type QuoteMap,
} from '../src/core/mySector';

describe('RATE_WEIGHT', () => {
  it('レートの2乗になっている', () => {
    expect(RATE_WEIGHT).toEqual({ 1: 1, 2: 4, 3: 9, 4: 16, 5: 25 });
  });
});

describe('clampRate', () => {
  it('1..5の範囲に丸め込む', () => {
    expect(clampRate(0)).toBe(1);
    expect(clampRate(-5)).toBe(1);
    expect(clampRate(1)).toBe(1);
    expect(clampRate(3.4)).toBe(3);
    expect(clampRate(3.6)).toBe(4);
    expect(clampRate(5)).toBe(5);
    expect(clampRate(99)).toBe(5);
  });
  it('数値でない/NaNは既定値3にする', () => {
    expect(clampRate('abc')).toBe(3);
    expect(clampRate(null)).toBe(3);
    expect(clampRate(undefined)).toBe(3);
    expect(clampRate(NaN)).toBe(3);
  });
  it('文字列の数値は変換する', () => {
    expect(clampRate('4')).toBe(4);
  });
});

describe('scoreMySector', () => {
  it('空セクター(構成銘柄0件)は changePct 0・members空でクラッシュしない', () => {
    const score = scoreMySector({ members: [] }, {});
    expect(score).toEqual({ changePct: 0, members: [], matched: 0, total: 0 });
  });

  it('quotesが全くない(全銘柄欠損)場合も changePct 0・members空', () => {
    const sector: MySector = { id: 's', name: 'テスト', members: [{ code: '1000', rate: 3 }] };
    expect(scoreMySector(sector, {})).toEqual({ changePct: 0, members: [], matched: 0, total: 1 });
    expect(scoreMySector(sector, null)).toEqual({ changePct: 0, members: [], matched: 0, total: 1 });
  });

  it('加重平均: レート5の1銘柄がレート1の多数派を押し負かさない(線形だと負けるケース)', () => {
    // レート1が2銘柄(+10%ずつ)、レート5が1銘柄(-10%)。
    // 単純平均なら (10+10-10)/3 = +3.33% になるが、レート2乗加重では
    // (1×10 + 1×10 + 25×(-10)) / (1+1+25) = (10+10-250)/27 ≈ -8.15% になるはず。
    const sector: MySector = {
      id: 's',
      name: 'テスト',
      members: [
        { code: '1001', rate: 1 },
        { code: '1002', rate: 1 },
        { code: '1003', rate: 5 },
      ],
    };
    const quotes: QuoteMap = {
      '1001': { p: 100, c: 10 },
      '1002': { p: 100, c: 10 },
      '1003': { p: 100, c: -10 },
    };
    const score = scoreMySector(sector, quotes);
    const expected = (1 * 10 + 1 * 10 + 25 * -10) / (1 + 1 + 25);
    expect(score.changePct).toBeCloseTo(expected, 8);
    expect(score.changePct).toBeLessThan(0); // 主力(レート5)の下落方向に振れる
  });

  it('具体値: レート1(+10%)とレート5(+2%)の加重平均', () => {
    const sector: MySector = {
      id: 's',
      name: 'テスト',
      members: [
        { code: '1001', rate: 1 },
        { code: '1002', rate: 5 },
      ],
    };
    const quotes: QuoteMap = { '1001': { p: 100, c: 10 }, '1002': { p: 200, c: 2 } };
    const score = scoreMySector(sector, quotes);
    // (1×10 + 25×2) / 26 = 60/26
    expect(score.changePct).toBeCloseTo(60 / 26, 10);
  });

  it('寄与度(contribution)の合計はセクターchangePctに一致する', () => {
    const sector: MySector = {
      id: 's',
      name: 'テスト',
      members: [
        { code: '1001', rate: 1 },
        { code: '1002', rate: 2 },
        { code: '1003', rate: 3 },
        { code: '1004', rate: 4 },
        { code: '1005', rate: 5 },
      ],
    };
    const quotes: QuoteMap = {
      '1001': { p: 100, c: 3.5 },
      '1002': { p: 100, c: -1.2 },
      '1003': { p: 100, c: 0 },
      '1004': { p: 100, c: -4.4 },
      '1005': { p: 100, c: 2.1 },
    };
    const score = scoreMySector(sector, quotes);
    const sumContribution = score.members.reduce((s, m) => s + m.contribution, 0);
    expect(sumContribution).toBeCloseTo(score.changePct, 10);
  });

  it('|寄与度| 降順で並ぶ(上昇/下落どちらが主因でも先頭に来る)', () => {
    const sector: MySector = {
      id: 's',
      name: 'テスト',
      members: [
        { code: '1001', rate: 1 }, // 小さい寄与
        { code: '1002', rate: 5 }, // 大きく下落 → 大きい負の寄与
        { code: '1003', rate: 3 }, // 中間
      ],
    };
    const quotes: QuoteMap = {
      '1001': { p: 100, c: 1 },
      '1002': { p: 100, c: -8 },
      '1003': { p: 100, c: 2 },
    };
    const score = scoreMySector(sector, quotes);
    const order = score.members.map((m) => m.code);
    expect(order).toEqual(['1002', '1003', '1001']);
    // 絶対値が実際に降順になっていることも確認
    for (let i = 1; i < score.members.length; i++) {
      expect(Math.abs(score.members[i - 1].contribution)).toBeGreaterThanOrEqual(
        Math.abs(score.members[i].contribution),
      );
    }
  });

  it('現在値の無い銘柄は無視する(Σ重みにも含めず、membersにも出ない)。N/M銘柄用のtotal/matchedは分けて数える', () => {
    const sector: MySector = {
      id: 's',
      name: 'テスト',
      members: [
        { code: '1001', rate: 5 },
        { code: '1002', rate: 5 }, // quotesに無い
        { code: '1003', rate: 5 }, // c が null
      ],
    };
    const quotes: QuoteMap = {
      '1001': { p: 100, c: 4 },
      '1003': { p: 100, c: null },
    };
    const score = scoreMySector(sector, quotes);
    expect(score.total).toBe(3);
    expect(score.matched).toBe(1);
    expect(score.members).toHaveLength(1);
    expect(score.members[0].code).toBe('1001');
    // 欠損銘柄を含めず、1銘柄だけの加重平均(=その銘柄のchangePctそのもの)になる
    expect(score.changePct).toBeCloseTo(4, 10);
  });

  it('コードの表記ゆれ(サフィックス・大文字小文字)を正規化して突き合わせる', () => {
    const sector: MySector = { id: 's', name: 'テスト', members: [{ code: '6758.T', rate: 3 }] };
    const quotes: QuoteMap = { '6758': { p: 3000, c: 1.5 } };
    const score = scoreMySector(sector, quotes);
    expect(score.matched).toBe(1);
    expect(score.members[0].code).toBe('6758');
    expect(score.changePct).toBeCloseTo(1.5, 10);
  });
});

describe('scoreMySectors', () => {
  it('複数セクターをまとめてIDごとに計算する', () => {
    const sectors: MySector[] = [
      { id: 'a', name: 'A', members: [{ code: '1001', rate: 3 }] },
      { id: 'b', name: 'B', members: [{ code: '1002', rate: 3 }] },
    ];
    const quotes: QuoteMap = { '1001': { p: 100, c: 2 }, '1002': { p: 100, c: -3 } };
    const map = scoreMySectors(sectors, quotes);
    expect(map.get('a')?.changePct).toBeCloseTo(2, 10);
    expect(map.get('b')?.changePct).toBeCloseTo(-3, 10);
  });
});

describe('makeSectorId', () => {
  it('呼ぶたびに異なるIDを返す', () => {
    const a = makeSectorId();
    const b = makeSectorId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('parseMySectors', () => {
  it('null・空文字は空配列', () => {
    expect(parseMySectors(null)).toEqual([]);
    expect(parseMySectors('')).toEqual([]);
    expect(parseMySectors(undefined)).toEqual([]);
  });

  it('壊れたJSON・想定外の形は空配列', () => {
    expect(parseMySectors('{oops')).toEqual([]);
    expect(parseMySectors('123')).toEqual([]);
    expect(parseMySectors('{"v":1}')).toEqual([]);
  });

  it('v1エンベロープ形式を復元する', () => {
    const raw = JSON.stringify({
      v: 1,
      sectors: [{ id: 'x1', name: '半導体', members: [{ code: '6758', rate: 4 }] }],
    });
    expect(parseMySectors(raw)).toEqual([
      { id: 'x1', name: '半導体', members: [{ code: '6758', rate: 4 }] },
    ]);
  });

  it('素の配列も受け付ける', () => {
    const raw = JSON.stringify([{ id: 'x1', name: 'A', members: [] }]);
    expect(parseMySectors(raw)).toEqual([{ id: 'x1', name: 'A', members: [] }]);
  });

  it('レートを1..5にクランプし、コードを正規化・重複除外する', () => {
    const raw = JSON.stringify({
      v: 1,
      sectors: [
        {
          id: 'x1',
          name: 'テスト',
          members: [
            { code: '6758.T', rate: 99 },
            { code: ' 6758 ', rate: -5 },
            { code: 'aapl', rate: 2.6 },
          ],
        },
      ],
    });
    const result = parseMySectors(raw);
    expect(result).toHaveLength(1);
    expect(result[0].members).toEqual([
      { code: '6758', rate: 5 },
      { code: 'AAPL', rate: 3 },
    ]);
  });

  it('名称が無い/空文字のセクターは除外する', () => {
    const raw = JSON.stringify({
      v: 1,
      sectors: [{ id: 'x1', name: '', members: [] }, { id: 'x2', members: [] }, 42, null],
    });
    expect(parseMySectors(raw)).toEqual([]);
  });

  it('idが無い要素には新しいIDを補う', () => {
    const raw = JSON.stringify({ v: 1, sectors: [{ name: 'A', members: [] }] });
    const result = parseMySectors(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id.length).toBeGreaterThan(0);
  });
});

describe('serializeMySectors → parseMySectors の往復', () => {
  it('保存・復元できる', () => {
    const sectors: MySector[] = [
      { id: 'x1', name: '半導体', members: [{ code: '6758', rate: 4 }, { code: 'AAPL', rate: 2 }] },
    ];
    const s = serializeMySectors(sectors);
    expect(parseMySectors(s)).toEqual(sectors);
  });
});

describe('parseMySectorsForImport', () => {
  it('空文字はエラー', () => {
    const r = parseMySectorsForImport('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('入力');
  });

  it('壊れたJSONはエラー', () => {
    const r = parseMySectorsForImport('{oops');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON');
  });

  it('形が違う(sectors配列が無い)場合はエラー', () => {
    const r = parseMySectorsForImport('{"v":1}');
    expect(r.ok).toBe(false);
  });

  it('有効なセクターが1件も無い場合はエラー', () => {
    const r = parseMySectorsForImport(JSON.stringify({ v: 1, sectors: [{ name: '' }, 42] }));
    expect(r.ok).toBe(false);
  });

  it('正しいデータは ok:true でクランプ・正規化済みの配列を返す', () => {
    const raw = JSON.stringify({
      v: 1,
      sectors: [{ id: 'x1', name: '半導体', members: [{ code: '6758.t', rate: 100 }] }],
    });
    const r = parseMySectorsForImport(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sectors).toEqual([{ id: 'x1', name: '半導体', members: [{ code: '6758', rate: 5 }] }]);
    }
  });

  it('素の配列形式も受け付ける', () => {
    const raw = JSON.stringify([{ id: 'x1', name: 'A', members: [] }]);
    const r = parseMySectorsForImport(raw);
    expect(r.ok).toBe(true);
  });
});
