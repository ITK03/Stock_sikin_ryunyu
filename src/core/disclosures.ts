// 適時開示の重複排除ユーティリティ。IO非依存の純粋関数のみ。
//
// 実データ(Stock_open_news)では同一の開示が yanoshin / scraper 等の複数ソースから
// 別々の id で取り込まれ、(time, code, title) が完全一致する重複行として feed に
// 混入することがある(実データ検証で確認: 実フィード1454件中708グループ・726件が重複)。
// 表示側で吸収し、フィード件数・スクロール量が実質的に水増しされないようにする。

import { normalizeCode } from './codes';
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

// ── 検索とトピック絞り込み ───────────────────────────────────────
// 以前は入力を銘柄コードとしてしか解釈しておらず、会社名や語句を入れても
// normalizeCode が null を返して「絞り込みなし」になっていた(何も起きない)。
// コード・会社名・タイトルのいずれかに当たれば表示する。

/** 検索語が開示に一致するか。コードは前方一致、名前とタイトルは部分一致。 */
export function matchesQuery(d: Disclosure, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const code = normalizeCode(q);
  if (code) {
    const dc = normalizeCode(d.code);
    if (dc !== null && dc.startsWith(code)) return true;
  }
  const lower = q.toLowerCase();
  const hay = `${d.company ?? ''} ${d.title ?? ''} ${(d.tags ?? []).join(' ')}`.toLowerCase();
  return hay.includes(lower);
}

export interface Topic {
  key: string;
  label: string;
  count: number;
}

/** 業績修正のうち上方/下方。カテゴリだけでは方向が分からないので分けて扱う。 */
const REVISION_CATEGORY = '業績修正';

function isUpward(d: Disclosure): boolean {
  return d.category === REVISION_CATEGORY && d.direction === 'positive';
}

function isDownward(d: Disclosure): boolean {
  return d.category === REVISION_CATEGORY && d.direction === 'negative';
}

/** チップの既定の上限。実データでカテゴリが26種類あり、全部出すと横スクロールが
    終わらない。件数の少ない裾(月次1件・減資2件など)は絞り込みの役に立たない。 */
export const TOPIC_LIMIT = 12;

/**
 * 絞り込みチップの候補を、実際のデータから作る。
 * 固定リストにすると、開示の傾向が変わったときに空のチップが並ぶ。
 */
export function disclosureTopics(items: Disclosure[], limit = TOPIC_LIMIT): Topic[] {
  const byCat = new Map<string, number>();
  let up = 0;
  let down = 0;
  for (const d of items) {
    const c = d.category;
    if (c) byCat.set(c, (byCat.get(c) ?? 0) + 1);
    if (isUpward(d)) up += 1;
    if (isDownward(d)) down += 1;
  }
  // 上方/下方は件数に関係なく先頭に固定する。件数順に並べ替えると、件数の多い
  // 「業績修正」の後ろに回ってしまうが、実際に探したいのは方向のほうなので。
  const pinned: Topic[] = [];
  if (up > 0) pinned.push({ key: 'up', label: '上方修正', count: up });
  if (down > 0) pinned.push({ key: 'down', label: '下方修正', count: down });

  const cats: Topic[] = [];
  for (const [label, count] of byCat) {
    // 「その他開示」は絞り込みの役に立たないので出さない
    if (label === 'その他開示') continue;
    cats.push({ key: `cat:${label}`, label, count });
  }
  cats.sort((a, b) => b.count - a.count);
  // 上方/下方は常に残し、カテゴリ側だけを上限で切る。
  return [...pinned, ...cats.slice(0, Math.max(0, limit - pinned.length))];
}

/** 選択されたトピックのいずれかに当たるか。未選択なら全件。 */
export function matchesTopics(d: Disclosure, keys: Set<string>): boolean {
  if (keys.size === 0) return true;
  for (const k of keys) {
    if (k === 'up' && isUpward(d)) return true;
    if (k === 'down' && isDownward(d)) return true;
    if (k.startsWith('cat:') && d.category === k.slice(4)) return true;
  }
  return false;
}
