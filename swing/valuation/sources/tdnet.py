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

import html.entities
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

# 連結/非連結の区別が無い項目。1株当たり配当は会社として決めるもので、
# コンテキストにも区別が入らない。基準ごとに分けた箱の片方にしか現れないため、
# もう片方から補わないと落ちる。
BASIS_NEUTRAL_FIELDS = ("dps",)

# 累計実績のコンテキスト(第n四半期の累計)。四半期番号も取り出す。
_ACCUM_RE = re.compile(r"CurrentAccumulatedQ(\d)Duration", re.I)


# TDnet の文書IDは「種別4桁 + 日付8桁 + 連番」。PDFとXBRLで先頭4桁が異なり、
# PDF が 1401… のとき XBRL は 0812… になる。実行ログでは 81_<id>.zip と
# <id>.zip はどちらも HTTP404、0812 への差し替えは 200 が返っていた。
# ただしこの規則は公開仕様ではないので、開示フィードが持つ実URL(url_hint)が
# あればそちらを使い、これはフィードにリンクが無い場合の保険として残す。
XBRL_ID_PREFIXES = ("0812", "0813")


def xbrl_urls(doc_id: str) -> list[str]:
    """XBRL(zip)の候補URL。公開仕様として保証されていないため複数試す。

    候補の順序は実行ログの実測で決める。当たったパターンは diagnostics() に
    "OK" として記録されるので、次回以降その並びを見直せる。
    """
    base = "https://www.release.tdnet.info/inbs"
    urls = []
    if len(doc_id) > 4 and doc_id.isdigit():
        for pref in XBRL_ID_PREFIXES:
            urls.append(f"{base}/{pref}{doc_id[4:]}.zip")
    urls += [f"{base}/81_{doc_id}.zip", f"{base}/{doc_id}.zip"]
    return urls


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _to_float(text: str | None) -> float | None:
    if not text:
        return None
    t = text.strip().replace(",", "").replace("△", "-").replace("▲", "-")
    # インラインXBRLでは桁区切りに全角スペースや薄いスペースが入ることがある
    t = t.replace(" ", "").replace("　", "").replace(" ", "")
    try:
        v = float(t)
    except ValueError:
        return None
    return v


_XSI_NIL = "{http://www.w3.org/2001/XMLSchema-instance}nil"
# 名前つき実体参照(&nbsp; など)。XHTMLとして配信されるインラインXBRLに混ざる
# ことがあり、ElementTree は DTD を読まないので未定義実体として解析に失敗する。
_ENTITY_RE = re.compile(r"&([A-Za-z][A-Za-z0-9]*);")
_KEEP_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}


def _resolve_entities(xml_bytes: bytes) -> bytes:
    """XMLとして未定義の名前つき実体を文字に置き換える。"""
    def sub(m: re.Match) -> str:
        name = m.group(1)
        if name in _KEEP_ENTITIES:
            return m.group(0)
        ch = html.entities.html5.get(name + ";") or html.entities.html5.get(name)
        return ch if ch else m.group(0)

    return _ENTITY_RE.sub(sub, xml_bytes.decode("utf-8", "replace")).encode("utf-8")


def _fact_name(el: ET.Element) -> str | None:
    """勘定科目のローカル名。

    通常のXBRLインスタンスでは要素名そのもの。インラインXBRLでは要素は
    `ix:nonFraction` で、勘定科目は name 属性(`tse-ed-t:NetSales` の形)に入る。
    """
    local = _local(el.tag)
    if local in ("nonFraction", "nonNumeric"):
        name = el.get("name") or ""
        return name.rsplit(":", 1)[-1] or None
    return local


def _fact_value(el: ET.Element) -> float | None:
    """ファクトの数値。インラインXBRLの scale / sign / 入れ子テキストを解く。

    インラインXBRLの金額は「表示された数字」なので、scale="6"(百万円表示)なら
    10^6 を掛けないと円にならない。負値は sign="-" で表され、テキスト自体は
    正の数で入る。ここを無視すると桁と符号が狂う。
    """
    if (el.get(_XSI_NIL) or "").lower() == "true":
        return None
    inline = _local(el.tag) in ("nonFraction", "nonNumeric")
    # インラインXBRLでは数字が <span> などで分割されていることがある
    raw = "".join(el.itertext()) if inline else el.text
    value = _to_float(raw)
    if value is None:
        return None
    if inline:
        scale = el.get("scale")
        if scale:
            try:
                value *= 10 ** int(scale)
            except ValueError:
                pass
        if (el.get("sign") or "").strip() == "-":
            value = -value
    return value


