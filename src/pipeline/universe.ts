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

const JPX_XLS =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';
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

async function buildJP(): Promise<UniverseEntry[]> {
  console.log('[universe:JP] downloading JPX listing...');
  const res = await fetch(JPX_XLS, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`JPX download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
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
    fetch(NASDAQ_LISTED, { headers: { 'user-agent': 'Mozilla/5.0' } }).then((r) => r.text()),
    fetch(OTHER_LISTED, { headers: { 'user-agent': 'Mozilla/5.0' } }).then((r) => r.text()),
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

  for (const region of regions) {
    try {
      const universe = await builders[region]();
      console.log(`[universe:${region}] ${universe.length} stocks`);
      await enrichShares(region, universe);
      const out = resolve(configDir, OUT_FILE[region]);
      writeFileSync(out, JSON.stringify(universe, null, 0));
      console.log(`[universe:${region}] wrote ${out}`);
    } catch (err) {
      console.error(`[universe:${region}] failed:`, err);
      if (regions.length === 1) process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error('[universe] failed:', e);
  process.exit(1);
});
