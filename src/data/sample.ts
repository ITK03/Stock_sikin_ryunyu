import type { DailyBar, MarketSegment } from '../core/types';
import type { DataProvider, FetchOptions } from './provider';

// 認証情報やネットワークが無くても全機能を確認できる決定論的サンプル。
// 実データの代替であり、数値に意味はない。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 直近 count 営業日の日付(土日のみ除外、祝日は簡略化のため無視)。 */
function recentBusinessDays(count: number, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(end);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

const SEGMENTS: MarketSegment[] = ['Prime', 'Standard', 'Growth'];

const NAME_PREFIX = ['テック', 'メディカル', 'グリーン', 'ネクスト', 'サン', 'ジャパン', 'スマート', 'デジタル', 'バイオ', 'フロンティア'];
const NAME_SUFFIX = ['ホールディングス', 'システムズ', 'ソリューションズ', '製作所', '商事', 'エナジー', 'ファーマ', 'ロボティクス', 'ネットワーク', '工業'];

interface Profile {
  code: string;
  name: string;
  market: MarketSegment;
  baseCap: number; // 時価総額の基準(円)
  basePrice: number; // 株価の基準(円)
  /** 資金流入の強さ(平常時の売買代金/時価総額の中央値, 0.001..0.15)。 */
  inflow: number;
  /** 直近で資金流入が継続的に高まっている度合い(0..1)。 */
  surge: number;
}

function buildUniverse(rng: () => number, n: number): Profile[] {
  const profiles: Profile[] = [];
  for (let i = 0; i < n; i++) {
    const code = String(1300 + i * 3).padStart(4, '0');
    const name = `${NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)]}${NAME_SUFFIX[Math.floor(rng() * NAME_SUFFIX.length)]}`;
    const market = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
    // 時価総額は対数一様で 30億〜5兆円程度に分布。
    const baseCap = Math.exp(Math.log(3e9) + rng() * (Math.log(5e12) - Math.log(3e9)));
    const basePrice = 200 + rng() * 6000;
    const inflow = 0.002 + Math.pow(rng(), 3) * 0.07; // 多くは低く、一部が高回転
    const surge = Math.pow(rng(), 4); // 一部の銘柄だけ連日強い
    profiles.push({ code, name, market, baseCap, basePrice, inflow, surge });
  }
  return profiles;
}

export class SampleProvider implements DataProvider {
  readonly id = 'sample';

  async fetchBars(opts: FetchOptions): Promise<DailyBar[]> {
    const rng = mulberry32(20260625);
    const universe = buildUniverse(rng, 320);
    const days = recentBusinessDays(opts.lookbackDays, new Date());
    const bars: DailyBar[] = [];

    for (const p of universe) {
      let price = p.basePrice;
      const shares = p.baseCap / p.basePrice;
      days.forEach((date, idx) => {
        // 価格は緩やかなランダムウォーク。
        price *= 1 + (rng() - 0.5) * 0.05;
        const marketCap = price * shares;
        // 期間の終盤ほど surge が効いて売買代金が膨らむ。
        const recency = idx / Math.max(1, days.length - 1);
        const surgeMult = 1 + p.surge * recency * 4;
        const noise = 0.5 + rng();
        const dayRatio = Math.min(0.45, p.inflow * surgeMult * noise);
        const turnover = marketCap * dayRatio;
        bars.push({
          date,
          code: p.code,
          name: p.name,
          market: p.market,
          close: Math.round(price * 10) / 10,
          turnover: Math.round(turnover),
          marketCap: Math.round(marketCap),
        });
      });
    }
    return bars;
  }
}
