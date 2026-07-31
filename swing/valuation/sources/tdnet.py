"""決算短信XBRL(TDnet)から会社予想と累計実績を取り出す。

なぜ短信XBRLか:
- **会社予想がここにしか無い。** yfinance はアナリスト予想しか返さず、日本株で
  実際に効くのは会社計画とその修正。進捗率も会社予想が無ければ計算できない。
- **公表日が確定する。** 開示の時刻がそのまま「市場が知った日」になるので、
  yfinance で使っている「期末+45日」の推定が要らなくなる。
- サマリー部はタグが標準化されており、有報XBRLよりはるかに解析しやすい。

実装の方針:
- 要素名は名前空間を落としたローカル名で見る。日本基準/IFRS/米国基準で
  名前空間が違うため、そこに依存すると壊れる。
- 実績か予想かは contextRef の文字列で判別する(Forecast を含むかどうか)。
  タクソノミのバージョン差に対して、これが最も壊れにくい。
- ZIPのURLパターンは公開仕様として保証されていないため、候補を順に試す。
"""
from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import zipfile

TIMEOUT = 25
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; valuation-bot)"}

# 取り出す勘定科目(ローカル名)。表記揺れを候補で吸収する。
FIELD_ELEMENTS: dict[str, tuple[str, ...]] = {
    "revenue": ("NetSales", "Sales", "OperatingRevenues", "NetSalesIFRS",
                "SalesIFRS", "OperatingRevenuesIFRS", "TotalRevenuesIFRS"),
    "operating_income": ("OperatingIncome", "OperatingIncomeIFRS",
                         "OperatingProfitIFRS"),
    "ordinary_income": ("OrdinaryIncome", "ProfitBeforeTaxIFRS"),
    "net_income": ("ProfitAttributableToOwnersOfParent", "NetIncome",
                   "ProfitAttributableToOwnersOfParentIFRS"),
    "eps": ("NetIncomePerShare", "BasicEarningsPerShareIFRS",
            "EarningsPerShareIFRS"),
    "dps": ("DividendPerShare", "AnnualDividendPerShare"),
}
_ELEMENT_TO_FIELD = {el: f for f, els in FIELD_ELEMENTS.items() for el in els}

# 累計実績のコンテキスト(第n四半期の累計)。四半期番号も取り出す。
_ACCUM_RE = re.compile(r"CurrentAccumulatedQ(\d)Duration", re.I)


def xbrl_urls(doc_id: str) -> list[str]:
    """XBRL(zip)の候補URL。公開仕様として保証されていないため複数試す。"""
    base = "https://www.release.tdnet.info/inbs"
    return [f"{base}/81_{doc_id}.zip", f"{base}/{doc_id}.zip"]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _to_float(text: str | None) -> float | None:
    if not text:
        return None
    t = text.strip().replace(",", "").replace("△", "-").replace("▲", "-")
    try:
        v = float(t)
    except ValueError:
        return None
    return v


def parse_summary(xml_bytes: bytes) -> dict:
    """XBRLインスタンスから実績・予想を取り出す。

    戻り値:
      {"actual": {...}, "forecast": {...}, "quarter": 1..4 | None,
       "consolidated": bool}
    金額は円単位のまま(短信XBRLは円で入る)。取れなかった項目は入れない。
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}

    actual: dict[str, float] = {}
    forecast: dict[str, float] = {}
    quarter: int | None = None
    consolidated = False

    for el in root.iter():
        field = _ELEMENT_TO_FIELD.get(_local(el.tag))
        if field is None:
            continue
        ctx = el.get("contextRef") or ""
        value = _to_float(el.text)
        if value is None:
            continue
        if "NonConsolidated" not in ctx and "Consolidated" in ctx:
            consolidated = True
        is_forecast = "Forecast" in ctx
        # 予想は通期(CurrentYearDuration)のものだけを使う。四半期予想は
        # 開示していない企業が多く、混ぜると比較できなくなる。
        if is_forecast:
            if "CurrentYearDuration" in ctx or "NextYearDuration" in ctx:
                forecast.setdefault(field, value)
            continue
        m = _ACCUM_RE.search(ctx)
        if m:
            quarter = quarter or int(m.group(1))
            actual.setdefault(field, value)
        elif "CurrentYearDuration" in ctx:
            # 通期実績(本決算)。四半期が無ければこちらを実績とする。
            actual.setdefault(field, value)

    return {"actual": actual, "forecast": forecast,
            "quarter": quarter, "consolidated": consolidated}


def summary_from_zip(zip_bytes: bytes) -> dict:
    """短信ZIPからサマリー部のXBRLインスタンスを探して解析する。

    ZIPには添付資料(Attachment)とサマリー(Summary)が入っている。サマリー側の
    ほうがタグが安定しているので優先する。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except (zipfile.BadZipFile, OSError):
        return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}

    names = [n for n in zf.namelist() if n.lower().endswith(".xbrl")]
    names.sort(key=lambda n: (0 if "summary" in n.lower() else 1, len(n)))
    for n in names:
        try:
            got = parse_summary(zf.read(n))
        except (KeyError, OSError):
            continue
        if got["actual"] or got["forecast"]:
            return got
    return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}


def fetch_summary(doc_id: str) -> dict | None:
    """TDnetから短信XBRLを取得して解析する。取得できなければ None。

    1銘柄の失敗で全体を止めない(可用性優先)。
    """
    import urllib.error
    import urllib.request

    for url in xbrl_urls(doc_id):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310
                data = resp.read()
        except (urllib.error.URLError, OSError, ValueError):
            continue
        got = summary_from_zip(data)
        if got["actual"] or got["forecast"]:
            return got
    return None