def parse_summary(xml_bytes: bytes) -> dict:
    """XBRLインスタンスから実績・予想を取り出す。

    通常のXBRLインスタンス(.xbrl)とインラインXBRL(*-ixbrl.htm)の両方を読む。
    TDnetの決算短信は後者で配信されており、こちらを読めないと1件も取れない。

    戻り値:
      {"actual": {...}, "forecast": {...}, "quarter": 1..4 | None,
       "consolidated": bool}
    金額は円単位に直す(インラインXBRLは百万円などの表示単位で入っている)。
    取れなかった項目は入れない。
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        try:
            root = ET.fromstring(_resolve_entities(xml_bytes))
        except ET.ParseError:
            return {"actual": {}, "forecast": {}, "quarter": None,
                    "consolidated": False}

    # 連結/非連結ごとに分けて集める。短信は同じ勘定科目を連結と単体の両方で
    # 載せるので、出現順で拾うと「連結の四半期実績 ÷ 単体の通期予想」のような
    # 組み合わせが起きる。単体の予想は連結より小さいので進捗率が1を超え、
    # 好調に見えてしまう。実績と予想は必ず同じ基準で揃える。
    buckets: dict[bool, dict] = {
        True: {"actual": {}, "cur": {}, "next": {}, "quarter": None},
        False: {"actual": {}, "cur": {}, "next": {}, "quarter": None},
    }

    for el in root.iter():
        name = _fact_name(el)
        field = _ELEMENT_TO_FIELD.get(name) if name else None
        if field is None:
            continue
        ctx = el.get("contextRef") or ""
        value = _fact_value(el)
        if value is None:
            continue
        b = buckets["NonConsolidated" not in ctx and "Consolidated" in ctx]
        # 予想は通期のものだけを使う。四半期予想は開示していない企業が多く、
        # 混ぜると比較できなくなる。
        if "Forecast" in ctx:
            if "CurrentYearDuration" in ctx:
                b["cur"].setdefault(field, value)
            elif "NextYearDuration" in ctx:
                b["next"].setdefault(field, value)
            continue
        m = _ACCUM_RE.search(ctx)
        if m:
            b["quarter"] = b["quarter"] or int(m.group(1))
            b["actual"].setdefault(field, value)
        elif "CurrentYearDuration" in ctx:
            # 通期実績(本決算)。四半期が無ければこちらを実績とする。
            b["actual"].setdefault(field, value)

    def unpack(b: dict) -> tuple[dict, dict, int | None]:
        # 当期予想を翌期予想より優先する。本決算では両方載ることがあり、
        # 出現順に任せると翌期の数字で進捗率を計算しかねない。
        forecast = dict(b["next"])
        forecast.update(b["cur"])
        return b["actual"], forecast, b["quarter"]

    def result(cons: bool) -> dict:
        actual, forecast, quarter = unpack(buckets[cons])
        other = unpack(buckets[not cons])[1]
        # 1株当たり配当は会社として決めるもので、連結/非連結の区別が無い。
        # コンテキストに区別が入らないため非連結側の箱に落ちる。基準を揃える
        # ために弾くと、配当予想しか出していない会社の予想が丸ごと消える
        # (実測で7銘柄。連結の実績と非連結側の配当予想で箱が分かれ、どちらの
        # 箱も「実績と予想が揃わない」状態になっていた)。
        for f in BASIS_NEUTRAL_FIELDS:
            if f not in forecast and f in other:
                forecast[f] = other[f]
        return {"actual": actual, "forecast": forecast,
                "quarter": quarter, "consolidated": cons}

    # 実績と予想が揃う基準を優先する(連結 → 非連結)。揃わなければ予想がある
    # ほうを取る。会社予想は予想が無いと何も出せないが、実績だけなら
    # プロファイル本体が持っているため。
    candidates = [result(True), result(False)]
    for accept in (lambda g: g["actual"] and g["forecast"],
                   lambda g: g["forecast"],
                   lambda g: g["actual"]):
        for got in candidates:
            if accept(got):
                return got
    return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}


def instance_names(names: list[str]) -> list[str]:
    """ZIP内のXBRLインスタンス候補を、読むべき順に並べる。

    決算短信のZIPは
      XBRLData/Summary/tse-…-ixbrl.htm   ← サマリー(ここに会社予想が入る)
      XBRLData/Attachment/…-ixbrl.htm    ← 添付の財務諸表
    という構成で、実体は**インラインXBRL(.htm)**。`.xbrl` だけを探していたため
    候補が常に空になり、ZIPは取れているのに1件も解析できていなかった。
    """
    out = [n for n in names
           if n.lower().endswith(".xbrl") or "ixbrl.htm" in n.lower()]
    out.sort(key=lambda n: (0 if "summary" in n.lower() else 1, len(n)))
    return out


def summary_from_zip(zip_bytes: bytes) -> dict:
    """短信ZIPからサマリー部のXBRLインスタンスを探して解析する。

    ZIPには添付資料(Attachment)とサマリー(Summary)が入っている。サマリー側の
    ほうがタグが安定しているので優先する。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except (zipfile.BadZipFile, OSError):
        return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}

    for n in instance_names(zf.namelist()):
        try:
            got = parse_summary(zf.read(n))
        except (KeyError, OSError):
            continue
        if got["actual"] or got["forecast"]:
            return got
    return {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}


