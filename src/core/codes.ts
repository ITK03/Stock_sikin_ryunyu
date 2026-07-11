// 銘柄コードの正規化ユーティリティ。IO非依存の純粋関数のみ。
// 資金流入ランキング(4桁の数字コード or 米国ティッカー)・開示(4-5桁、空文字あり)・
// セクター(code/ticker、"6758.T" 形式を含む)の3データソースを同じキーで突き合わせるために使う。

/**
 * 銘柄コード文字列を比較用の正規形へ変換する。
 * - 前後の空白を除去
 * - 大文字化(米国株ティッカーの小文字表記対策)
 * - 取引所サフィックスを除去 ("6758.T" → "6758" 等)
 * 空文字・null・undefined・英数字以外を含む値は null を返す。
 */
export function normalizeCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s) return null;
  const dot = s.indexOf('.');
  if (dot > 0) s = s.slice(0, dot);
  s = s.trim();
  if (!s) return null;
  if (!/^[0-9A-Z]{1,10}$/.test(s)) return null;
  return s;
}

/** 日本株コードらしい形式(4〜5桁の数字)かどうか。 */
export function isJpCode(code: string | null | undefined): boolean {
  const n = normalizeCode(code);
  return n !== null && /^[0-9]{4,5}$/.test(n);
}

/** 2つの銘柄コード表記が正規化後に一致するか。 */
export function codesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCode(a);
  const nb = normalizeCode(b);
  return na !== null && na === nb;
}
