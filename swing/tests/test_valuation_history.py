"""自社過去バリュエーションの検証。

先読み(公表前の数字を使う)が起きていないこと、収益力低下による低PBRを
「割安」と誤判定しないことを中心に固定する。
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from valuation.history import (FundamentalRecord, band, explain_pbr_by_roe,
                               market_adjusted, percentile_rank,
                               point_in_time_frame, valuation_frame)


def days(n, start="2020-01-01"):
    return pd.bdate_range(start, periods=n)


def rec(period_end, known_from, **kw):
    return FundamentalRecord(period_end=date.fromisoformat(period_end),
                             known_from=date.fromisoformat(known_from), **kw)


class TestPointInTime:
    def test_value_appears_only_after_publication(self):
        """決算期末ではなく公表日から反映されること(先読み防止の中核)。"""
        idx = days(60, "2021-01-01")
        # 2020-12期末、公表は2021-02-10
        r = rec("2020-12-31", "2021-02-10", eps=100.0)
        pit = point_in_time_frame([r], idx)
        assert np.isnan(pit.loc[pd.Timestamp("2021-02-09"), "eps"])
        assert pit.loc[pd.Timestamp("2021-02-10"), "eps"] == 100.0
        assert pit.loc[pd.Timestamp("2021-03-01"), "eps"] == 100.0

    def test_steps_up_on_each_publication(self):
        idx = days(200, "2021-01-01")
        pit = point_in_time_frame(
            [rec("2020-12-31", "2021-02-10", eps=100.0),
             rec("2021-06-30", "2021-08-10", eps=140.0)], idx)
        assert pit.loc[pd.Timestamp("2021-07-01"), "eps"] == 100.0
        assert pit.loc[pd.Timestamp("2021-08-10"), "eps"] == 140.0

    def test_same_day_publication_prefers_newer_period(self):
        """訂正や期跨ぎの同日公表では、新しい期の数字を採用する。"""
        idx = days(30, "2021-08-01")
        pit = point_in_time_frame(
            [rec("2020-12-31", "2021-08-10", eps=100.0),
             rec("2021-06-30", "2021-08-10", eps=140.0)], idx)
        assert pit.loc[pd.Timestamp("2021-08-11"), "eps"] == 140.0

    def test_empty_records_is_all_nan(self):
        pit = point_in_time_frame([], days(10))
        assert pit["eps"].isna().all()

    def test_publication_before_period_end_is_rejected(self):
        """公表日が期末より前のレコードは作れない(データ不整合の早期検出)。"""
        with pytest.raises(ValueError):
            rec("2021-06-30", "2021-01-10", eps=100.0)


class TestValuationFrame:
    def test_per_and_pbr(self):
        idx = days(30, "2021-03-01")
        prices = pd.Series(1500.0, index=idx)
        v = valuation_frame(prices, [rec("2020-12-31", "2021-02-10",
                                         eps=100.0, bps=1000.0)])
        assert v["per"].iloc[-1] == pytest.approx(15.0)
        assert v["pbr"].iloc[-1] == pytest.approx(1.5)

    def test_loss_making_company_has_no_per_but_keeps_pbr(self):
        """赤字でPERが定義できなくても、PBRは残す(赤字=評価不能にしない)。"""
        idx = days(30, "2021-03-01")
        prices = pd.Series(800.0, index=idx)
        v = valuation_frame(prices, [rec("2020-12-31", "2021-02-10",
                                         eps=-50.0, bps=1000.0)])
        assert v["per"].isna().all()
        assert v["pbr"].iloc[-1] == pytest.approx(0.8)

    def test_before_first_publication_is_nan(self):
        idx = days(20, "2021-01-01")
        prices = pd.Series(1500.0, index=idx)
        v = valuation_frame(prices, [rec("2020-12-31", "2021-06-10", eps=100.0)])
        assert v["per"].isna().all()


class TestPercentileAndBand:
    def _series(self, values):
        return pd.Series(values, index=days(len(values)))

    def test_lowest_value_is_near_zero_percentile(self):
        s = self._series(list(np.linspace(30, 10, 400)))
        assert percentile_rank(s) == pytest.approx(0.0, abs=0.5)

    def test_highest_value_is_near_hundred(self):
        s = self._series(list(np.linspace(10, 30, 400)))
        assert percentile_rank(s) == pytest.approx(100.0, abs=0.5)

    def test_insufficient_history_returns_none(self):
        """新規上場などで履歴が足りないときは黙って値を出さない。"""
        assert percentile_rank(self._series([15.0] * 100)) is None
        assert band(self._series([15.0] * 100)) is None

    def test_band_reports_quantiles_and_sample_size(self):
        s = self._series(list(np.linspace(10, 20, 400)))
        b = band(s)
        assert b["observations"] == 400
        assert b["p10"] < b["median"] < b["p90"]
        assert b["current"] == pytest.approx(20.0)

    def test_only_recent_years_are_used(self):
        """古い異常値が現在の評価に混ざらないこと。"""
        idx = pd.bdate_range("2005-01-01", periods=5500)
        v = np.full(5500, 15.0)
        v[:500] = 200.0            # 20年前のバブル的水準
        s = pd.Series(v, index=idx)
        b = band(s, years=10)
        assert b["p90"] == pytest.approx(15.0)


class TestMarketAdjusted:
    def test_removes_market_wide_rerating(self):
        """自社PERが上がっても、市場全体が同じだけ上がっていれば相対値は不変。"""
        idx = days(100)
        own = pd.Series(np.linspace(10, 20, 100), index=idx)
        market = pd.Series(np.linspace(20, 40, 100), index=idx)
        rel = market_adjusted(own, market)
        assert rel.iloc[0] == pytest.approx(rel.iloc[-1])


class TestExplainPbrByRoe:
    def _frame(self, roe, pbr, n=400):
        idx = days(n)
        return pd.DataFrame({"roe": roe, "pbr": pbr}, index=idx)

    def test_falling_roe_explains_falling_pbr(self):
        """ROE低下に見合ってPBRが下がった場合、割安とは判定しない。

        バリュートラップ識別の中核。ピアを使わずにこれができる。
        """
        n = 500
        roe = np.linspace(0.12, 0.06, n)
        pbr = np.exp(0.5 + 8.0 * roe)     # ROEで完全に説明できる形
        e = explain_pbr_by_roe(self._frame(roe, pbr, n))
        assert e is not None
        assert e.r2 > 0.95
        assert abs(e.gap_pct) < 5.0       # 乖離なし = 説明できている

    def test_detects_pbr_below_what_roe_justifies(self):
        """ROEは維持しているのにPBRだけ切り下がった場合は割安と判定する。"""
        n = 500
        roe = np.linspace(0.12, 0.06, n)
        pbr = np.exp(0.5 + 8.0 * roe)
        pbr[-60:] *= 0.7                  # 直近だけ理由なく3割安
        e = explain_pbr_by_roe(self._frame(roe, pbr, n))
        assert e is not None
        # 直近を推定から外すので、割引きぶん(-30%)がそのまま乖離として出る
        assert e.gap_pct == pytest.approx(-30.0, abs=2.0)

    def test_recent_anomaly_does_not_define_its_own_baseline(self):
        """直近を推定に含めると乖離が薄まってしまうことの確認(退行防止)。"""
        n = 500
        roe = np.linspace(0.12, 0.06, n)
        pbr = np.exp(0.5 + 8.0 * roe)
        pbr[-60:] *= 0.7
        proper = explain_pbr_by_roe(self._frame(roe, pbr, n))
        diluted = explain_pbr_by_roe(self._frame(roe, pbr, n), exclude_recent_days=0)
        assert proper.gap_pct < diluted.gap_pct - 5.0

    def test_returns_none_when_relationship_is_weak(self):
        """関係が無いのに乖離を語らない。"""
        rng = np.random.default_rng(0)
        n = 500
        e = explain_pbr_by_roe(
            self._frame(rng.normal(0.08, 0.02, n), rng.lognormal(0, 0.4, n), n))
        assert e is None

    def test_returns_none_when_roe_is_constant(self):
        """ROEが動いていなければ傾きが定まらないので判定しない。"""
        n = 500
        e = explain_pbr_by_roe(self._frame(np.full(n, 0.08),
                                           np.linspace(1.0, 2.0, n), n))
        assert e is None

    def test_returns_none_without_enough_history(self):
        assert explain_pbr_by_roe(
            self._frame(np.linspace(0.12, 0.06, 100),
                        np.linspace(2.0, 1.0, 100), 100)) is None


class TestEndToEndNoLookahead:
    def test_valuation_uses_only_published_numbers(self):
        """系列を途中で切っても、その時点までのPERが変わらないこと。"""
        idx = days(600, "2021-01-01")
        rng = np.random.default_rng(3)
        prices = pd.Series(1000 * np.cumprod(1 + rng.normal(0, 0.01, 600)), index=idx)
        records = [
            rec("2020-12-31", "2021-02-10", eps=80.0, bps=900.0, roe=0.089),
            rec("2021-12-31", "2022-02-10", eps=100.0, bps=1000.0, roe=0.10),
            rec("2022-12-31", "2023-02-10", eps=120.0, bps=1100.0, roe=0.109),
        ]
        full = valuation_frame(prices, records)
        cut = 400
        part = valuation_frame(prices.iloc[:cut], records)
        pd.testing.assert_series_equal(part["per"], full["per"].iloc[:cut])
