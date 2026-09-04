"""売買対象ユニバース: 東証プライム全銘柄（内国株式）。

実行時にJPX公開の上場銘柄一覧(data_j.xls)を取得し、市場区分が
「プライム（内国株式）」の4桁コードを抽出する（約1,600銘柄）。
GitHub Actionsランナーのようにインターネットへ出られる環境で機能する。
取得に失敗した環境では大型株フォールバック(_FALLBACK, 約120銘柄)を用いる。
結果はモジュール内でメモ化し、1プロセスで1回だけ取得する。
"""
from __future__ import annotations

import re

# JPX「その他統計資料 > 東証上場銘柄一覧」の配布ページ。
# ファイル本体は .../misc/<ハッシュ>-att/data_j.xls という形で、この <ハッシュ> は
# JPX 側の都合で入れ替わる。直書きしていた tvdivq0000001vg2-att は実際に 404 に
# なっており、ユニバース取得が失敗して129銘柄のフォールバックで動き続けていた
# （signals.json の universe_count が 128 になっていたのはこれ）。推測でURLを
# 書き換えても次の入れ替えでまた壊れるので、配布ページから現在のリンクを読む。
JPX_LISTING_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
# 旧URL。配布ページから拾えなかったときの最後の候補として残す。
JPX_URL = ("https://www.jpx.co.jp/markets/statistics-equities/misc/"
           "tvdivq0000001vg2-att/data_j.xls")
_UA = {"User-Agent": "Mozilla/5.0"}
_JPX_HREF_RE = re.compile(r'href="([^"]*data_j\.xlsx?)"', re.I)

# 不正OHLC（データ品質問題）が確認された銘柄。スクリーナー・バックテスト双方の
# ユニバースから除外する。
# - 7944, 8303, 8919: 終値が0以下になる区間があり明確に不正（research/round6で発覚）。
# - 1773, 4392, 6740, 8103, 8227: 単日騰落率60%超（東証の通常の値幅制限を超える）を
#   検出（2026-07-22, data/full/ 全期間スキャン）。TOB等による特別気配・長期売買停止後の
#   基準値リセットなど正当な値動きの可能性を排除できていないため「未確認」だが、
#   通常の値幅制限では説明できない値のためシグナル品質保護のため予防的に除外する。
EXCLUDED_TICKERS = {"7944", "8303", "8919", "1773", "4392", "6740", "8103", "8227"}

