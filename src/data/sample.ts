import type { DailyBar, MarketSegment, Region } from '../core/types';
import type { DataProvider, FetchOptions } from './provider';

// 認証情報やネットワークが無くても全機能を確認できる決定論的サンプル。
// 実データの代替であり、数値に意味はない。JP/US で別の銘柄群を生成する。

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

interface RegionCfg {
  seed: number;
  segments: MarketSegment[];
  capMin: number;
  capMax: number;
  priceMin: number;
  priceMax: number;
  decimals: number;
  ticker: (i: number) => string;
  name: (rng: () => number) => string;
}

const JP_PREFIX = ['テック', 'メディカル', 'グリーン', 'ネクスト', 'サン', 'ジャパン', 'スマート', 'デジタル', 'バイオ', 'フロンティア'];
const JP_SUFFIX = ['ホールディングス', 'システムズ', 'ソリューションズ', '製作所', '商事', 'エナジー', 'ファーマ', 'ロボティクス', 'ネットワーク', '工業'];
const US_PREFIX = ['Apex', 'Nova', 'Summit', 'Vertex', 'Pioneer', 'Quantum', 'Atlas', 'Orbital', 'Bright', 'Crest', 'Vanta', 'Lumen'];
const US_SUFFIX = ['Inc', 'Corp', 'Holdings', 'Technologies', 'Labs', 'Systems', 'Group', 'Networks', 'Pharma', 'Energy'];
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const CFG: Record<Region, RegionCfg> = {
  JP: {
    seed: 20260625,
    segments: ['Prime', 'Standard', 'Growth'],
    capMin: 3e9,
    capMax: 5e12, // 円
    priceMin: 200,
    priceMax: 6200,
    decimals: 1,
    ticker: (i) => String(1300 + i * 3).padStart(4, '0'),
    name: (rng) =>
      `${JP_PREFIX[Math.floor(rng() * JP_PREFIX.length)]}${JP_SUFFIX[Math.floor(rng() * JP_SUFFIX.length)]}`,
  },
  US: {
    seed: 20260626,
    segments: ['NYSE', 'NASDAQ', 'AMEX'],
    capMin: 3e8,
    capMax: 3e12, // ドル
    priceMin: 5,
    priceMax: 600,
    decimals: 2,
    ticker: (i) => {
      const n = i + 100; // 0..675 の範囲で3文字ユニーク
      return L[Math.floor(n / 676) % 26] + L[Math.floor(n / 26) % 26] + L[n % 26];
    },
    name: (rng) =>
      `${US_PREFIX[Math.floor(rng() * US_PREFIX.length)]} ${US_SUFFIX[Math.floor(rng() * US_SUFFIX.length)]}`,
  },
};

interface Profile {
  code: string;
  name: string;
  market: MarketSegment;
  baseCap: number;
  basePrice: number;
  inflow: number; // 平常時の 売買代金/時価総額
  surge: number; // 連日強い度合い 0..1
}

function buildUniverse(cfg: RegionCfg, rng: () => number, n: number): Profile[] {
  const profiles: Profile[] = [];
  for (let i = 0; i < n; i++) {
    const market = cfg.segments[Math.floor(rng() * cfg.segments.length)];
    const baseCap = Math.exp(Math.log(cfg.capMin) + rng() * (Math.log(cfg.capMax) - Math.log(cfg.capMin)));
    const basePrice = cfg.priceMin + rng() * (cfg.priceMax - cfg.priceMin);
    profiles.push({
      code: cfg.ticker(i),
      name: cfg.name(rng),
      market,
      baseCap,
      basePrice,
      inflow: 0.002 + Math.pow(rng(), 3) * 0.07,
      surge: Math.pow(rng(), 4),
    });
  }
  return profiles;
}

export class SampleProvider implements DataProvider {
  readonly id: string;

  constructor(private readonly region: Region = 'JP') {
    this.id = `sample-${region.toLowerCase()}`;
  }

  async fetchBars(opts: FetchOptions): Promise<DailyBar[]> {
    const cfg = CFG[this.region];
    const rng = mulberry32(cfg.seed);
    const universe = buildUniverse(cfg, rng, 320);
    const days = recentBusinessDays(opts.lookbackDays, new Date());
    const round = Math.pow(10, cfg.decimals);
    const bars: DailyBar[] = [];

    for (const p of universe) {
      let price = p.basePrice;
      const shares = p.baseCap / p.basePrice;
      days.forEach((date, idx) => {
        price *= 1 + (rng() - 0.5) * 0.05;
        const marketCap = price * shares;
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
          close: Math.round(price * round) / round,
          turnover: Math.round(turnover),
          marketCap: Math.round(marketCap),
        });
      });
    }
    return bars;
  }
}
