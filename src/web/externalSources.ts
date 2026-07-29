// 同一オーナー(ITK03)の他リポジトリが公開するデータソース定義。

import type { Region } from '../core/types';

// 資金流入ランキング(本リポジトリの build:data 生成物)。
// 以前は Pages にバンドルされたコピーだけを読んでいたため、株価の更新頻度が
// 「Build and Deploy の実行間隔」に律速されていた。GitHub の cron は宣言通りには
// 起動せず(実測で1〜4時間の空白が出る)、寄り付き直後に前日夜の値が出たままになる、
// 更新ボタンを押しても同じデプロイ成果物を取り直すだけで何も変わらない、という
// 不具合の原因になっていた。
// そこで data-refresh ワークフローが数分おきに `data-rankings` orphanブランチへ
// force-push したものを raw から優先して読む。Pages のコピーはフォールバックとして
// 残す(ブランチ配信が止まってもアプリは動く)。
export function rankingsUrls(region: Region, bust = false): string[] {
  const file = region === 'US' ? 'rankings.us.json' : 'rankings.json';
  // raw も Pages も CDN が5分キャッシュするため、明示更新時はクエリで確実に破る。
  const q = bust ? `?t=${Date.now()}` : '';
  return [
    `https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/data-rankings/${file}${q}`,
    `${import.meta.env.BASE_URL}data/${file}${q}`,
  ];
}

// 開示データの配信元。
//
// 生成元の Stock_open_news は非公開リポジトリのため、raw も GitHub Pages も
// ブラウザからは読めない(リポジトリ単位で404)。そこで生成側のワークフローが
// 配信ぶんだけを本リポジトリ(公開)の `data-disclosures` ブランチへ同期し、
// ダッシュボードはそこから読む。セクターデータと同じ方式。
//
// 旧URL(Stock_open_news の raw / Pages)はフォールバックとして残す:
// 生成元を再び公開に戻した場合はそちらでも動く。
const DISCLOSURES_BRANCH =
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/data-disclosures';

export const DISCLOSURES_URLS = [
  `${DISCLOSURES_BRANCH}/disclosures.json`,
  'https://raw.githubusercontent.com/ITK03/Stock_open_news/data/disclosures.json',
  'https://itk03.github.io/Stock_open_news/data/disclosures.json',
];

// 開示の日付別アーカイブ索引(過去日に遡って閲覧するための日付一覧)。
export const DISCLOSURES_ARCHIVE_INDEX_URLS = [
  `${DISCLOSURES_BRANCH}/archive/index.json`,
  'https://itk03.github.io/Stock_open_news/data/archive/index.json',
];

/** 指定日(YYYY-MM-DD)の開示アーカイブの候補URL。disclosures.json と同形。 */
export function disclosuresArchiveUrls(date: string): string[] {
  return [
    `${DISCLOSURES_BRANCH}/archive/${date}.json`,
    `https://itk03.github.io/Stock_open_news/data/archive/${date}.json`,
  ];
}

// セクター(sector-monitor 生成 → Stock_sikin_ryunyu/public/data/ に同期)。
// sector-monitor は private なため、本リポジトリ(public)経由で配信する。
// raw.githubusercontent.com は push 直後から反映される(CDN 5分キャッシュ)。
// GitHub Pages(dist/data/)は次回ビルドまでラグがあるためフォールバック。
//
// bust=true は「更新ボタン」など明示的な再取得のときだけ付ける。raw も Pages も
// CDN が5分キャッシュするため、クエリを変えないと押しても同じ内容が返ってくる
// (fetch の cache:'no-store' はブラウザキャッシュしか無効化できない)。
// 常時付けると数MBのJSONがタブ切替のたびに再転送されるので既定は false。
export function sectorUrls(region: Region, bust = false): string[] {
  const file = region === 'US' ? 'sector_us.json' : 'sector_jp.json';
  const q = bust ? `?t=${Date.now()}` : '';
  return [
    `https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/main/public/data/${file}${q}`,
    `https://itk03.github.io/Stock_sikin_ryunyu/data/${file}${q}`,
  ];
}

export const SECTOR_JP_URL = sectorUrls('JP');
export const SECTOR_US_URL = sectorUrls('US');

// スイングスクリーナー(swing/ で生成 → 本リポジトリ public/data/ にコミット)。
// swing-screener ワークフローが commit するため、raw を優先(push直後に反映)し
// Pages をフォールバックにする(セクターデータと同じ配信方式)。
// スイング: signals.json / paper_log.json は肥大化対策で「data」orphanブランチ
// (force-push配信)へ移行。raw のdataブランチを優先し、Pagesにバンドルされた
// 前回デプロイ時点のコピーをフォールバックにする。
export const SWING_SIGNALS_URLS = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/data/signals.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/signals.json',
];

// 検証ログ(自動ペーパートレードの pending/open/closed 明細)。
export const SWING_PAPER_LOG_URLS = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/data/paper_log.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/paper_log.json',
];

// 銘柄横断インデックス(日本株のみ・所属セクターは全件)。銘柄詳細を最初に開いたときに遅延fetch。
export const TICKER_INDEX_URL = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/main/public/data/ticker_index.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/ticker_index.json',
];

/**
 * 開示レーダー本家(Stock_open_news の GitHub Pages)。
 * 生成元リポジトリを非公開にしたため Pages は配信されない(404)。
 * 空文字にするとヘッダーのリンク自体が表示されない。
 * 再び公開に戻した場合はURLを書き戻せばリンクが復活する。
 */
export const DISCLOSURE_RADAR_URL = '';

/**
 * リアルタイム版セクターモニター(Streamlit)の公開URL。
 * 空の場合、ヘッダー/フッターのリンク自体を表示しない。
 */
export const SECTOR_MONITOR_STREAMLIT_URL = 'https://sector-monitor-zt4j9l8nx.streamlit.app';
