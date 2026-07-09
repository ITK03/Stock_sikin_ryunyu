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

// 地域 → 取引所ローカルタイムゾーン。
const SESSION_TZ: Record<Region, string> = {
  JP: 'Asia/Tokyo',
  US: 'America/New_York',
};

// 地域 → 場中の取引時間帯(分, 0:00起点)。昼休みがあるのは JP のみ。
interface SessionWindow {
  openMin: number; // 寄り
  closeMin: number; // 引け
  breakStartMin?: number; // 休憩開始(昼休み)
  breakEndMin?: number; // 休憩終了
}
const SESSION_WINDOW: Record<Region, SessionWindow> = {
  // 9:00-11:30, 12:30-15:00 → 実質300分。
  JP: { openMin: 9 * 60, closeMin: 15 * 60, breakStartMin: 11 * 60 + 30, breakEndMin: 12 * 60 + 30 },
  // 9:30-16:00 → 390分。昼休みなし。
  US: { openMin: 9 * 60 + 30, closeMin: 16 * 60 },
};

/**
 * 取引所ローカルの現在日時から、当日の日付とセッション経過率(0..1]を求める。
 * 場が開く前(前日終値が確定済み)や引け後は progress=1(完全な日足)として扱う。
 * 昼休み中は経過時間が休憩開始時点で止まった状態(flat)として扱う。
 */
function sessionInfo(region: Region, now = new Date()): { date: string; progress: number } {
  const tz = SESSION_TZ[region];
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const date = dateFmt.format(now); // 'en-CA' は 'YYYY-MM-DD' 形式
  const [hh, mm] = timeFmt.format(now).split(':').map((v) => Number(v));
  const nowMin = hh * 60 + mm;

  const { openMin, closeMin, breakStartMin, breakEndMin } = SESSION_WINDOW[region];
  const breakLen = breakStartMin !== undefined && breakEndMin !== undefined ? breakEndMin - breakStartMin : 0;
  const tradingMinutes = closeMin - openMin - breakLen;

  let progress: number;
  if (nowMin < openMin) {
    progress = 1; // 寄り前は前営業日のデータが完全な日足
  } else if (nowMin >= closeMin) {
    progress = 1; // 引け後は当日データが確定
  } else {
    let elapsed: number;
    if (breakStartMin !== undefined && breakEndMin !== undefined && nowMin > breakStartMin) {
      // 昼休み中は休憩開始時点で頭打ち(flat)、再開後はそこから再加算。
      elapsed = nowMin < breakEndMin
        ? breakStartMin - openMin
        : (breakStartMin - openMin) + (nowMin - breakEndMin);
    } else {
      elapsed = nowMin - openMin;
    }
    progress = Math.max(0, Math.min(1, elapsed / tradingMinutes));
  }
  return { date, progress };
}

async function buildRegion(region: Region, forceSample: boolean, outDir: string) {
  const provider = await selectProvider(region, forceSample);
  console.log(`[build:${region}] provider = ${provider.id}`);

  const bars = await provider.fetchBars({ lookbackDays: LOOKBACK_DAYS });
  console.log(`[build:${region}] fetched ${bars.length} bars`);

  const session = sessionInfo(region);
  console.log(`[build:${region}] session date=${session.date} progress=${session.progress.toFixed(2)}`);

  const dataset = computeRankings(bars, {
    // 市場フィルタ後も各区分(プライム/スタンダード/グロース等)に十分な件数が
    // 残るよう、集計の深さを広めに取る。③は全市場売買代金上位 topK に限定される
    // 性質上、これとは別に大型株中心になる。
    topN: 300,
    topK: 100,
    minCoverage: 0.6,
    source: provider.id,
    region,
    intraday: { date: session.date, progress: session.progress },
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
