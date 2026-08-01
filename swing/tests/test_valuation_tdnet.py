"""決算短信XBRLの解析と進捗率の検証(ネットワーク不要)。

TDnet は実行環境から到達できないことがあるため、XBRLインスタンスを組み立てて
解析側だけを固定する。名前空間やタクソノミ版の差で壊れないことが要点。
"""
from __future__ import annotations

import io
import zipfile

import pytest

from valuation.guidance import ELAPSED_BY_QUARTER, guidance_block, progress, verdict
from valuation.sources.tdnet import parse_summary, summary_from_zip, xbrl_urls

NS_ED = "http://www.xbrl.tdnet.info/jp/br/tdnet/t/ed/2007-06-30"
NS_IFRS = "http://www.xbrl.tdnet.info/jp/br/tdnet/t/ed/2014-01-12"


def xbrl(facts: list[tuple[str, str, str]], ns: str = NS_ED) -> bytes:
    """(要素名, contextRef, 値) から XBRL インスタンスを組み立てる。"""
    body = "".join(
        f'<t:{el} contextRef="{ctx}" unitRef="JPY">{val}</t:{el}>'
        for el, ctx, val in facts)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" '
        f'xmlns:t="{ns}">{body}</xbrli:xbrl>'
    ).encode("utf-8")


Q1_FACTS = [
    ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "70000000000"),
    ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "6000000000"),
    ("OrdinaryIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "6200000000"),
    ("ProfitAttributableToOwnersOfParent",
     "CurrentAccumulatedQ1Duration_ConsolidatedMember", "4000000000"),
    ("NetSales", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "290000000000"),
    ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000000000"),
    ("ProfitAttributableToOwnersOfParent",
     "CurrentYearDuration_ConsolidatedMember_ForecastMember", "14000000000"),
    ("NetIncomePerShare", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "133.5"),
    ("DividendPerShare", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "45.0"),
]


class TestParseSummary:
    def test_separates_actual_and_forecast(self):
        s = parse_summary(xbrl(Q1_FACTS))
        assert s["actual"]["revenue"] == pytest.approx(70e9)
        assert s["actual"]["operating_income"] == pytest.approx(6e9)
        assert s["forecast"]["revenue"] == pytest.approx(290e9)
        assert s["forecast"]["operating_income"] == pytest.approx(20e9)
        assert s["quarter"] == 1
        assert s["consolidated"] is True

    def test_reads_forecast_eps_and_dps(self):
        s = parse_summary(xbrl(Q1_FACTS))
        assert s["forecast"]["eps"] == pytest.approx(133.5)
        assert s["forecast"]["dps"] == pytest.approx(45.0)

    def test_ifrs_namespace_and_element_names(self):
        """IFRS採用企業でも壊れないこと(名前空間に依存しない)。"""
        s = parse_summary(xbrl([
            ("NetSalesIFRS", "CurrentAccumulatedQ2Duration_ConsolidatedMember", "5000"),
            ("OperatingProfitIFRS", "CurrentAccumulatedQ2Duration_ConsolidatedMember", "600"),
            ("OperatingProfitIFRS",
             "CurrentYearDuration_ConsolidatedMember_ForecastMember", "1400"),
        ], ns=NS_IFRS))
        assert s["quarter"] == 2
        assert s["actual"]["operating_income"] == pytest.approx(600)
        assert s["forecast"]["operating_income"] == pytest.approx(1400)

    def test_negative_numbers_with_japanese_signs(self):
        """△・▲ を負号として読むこと(短信で使われる)。"""
        s = parse_summary(xbrl([
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "△1,500"),
        ]))
        assert s["actual"]["operating_income"] == pytest.approx(-1500)

    def test_quarterly_forecast_is_ignored(self):
        """四半期予想は開示企業が少なく混ぜると比較できないので使わない。"""
        s = parse_summary(xbrl([
            ("OperatingIncome",
             "CurrentAccumulatedQ2Duration_ConsolidatedMember_ForecastMember", "900"),
        ]))
        assert s["forecast"] == {}

    def test_non_consolidated_only(self):
        s = parse_summary(xbrl([
            ("NetSales", "CurrentAccumulatedQ1Duration_NonConsolidatedMember", "100"),
        ]))
        assert s["consolidated"] is False
        assert s["actual"]["revenue"] == pytest.approx(100)

    def test_full_year_actual_without_quarter(self):
        s = parse_summary(xbrl([
            ("NetSales", "CurrentYearDuration_ConsolidatedMember", "290000"),
        ]))
        assert s["quarter"] is None
        assert s["actual"]["revenue"] == pytest.approx(290000)

    def test_broken_xml_is_not_fatal(self):
        s = parse_summary(b"<not xml")
        assert s == {"actual": {}, "forecast": {}, "quarter": None, "consolidated": False}