# 失敗の内訳。URLパターンは公開仕様として保証されていないため、推測ではなく
# 実行ログの実測で決める。最初の数件だけ詳細を出す(1回の実行で数百件試すため)。
_diag: dict[str, int] = {}
_verbose_left = 5


def diagnostics() -> dict[str, int]:
    """取得結果の内訳(URLごとの成功/失敗理由)。実行の最後にまとめて出す用。"""
    return dict(_diag)


def fetch_summary(doc_id: str, url_hint: str | None = None) -> dict | None:
    """TDnetから短信XBRLを取得して解析する。取得できなければ None。

    url_hint は開示フィードが持つ実際のXBRLリンク。URLの規則は公開仕様として
    保証されていないので、一覧ページに出ているリンクがあればそれを最優先する。

    1銘柄の失敗で全体を止めない(可用性優先)。
    """
    global _verbose_left
    import urllib.error
    import urllib.request

    # 推測URLが url_hint と一致することがある(実測では 0812… の差し替えが
    # そのまま正解)。重複を除かないと同じZIPを2回ダウンロードすることになる。
    candidates: list[str] = []
    for u in ([url_hint] if url_hint else []) + xbrl_urls(doc_id):
        if u not in candidates:
            candidates.append(u)
    for url in candidates:
        pattern = url.rsplit("/", 1)[-1].replace(doc_id, "<id>")
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310
                data = resp.read()
        except urllib.error.HTTPError as exc:
            _diag[f"{pattern} HTTP{exc.code}"] = _diag.get(f"{pattern} HTTP{exc.code}", 0) + 1
            if _verbose_left > 0:
                _verbose_left -= 1
                print(f"  XBRL取得失敗 {url} -> HTTP {exc.code}")
            continue
        except (urllib.error.URLError, OSError, ValueError) as exc:
            key = f"{pattern} {type(exc).__name__}"
            _diag[key] = _diag.get(key, 0) + 1
            if _verbose_left > 0:
                _verbose_left -= 1
                print(f"  XBRL取得失敗 {url} -> {exc}")
            continue
        got = summary_from_zip(data)
        if got["actual"] or got["forecast"]:
            _diag[f"{pattern} OK"] = _diag.get(f"{pattern} OK", 0) + 1
            return got
        _diag[f"{pattern} 解析不能"] = _diag.get(f"{pattern} 解析不能", 0) + 1
        if _verbose_left > 0:
            _verbose_left -= 1
            # 「ZIPは取れたが解釈できない」ときは中身が分からないと手が出ない。
            # 実際、候補ファイルが常に空(インラインXBRLを見ていなかった)なのに
            # 解析失敗としか出ず、原因の特定に時間を取られた。
            try:
                names = zipfile.ZipFile(io.BytesIO(data)).namelist()
            except (zipfile.BadZipFile, OSError):
                names = ["(ZIPとして開けない)"]
            print(f"  XBRLは取れたが中身を解釈できず {url} ({len(data)}B)")
            print(f"    ZIP内: {names[:12]}")
            print(f"    解析対象の候補: {instance_names(names)[:4]}")
    return None
