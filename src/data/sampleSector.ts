import type { SectorFile, TickerIndexFile } from '../core/types';

// 認証情報やネットワークが無くても「セクター」タブ・銘柄詳細を確認できる決定論的サンプル。
// スキーマは sector-monitor の契約 schema_version 2 に準拠(地域ごとにファイル分割、
// members は上位30件のみ、ticker_index は日本株のみ・所属セクター全件)。
// JPのコードはランキングのサンプルデータ(src/data/sample.ts, ticker(i)=1300+i*3)と
// 一部重複させ、銘柄詳細での横断連携をサンプルモードでも確認できるようにしている。

export const SAMPLE_SECTOR_JP: SectorFile = {
  schema_version: 2,
  generated_at: '2026-07-11T15:30:00Z',
  market: 'JP',
  sectors: [
    {
      name: '半導体',
      change_pct: 3.42,
      count: 3,
      members: [
        { code: '1300', name: 'テックホールディングス', tier: 'S', change_pct: 5.1 },
        { code: '1303', name: 'メディカルシステムズ', tier: 'A', change_pct: 2.8 },
        { code: '1330', name: 'デジタルロボティクス', tier: 'B', change_pct: 1.2 },
      ],
    },
    {
      name: '内需・消費',
      change_pct: -0.85,
      count: 2,
      members: [
        { code: '1306', name: 'グリーンネクスト工業', tier: 'A', change_pct: -1.4 },
        { code: '1309', name: 'サンフロンティア商事', tier: 'B', change_pct: -0.3 },
      ],
    },
    {
      name: '創薬・バイオ',
      change_pct: 1.95,
      count: 2,
      members: [
        { code: '1312', name: 'ジャパンファーマ', tier: 'S', change_pct: 4.2 },
        { code: '1350', name: 'フロンティアバイオ', tier: 'C', change_pct: -0.5 },
      ],
    },
    {
      name: '銀行・金融',
      change_pct: null,
      count: 1,
      members: [{ code: '1360', name: 'ネクスト商事', tier: 'B', change_pct: null }],
    },
  ],
};

export const SAMPLE_SECTOR_US: SectorFile = {
  schema_version: 2,
  generated_at: '2026-07-11T15:30:00Z',
  market: 'US',
  sectors: [
    {
      name: 'Semiconductors',
      change_pct: 2.1,
      count: 2,
      members: [
        { code: 'AAA', name: 'Apex Technologies', tier: 'S', change_pct: 3.3 },
        { code: 'NVX', name: 'Nova Vertex Inc', tier: 'A', change_pct: 0.9 },
      ],
    },
    {
      name: 'Software',
      change_pct: -1.1,
      count: 1,
      members: [{ code: 'QTM', name: 'Quantum Systems Corp', tier: 'B', change_pct: -1.1 }],
    },
  ],
};

// ticker_index.json は日本株のみ・所属セクターは全件(sector_jp.json の上位30件制限を受けない)。
export const SAMPLE_TICKER_INDEX: TickerIndexFile = {
  schema_version: 2,
  generated_at: '2026-07-11T15:30:00Z',
  tickers: {
    '1300': { n: 'テックホールディングス', c: 5.1, p: 4820, s: [['半導体', 'S']] },
    '1303': { n: 'メディカルシステムズ', c: 2.8, p: 2310, s: [['半導体', 'A']] },
    '1330': { n: 'デジタルロボティクス', c: 1.2, p: 980, s: [['半導体', 'B']] },
    '1306': { n: 'グリーンネクスト工業', c: -1.4, p: 1560, s: [['内需・消費', 'A']] },
    '1309': { n: 'サンフロンティア商事', c: -0.3, p: 720, s: [['内需・消費', 'B']] },
    '1312': { n: 'ジャパンファーマ', c: 4.2, p: 3150, s: [['創薬・バイオ', 'S']] },
    '1350': { n: 'フロンティアバイオ', c: -0.5, p: 410, s: [['創薬・バイオ', 'C']] },
    '1360': { n: 'ネクスト商事', c: null, p: null, s: [['銀行・金融', 'B']] },
  },
};