class TestSummaryFromZip:
    def _zip(self, entries: dict[str, bytes]) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for n, b in entries.items():
                z.writestr(n, b)
        return buf.getvalue()

    def test_prefers_summary_instance(self):
        """添付資料より Summary 側のタグのほうが安定しているので優先する。"""
        z = self._zip({
            "XBRLData/Attachment/tse-acedjpfr-99999-2026.xbrl": xbrl([
                ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "1")]),
            "XBRLData/Summary/tse-qcedjpsm-99999-2026.xbrl": xbrl(Q1_FACTS),
        })
        s = summary_from_zip(z)
        assert s["actual"]["revenue"] == pytest.approx(70e9)

    def test_falls_back_to_any_instance(self):
        z = self._zip({"XBRLData/Attachment/x.xbrl": xbrl(Q1_FACTS)})
        assert summary_from_zip(z)["quarter"] == 1

    def test_broken_zip_is_not_fatal(self):
        assert summary_from_zip(b"not a zip")["actual"] == {}

    def test_zip_without_xbrl(self):
        assert summary_from_zip(self._zip({"readme.txt": b"hi"}))["actual"] == {}


class TestXbrlUrls:
    def test_tries_prefix_swapped_id_first(self):
        """PDFとXBRLで文書IDの先頭4桁が異なる(1401… → 0812…)。

        当初 81_<id>.zip と <id>.zip だけを試しており、実行ログで両方 HTTP404
        だった(22件ずつ)。先頭4桁の差し替えを第一候補にする。
        """
        urls = xbrl_urls("140120260729501927")
        assert urls[0].endswith("081220260729501927.zip")
        # 元のパターンも候補として残す(どれが当たるかは実行ログで確認する)
        assert any(u.endswith("81_140120260729501927.zip") for u in urls)
        assert any(u.endswith("/140120260729501927.zip") for u in urls)

    def test_all_candidates_share_the_sequence_part(self):
        urls = xbrl_urls("140120260729501927")
        assert all("20260729501927" in u for u in urls)

    def test_non_numeric_id_falls_back_to_original_patterns(self):
        urls = xbrl_urls("abc123")
        assert all("abc123" in u for u in urls)


class TestProgress:
    def test_ratio_against_elapsed(self):
        p = progress(parse_summary(xbrl(Q1_FACTS)))
        assert p["quarter"] == 1
        assert p["elapsed"] == 0.25
        # 営業利益 6,000 / 20,000 = 30%。経過率25%に対して+5ptなので
        # 「上振れ」とは呼ばない(誤差の範囲)。閾値は±10pt。
        assert p["operating_income"] == pytest.approx(0.30)
        assert p["lead"] == pytest.approx(0.30)
        assert p["verdict"] == "ontrack"

    def test_clearly_ahead(self):
        facts = [
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "8000"),
            ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]
        p = progress(parse_summary(xbrl(facts)))
        assert p["lead"] == pytest.approx(0.40)   # 経過率25%に対して+15pt
        assert p["verdict"] == "ahead"

    def test_lead_prefers_operating_income(self):
        """代表指標は営業利益。売上だけ良くて利益が悪い場合に見誤らないため。"""
        facts = [
            ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "9000"),
            ("NetSales", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "1000"),
            ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]
        p = progress(parse_summary(xbrl(facts)))
        assert p["lead"] == pytest.approx(0.05)
        assert p["verdict"] == "behind"

    def test_on_track(self):
        facts = [
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "5000"),
            ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]
        assert progress(parse_summary(xbrl(facts)))["verdict"] == "ontrack"

    def test_behind(self):
        facts = [
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "2000"),
            ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]
        assert progress(parse_summary(xbrl(facts)))["verdict"] == "behind"

    def test_no_progress_for_full_year_results(self):
        """本決算に進捗という概念は無い。"""
        s = parse_summary(xbrl([
            ("NetSales", "CurrentYearDuration_ConsolidatedMember", "290000"),
            ("NetSales", "NextYearDuration_ConsolidatedMember_ForecastMember", "310000"),
        ]))
        assert progress(s) is None

    def test_no_progress_without_forecast(self):
        s = parse_summary(xbrl([
            ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "70")]))
        assert progress(s) is None

    def test_loss_forecast_yields_no_ratio(self):
        """赤字予想に対する進捗率は意味を持たない。"""
        facts = [
            ("OperatingIncome", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "-500"),
            ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember", "-2000"),
        ]
        assert progress(parse_summary(xbrl(facts))) is None

    def test_elapsed_table(self):
        assert ELAPSED_BY_QUARTER == {1: 0.25, 2: 0.50, 3: 0.75, 4: 1.00}

    def test_verdict_unknown_without_ratio(self):
        assert verdict(None, 0.25) == "unknown"


