// 同一オーナー(ITK03)の他リポジトリが公開するデータソース定義。

// 開示(Stock_open_news): GitHub Pages を優先し、失敗時は raw.githubusercontent.com へ。
export const DISCLOSURES_URLS = [
  'https://itk03.github.io/Stock_open_news/data/disclosures.json',
  'https://raw.githubusercontent.com/ITK03/Stock_open_news/main/docs/data/disclosures.json',
];

// セクター(sector-monitor, データ契約 schema_version 2): 専用ブランチ `data` のルート直下。
// 旧 itk03.github.io 系のセクターURLは廃止された。地域ごとにファイルが分割され、
// 数MB規模になり得るため JP/US はタブ切替時に遅延fetchする(externalData.ts 側で制御)。
export const SECTOR_JP_URL = ['https://raw.githubusercontent.com/ITK03/sector-monitor/data/sector_jp.json'];
export const SECTOR_US_URL = ['https://raw.githubusercontent.com/ITK03/sector-monitor/data/sector_us.json'];

// 銘柄横断インデックス(日本株のみ・所属セクターは全件)。銘柄詳細を最初に開いたときに遅延fetch。
export const TICKER_INDEX_URL = ['https://raw.githubusercontent.com/ITK03/sector-monitor/data/ticker_index.json'];

/** 開示レーダー本家(Stock_open_news の GitHub Pages)。 */
export const DISCLOSURE_RADAR_URL = 'https://itk03.github.io/Stock_open_news/';

/**
 * リアルタイム版セクターモニター(Streamlit)の公開URL。
 * sector-monitor リポジトリのドキュメントに share.streamlit.io へのデプロイ手順は
 * あるが、確認時点で本番公開URL(*.streamlit.app)は見つからなかったため空にしている。
 * 空の場合、ヘッダー/フッターのリンク自体を表示しない。
 */
export const SECTOR_MONITOR_STREAMLIT_URL = '';
