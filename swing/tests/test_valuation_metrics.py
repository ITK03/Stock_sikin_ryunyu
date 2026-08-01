"""財務指標・成長率の検証。

「割り算の分母が無いときに0で埋めない」ことを中心に固定する。欠測を0にすると
「自己資本比率0%(危険)」と「自己資本比率が分からない」が区別できなくなる。
"""
from __future__ import annotations

from datetime import date

import pytest

from valuation.history import FundamentalRecord
from valuation.metrics import (financial_metrics, growth_metrics,
                               quarterly_history, yearly_history)


def rec(year, month=12, **kw):
    pe = date(year, month, 28)
    return FundamentalRecord(period_end=pe, known_from=date(year + 1, 2, 14), **kw)


FULL = dict(
    eps=100.0, shares=1000.0, revenue=500_000.0, gross_profit=115_000.0,
    operating_income=40_000.0, net_income=100_000.0, total_assets=2_000_000.0,
    equity=1_000_000.0, total_debt=350_000.0, cash=500_000.0,
    current_assets=900_000.0, current_liabilities=500_000.0,
    interest_expense=2_000.0, operating_cf=480_000.0, capex=-270_000.0,
    dividends_paid=-31_000.0,
)


class TestFinancialMetrics:
    def test_computes_profitability_and_safety(self):
        m = financial_metrics(rec(2025, **FULL))
        assert m["gross_margin"] == pytest.approx(0.23)
        assert m["op_margin"] == pytest.approx(0.08)
        assert m["roa"] == pytest.approx(0.05)
        assert m["equity_ratio"] == pytest.approx(0.5)
        assert m["de"] == pytest.approx(0.35)
        assert m["current_ratio"] == pytest.approx(1.8)
        assert m["interest_cover"] == pytest.approx(20.0)

    def test_net_cash_per_share(self):
        """日本株では現金が時価総額の数割を占める企業が多く、これを見ないと
        PERが機械的に割高に見える。"""
        m = financial_metrics(rec(2025, **FULL))
        # (現金500,000 - 有利子負債350,000) / 1,000株 = 150
        assert m["net_cash_ps"] == pytest.approx(150.0)

    def test_net_cash_can_be_negative(self):
        d = {**FULL, "cash": 100_000.0, "total_debt": 600_000.0}
        assert financial_metrics(rec(2025, **d))["net_cash_ps"] == pytest.approx(-500.0)

    def test_fcf_subtracts_capex_regardless_of_sign(self):
        """capex は負値で入ることが多い。符号に依存しないこと。"""
        a = financial_metrics(rec(2025, **{**FULL, "capex": -270_000.0}))["fcf_ps"]
        b = financial_metrics(rec(2025, **{**FULL, "capex": 270_000.0}))["fcf_ps"]
        assert a == b == pytest.approx(210.0)

    def test_dividend_and_payout(self):
        m = financial_metrics(rec(2025, **FULL))
        assert m["dps"] == pytest.approx(31.0)
        assert m["payout"] == pytest.approx(0.31)

    def test_missing_inputs_yield_none_not_zero(self):
        """欠測を0で埋めない。『自己資本比率0%』と『不明』は全く違う。"""
        m = financial_metrics(rec(2025, eps=100.0))
        for k in ("gross_margin", "op_margin", "roa", "equity_ratio", "de",
                  "current_ratio", "interest_cover", "net_cash_ps", "ocf_ps",
                  "fcf_ps", "dps", "payout"):
            assert m[k] is None, f"{k} が欠測で None になっていない"

    def test_zero_denominator_is_none(self):
        m = financial_metrics(rec(2025, revenue=0.0, gross_profit=100.0,
                                  equity=0.0, total_debt=100.0))
        assert m["gross_margin"] is None
        assert m["de"] is None

    def test_no_interest_expense_means_no_coverage_ratio(self):
        """無借金企業ではインタレストカバレッジが定義できない(除算不能)。"""
        m = financial_metrics(rec(2025, **{**FULL, "interest_expense": 0.0}))
        assert m["interest_cover"] is None


