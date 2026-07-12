// 横断ウォッチリストの純ロジック。IO非依存(localStorage への読み書きは src/web 側)。
// コードは normalizeCode で正規化した形で保持する("6758.T" と "6758" を同一銘柄として扱う)。

import { normalizeCode } from './codes';

/** 永続化フォーマットのバージョン付きエンベロープ。 */
interface WatchlistEnvelope {
  v: 1;
  codes: string[];
}

/**
 * 永続化された文字列(JSON)からウォッチリストを復元する。
 * 壊れたデータ・不正なコードは黙って捨てる(空配列にフォールバック)。
 * 正規化・重複排除済みの配列を返す。
 */
export function parseWatchlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    // v1 エンベロープ形式と、素の配列(将来/手書き)の両方を受け付ける。
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as WatchlistEnvelope).codes)
      ? (parsed as WatchlistEnvelope).codes
      : [];
    return dedupeNormalized(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return [];
  }
}

/** ウォッチリストを永続化用の文字列(JSON)へ変換する。 */
export function serializeWatchlist(codes: string[]): string {
  const env: WatchlistEnvelope = { v: 1, codes: dedupeNormalized(codes) };
  return JSON.stringify(env);
}

/** コードを正規化しつつ順序を保って重複排除する。不正なコードは除外。 */
function dedupeNormalized(codes: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of codes) {
    const n = normalizeCode(c);
    if (n !== null && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** そのコードがウォッチ済みか(表記ゆれは正規化して判定)。 */
export function isWatched(codes: string[], code: string | null | undefined): boolean {
  const n = normalizeCode(code);
  return n !== null && codes.includes(n);
}

/**
 * ウォッチのトグル。登録済みなら外し、未登録なら末尾に追加した新しい配列を返す。
 * 不正なコードの場合は元の配列をそのまま返す。
 */
export function toggleWatch(codes: string[], code: string | null | undefined): string[] {
  const n = normalizeCode(code);
  if (n === null) return codes;
  return codes.includes(n) ? codes.filter((c) => c !== n) : [...codes, n];
}
