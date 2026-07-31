"""配信プロファイルの検証。

サイズ要件(1銘柄約1KB)と、欠測を黙って埋めないことを中心に固定する。
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from valuation.history import FundamentalRecord
from valuation.profile import (GRID_POINTS, SPARK_MONTHS, build_profile,
                               estimate_known_from, monthly_series,
                               percentile_from_grid, quantile_grid,
                               yearly_ranges)


def make_case(years=11, eps_growth=1.06, seed=0):
    """年1回決算・日次株価の銘柄を1つ作る。"""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2015-01-01", periods=years * 250)
    prices = pd.Series(1000 * np.cumprod(1 + rng.normal(0.0003, 0.012, len(idx))),
                       index=idx)
    records, eps, bps = [], 80.0, 800.0
    for y in range(2014, 2014 + years):
        pe = date(y, 12, 31)
        records.append(FundamentalRecord(
            period_end=pe, known_from=estimate_known_from(pe),
            eps=eps, bps=bps, roe=eps / bps))
        eps *= eps_growth
        bps *= 1.04
    return prices, records


class TestQuantileGrid:
    def test_grid_is_ascending_with_fixed_length(self):
        s = pd.Series(np.random.default_rng(0).normal(15, 3, 500))
        g = quantile_grid(s)
        assert len(g) == GRID_POINTS
        assert g == sorted(g)

    def test_none_when_history_is_short(self):
        assert quantile_grid(pd.Series(np.arange(100.0))) is None


class TestPercentileFromGrid:
    def test_endpoints(self):
        g = [10.0, 12.0, 14.0, 16.0, 18.0]
        assert percentile_from_grid(g, 5.0) == 0.0
        assert percentile_from_grid(g, 99.0) == 100.0

    def test_midpoint_interpolates(self):
        g = [10.0, 12.0, 14.0, 16.0, 18.0]
        assert percentile_from_grid(g, 14.0) == pytest.approx(50.0)
        assert percentile_from_grid(g, 13.0) == pytest.approx(37.5)

    def test_matches_empirical_percentile(self):
        """グリッド経由の判定が、元系列の実パーセンタイルとほぼ一致すること。

        ブラウザ側はグリッドしか持たないので、この近似が崩れると表示が狂う。
        """
        rng = np.random.default_rng(1)
        s = pd.Series(rng.lognormal(2.6, 0.35, 3000))
        g = quantile_grid(s, digits=4)
        for v in s.quantile([0.1, 0.3, 0.5, 0.7, 0.9]):
            approx = percentile_from_grid(g, float(v))
            exact = float((s < v).mean() * 100)
            assert abs(approx - exact) < 3.0


class TestYearlyRanges:
    def test_shape_and_ordering(self):
        idx = pd.bdate_range("2020-01-01", periods=1000)
        s = pd.Series(np.linspace(10, 20, 1000), index=idx)
        rows = yearly_ranges(s)
        assert all(len(r) == 4 for r in rows)
        for _, lo, med, hi in rows:
            assert lo <= med <= hi
        assert [r[0] for r in rows] == sorted(r[0] for r in rows)

    def test_skips_years_with_too_few_days(self):
        """数日しかない年は誤解を招くので出さない。"""
        idx = pd.bdate_range("2020-12-24", periods=200)   # 2020年は数日だけ
        s = pd.Series(np.linspace(10, 20, 200), index=idx)
        assert 2020 not in [r[0] for r in yearly_ranges(s)]


class TestBuildProfile:
    def test_contains_no_price(self):
        """株価はブラウザ側で当てる。プロファイルに混ぜない(鮮度が縛られるため)。"""
        prices, records = make_case()
        p = build_profile("7203", "トヨタ自動車", prices, records)
        blob = json.dumps(p, ensure_ascii=False)
        assert "close" not in p and "price" not in p
        assert str(round(float(prices.iloc[-1]))) not in blob

    def test_size_stays_within_delivery_budget(self):
        """1銘柄2.5KB以内に収まること。

        v2 で収益性・安全性・成長・四半期・月次スパークラインを足したため
        約1KB→2KBになった。全1526銘柄で約3MB。orphanブランチへの
        force-push なので履歴は増えず、1銘柄ぶんの取得は依然として即時。
        """
        prices, records = make_case()
        p = build_profile("7203", "トヨタ自動車", prices, records)
        size = len(json.dumps(p, ensure_ascii=False, separators=(",", ":")).encode())
        assert size < 2600, f"プロファイルが大きすぎる: {size}B"

    def test_yearly_ranges_are_capped_by_window(self):
        """10年ローリングなので年次レンジの件数が増え続けないこと。"""
        prices, records = make_case(years=20)
        p = build_profile("7203", "トヨタ", prices, records, years=10)
        assert len(p["per_y"]) <= 11    # 端数の年を含めても11

    def test_reports_missing_instead_of_filling(self):
        """欠測を平均値などで埋めず、missing に列挙すること。"""
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)   # market_per なし
        assert p["rel_q"] is None
        assert "rel_per" in p["cov"]["missing"]

    def test_flags_estimated_publication_date(self):
        """公表日が推定値であることを隠さない(過去レンジに先読みが混じるため)。"""
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)
        assert p["cov"]["known_from_estimated"] is True

    def test_short_history_yields_no_grid(self):
        """新規上場などで履歴が足りなければ分位を出さない。"""
        idx = pd.bdate_range("2025-01-01", periods=120)
        prices = pd.Series(1000.0, index=idx)
        rec = [FundamentalRecord(period_end=date(2024, 12, 31),
                                 known_from=date(2025, 2, 14), eps=50.0, bps=500.0)]
        p = build_profile("999A", "新規上場", prices, rec)
        assert p["per_q"] is None and p["pbr_q"] is None
        assert "per" in p["cov"]["missing"] and "pbr" in p["cov"]["missing"]

    def test_market_relative_grid_when_market_given(self):
        prices, records = make_case()
        mkt = pd.Series(np.linspace(14, 18, len(prices)), index=prices.index)
        p = build_profile("7203", "トヨタ", prices, records, market_per=mkt)
        assert p["rel_q"] is not None and len(p["rel_q"]) == GRID_POINTS
        assert "rel_per" not in p["cov"]["missing"]

    def test_client_side_per_matches_server_side(self):
        """「株価÷EPS を分位グリッドに当てる」という配信設計が成立すること。"""
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)
        per_now = float(prices.iloc[-1]) / p["eps"]
        pct = percentile_from_grid(p["per_q"], per_now)
        assert 0.0 <= pct <= 100.0


class TestEstimateKnownFrom:
    def test_lags_after_period_end(self):
        assert estimate_known_from(date(2025, 3, 31)) == date(2025, 5, 15)

    def test_never_precedes_period_end(self):
        """FundamentalRecord の検証を通る値になっていること。"""
        pe = date(2025, 3, 31)
        FundamentalRecord(period_end=pe, known_from=estimate_known_from(pe), eps=1.0)


class TestCoverageHonesty:
    """収録期間を要求値ではなく実測で出すこと。

    yfinance の財務は4〜5年しか遡れないため、years=10 を要求しても中身は5年
    しかない。「過去10年レンジの下位8%」と表示すると事実と違う。
    """

    def test_span_reflects_actual_data_not_requested_window(self):
        prices, records = make_case(years=11)
        # 直近3期ぶんの決算しか無い銘柄
        p = build_profile("7203", "トヨタ", prices, records[-3:], years=10)
        assert p["cov"]["years_max"] == 10
        lo, hi = p["cov"]["span"]
        assert hi - lo <= 4, f"実収録が10年に満たないのに span が広すぎる: {lo}-{hi}"
        assert p["cov"]["span_years"] < 6.0

    def test_span_years_matches_observation_count(self):
        prices, records = make_case(years=11)
        p = build_profile("7203", "トヨタ", prices, records)
        assert p["cov"]["span_years"] == pytest.approx(p["cov"]["obs"] / 245.0, abs=0.1)

    def test_obs_counts_valuation_days_not_price_days(self):
        """公表前の期間は評価できないので obs に数えない。"""
        prices, records = make_case(years=11)
        p = build_profile("7203", "トヨタ", prices, records[-2:], years=10)
        assert p["cov"]["obs"] < p["cov"]["price_obs"]

    def test_span_is_none_without_any_valuation(self):
        idx = pd.bdate_range("2025-01-01", periods=300)
        p = build_profile("999A", "新規", pd.Series(1000.0, index=idx), [])
        assert p["cov"]["span"] is None
        assert p["cov"]["obs"] == 0


class TestSparkline:
    """スペースを取らない簡易グラフ用の月次系列。"""

    def test_monthly_points_are_capped(self):
        idx = pd.bdate_range("2015-01-01", periods=2600)
        s = pd.Series(np.linspace(10, 20, 2600), index=idx)
        m = monthly_series(s)
        assert len(m) <= SPARK_MONTHS
        assert m[-1] == pytest.approx(20.0, abs=0.1)

    def test_short_history_yields_short_series(self):
        idx = pd.bdate_range("2025-01-01", periods=60)
        m = monthly_series(pd.Series(np.linspace(10, 12, 60), index=idx))
        assert 1 <= len(m) <= 4

    def test_empty_series(self):
        assert monthly_series(pd.Series(dtype=float)) == []

    def test_profile_carries_sparkline_series(self):
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)
        assert 0 < len(p["per_m"]) <= SPARK_MONTHS
        assert 0 < len(p["pbr_m"]) <= SPARK_MONTHS


class TestProfileV2Sections:
    """収益性・安全性・成長・四半期が載っていること。"""

    def test_financial_and_growth_sections_exist(self):
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)
        assert p["v"] == 2
        assert set(p["fin"]) >= {"op_margin", "equity_ratio", "de", "net_cash_ps"}
        assert set(p["growth"]) >= {"rev_yoy", "eps_yoy", "eps_cagr3"}
        assert p["hist"]["years"] == [r.period_end.year for r in records]

    def test_quarterly_absence_is_reported(self):
        """四半期データが無いことを missing に出す(黙って空にしない)。"""
        prices, records = make_case()
        p = build_profile("7203", "トヨタ", prices, records)
        assert "quarterly" in p["cov"]["missing"]

    def test_quarterly_included_when_given(self):
        prices, records = make_case()
        qs = [FundamentalRecord(period_end=date(2025, m, 28),
                                known_from=date(2025, m, 28) + timedelta(days=45),
                                revenue=100.0 + m, operating_income=8.0 + m)
              for m in (3, 6, 9, 12)]
        p = build_profile("7203", "トヨタ", prices, records, quarterly=qs)
        assert len(p["q"]["labels"]) == 4
        assert "quarterly" not in p["cov"]["missing"]