# JPX取得不能時のフォールバック（東証プライムの大型・高流動性銘柄）。
_FALLBACK = {
    # 自動車・輸送機器
    "7203": "トヨタ自動車", "7267": "ホンダ", "7201": "日産自動車",
    "7269": "スズキ", "7270": "SUBARU", "6902": "デンソー",
    "5108": "ブリヂストン",
    # 電機・精密・半導体
    "6758": "ソニーG", "6501": "日立製作所", "6503": "三菱電機",
    "6752": "パナソニックHD", "6954": "ファナック", "6981": "村田製作所",
    "6594": "ニデック", "6702": "富士通", "6701": "NEC",
    "6861": "キーエンス", "8035": "東京エレクトロン", "6857": "アドバンテスト",
    "6920": "レーザーテック", "6146": "ディスコ", "7735": "SCREEN",
    "6723": "ルネサス", "6762": "TDK", "6971": "京セラ",
    "6963": "ローム", "7751": "キヤノン", "7733": "オリンパス",
    "7741": "HOYA", "4543": "テルモ", "6506": "安川電機",
    "6645": "オムロン", "6273": "SMC", "6367": "ダイキン工業",
    # 機械・重工
    "6301": "コマツ", "6326": "クボタ", "7011": "三菱重工",
    "7012": "川崎重工", "7013": "IHI",
    # 素材・化学
    "5401": "日本製鉄", "5411": "JFE", "5713": "住友金属鉱山",
    "5802": "住友電工", "3407": "旭化成", "4005": "住友化学",
    "4188": "三菱ケミカルG", "4183": "三井化学", "4063": "信越化学",
    "4901": "富士フイルム", "3402": "東レ", "5201": "AGC",
    # 医薬品
    "4502": "武田薬品", "4568": "第一三共", "4503": "アステラス製薬",
    "4507": "塩野義製薬", "4519": "中外製薬", "4523": "エーザイ",
    "4578": "大塚HD",
    # 食品・生活用品
    "2914": "JT", "2502": "アサヒGHD", "2503": "キリンHD",
    "2802": "味の素", "2801": "キッコーマン", "2269": "明治HD",
    "4452": "花王", "4911": "資生堂", "8113": "ユニ・チャーム",
    # 商社
    "8058": "三菱商事", "8001": "伊藤忠商事", "8031": "三井物産",
    "8053": "住友商事", "8002": "丸紅", "8015": "豊田通商",
    # 金融
    "8306": "三菱UFJ", "8316": "三井住友FG", "8411": "みずほFG",
    "8604": "野村HD", "8766": "東京海上HD", "8750": "第一生命HD",
    "8591": "オリックス", "8697": "JPX", "8725": "MS&AD",
    "8630": "SOMPO", "8308": "りそなHD",
    # 通信・IT・サービス
    "9432": "NTT", "9433": "KDDI", "9434": "ソフトバンク",
    "9984": "ソフトバンクG", "6098": "リクルートHD", "9613": "NTTデータG",
    "4307": "野村総研", "4704": "トレンドマイクロ", "2413": "エムスリー",
    "4661": "OLC", "9735": "セコム", "4324": "電通G",
    "7974": "任天堂", "9766": "コナミG", "9684": "スクエニHD",
    "7832": "バンダイナムコHD", "9697": "カプコン",
    # 小売
    "9983": "ファーストリテイリング", "3382": "セブン&アイ", "8267": "イオン",
    "9843": "ニトリHD", "3092": "ZOZO", "4755": "楽天G",
    # 運輸・エネルギー・電力
    "9101": "日本郵船", "9104": "商船三井", "9107": "川崎汽船",
    "9020": "JR東日本", "9022": "JR東海", "9021": "JR西日本",
    "9202": "ANAHD", "9201": "JAL", "1605": "INPEX",
    "5020": "ENEOS", "5019": "出光興産", "9501": "東京電力HD",
    "9503": "関西電力", "9531": "東京ガス",
    # 不動産・建設
    "8801": "三井不動産", "8802": "三菱地所", "8830": "住友不動産",
    "1801": "大成建設", "1802": "大林組", "1803": "清水建設",
    "1925": "大和ハウス", "1928": "積水ハウス",
}

_CACHE: dict[str, str] | None = None


def extract_jpx_listing_urls(html: str,
                             page_url: str = JPX_LISTING_PAGE) -> list[str]:
    """配布ページのHTMLから data_j.xls / .xlsx への現在のリンクを抜き出す。

    相対パスで書かれているので絶対URLに直す。重複は畳み、出現順を保つ。
    """
    from urllib.parse import urljoin
    out: list[str] = []
    for m in _JPX_HREF_RE.finditer(html or ""):
        url = urljoin(page_url, m.group(1))
        if url not in out:
            out.append(url)
    return out


def _jpx_candidates() -> list[str]:
    """一覧ファイルの候補URL。配布ページから拾えたものを優先し、旧URLを最後に。"""
    import urllib.request
    urls: list[str] = []
    try:
        req = urllib.request.Request(JPX_LISTING_PAGE, headers=_UA)
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            html = resp.read().decode("utf-8", "replace")
        urls = extract_jpx_listing_urls(html)
    except Exception as exc:  # noqa: BLE001 - 配布ページが読めなくても旧URLを試す
        print(f"WARNING: JPX配布ページを読めません({exc})")
    if JPX_URL not in urls:
        urls.append(JPX_URL)
    return urls


def _fetch_jpx_workbook() -> bytes:
    """一覧ファイルを取得する。候補を順に試し、全滅なら理由をまとめて投げる。"""
    import urllib.request
    failures: list[str] = []
    for url in _jpx_candidates():
        try:
            req = urllib.request.Request(url, headers=_UA)
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
                raw = resp.read()
            print(f"JPX一覧を取得: {url} ({len(raw)}バイト)")
            return raw
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{url} -> {exc}")
    raise RuntimeError("JPXの上場一覧を取得できない: " + " / ".join(failures))


