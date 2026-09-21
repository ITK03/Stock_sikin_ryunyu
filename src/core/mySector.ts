// マイセクター(ユーザー定義セクター)の純ロジック。IO非依存(localStorage等は src/web 側)。
// 「セクター」タブの新サブタブ「マイセクター」向け。既存の sector-monitor 生成セクター
// (SectorEntry/SectorFile)とは別物 — こちらは銘柄をユーザー自身がレート付きで束ね、
// 現在値(quotes_*.json)に対して加重平均の騰落率を出す。

import { normalizeCode } from './codes';

/** 銘柄の重要度レート。5が主力・1が周辺。 */
export type Rate = 1 | 2 | 3 | 4 | 5;

/** マイセクターの構成銘柄1件。表示用の名称は保持せず、常に最新のインデックスから解決する。 */
export interface SectorMember {
  code: string;
  rate: Rate;
}

/** マイセクター1件。 */
export interface MySector {
  id: string;
  name: string;
  members: SectorMember[];
}

/**
 * レート比重はレートの2乗。線形だとレート1の多数派がレート5の主力を押し負かすため。
 */
export const RATE_WEIGHT: Record<Rate, number> = { 1: 1, 2: 4, 3: 9, 4: 16, 5: 25 };

// ---------------------------------------------------------------------------
// スコアリング
// ---------------------------------------------------------------------------

/** 現在値ソース。quotes_jp.json / quotes_us.json の `quotes` フィールドと同じ形。 */
export type QuoteMap = Record<string, { p: number | null; c: number | null }>;

/** スコア計算後の構成銘柄1件(現在値が取得できた銘柄のみ)。 */
export interface ScoredMember {
  code: string;
  rate: Rate;
  weight: number;
  price: number | null;
  /** この銘柄自身の騰落率(%)。 */
  changePct: number;
  /** セクター騰落率に対する寄与度(%)。全銘柄分の合計はセクター騰落率に一致する。 */
  contribution: number;
}

export interface SectorScore {
  /** 加重平均の騰落率(%)。空/全銘柄欠損の場合は0。 */
  changePct: number;
  /** |寄与度| 降順(値が大きい方が先頭。上昇/下落どちらでも押し上げ・押し下げの主因が先頭に来る)。 */
  members: ScoredMember[];
  /** 現在値が取得できた銘柄数。 */
  matched: number;
  /** セクターの構成銘柄数(現在値の有無に関わらない全数)。 */
  total: number;
}

/** quotes のキーを正規化して引きやすくする(コード表記ゆれ対策)。 */
function normalizeQuoteMap(quotes: QuoteMap | null | undefined): Map<string, { p: number | null; c: number | null }> {
  const map = new Map<string, { p: number | null; c: number | null }>();
  if (!quotes) return map;
  for (const [rawCode, v] of Object.entries(quotes)) {
    const code = normalizeCode(rawCode);
    if (code && !map.has(code)) map.set(code, v);
  }
  return map;
}

/**
 * マイセクター1件のスコアを計算する。
 * - 現在値が無い(quotesに存在しない、または changePct が null)銘柄は完全に無視する:
 *   Σ重みに含めず、返り値の members にも含めない。matched/total で欠損を可視化する。
 * - sector changePct = Σ(weight_i × changePct_i) / Σweight_i (加重平均)
 * - contribution_i = weight_i × changePct_i / Σweight_i (合計すると sector changePct に一致)
 * - members は |contribution| 降順(上昇/下落どちらのセクターでも主因が先頭に来る)。
 */
export function scoreMySector(
  sector: Pick<MySector, 'members'>,
  quotes: QuoteMap | null | undefined,
): SectorScore {
  const total = sector.members.length;
  const quoteMap = normalizeQuoteMap(quotes);

  const withQuote: { code: string; rate: Rate; weight: number; price: number | null; changePct: number }[] = [];
  let sumWeight = 0;
  for (const m of sector.members) {
    const code = normalizeCode(m.code);
    if (!code) continue;
    const q = quoteMap.get(code);
    if (!q || q.c === null || q.c === undefined || !Number.isFinite(q.c)) continue; // 現在値なし → 無視
    const weight = RATE_WEIGHT[m.rate];
    sumWeight += weight;
    withQuote.push({ code, rate: m.rate, weight, price: q.p, changePct: q.c });
  }

  if (sumWeight <= 0 || withQuote.length === 0) {
    return { changePct: 0, members: [], matched: 0, total };
  }

  const members: ScoredMember[] = withQuote.map((m) => ({
    ...m,
    contribution: (m.weight * m.changePct) / sumWeight,
  }));
  members.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // 合計 = 加重平均そのもの(contribution の定義上、定義から自明に一致する)。
  const changePct = members.reduce((sum, m) => sum + m.contribution, 0);

  return { changePct, members, matched: members.length, total };
}

