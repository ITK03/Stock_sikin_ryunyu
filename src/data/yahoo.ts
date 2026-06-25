import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DailyBar, MarketSegment } from '../core/types';
import type { DataProvider, FetchOptions } from './provider';

// Yahoo Finance(無料・APIキー不要)プロバイダ。
//  - 株価/出来高の履歴: chart API v8(認証不要)
//  - 発行済株式数(時価総額用): quote API v7(crumb + cookie が必要)
//
// 指標の算出(無料データの制約):
//  - 売買代金 ≈ 終値 × 出来高(出来高代金の近似。真の売買代金 Σ価格×数量 は
//    無料では銘柄横断・履歴で取得できないため、強く相関するこの近似を用いる)
//  - 時価総額 = 終値 × 発行済株式数
//
// 対象銘柄(ユニバース)は config/universe.json から読む(`npm run universe` で生成)。
// このリポジトリのサンドボックスは外部ドメインがegress制限で遮断されるため、
// 実取得は GitHub Actions(ネットワーク開放)上で走る前提。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface UniverseEntry {
  code: string; // 4桁コード 例 '7203'
  name: string;
  market: MarketSegment;
  /** 発行済株式数。未取得なら provider が quote API で補完する。 */
  shares?: number;
}

interface ChartResult {
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
}

/**
 * Yahoo chart API のレスポンスを DailyBar[] へ変換する純粋関数(テスト対象)。
 * 売買代金 ≈ 終値 × 出来高、時価総額 = 終値 × 発行済株式数。
 */
export function barsFromChart(
  json: any,
  entry: UniverseEntry,
  shares: number,
  lookbackDays: number,
): DailyBar[] {
  const result: ChartResult | undefined = json?.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  const closes = q?.close ?? [];
  const volumes = q?.volume ?? [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    const volume = volumes[i];
    if (close == null || volume == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    bars.push({
      date,
      code: entry.code,
      name: entry.name,
      market: entry.market,
      close,
      turnover: close * volume, // ≈ 売買代金
      marketCap: close * shares,
    });
  }
  return bars.slice(-lookbackDays);
}

async function fetchJson(url: string, headers: Record<string, string>, attempts = 3): Promise<any> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** a));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** a));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 4桁コードを Yahoo の東証シンボルへ。 */
export const toSymbol = (code: string): string => `${code}.T`;

export function loadUniverse(): UniverseEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../config/universe.json');
  return JSON.parse(readFileSync(path, 'utf8')) as UniverseEntry[];
}

/** Yahoo の cookie + crumb を取得(quote API に必須)。失敗時は空を返す。 */
export async function getCrumb(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const seed = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA } });
    const cookie = (seed.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'user-agent': UA, cookie },
    });
    const crumb = (await res.text()).trim();
    if (!crumb || crumb.includes('<')) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

/** quote API でコード→発行済株式数を取得(100件ずつバッチ)。 */
export async function fetchShares(
  codes: string[],
  auth: { cookie: string; crumb: string },
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const symbols = batch.map(toSymbol).join(',');
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const json = await fetchJson(url, { cookie: auth.cookie });
      for (const r of json?.quoteResponse?.result ?? []) {
        const code = String(r.symbol ?? '').replace(/\.T$/, '');
        const sh = Number(r.sharesOutstanding);
        if (code && Number.isFinite(sh) && sh > 0) map.set(code, sh);
      }
    } catch {
      // バッチ失敗は無視(該当銘柄は時価総額を出せず除外)。
    }
  }
  return map;
}

export class YahooProvider implements DataProvider {
  readonly id = 'yahoo';

  async fetchBars(opts: FetchOptions): Promise<DailyBar[]> {
    const universe = loadUniverse();

    // 発行済株式数: universe に無いものを quote API で補完。
    const shares = new Map<string, number>();
    for (const u of universe) if (u.shares && u.shares > 0) shares.set(u.code, u.shares);
    const missing = universe.filter((u) => !shares.has(u.code)).map((u) => u.code);
    if (missing.length > 0) {
      const auth = await getCrumb();
      if (auth) {
        const fetched = await fetchShares(missing, auth);
        for (const [c, s] of fetched) shares.set(c, s);
      }
    }

    const meta = new Map(universe.map((u) => [u.code, u]));
    // 半年(約120営業日)を確実に含むため range=1y を取り、直近 lookbackDays に絞る。
    const range = opts.lookbackDays > 120 ? '1y' : '6mo';

    const perCode = await mapLimit(universe, 8, async (u) => {
      const sh = shares.get(u.code);
      if (!sh) return [] as DailyBar[];
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${toSymbol(u.code)}?range=${range}&interval=1d`;
      try {
        const json = await fetchJson(url, {});
        return barsFromChart(json, u, sh, opts.lookbackDays);
      } catch {
        return [] as DailyBar[];
      }
    });

    void meta;
    return perCode.flat();
  }
}
