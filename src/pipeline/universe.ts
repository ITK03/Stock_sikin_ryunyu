import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import type { MarketSegment, Region } from '../core/types';
import { fetchShares, getCrumb, type UniverseEntry } from '../data/yahoo.js';

// 上場銘柄ユニバースを生成し、Yahoo から発行済株式数を補完して config に書き出す。
//  - JP: JPX公式「東証上場銘柄一覧」(data_j.xls) → config/universe.json
//  - US: NASDAQ Trader のシンボル一覧(nasdaqlisted/otherlisted) → config/universe.us.json
// ネットワーク開放環境(GitHub Actions 等)で実行する想定。

// JPX「東証上場銘柄一覧」の配布ページ。ファイル本体のURLは
// `.../misc/<ハッシュ>-att/data_j.xls` という形で、この <ハッシュ> は JPX 側の
// 都合で入れ替わる。実際 tvdivq0000001vg2-att は 404 になっており(CIログで確認)、
// 直書きのURLだけに頼っていたため日本株のユニバースが取得できず、
// コミット済みのフォールバック20銘柄で資金流入ランキングが作られ続けていた。
// URLを推測で書き換えても次の入れ替えでまた壊れるので、配布ページから
// 現在のリンクを読む。
const JPX_LISTING_PAGE =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html';
// 旧URL。配布ページから拾えなかったときの最後の候補として残す。
const JPX_LEGACY_XLS =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';
const UA = 'Mozilla/5.0';
// 妥当な最小件数。全市場の実数は JP 約3,900・US 約6,900。これを大きく下回る
// 結果は取得・解析の異常とみなす(Python側の swing/backtest/universe.py も
// 同じ考えで 2,500 件未満を異常として弾いている)。
const MIN_UNIVERSE: Record<Region, number> = { JP: 2500, US: 3000 };

const NASDAQ_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

const OUT_FILE: Record<Region, string> = {
  JP: 'universe.json',
  US: 'universe.us.json',
};

function jpSegment(div: string): MarketSegment | null {
  if (div.includes('プライム')) return 'Prime';
  if (div.includes('スタンダード')) return 'Standard';
  if (div.includes('グロース')) return 'Growth';
  // ETF/ETN/REIT/インフラファンド等も対象(SBIの急増ランキングに含まれるため)。
  // 時価総額比の①②③には出ないが、④急増ランキングで拾う。
  if (
    div.includes('ETF') ||
    div.includes('ETN') ||
    div.includes('REIT') ||
    div.includes('インフラファンド') ||
    div.includes('出資証券') ||
    div.includes('ベンチャーファンド') ||
    div.includes('カントリーファンド')
  ) {
    return 'Other';
  }
  return null; // PRO Market 等は対象外
}

/**
 * 配布ページのHTMLから data_j.xls / .xlsx への現在のリンクを抜き出す。
 * 相対パスで書かれているので絶対URLに直す。重複は畳む。
 */
export function extractJpxListingUrls(html: string, pageUrl = JPX_LISTING_PAGE): string[] {
  const found = [...html.matchAll(/href="([^"]*data_j\.xlsx?)"/gi)].map((m) => {
    try {
      return new URL(m[1], pageUrl).toString();
    } catch {
      return '';
    }
  });
  return [...new Set(found.filter(Boolean))];
}

async function discoverJpxListingUrls(): Promise<string[]> {
  try {
    const res = await fetch(JPX_LISTING_PAGE, { headers: { 'user-agent': UA } });
    if (!res.ok) {
      console.warn(`[universe:JP] 配布ページを開けない: ${res.status}`);
      return [];
    }
    return extractJpxListingUrls(await res.text());
  } catch (err) {
    console.warn('[universe:JP] 配布ページの取得に失敗:', err);
    return [];
  }
}

async function fetchJpxWorkbook(): Promise<Buffer> {
  const discovered = await discoverJpxListingUrls();
  const candidates = [...new Set([...discovered, JPX_LEGACY_XLS])];
  console.log(`[universe:JP] 候補URL ${candidates.length}件: ${candidates.join(' , ')}`);
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) {
        // 何が返ってきたかを残す。置き場所の変更(404)と遮断(403)では対処が
        // まったく違うのに、以前は状態コードすら追えていなかった。
        const body = await res.text().catch(() => '');
        failures.push(
          `${url} -> ${res.status} ${res.statusText} ` +
            `content-type=${res.headers.get('content-type') ?? '不明'} ` +
            `body=${JSON.stringify(body.slice(0, 120))}`,
        );
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[universe:JP] 一覧を取得: ${url} (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      failures.push(`${url} -> ${err}`);
    }
  }
  throw new Error(`JPXの上場一覧を取得できない:\n  ${failures.join('\n  ')}`);
}

