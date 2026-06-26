import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Region } from '../core/types.js';
import { computeRankings } from '../core/rankings.js';
import { selectProvider } from '../data/provider.js';

// データ取得 → ランキング計算 → public/data/rankings(.us).json 出力。
// JP/US 両地域を生成する。半年(約120営業日)を見るため余裕をもって 130 営業日取得。
const LOOKBACK_DAYS = 130;

// 地域 → 出力ファイル名(US は .us 接尾辞、フロントは地域でロード先を切替)。
const OUT_FILE: Record<Region, string> = {
  JP: 'rankings.json',
  US: 'rankings.us.json',
};

async function buildRegion(region: Region, forceSample: boolean, outDir: string) {
  const provider = await selectProvider(region, forceSample);
  console.log(`[build:${region}] provider = ${provider.id}`);

  const bars = await provider.fetchBars({ lookbackDays: LOOKBACK_DAYS });
  console.log(`[build:${region}] fetched ${bars.length} bars`);

  const dataset = computeRankings(bars, {
    topN: 100,
    topK: 100,
    minCoverage: 0.6,
    source: provider.id,
    region,
  });

  const outPath = resolve(outDir, OUT_FILE[region]);
  writeFileSync(outPath, JSON.stringify(dataset));
  console.log(
    `[build:${region}] wrote ${outPath} (asOf=${dataset.asOfDate}, universe=${dataset.universe})`,
  );
}

async function main() {
  const forceSample = process.argv.includes('--sample');
  // 単一地域だけ生成したい場合: --region=us / --region=jp
  const arg = process.argv.find((a) => a.startsWith('--region='));
  const only = arg ? (arg.split('=')[1].toUpperCase() as Region) : null;
  const regions: Region[] = only ? [only] : ['JP', 'US'];

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, '../../public/data');
  mkdirSync(outDir, { recursive: true });

  for (const region of regions) {
    try {
      await buildRegion(region, forceSample, outDir);
    } catch (err) {
      // 片方の地域が失敗しても、もう片方は出力する。
      console.error(`[build:${region}] failed:`, err);
      if (regions.length === 1) process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
