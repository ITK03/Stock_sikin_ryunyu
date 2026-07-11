// 銘柄コードの正規化ユーティリティ。IO非依存の純粋関数のみ。
// 資金流入ランキング(4桁の数字コード or 米国ティッカー)・開示(4-5桁、空文字あり)・
// セクター(code/ticker、"6758.T" 形式を含む)の3データソースを同じキーで突き合わせるために使う。

// 除去してよい既知の取引所サフィックス(Yahoo等の表記)。
// "BRK.B" のような米国株のクラス株表記(.B は取引所ではない)まで削って
// 別クラスの銘柄と混同しないよう、既知のサフィックスに限定して除去する。
const EXCHANGE_SUFFIXES = new Set(['T', 'JP', 'TYO', 'US']);

/**
 * 銘柄コード文字列を比較用の正規形へ変換する。
 * - 前後の空白を除去
 * - 大文字化(米国株ティッカーの小文字表記対策)
 * - 既知の取引所サフィックスを除去 ("6758.T" → "6758", "aapl.US" → "AAPL")
 * - クラス株表記("BRK.B" / "BRK-B")はそのまま保持する
 * 空文字・null・undefined・英数字と . - 以外を含む値は null を返す。
 */
export function normalizeCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s) return null;
  const dot = s.lastIndexOf('.');
  if (dot > 0 && EXCHANGE_SUFFIXES.has(s.slice(dot + 1))) {
    s = s.slice(0, dot).trim();
  }
  if (!s) return null;
  // 先頭は英数字。以降は英数字と . -(クラス株表記)のみ。末尾の区切り文字は不正。
  if (!/^[0-9A-Z][0-9A-Z.-]{0,9}$/.test(s) || /[.-]$/.test(s)) return null;
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