/** 複数のマイセクターをまとめてスコア計算する(id → スコア)。 */
export function scoreMySectors(sectors: MySector[], quotes: QuoteMap | null | undefined): Map<string, SectorScore> {
  const map = new Map<string, SectorScore>();
  for (const s of sectors) map.set(s.id, scoreMySector(s, quotes));
  return map;
}

// ---------------------------------------------------------------------------
// 永続化(パース/シリアライズ)。IO(localStorage等)は src/web 側の責務。
// ---------------------------------------------------------------------------

/** 永続化フォーマットのバージョン付きエンベロープ。 */
interface MySectorsEnvelope {
  v: 1;
  sectors: MySector[];
}

/** レートを 1..5 の整数へ丸め込む。不正な値は既定値3(中間)にする。 */
export function clampRate(raw: unknown): Rate {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n))) as Rate;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/** 新規マイセクターのID(時刻+乱数)。SwingPosition の makePositionId と同じ方式。 */
export function makeSectorId(): string {
  return `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 構成銘柄配列を検証・正規化する。コードを正規化しつつ重複を除外し、レートを1..5にクランプする。 */
function sanitizeMembers(raw: unknown): SectorMember[] {
  if (!Array.isArray(raw)) return [];
  const out: SectorMember[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const code = normalizeCode(typeof o.code === 'string' ? o.code : null);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, rate: clampRate(o.rate) });
  }
  return out;
}

/** セクター名の最大長(表示崩れ防止)。 */
const NAME_MAX_LEN = 40;

/** 入力を検証・正規化した MySector にする。名称が無い/空文字の場合は不正として null。 */
function sanitizeSector(raw: unknown): MySector | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.name)) return null;
  const name = o.name.trim().slice(0, NAME_MAX_LEN);
  const id = isNonEmptyString(o.id) ? o.id : makeSectorId();
  const members = sanitizeMembers(o.members);
  return { id, name, members };
}

/**
 * 永続化された文字列(JSON)からマイセクター一覧を復元する。
 * 壊れたデータ・不正な要素は黙って捨てる(空配列にフォールバック。localStorage起動時用)。
 */
export function parseMySectors(raw: string | null | undefined): MySector[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as MySectorsEnvelope).sectors)
      ? (parsed as MySectorsEnvelope).sectors
      : null;
    if (arr === null) return [];
    const out: MySector[] = [];
    for (const item of arr) {
      const s = sanitizeSector(item);
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/** マイセクター一覧を永続化・入出力用の文字列(JSON)へ変換する。入出力シートでも読める整形付き。 */
export function serializeMySectors(sectors: MySector[]): string {
  const env: MySectorsEnvelope = { v: 1, sectors };
  return JSON.stringify(env, null, 2);
}

/** 入出力シートの読み込み結果。 */
export type MySectorsImportResult =
  | { ok: true; sectors: MySector[] }
  | { ok: false; error: string };

/**
 * 入出力シートの「読み込み」用。parseMySectors と異なり、壊れた入力は捨てずに
 * 日本語のエラーメッセージを返す(ユーザーが貼り付けたテキストの誤りに気づけるように)。
 * 個々の不正な要素(欠損フィールド等)は緩く無視するが、全体の形が違う/1件も
 * 有効なセクターが無い場合はエラーにする。
 */
export function parseMySectorsForImport(raw: string): MySectorsImportResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'データが入力されていません。' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSONの形式が正しくありません。' };
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as MySectorsEnvelope).sectors)
    ? (parsed as MySectorsEnvelope).sectors
    : null;
  if (arr === null) {
    return { ok: false, error: 'マイセクターのデータ形式ではありません。' };
  }

  const sectors: MySector[] = [];
  for (const item of arr) {
    const s = sanitizeSector(item);
    if (s) sectors.push(s);
  }
  if (sectors.length === 0) {
    return { ok: false, error: '有効なセクターが見つかりませんでした。' };
  }
  return { ok: true, sectors };
}
