// 同一オーナー(ITK03)の他リポジトリが公開するデータソース定義。

// 開示(Stock_open_news): GitHub Pages を優先し、失敗時は raw.githubusercontent.com へ。
export const DISCLOSURES_URLS = [
  'https://itk03.github.io/Stock_open_news/data/disclosures.json',
  'https://raw.githubusercontent.com/ITK03/Stock_open_news/main/docs/data/disclosures.json',
];

// 開示の日付別アーカイブ索引(過去日に遡って閲覧するための日付一覧)。
export const DISCLOSURES_ARCHIVE_INDEX_URLS = [
  'https://itk03.github.io/Stock_open_news/data/archive/index.json',
  'https://raw.githubusercontent.com/ITK03/Stock_open_news/main/docs/data/archive/index.json',
];

/** 指定日(YYYY-MM-DD)の開示アーカイブの候補URL。disclosures.json と同形。 */
export function disclosuresArchiveUrls(date: string): string[] {
  return [
    `https://itk03.github.io/Stock_open_news/data/archive/${date}.json`,
    `https://raw.githubusercontent.com/ITK03/Stock_open_news/main/docs/data/archive/${date}.json`,
  ];
}

// セクター(sector-monitor 生成 → Stock_sikin_ryunyu/public/data/ に同期)。
// sector-monitor は private なため、本リポジトリ(public)経由で配信する。
// raw.githubusercontent.com は push 直後から反映される(CDN 5分キャッシュ)。
// GitHub Pages(dist/data/)は次回ビルドまでラグがあるためフォールバック。
export const SECTOR_JP_URL = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/main/public/data/sector_jp.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/sector_jp.json',
];
export const SECTOR_US_URL = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/main/public/data/sector_us.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/sector_us.json',
];

// 銘柄横断インデックス(日本株のみ・所属セクターは全件)。銘柄詳細を最初に開いたときに遅延fetch。
export const TICKER_INDEX_URL = [
  'https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/main/public/data/ticker_index.json',
  'https://itk03.github.io/Stock_sikin_ryunyu/data/ticker_index.json',
];

/** 開示レーダー本家(Stock_open_news の GitHub Pages)。 */
export const DISCLOSURE_RADAR_URL = 'https://itk03.github.io/Stock_open_news/';

/**
 * リアルタイム版セクターモニター(Streamlit)の公開URL。
 * sector-monitor リポジトリのドキュメントに share.streamlit.io へのデプロイ手順は
 * あるが、確認時点で本番公開URL(*.streamlit.app)は見つからなかったため空にしている。
 * 空の場合、ヘッダー/フッターのリンク自体を表示しない。
 */
export const SECTOR_MONITOR_STREAMLIT_URL = '';
