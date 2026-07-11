import { describe, expect, it } from 'vitest';
import { buildStockProfile } from '../src/core/crosslink';
import { computeRankings } from '../src/core/rankings';
import type { DailyBar, Disclosure, DisclosuresFeed, SectorFile, TickerIndexFile } from '../src/core/types';

function dates(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`2026-01-${String(i + 1).padStart(2, '0')}`);
  return out;
}

function bar(date: string, code: string, name: string, turnover: number, marketCap: number): DailyBar {
  return { date, code, name, market: 'Prime', close: 100, turnover, marketCap };
}

function makeRankings(codes: { code: string; name: string; turnover: number }[]) {
  const ds = dates(5);
  const bars: DailyBar[] = [];
  for (const d of ds) {
    for (const c of codes) bars.push(bar(d, c.code, c.name, c.turnover, 1000));
  }
  return computeRankings(bars, { source: 'test', minCoverage: 0.5 });
}

function makeDisclosure(overrides: Partial<Disclosure>): Disclosure {
  return {
    id: overrides.id ?? 'id1',
    time: overrides.time ?? '2026-07-10T10:00:00+09:00',
    code: overrides.code ?? '7203',
    company: overrides.company ?? 'トヨタ自動車',
    title: overrides.title ?? 'お知らせ',
    pdf_url: '',
    exchange: '東証',
    markets: '',
    source: 'scraper',
    category: 'その他開示',
    score: 50,
    impact: 'low',
    direction: 'unknown',
    urgent: false,
    summary: '',
    reasons: [],
    analyzed_by: 'rules',
    analyzed_at: '2026-07-10T10:00:00+09:00',
    confidence: 50,
    is_correction: false,
    tags: [],
    ...overrides,
  };
}

describe('buildStockProfile', () => {
  it('コードが不正なら null を返す', () => {
    expect(buildStockProfile('', {})).toBeNull();
    expect(buildStockProfile('  ', {})).toBeNull();
  });

  it('どのソースも無い場合はコードのみで、他は null/空配列', () => {
    const p = buildStockProfile('7203', {});
    expect(p).not.toBeNull();
    expect(p!.code).toBe('7203');
    expect(p!.name).toBeNull();
    expect(p!.price).toBeNull();
    expect(p!.changePct).toBeNull();
    expect(p!.sectors).toEqual([]);
    expect(p!.rankings).toEqual([]);
    expect(p!.disclosures).toEqual([]);
  });

  it('ランキングデータから順位・名称を拾う(①②③それぞれ)', () => {
    const rankingsJP = makeRankings([
      { code: '7203', name: 'トヨタ自動車', turnover: 900 },
      { code: '9999', name: 'ダミー', turnover: 10 },
    ]);
    const p = buildStockProfile('7203', { rankingsJP });
    expect(p!.name).toBe('トヨタ自動車');
    expect(p!.rankings).toHaveLength(1);
    const info = p!.rankings[0];
    expect(info.region).toBe('JP');
    expect(info.ranking1).toBe(1);
    expect(info.ranking2.length).toBeGreaterThan(0);
    expect(info.ranking3.length).toBeGreaterThan(0);
  });

  it('コード表記が ".T" 付きでも正規化して一致させる', () => {
    const rankingsJP = makeRankings([{ code: '6758', name: 'ソニーG', turnover: 500 }]);
    const p = buildStockProfile('6758.T', { rankingsJP });
    expect(p!.code).toBe('6758');
    expect(p!.name).toBe('ソニーG');
    expect(p!.rankings[0].ranking1).toBe(1);
  });

  it('ticker_index.json(日本株)から名称・現在値・騰落率・所属セクターを埋める', () => {
    const tickerIndex: TickerIndexFile = {
      schema_version: 2,
      generated_at: '2026-07-11T10:00:00Z',
      tickers: {
        '6758': { n: 'ソニーG', c: 2.1, p: 12345, s: [['半導体', 'S']] },
      },
    };
    const p = buildStockProfile('6758', { tickerIndex });
    expect(p!.name).toBe('ソニーG');
    expect(p!.price).toBe(12345);
    expect(p!.changePct).toBe(2.1);
    expect(p!.sectors).toEqual([{ name: '半導体', tier: 'S', market: 'JP' }]);
  });

  it('米国株は sector_us.json の構成銘柄一覧からベストエフォートで拾う(現在値は無い)', () => {
    const sectorUS: SectorFile = {
      schema_version: 2,
      generated_at: '2026-07-11T10:00:00Z',
      market: 'US',
      sectors: [
        {
          name: 'Semiconductors',
          change_pct: 1.5,
          count: 50,
          members: [{ code: 'NVDA', name: 'NVIDIA Corp', tier: 'S', change_pct: 3.2 }],
        },
      ],
    };
    const p = buildStockProfile('NVDA', { sectorUS });
    expect(p!.name).toBe('NVIDIA Corp');
    expect(p!.price).toBeNull();
    expect(p!.changePct).toBe(3.2);
    expect(p!.sectors).toEqual([{ name: 'Semiconductors', tier: 'S', market: 'US' }]);
  });

  it('ticker_index/sector_us どちらにも無ければランキングの名称で代替する', () => {
    const rankingsJP = makeRankings([{ code: '7203', name: 'トヨタ自動車', turnover: 500 }]);
    const p = buildStockProfile('7203', { rankingsJP, tickerIndex: null, sectorUS: null });
    expect(p!.name).toBe('トヨタ自動車');
    expect(p!.price).toBeNull();
    expect(p!.sectors).toEqual([]);
  });

  it('開示データからコード一致するものだけを新しい順に抽出する', () => {
    const disclosures: DisclosuresFeed = {
      updated_at: '2026-07-11T10:00:00+09:00',
      count: 3,
      items: [
        makeDisclosure({ id: 'a', code: '7203', time: '2026-07-09T10:00:00+09:00', title: '古い開示' }),
        makeDisclosure({ id: 'b', code: '7203', time: '2026-07-10T10:00:00+09:00', title: '新しい開示' }),
        makeDisclosure({ id: 'c', code: '9999', time: '2026-07-11T10:00:00+09:00', title: '別銘柄' }),
        makeDisclosure({ id: 'd', code: '', time: '2026-07-11T11:00:00+09:00', title: 'コード不明' }),
      ],
    };
    const p = buildStockProfile('7203', { disclosures });
    expect(p!.disclosures.map((d) => d.id)).toEqual(['b', 'a']);
  });

  it('開示のコードが ".T" やスペース付きでも一致させる', () => {
    const disclosures: DisclosuresFeed = {
      updated_at: '2026-07-11T10:00:00+09:00',
      count: 1,
      items: [makeDisclosure({ id: 'a', code: ' 7203 ' })],
    };
    const p = buildStockProfile('7203', { disclosures });
    expect(p!.disclosures).toHaveLength(1);
  });
});