def _fetch_prime() -> dict[str, str]:
    """JPXの上場銘柄一覧からプライム（内国株式）の code->銘柄名 を返す。"""
    import io

    import pandas as pd

    raw = _fetch_jpx_workbook()
    df = pd.read_excel(io.BytesIO(raw), dtype=str)
    seg = df["市場・商品区分"].astype(str)
    df = df[seg.str.contains("プライム", na=False)]
    out: dict[str, str] = {}
    for code, name in zip(df["コード"], df["銘柄名"]):
        code = str(code).strip()
        if len(code) == 4 and code.isdigit():  # 内国株式は4桁数字（ETF/REIT等を除外）
            out[code] = str(name).strip()
    return out


def _build() -> dict[str, str]:
    try:
        universe = _fetch_prime()
        if len(universe) >= 1000:  # プライムは約1,600。極端に少なければ取得異常とみなす
            return universe
        print(f"WARNING: JPXユニバースが少数({len(universe)})のためフォールバック使用")
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING: JPXユニバース取得失敗({exc})のためフォールバック使用")
    return dict(_FALLBACK)


def load_universe() -> dict[str, str]:
    """code->銘柄名 のユニバースを返す（プロセス内でメモ化）。

    EXCLUDED_TICKERS（不正OHLC銘柄）はここで除外するため、本関数を経由する
    すべての呼び出し元（スクリーナーの直接取得パス・yf_tickers経由の
    data_fullバックフィルパス）で一貫して除外される。
    """
    global _CACHE
    if _CACHE is None:
        _CACHE = {code: name for code, name in _build().items()
                  if code not in EXCLUDED_TICKERS}
    return _CACHE


def yf_tickers() -> list[str]:
    """yfinance用のティッカー一覧（.T付き）を返す。"""
    return [f"{code}.T" for code in load_universe()]


# ---------------------------------------------------------------------------
# 全市場ユニバース（大相場検知の研究用）
# ---------------------------------------------------------------------------
# プライム限定だと、大相場になりやすいグロース/スタンダードの中小型株
# （テラドローン・AIメカテック等）がそもそも母集団に入らない。
# 大相場検知はこちらを使う。既定の load_universe()（プライム限定・本番の
# スクリーナーが使う）は一切変更しない。

_CACHE_ALL: dict[str, str] | None = None

# 2024年以降の新規上場に多い「英数字4桁」コード（例: 278A テラドローン、
# 285A キオクシア）にも対応する。従来の4桁数字だけだと新興の大相場銘柄を
# 取りこぼす。
def _is_domestic_stock_code(code: str) -> bool:
    """内国株式のコードか（4桁・数字始まり）。ETF/REIT等の5桁は除外する。"""
    return len(code) == 4 and code[0].isdigit()


def _fetch_all_markets() -> dict[str, str]:
    """JPXの上場銘柄一覧から、プライム・スタンダード・グロースの全内国株を返す。"""
    import io

    import pandas as pd

    raw = _fetch_jpx_workbook()
    df = pd.read_excel(io.BytesIO(raw), dtype=str)
    seg = df["市場・商品区分"].astype(str)
    df = df[seg.str.contains("プライム|スタンダード|グロース", na=False, regex=True)]
    out: dict[str, str] = {}
    for code, name in zip(df["コード"], df["銘柄名"]):
        code = str(code).strip()
        if _is_domestic_stock_code(code) and code not in EXCLUDED_TICKERS:
            out[code] = str(name).strip()
    return out


def load_universe_all() -> dict[str, str]:
    """全市場（プライム/スタンダード/グロース）の code->銘柄名。プロセス内でメモ化。"""
    global _CACHE_ALL
    if _CACHE_ALL is None:
        try:
            u = _fetch_all_markets()
            if len(u) < 2500:  # 全市場は約3,900。極端に少なければ取得異常
                raise ValueError(f"全市場ユニバースが少数({len(u)})")
            _CACHE_ALL = u
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: 全市場ユニバース取得失敗({exc}) → プライムで代替")
            _CACHE_ALL = load_universe()
    return _CACHE_ALL


def yf_tickers_all() -> list[str]:
    """全市場ユニバースの yfinance 用ティッカー一覧（.T付き）。"""
    return [f"{code}.T" for code in load_universe_all()]