class TestGuidanceBlock:
    def test_builds_block_with_progress(self):
        b = guidance_block(parse_summary(xbrl(Q1_FACTS)), "2026-07-29")
        assert b["known_from"] == "2026-07-29"
        assert b["eps"] == pytest.approx(133.5)
        assert b["dps"] == pytest.approx(45.0)
        assert b["progress"]["verdict"] == "ontrack"

    def test_derives_eps_from_net_income_when_absent(self):
        facts = [f for f in Q1_FACTS if f[0] != "NetIncomePerShare"]
        b = guidance_block(parse_summary(xbrl(facts)), "2026-07-29", shares=1.0e8)
        assert b["eps"] == pytest.approx(140.0)

    def test_none_without_forecast(self):
        s = parse_summary(xbrl([
            ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember", "70")]))
        assert guidance_block(s, "2026-07-29") is None

    def test_none_for_empty_summary(self):
        assert guidance_block(None, None) is None
        assert guidance_block({}, None) is None


# --- インラインXBRL ---------------------------------------------------------
# 決算短信の実体は `.xbrl` ではなく `XBRLData/Summary/…-ixbrl.htm`(インライン
# XBRL)。`.xbrl` だけを探していたため候補が常に空になり、ZIPは200で取れている
# のに「解析不能」が全件、会社予想0件という状態になっていた。
#
# 実行環境から TDnet に到達できない(プロキシが遮断する)ため、実物のZIPでは
# 検証できない。ここで固定しているのは実物の構造を模した組み立てであって、
# 実物での動作確認ではない。

IX_NS = 'xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"'


def ixbrl(facts: list[tuple[str, str, str, str]]) -> bytes:
    """(要素名, contextRef, scale, 表示値) からインラインXBRLを組み立てる。

    金額は「表示された数字」で入るので、scale を掛けないと円にならない。
    """
    body = "".join(
        f'<ix:nonFraction name="tse-ed-t:{el}" contextRef="{ctx}" '
        f'unitRef="JPY" scale="{scale}" decimals="-6">{val}</ix:nonFraction>'
        for el, ctx, scale, val in facts)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<html xmlns="http://www.w3.org/1999/xhtml" {IX_NS}>'
        f'<body><div style="display:none">{body}</div></body></html>'
    ).encode("utf-8")


IX_FACTS = [
    ("NetSales", "CurrentAccumulatedQ1Duration_ConsolidatedMember_ResultMember",
     "6", "70,000"),
    ("OperatingIncome",
     "CurrentAccumulatedQ1Duration_ConsolidatedMember_ResultMember", "6", "6,000"),
    ("NetSales", "CurrentYearDuration_ConsolidatedMember_ForecastMember",
     "6", "290,000"),
    ("OperatingIncome", "CurrentYearDuration_ConsolidatedMember_ForecastMember",
     "6", "20,000"),
    ("NetIncomePerShare", "CurrentYearDuration_ConsolidatedMember_ForecastMember",
     "0", "133.50"),
]


class TestInlineXbrl:
    def test_reads_facts_from_name_attribute(self):
        got = parse_summary(ixbrl(IX_FACTS))
        assert got["actual"]["revenue"] == 70_000 * 10 ** 6
        assert got["forecast"]["operating_income"] == 20_000 * 10 ** 6
        assert got["forecast"]["eps"] == 133.5
        assert got["quarter"] == 1
        assert got["consolidated"] is True

    def test_applies_scale(self):
        """scale を無視すると百万円が円として入り、桁が6つ狂う。"""
        got = parse_summary(ixbrl([
            ("NetSales", "CurrentYearDuration_ConsolidatedMember_ForecastMember",
             "6", "1,234")]))
        assert got["forecast"]["revenue"] == 1_234_000_000

    def test_applies_sign_attribute(self):
        """赤字は sign="-" で表され、テキスト自体は正の数で入る。"""
        xml = ixbrl([("OperatingIncome",
                      "CurrentYearDuration_ConsolidatedMember_ForecastMember",
                      "6", "500")]).replace(b'scale="6"', b'scale="6" sign="-"')
        assert parse_summary(xml)["forecast"]["operating_income"] == -500_000_000

    def test_reads_value_split_across_child_elements(self):
        xml = ixbrl([]).replace(
            b"</div>",
            b'<ix:nonFraction name="tse-ed-t:NetSales" '
            b'contextRef="CurrentYearDuration_ConsolidatedMember_ForecastMember" '
            b'unitRef="JPY" scale="6"><span>1,2</span><span>34</span>'
            b"</ix:nonFraction></div>")
        assert parse_summary(xml)["forecast"]["revenue"] == 1_234_000_000

    def test_skips_nil_facts(self):
        xml = ixbrl([]).replace(
            b"</div>",
            b'<ix:nonFraction name="tse-ed-t:NetSales" '
            b'contextRef="CurrentYearDuration_ConsolidatedMember_ForecastMember" '
            b'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            b'xsi:nil="true" unitRef="JPY" scale="6" /></div>')
        assert parse_summary(xml)["forecast"] == {}

    def test_tolerates_html_entities(self):
        """XHTMLとして配信されるため &nbsp; などが混ざる。ElementTree は DTD を
        読まないので、そのままだと未定義実体で解析ごと落ちる。"""
        xml = ixbrl(IX_FACTS).replace(b"<body>", b"<body><p>&nbsp;&yen;</p>")
        assert parse_summary(xml)["forecast"]["eps"] == 133.5

    def test_zip_prefers_summary_instance(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("XBRLData/Attachment/tse-acedjpfr-99999-ixbrl.htm",
                        ixbrl([("NetSales",
                                "CurrentYearDuration_ConsolidatedMember_ForecastMember",
                                "6", "1")]))
            zf.writestr("XBRLData/Summary/tse-acedjpsm-99999-ixbrl.htm",
                        ixbrl(IX_FACTS))
            zf.writestr("manifest.xml", b"<manifest/>")
        got = summary_from_zip(buf.getvalue())
        assert got["forecast"]["eps"] == 133.5

    def test_zip_with_only_ixbrl_is_not_empty(self):
        """`.xbrl` が1件も無いZIP。これが実物の形で、以前は必ず空を返していた。"""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("XBRLData/Summary/tse-acedjpsm-99999-ixbrl.htm",
                        ixbrl(IX_FACTS))
        assert summary_from_zip(buf.getvalue())["forecast"]["eps"] == 133.5


class TestBasisConsistency:
    """実績と予想は必ず同じ基準(連結/非連結)で揃えること。

    短信は同じ勘定科目を連結と単体の両方で載せる。出現順に拾うと
    「連結の四半期実績 ÷ 単体の通期予想」という組み合わせが起き、単体の予想は
    連結より小さいので進捗率が1を超えて好調に見えてしまう。実データでも
    Q1で進捗率1.0超が6件出ていた。
    """

    def test_does_not_mix_consolidated_actual_with_parent_forecast(self):
        got = parse_summary(xbrl([
            ("OperatingIncome",
             "CurrentAccumulatedQ1Duration_ConsolidatedMember_ResultMember", "5000"),
            ("OperatingIncome",
             "CurrentYearDuration_NonConsolidatedMember_ForecastMember", "3000"),
            ("OperatingIncome",
             "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]))
        assert got["consolidated"] is True
        assert got["forecast"]["operating_income"] == 20000
        assert got["actual"]["operating_income"] == 5000

    def test_falls_back_to_parent_when_only_parent_exists(self):
        got = parse_summary(xbrl([
            ("OperatingIncome",
             "CurrentAccumulatedQ1Duration_NonConsolidatedMember_ResultMember", "500"),
            ("OperatingIncome",
             "CurrentYearDuration_NonConsolidatedMember_ForecastMember", "2000"),
        ]))
        assert got["consolidated"] is False
        assert got["actual"]["operating_income"] == 500
        assert got["forecast"]["operating_income"] == 2000

    def test_prefers_current_year_forecast_over_next_year(self):
        """本決算では当期予想と翌期予想が両方載る。出現順に任せると翌期の
        数字で進捗率を計算しかねない。"""
        got = parse_summary(xbrl([
            ("OperatingIncome",
             "NextYearDuration_ConsolidatedMember_ForecastMember", "99999"),
            ("OperatingIncome",
             "CurrentYearDuration_ConsolidatedMember_ForecastMember", "20000"),
        ]))
        assert got["forecast"]["operating_income"] == 20000

    def test_keeps_next_year_forecast_when_current_year_absent(self):
        got = parse_summary(xbrl([
            ("OperatingIncome",
             "NextYearDuration_ConsolidatedMember_ForecastMember", "12345"),
        ]))
        assert got["forecast"]["operating_income"] == 12345
