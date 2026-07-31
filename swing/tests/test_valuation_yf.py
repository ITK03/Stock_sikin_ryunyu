"""yfinance財務 → FundamentalRecord 変換の検証(ネットワーク不要)。

科目名の揺れ・欠損・ROEの計算方法を固定する。
"""
from __future__ import annotations

from datetime import date

import pandas as pd
import pytest

from valuation.sources.yf import records_from_statements


def frame(rows: dict[str, list], periods: list[str]) -> pd.DataFrame:
    return pd.DataFrame(rows, index=None).T.set_axis(
        [pd.Timestamp(p) for p in periods], axis=1)


def mk(income_rows, balance_rows, periods):
    inc = pd.DataFrame(income_rows, index=[pd.Timestamp(p) for p in periods]).T
    bal = pd.DataFrame(balance_rows, index=[pd.Timestamp(p) for p in periods]).T
    return inc, bal


PERIODS = ["2023-03-31", "2024-03-31", "2025-03-31"]


class TestBasicMapping:
    def test_extracts_eps_bps_sps(self):
        inc, bal = mk(
            {"Diluted EPS": [100.0, 120.0, 140.0],
             "Net Income": [10_000, 12_000, 14_000],
             "Total Revenue": [100_000, 110_000, 120_000],
             "Diluted Average Shares": [100, 100, 100]},
            {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        assert len(recs) == 3
        assert recs[0].period_end == date(2023, 3, 31)
        assert recs[-1].eps == pytest.approx(140.0)
        assert recs[-1].bps == pytest.approx(960.0)
        assert recs[-1].sps == pytest.approx(1200.0)

    def test_records_are_in_chronological_order(self):
        """yfinanceは新しい期を先頭に返すことがあるので並べ直す。"""
        inc, bal = mk({"Diluted EPS": [100.0, 120.0, 140.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc[inc.columns[::-1]], bal[bal.columns[::-1]])
        assert [r.period_end.year for r in recs] == [2023, 2024, 2025]

    def test_publication_date_is_after_period_end(self):
        inc, bal = mk({"Diluted EPS": [100.0, 120.0, 140.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        for r in records_from_statements(inc, bal):
            assert r.known_from > r.period_end


class TestRoe:
    def test_uses_average_equity(self):
        """期首期末平均で割ること。期末だけだと増資期のROEが実態からずれる。"""
        inc, bal = mk({"Net Income": [10_000, 12_000, 14_000],
                       "Diluted EPS": [100.0, 120.0, 140.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 120_000, 160_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        # 2期目: 12,000 / ((80,000+120,000)/2) = 0.12
        assert recs[1].roe == pytest.approx(0.12)
        # 初回は前期が無いので期末自己資本で割る
        assert recs[0].roe == pytest.approx(10_000 / 80_000)

    def test_no_roe_without_net_income(self):
        inc, bal = mk({"Diluted EPS": [100.0, 120.0, 140.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        assert all(r.roe is None for r in records_from_statements(inc, bal))


class TestRowNameVariants:
    def test_falls_back_to_basic_eps(self):
        inc, bal = mk({"Basic EPS": [100.0, 120.0, 140.0],
                       "Basic Average Shares": [100, 100, 100]},
                      {"Common Stock Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        assert recs[-1].eps == pytest.approx(140.0)
        assert recs[-1].bps == pytest.approx(960.0)

    def test_derives_eps_from_net_income_when_absent(self):
        """EPS行が無くても、純利益と株式数から算出する。"""
        inc, bal = mk({"Net Income Common Stockholders": [10_000, 12_000, 14_000],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        assert recs[-1].eps == pytest.approx(140.0)


class TestMissingData:
    def test_empty_input_yields_no_records(self):
        assert records_from_statements(pd.DataFrame(), pd.DataFrame()) == []
        assert records_from_statements(None, None) == []

    def test_period_with_nothing_usable_is_skipped(self):
        """EPSもBPSも取れない期は作らない(空レコードで水増ししない)。"""
        inc, bal = mk({"Total Revenue": [100_000, 110_000, 120_000]},
                      {"Something Else": [1, 2, 3]}, PERIODS)
        assert records_from_statements(inc, bal) == []

    def test_partial_periods_are_kept(self):
        """一部の期だけ取れる場合、取れた期は残す。"""
        inc, bal = mk({"Diluted EPS": [100.0, float("nan"), 140.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        assert len(recs) == 3            # BPSは3期とも取れるので残る
        assert recs[1].eps is None
        assert recs[1].bps == pytest.approx(880.0)

    def test_zero_shares_does_not_crash(self):
        inc, bal = mk({"Net Income": [10_000, 12_000, 14_000],
                       "Diluted Average Shares": [0, 0, 0]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        assert records_from_statements(inc, bal) == []

    def test_loss_making_company_keeps_negative_eps(self):
        """赤字を欠測扱いにしない(PERは出ないがPBRは出せる)。"""
        inc, bal = mk({"Diluted EPS": [-50.0, -20.0, 30.0],
                       "Diluted Average Shares": [100, 100, 100]},
                      {"Stockholders Equity": [80_000, 88_000, 96_000]}, PERIODS)
        recs = records_from_statements(inc, bal)
        assert recs[0].eps == pytest.approx(-50.0)
        assert recs[0].bps == pytest.approx(800.0)