class TestGrowthMetrics:
    def _series(self, revs, ops, epss):
        return [rec(2021 + i, revenue=r, operating_income=o, eps=e)
                for i, (r, o, e) in enumerate(zip(revs, ops, epss))]

    def test_yoy_and_cagr(self):
        g = growth_metrics(self._series([100, 106, 113, 119, 127],
                                        [8, 9, 10, 11, 12],
                                        [180, 196, 215, 243, 280]))
        assert g["rev_yoy"] == pytest.approx(127 / 119 - 1, abs=1e-4)
        assert g["eps_yoy"] == pytest.approx(280 / 243 - 1, abs=1e-4)
        # 3年CAGR は4期前(106)を起点にする
        assert g["rev_cagr3"] == pytest.approx((127 / 106) ** (1 / 3) - 1, abs=1e-4)

    def test_needs_two_periods(self):
        g = growth_metrics(self._series([100], [8], [180]))
        assert all(v is None for v in g.values())

    def test_no_cagr_without_four_periods(self):
        g = growth_metrics(self._series([100, 110], [8, 9], [180, 200]))
        assert g["rev_yoy"] is not None
        assert g["rev_cagr3"] is None

    def test_growth_from_loss_is_none(self):
        """赤字からの回復は成長率として意味を持たない(-500%等になる)。"""
        g = growth_metrics(self._series([100, 110], [-5, 9], [-20, 200]))
        assert g["op_yoy"] is None
        assert g["eps_yoy"] is None


class TestYearlyHistory:
    def test_revenue_is_indexed_to_largest_absolute_value(self):
        rs = [rec(2022 + i, revenue=r, operating_income=o, eps=e, roe=0.08,
                  equity=50.0, total_assets=100.0)
              for i, (r, o, e) in enumerate(zip([100, 110, 120], [8, 9, 10],
                                                [50, 55, 60]))]
        h = yearly_history(rs)
        assert h["years"] == [2022, 2023, 2024]
        assert h["rev"] == [83.3, 91.7, 100.0]
        # EPS・自己資本比率は指数化せず実値のまま
        assert h["eps"] == [50.0, 55.0, 60.0]
        assert h["eq"] == [0.5, 0.5, 0.5]

    def test_loss_making_base_year_does_not_invert_the_series(self):
        """基準年が赤字でも符号が反転しないこと。

        「最初の非ゼロ値を100」にしていた頃は、赤字から立ち直った会社の推移が
        上下逆さまに描かれていた。指数の先頭は常に +100 になるので、配信済みの
        データを見ても反転に気づけない。
        """
        rs = [rec(2022 + i, revenue=100.0, operating_income=o, eps=1.0, roe=0.01,
                  equity=50.0, total_assets=100.0)
              for i, o in enumerate([-20.0, -5.0, 10.0, 40.0])]
        h = yearly_history(rs)
        assert h["op"] == [-50.0, -12.5, 25.0, 100.0]
        assert h["op"][0] < 0 < h["op"][-1], "赤字→黒字が上向きに出ていない"

    def test_near_zero_base_year_does_not_explode(self):
        """基準年がゼロ近傍でも指数が桁違いに振れないこと(実測で絶対値1000超が
        47銘柄あった)。"""
        rs = [rec(2022 + i, revenue=100.0, operating_income=o, eps=1.0, roe=0.01,
                  equity=50.0, total_assets=100.0)
              for i, o in enumerate([0.01, 5.0, 8.0, 10.0])]
        h = yearly_history(rs)
        assert max(abs(v) for v in h["op"]) == 100.0

    def test_handles_all_missing(self):
        h = yearly_history([rec(2022), rec(2023)])
        assert h["rev"] == [None, None]

    def test_empty(self):
        assert yearly_history([])["years"] == []


class TestQuarterlyHistory:
    def _quarters(self, n=8):
        out = []
        for i in range(n):
            y, m = 2024 + i // 4, [3, 6, 9, 12][i % 4]
            out.append(rec(y, m, revenue=100.0 + i * 5, operating_income=8.0 + i))
        return out

    def test_labels_and_yoy(self):
        q = quarterly_history(self._quarters())
        assert len(q["labels"]) == 8
        assert q["labels"][0].endswith("Q1")
        # 前年同期(4期前)との比較。最初の4期はYoYが出せない
        assert q["rev_yoy"][:4] == [None, None, None, None]
        assert q["rev_yoy"][4] == pytest.approx(120 / 100 - 1, abs=1e-4)

    def test_keeps_only_recent_eight(self):
        q = quarterly_history(self._quarters(20))
        assert len(q["labels"]) == 8

    def test_empty(self):
        assert quarterly_history([])["labels"] == []
