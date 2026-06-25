import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import type { MarketSegment } from '../core/types';
import { fetchShares, getCrumb, type UniverseEntry } from '../data/yahoo.js';

// JPX公式「東証上場銘柄一覧」(data_j.xls)から全市場の内国株式ユニバースを生成し、
// Yahoo から発行済株式数を補完して config/universe.json に書き出す。
// ネットワーク開放環境(GitHub Actions 等)で実行する想定。

const JPX_XLS =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';

function segmentOf(div: string): MarketSegment | null {
  if (div.includes('プライム')) return 'Prime';
  if (div.includes('スタンダード')) return 'Standard';
  if (div.includes('グロース')) return 'Growth';
  return null; // ETF/REIT/PRO Market 等は対象外
}

async function main() {
  console.log('[universe] downloading JPX listing...');
  const res = await fetch(JPX_XLS, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
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
    const div = String(row['市場・商品区分'] ?? '');
    const market = segmentOf(div);
    if (!code || !name || !market) continue;
    universe.push({ code, name, market });
  }
  console.log(`[universe] ${universe.length} domestic stocks`);

  // 発行済株式数を Yahoo quote API で補完。
  const auth = await getCrumb();
  if (auth) {
    const shares = await fetchShares(
      universe.map((u) => u.code),
      auth,
    );
    let filled = 0;
    for (const u of universe) {
      const s = shares.get(u.code);
      if (s) {
        u.shares = s;
        filled++;
      }
    }
    console.log(`[universe] shares filled for ${filled}/${universe.length}`);
  } else {
    console.warn('[universe] crumb 取得失敗。shares はビルド時に補完されます。');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '../../config/universe.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(universe, null, 0));
  console.log(`[universe] wrote ${out}`);
}

main().catch((e) => {
  console.error('[universe] failed:', e);
  process.exit(1);
});
