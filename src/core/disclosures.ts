// 適時開示の重複排除ユーティリティ。IO非依存の純粋関数のみ。
//
// 実データ(Stock_open_news)では同一の開示が yanoshin / scraper 等の複数ソースから
// 別々の id で取り込まれ、(time, code, title) が完全一致する重複行として feed に
// 混入することがある(実データ検証で確認: 実フィード1454件中708グループ・726件が重複)。
// 表示側で吸収し、フィード件数・スクロール量が実質的に水増しされないようにする。

import type { Disclosure } from './types';

/** 重複判定キー。code は表記ゆれを避けるため正規化しない(空文字同士も同一視してよい)。 */
function dedupeKey(d: Disclosure): string {
  return `${d.time}|${d.code}|${d.title}`;
}

/**
 * (time, code, title) が完全一致する行を1件に統合する。
 * 同じキーの候補が複数ある場合、id の昇順で先頭(=決定論的)を採用する。
 * 入力の並び順は保持しない(呼び出し側で改めてソートする前提)。
 */
export function dedupeDisclosures(items: Disclosure[]): Disclosure[] {
  const best = new Map<string, Disclosure>();
  for (const d of items) {
    const key = dedupeKey(d);
    const existing = best.get(key);
    if (!existing || d.id < existing.id) best.set(key, d);
  }
  return Array.from(best.values());
}

// ---------------------------------------------------------------------------
// 材料分類(好材料/悪材料/特大)。
// ---------------------------------------------------------------------------

/**
 * 特大とみなすスコア下限。重要度フィルタの最上段「85+」と同じ水準で、
 * 大幅な上昇/下落が期待される開示だけが該当するように高めに設定。
 */
export const MEGA_SCORE = 85;

/** 材料分類。mega-* は方向が明確かつスコアが MEGA_SCORE 以上。 */
export type MaterialClass =
  | 'mega-positive'
  | 'positive'
  | 'negative'
  | 'mega-negative'
  | 'other';

/** 開示の方向とスコアから材料分類を決める純粋関数。 */
export function materialClass(
  d: Pick<Disclosure, 'direction' | 'score'>,
): MaterialClass {
  if (d.direction === 'positive') return d.score >= MEGA_SCORE ? 'mega-positive' : 'positive';
  if (d.direction === 'negative') return d.score >= MEGA_SCORE ? 'mega-negative' : 'negative';
  return 'other';
}
