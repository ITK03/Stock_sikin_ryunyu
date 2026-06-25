import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRankings } from '../core/rankings.js';
import { selectProvider } from '../data/provider.js';

// データ取得 → ランキング計算 → public/data/rankings.json 出力。
// 半年(約120営業日)を見るため余裕をもって 130 営業日取得する。
const LOOKBACK_DAYS = 130;

async function main() {
  const forceSample = process.argv.includes('--sample');
  const provider = await selectProvider(forceSample);
  console.log(`[build] provider = ${provider.id}`);

  const bars = await provider.fetchBars({ lookbackDays: LOOKBACK_DAYS });
  console.log(`[build] fetched ${bars.length} bars`);

  const dataset = computeRankings(bars, {
    topN: 100,
    topK: 100,
    minCoverage: 0.6,
    source: provider.id,
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, '../../public/data/rankings.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(dataset));
  console.log(
    `[build] wrote ${outPath} (asOf=${dataset.asOfDate}, universe=${dataset.universe})`,
  );
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
