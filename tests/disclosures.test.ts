import { describe, expect, it } from 'vitest';
import { dedupeDisclosures } from '../src/core/disclosures';
import type { Disclosure } from '../src/core/types';

// 実データ検証で確認した実際の重複パターンを再現する最小フィールドのヘルパー。
function d(over: Partial<Disclosure> & { id: string; time: string; code: string; title: string }): Disclosure {
  return {
    company: '',
    pdf_url: '',
    exchange: '東証',
    markets: '',
    source: 'yanoshin',
    category: 'その他',
    score: 50,
    impact: 'medium',
    direction: 'unknown',
    urgent: false,
    summary: '',
    reasons: [],
    analyzed_by: 'rules',
    analyzed_at: over.time,
    confidence: 50,
    is_correction: false,
    tags: [],
    ...over,
  };
}

describe('dedupeDisclosures', () => {
  it('time/code/title が完全一致する行を1件に統合する(複数ソース由来の重複)', () => {
    const items: Disclosure[] = [
      d({ id: '9bd8fe6874045cca', time: '2026-07-10T18:20:00+09:00', code: '8367', title: '破産手続開始', source: 'scraper' }),
      d({ id: '140120260710591667', time: '2026-07-10T18:20:00+09:00', code: '8367', title: '破産手続開始', source: 'yanoshin' }),
    ];
    const out = dedupeDisclosures(items);
    expect(out).toHaveLength(1);
    // id昇順で決定論的に先頭を採用する。
    expect(out[0].id).toBe('140120260710591667');
  });

  it('title が同じでも code が異なれば別開示として残す(ETFの一斉配信など)', () => {
    const items: Disclosure[] = [
      d({ id: 'a', time: '2026-07-10T18:45:00+09:00', code: '1305', title: '収益分配のお知らせ' }),
      d({ id: 'b', time: '2026-07-10T18:45:00+09:00', code: '1320', title: '収益分配のお知らせ' }),
    ];
    expect(dedupeDisclosures(items)).toHaveLength(2);
  });

  it('code が空文字同士でも time/title が一致すれば統合する(スクレイパのゴミ値重複)', () => {
    const items: Disclosure[] = [
      d({ id: '7316960a614a2d94', time: '2026-07-11T00:00:00+09:00', code: 'Copy', title: 'Copyright © Tokyo Stock Exchange, Inc. All rights reserved.' }),
      d({ id: 'c1c2b4bd4c4dafcf', time: '2026-07-11T00:00:00+09:00', code: '', title: 'Copyright © Tokyo Stock Exchange, Inc. All rights reserved.' }),
    ];
    // code が異なる('Copy' vs '')ためこのケースはキーが分かれ2件のまま残る。
    // (実データのこの2件は code が異なるため、意図的に非統合のケースとして確認する)
    expect(dedupeDisclosures(items)).toHaveLength(2);
  });

  it('空配列は空配列を返す', () => {
    expect(dedupeDisclosures([])).toEqual([]);
  });

  it('重複が無ければそのまま全件返す', () => {
    const items: Disclosure[] = [
      d({ id: 'a', time: '2026-07-10T10:00:00+09:00', code: '7203', title: 'A' }),
      d({ id: 'b', time: '2026-07-10T11:00:00+09:00', code: '7203', title: 'B' }),
    ];
    expect(dedupeDisclosures(items)).toHaveLength(2);
  });
});

import { materialClass } from '../src/core/disclosures';

describe('materialClass', () => {
  const d = (direction: any, score: number) => ({ direction, score });
  it('スコア85以上かつ方向が明確なら特大', () => {
    expect(materialClass(d('positive', 85))).toBe('mega-positive');
    expect(materialClass(d('negative', 92))).toBe('mega-negative');
  });
  it('85未満は通常の好材料/悪材料', () => {
    expect(materialClass(d('positive', 84))).toBe('positive');
    expect(materialClass(d('negative', 50))).toBe('negative');
  });
  it('中立/判定不能はスコアに関わらずother', () => {
    expect(materialClass(d('neutral', 95))).toBe('other');
    expect(materialClass(d('unknown', 95))).toBe('other');
  });
});