async function buildJP(): Promise<UniverseEntry[]> {
  console.log('[universe:JP] downloading JPX listing...');
  const buf = await fetchJpxWorkbook();
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    wb.Sheets[wb.SheetNames[0]],
  );
  const universe: UniverseEntry[] = [];
  for (const row of rows) {
    const code = String(row['コード'] ?? '').trim();
    const name = String(row['銘柄名'] ?? '').trim();
    const market = jpSegment(String(row['市場・商品区分'] ?? ''));
    if (!code || !name || !market) continue;
    universe.push({ code, name, market });
  }
  return universe;
}

// パイプ区切りファイルをヘッダ付きで配列化(末尾の "File Creation Time" 行は除外)。
function parsePipe(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('File Creation Time'));
  if (lines.length === 0) return [];
  const header = lines[0].split('|');
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (cells[i] ?? '').trim()));
    return o;
  });
}

// 普通株のティッカーのみ(クラス株/優先株/ワラント等の特殊記号は除外)。
const isPlainTicker = (s: string) => /^[A-Z]{1,5}$/.test(s);

async function buildUS(): Promise<UniverseEntry[]> {
  console.log('[universe:US] downloading NASDAQ Trader symbol files...');
  const [nas, oth] = await Promise.all([
    fetch(NASDAQ_LISTED, { headers: { 'user-agent': UA } }).then((r) => r.text()),
    fetch(OTHER_LISTED, { headers: { 'user-agent': UA } }).then((r) => r.text()),
  ]);
  const universe: UniverseEntry[] = [];
  const seen = new Set<string>();

  for (const row of parsePipe(nas)) {
    const sym = row['Symbol'];
    if (row['Test Issue'] === 'Y' || row['ETF'] === 'Y') continue;
    if (!isPlainTicker(sym) || seen.has(sym)) continue;
    seen.add(sym);
    universe.push({ code: sym, name: row['Security Name'] || sym, market: 'NASDAQ' });
  }

  // otherlisted: Exchange A=NYSE American(AMEX), N=NYSE, P/Z/V 等は対象外。
  for (const row of parsePipe(oth)) {
    const sym = row['ACT Symbol'];
    if (row['Test Issue'] === 'Y' || row['ETF'] === 'Y') continue;
    if (!isPlainTicker(sym) || seen.has(sym)) continue;
    const ex = row['Exchange'];
    const market: MarketSegment | null = ex === 'N' ? 'NYSE' : ex === 'A' ? 'AMEX' : null;
    if (!market) continue;
    seen.add(sym);
    universe.push({ code: sym, name: row['Security Name'] || sym, market });
  }
  return universe;
}

async function enrichShares(region: Region, universe: UniverseEntry[]) {
  const auth = await getCrumb();
  if (!auth) {
    console.warn(`[universe:${region}] crumb 取得失敗。shares はビルド時に補完されます。`);
    return;
  }
  const shares = await fetchShares(universe.map((u) => u.code), auth, region);
  let filled = 0;
  for (const u of universe) {
    const s = shares.get(u.code);
    if (s) {
      u.shares = s;
      filled++;
    }
  }
  console.log(`[universe:${region}] shares filled for ${filled}/${universe.length}`);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const configDir = resolve(here, '../../config');
  mkdirSync(configDir, { recursive: true });

  const builders: Record<Region, () => Promise<UniverseEntry[]>> = { JP: buildJP, US: buildUS };
  const arg = process.argv.find((a) => a.startsWith('--region='));
  const only = arg ? (arg.split('=')[1].toUpperCase() as Region) : null;
  const regions: Region[] = only ? [only] : ['JP', 'US'];

  let failed = false;
  for (const region of regions) {
    try {
      const universe = await builders[region]();
      console.log(`[universe:${region}] ${universe.length} stocks`);
      // 極端に少ない結果は書き込まない。取得や解析が壊れても件数が0や数十で
      // 「成功」してしまい、既にある正しいユニバースを上書きするため。
      if (universe.length < MIN_UNIVERSE[region]) {
        throw new Error(
          `ユニバースが少なすぎる(${universe.length}件 < ${MIN_UNIVERSE[region]}件)。` +
            '取得か解析が壊れている可能性が高いので既存のconfigを残す',
        );
      }
      await enrichShares(region, universe);
      const out = resolve(configDir, OUT_FILE[region]);
      writeFileSync(out, JSON.stringify(universe, null, 0));
      console.log(`[universe:${region}] wrote ${out}`);
    } catch (err) {
      console.error(`[universe:${region}] failed:`, err);
      failed = true;
    }
  }
  // 1地域でも失敗したら異常終了する。以前は regions.length === 1 のときしか
  // 終了コードを立てておらず、JP/US を一度に回す通常運用では日本の取得が
  // 失敗しても `npm run universe` が成功扱いで終わっていた。そのため
  // デプロイは緑のまま、コミット済みの20銘柄フォールバックで資金流入
  // ランキングが作られ続けていた(実測: JP universe=20 / US universe=6,934)。
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[universe] failed:', e);
  process.exit(1);
});
