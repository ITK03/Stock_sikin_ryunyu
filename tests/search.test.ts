import { describe, expect, it } from 'vitest';
import { searchStocks } from '../src/core/search';
import type { RankingDataset, TickerIndexFile } from '../src/core/types';

function emptyDataset(overrides: Partial<RankingDataset> = {}): RankingDataset {
  return {
    generatedAt: '2026-07-11T00:00:00Z',
    asOfDate: '2026-07-11',
    region: 'JP',
    universe: 0,
    topK: 100,
    topN: 100,
    source: 'test',
    ranking1: [],
    ranking2: { '3d': [], '1w': [], '2w': [], '1m': [], '3m': [], '6m': [] },
    ranking3: { '3d': [], '1w': [], '2w': [], '1m': [], '3m': [], '6m': [] },
    ranking4: { '1d': [], '2d': [], '3d': [] },
    ...overrides,
  };
}

describe('searchStocks', () => {
  it('空クエリは空配列', () => {
    expect(searchStocks('', {})).toEqual([]);
    expect(searchStocks('   ', {})).toEqual([]);
  });

  it('コード前方一致でランキングから見つかる', () => {
    const rankingsJP = emptyDataset({
      ranking1: [
        { rank: 1, code: '7203', name: 'トヨタ自動車', market: 'Prime', ratio: 0.1, turnover: 1, marketCap: 1, coverage: 1 },
      ],
    });
    const results = searchStocks('720', { rankingsJP });
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe('7203');
    expect(results[0].region).toBe('JP');
  });

  it('銘柄名の部分一致で見つかる', () => {
    const rankingsJP = emptyDataset({
      ranking1: [
        { rank: 1, code: '7203', name: 'トヨタ自動車', market: 'Prime', ratio: 0.1, turnover: 1, marketCap: 1, coverage: 1 },
      ],
    });
    expect(searchStocks('トヨタ', { rankingsJP })).toHaveLength(1);
    expect(searchStocks('自動車', { rankingsJP })).toHaveLength(1);
    expect(searchStocks('ソニー', { rankingsJP })).toHaveLength(0);
  });

  it('ticker_index からも見つかる(所属セクター横断)', () => {
    const tickerIndex: TickerIndexFile = {
      schema_version: 2,
      generated_at: '2026-07-11T00:00:00Z',
      tickers: { '6758': { n: 'ソニーグループ', c: 1.2, p: 3000, s: [['半導体', 'A']] } },
    };
    const results = searchStocks('6758', { tickerIndex });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('ソニーグループ');
  });

  it('開示の会社名からも見つかるが、コード不正(非数値)は除外', () => {
    const disclosures = {
      updated_at: '2026-07-11T00:00:00Z',
      count: 2,
      items: [
        { id: 'a', time: '2026-07-11T00:00:00+09:00', code: '9861', company: '吉野家HD', title: 't', pdf_url: '', exchange: '', markets: '', source: 's', category: 'c', score: 0, impact: 'low' as const, direction: 'unknown' as const, urgent: false, summary: '', reasons: [], analyzed_by: 'rules', analyzed_at: '', confidence: 0, is_correction: false, tags: [] },
        { id: 'b', time: '2026-07-11T00:00:00+09:00', code: 'Copy', company: 'ゴミ値', title: 't', pdf_url: '', exchange: '', markets: '', source: 's', category: 'c', score: 0, impact: 'low' as const, direction: 'unknown' as const, urgent: false, summary: '', reasons: [], analyzed_by: 'rules', analyzed_at: '', confidence: 0, is_correction: false, tags: [] },
      ],
    };
    const results = searchStocks('吉野家', { disclosures });
    expect(results).toHaveLength(1);
    expect(searchStocks('ゴミ値', { disclosures })).toHaveLength(0);
  });

  it('同じコードが複数ソースにあっても重複しない', () => {
    const rankingsJP = emptyDataset({
      ranking1: [
        { rank: 1, code: '7203', name: 'トヨタ自動車', market: 'Prime', ratio: 0.1, turnover: 1, marketCap: 1, coverage: 1 },
      ],
    });
    const tickerIndex: TickerIndexFile = {
      schema_version: 2,
      generated_at: '2026-07-11T00:00:00Z',
      tickers: { '7203': { n: 'トヨタ自動車', c: 0.5, p: 3000, s: [] } },
    };
    expect(searchStocks('7203', { rankingsJP, tickerIndex })).toHaveLength(1);
  });

  it('コード完全一致を名称一致より優先して並べる', () => {
    const rankingsJP = emptyDataset({
      ranking1: [
        { rank: 1, code: '1234', name: 'よくある名前A', market: 'Prime', ratio: 0.1, turnover: 1, marketCap: 1, coverage: 1 },
        { rank: 2, code: '5678', name: '1234という名前', market: 'Prime', ratio: 0.1, turnover: 1, marketCap: 1, coverage: 1 },
      ],
    });
    const results = searchStocks('1234', { rankingsJP });
    expect(results[0].code).toBe('1234');
  });

  it('最大30件に制限する', () => {
    const ranking1 = Array.from({ length: 50 }, (_, i) => ({
      rank: i + 1,
      code: String(1000 + i),
      name: `テスト銘柄${i}`,
      market: 'Prime' as const,
      ratio: 0.1,
      turnover: 1,
      marketCap: 1,
      coverage: 1,
    }));
    const results = searchStocks('テスト', { rankingsJP: emptyDataset({ ranking1 }) });
    expect(results).toHaveLength(30);
  });
});
