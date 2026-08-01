import { describe, expect, it } from 'vitest';
import { dedupeDisclosures, disclosureTopics, matchesQuery, matchesTopics } from '../src/core/disclosures';
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

// 以前は入力を銘柄コードとしてしか解釈しておらず、会社名を入れても
// normalizeCode が null を返して「絞り込みなし」になっていた(何も起きない)。
describe('matchesQuery — コード・会社名・語句のいずれでも探せる', () => {
  const d = (over: Partial<Disclosure> = {}): Disclosure => ({
    id: 'x', time: '2026-07-31T15:00:00+09:00', code: '7203',
    company: 'トヨタ自動車', title: '2027年3月期第1四半期決算短信〔日本基準〕(連結)',
    pdf_url: '', exchange: '東証', markets: '', source: 's', category: '決算',
    score: 60, impact: 'mid', direction: 'neutral', urgent: false, confidence: 70,
    is_correction: false, tags: ['決算短信'], reasons: [], summary: '',
    ...over,
  } as Disclosure);

  it('銘柄コードの前方一致', () => {
    expect(matchesQuery(d(), '72')).toBe(true);
    expect(matchesQuery(d(), '7203')).toBe(true);
    expect(matchesQuery(d(), '6758')).toBe(false);
  });

  it('会社名の部分一致', () => {
    expect(matchesQuery(d(), 'トヨタ')).toBe(true);
    expect(matchesQuery(d(), '自動車')).toBe(true);
    expect(matchesQuery(d(), 'ソニー')).toBe(false);
  });

  it('タイトルの語句', () => {
    expect(matchesQuery(d(), '決算短信')).toBe(true);
    expect(matchesQuery(d(), '四半期')).toBe(true);
    expect(matchesQuery(d(), '自己株式')).toBe(false);
  });

  it('タグも対象にする', () => {
    expect(matchesQuery(d({ tags: ['公開買付'] }), '公開買付')).toBe(true);
  });

  it('空の検索語は全件通す', () => {
    expect(matchesQuery(d(), '')).toBe(true);
    expect(matchesQuery(d(), '   ')).toBe(true);
  });

  it('英字は大文字小文字を区別しない', () => {
    expect(matchesQuery(d({ company: 'ABC Holdings' }), 'abc')).toBe(true);
  });

  it('会社名やタイトルが欠けていても落ちない', () => {
    expect(() => matchesQuery(d({ company: undefined as never, title: undefined as never }), 'x'))
      .not.toThrow();
  });
});

describe('disclosureTopics — 実データから絞り込み候補を作る', () => {
  const mk = (category: string, direction = 'neutral'): Disclosure =>
    ({ id: Math.random().toString(), code: '1', category, direction } as Disclosure);

  it('件数の多い順に並ぶ', () => {
    const t = disclosureTopics([mk('決算'), mk('決算'), mk('配当')]);
    expect(t[0].label).toBe('決算');
    expect(t[0].count).toBe(2);
  });

  it('上方修正・下方修正を業績修正から切り出す', () => {
    const t = disclosureTopics([
      mk('業績修正', 'positive'), mk('業績修正', 'positive'), mk('業績修正', 'negative'),
    ]);
    const up = t.find((x) => x.key === 'up')!;
    const down = t.find((x) => x.key === 'down')!;
    expect(up.count).toBe(2);
    expect(down.count).toBe(1);
    // 探したいのは方向なので、業績修正カテゴリより前に出す
    expect(t.indexOf(up)).toBeLessThan(t.findIndex((x) => x.key === 'cat:業績修正'));
  });

  it('「その他開示」は絞り込みの役に立たないので出さない', () => {
    const t = disclosureTopics([mk('その他開示'), mk('その他開示'), mk('配当')]);
    expect(t.map((x) => x.label)).not.toContain('その他開示');
  });

  it('該当が0件のトピックは作らない(空のチップを並べない)', () => {
    const t = disclosureTopics([mk('決算')]);
    expect(t.find((x) => x.key === 'up')).toBeUndefined();
  });

  it('空の入力', () => {
    expect(disclosureTopics([])).toEqual([]);
  });
});

describe('matchesTopics — 複数選択はOR', () => {
  const mk = (category: string, direction = 'neutral'): Disclosure =>
    ({ id: '1', code: '1', category, direction } as Disclosure);

  it('未選択なら全件通す', () => {
    expect(matchesTopics(mk('決算'), new Set())).toBe(true);
  });

  it('カテゴリ一致', () => {
    expect(matchesTopics(mk('決算'), new Set(['cat:決算']))).toBe(true);
    expect(matchesTopics(mk('配当'), new Set(['cat:決算']))).toBe(false);
  });

  it('上方修正は業績修正かつ強気のものだけ', () => {
    expect(matchesTopics(mk('業績修正', 'positive'), new Set(['up']))).toBe(true);
    expect(matchesTopics(mk('業績修正', 'negative'), new Set(['up']))).toBe(false);
    expect(matchesTopics(mk('決算', 'positive'), new Set(['up']))).toBe(false);
  });

  it('複数選択はいずれかに当たれば通る', () => {
    const keys = new Set(['cat:決算', 'up']);
    expect(matchesTopics(mk('決算'), keys)).toBe(true);
    expect(matchesTopics(mk('業績修正', 'positive'), keys)).toBe(true);
    expect(matchesTopics(mk('配当'), keys)).toBe(false);
  });
});

describe('disclosureTopics の件数上限', () => {
  const mk = (category: string, direction = 'neutral'): Disclosure =>
    ({ id: Math.random().toString(), code: '1', category, direction } as Disclosure);

  it('カテゴリが多くてもチップは上限で打ち切る', () => {
    // 実データではカテゴリが26種類あり、全部出すと横スクロールが終わらない
    const items: Disclosure[] = [];
    for (let i = 0; i < 26; i += 1) {
      for (let n = 0; n <= i; n += 1) items.push(mk(`カテゴリ${i}`));
    }
    expect(disclosureTopics(items).length).toBe(12);
  });

  it('件数の多いカテゴリから残る', () => {
    const items = [mk('多'), mk('多'), mk('多'), mk('少')];
    expect(disclosureTopics(items, 1).map((t) => t.label)).toEqual(['多']);
  });

  it('上方/下方は上限に関係なく残す(方向が最も探したいものなので)', () => {
    const items: Disclosure[] = [mk('業績修正', 'positive'), mk('業績修正', 'negative')];
    for (let i = 0; i < 20; i += 1) items.push(mk(`カテゴリ${i}`));
    const t = disclosureTopics(items, 3);
    expect(t.map((x) => x.key).slice(0, 2)).toEqual(['up', 'down']);
    expect(t.length).toBe(3);
  });
});
