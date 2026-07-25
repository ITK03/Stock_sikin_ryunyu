"""資金フロー指標が、ダッシュボード(src/core/rankings.ts)の定義と一致することの検証。

指標の値をこのテストで固定しておかないと、バックテスト結果が「本家と違う式を
測っていた」という形で無意味になる。手計算できる小さな系列で突き合わせる。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from research.flow import (SURGE_BASELINE_DAYS, continuity_score,
                           flow_capitulation, flow_momentum, rel_turnover,
                           rsi2_flow, rsi2_quiet, surge, turnover)


def make_df(closes, volumes=None, highs=None, lows=None, opens=None):
    n = len(closes)
    idx = pd.bdate_range("2020-01-01", periods=n)
    closes = np.asarray(closes, dtype=float)
    volumes = np.full(n, 1000.0) if volumes is None else np.asarray(volumes, dtype=float)
    return pd.DataFrame({
        "open": closes if opens is None else np.asarray(opens, float),
        "high": closes * 1.01 if highs is None else np.asarray(highs, float),
        "low": closes * 0.99 if lows is None else np.asarray(lows, float),
        "close": closes,
        "volume": volumes,
    }, index=idx)


def test_turnover_is_close_times_volume():
    df = make_df([100, 200], [10, 20])
    assert list(turnover(df)) == [1000.0, 4000.0]


class TestSurge:
    """④急増率 = 直近n日平均 ÷ その手前25日平均(基準窓はn日ずらす)。"""

    def test_flat_series_is_one(self):
        df = make_df([100] * 40, [1000] * 40)
        assert surge(df, 1).iloc[-1] == pytest.approx(1.0)

    def test_doubling_last_day(self):
        # 直近1日だけ売買代金2倍 → 急増率2.0
        vol = [1000] * 39 + [2000]
        df = make_df([100] * 40, vol)
        assert surge(df, 1).iloc[-1] == pytest.approx(2.0)

    def test_baseline_window_is_shifted_back_by_n(self):
        # 直近3日が5倍。基準窓は「その手前25日」なので急増中の日を含まない。
        vol = [1000] * 37 + [5000] * 3
        df = make_df([100] * 40, vol)
        assert surge(df, 3).iloc[-1] == pytest.approx(5.0)
        # 逆に基準窓が手前にずれていなければ 5.0 にはならない(退化検出)
        naive = (pd.Series(vol, dtype=float).rolling(3).mean()
                 / pd.Series(vol, dtype=float).rolling(SURGE_BASELINE_DAYS).mean())
        assert naive.iloc[-1] != pytest.approx(5.0)

    def test_needs_minimum_baseline_days(self):
        # 基準は25日窓・最低15日必要 → 履歴が足りなければ NaN
        df = make_df([100] * 12, [1000] * 12)
        assert np.isnan(surge(df, 1).iloc[-1])

    def test_no_lookahead(self):
        """ある日の値は、その日までのデータだけで決まる(未来を足しても不変)。"""
        vol = list(np.linspace(1000, 3000, 45))
        df = make_df([100] * 45, vol)
        full = surge(df, 1)
        truncated = surge(df.iloc[:40], 1)
        assert truncated.iloc[-1] == pytest.approx(full.iloc[39])


class TestRelTurnover:
    def test_relative_to_own_median(self):
        vol = [1000] * 25 + [3000]
        df = make_df([100] * 26, vol)
        assert rel_turnover(df).iloc[-1] == pytest.approx(3.0)


class TestContinuityScore:
    """②連日継続 = winsorMean(x) * (0.6 + 0.4*consistency)。本家と同一式。"""

    def test_perfectly_constant_series(self):
        # 全日同じ → consistency=1, winsorMean=値そのもの → score = 値
        s = pd.Series([2.0] * 10)
        assert continuity_score(s, 10).iloc[-1] == pytest.approx(2.0)

    def test_single_spike_is_damped(self):
        """1日だけ大商い vs 毎日コンスタント。後者が高く評価されること。"""
        spiky = pd.Series([1.0] * 9 + [100.0])
        steady = pd.Series([2.0] * 10)
        spike_score = continuity_score(spiky, 10).iloc[-1]
        steady_score = continuity_score(steady, 10).iloc[-1]
        assert steady_score > spike_score

    def test_matches_hand_computed_formula(self):
        x = np.array([1.0, 1.0, 1.0, 1.0, 10.0])
        med = np.median(x)                      # 1.0
        cap = med * 3                            # 3.0
        base = np.minimum(x, cap).mean()         # (1+1+1+1+3)/5 = 1.4
        consistency = (x >= 0.6 * med).mean()    # 全日 >= 0.6 → 1.0
        expected = base * (0.6 + 0.4 * consistency)
        got = continuity_score(pd.Series(x), 5).iloc[-1]
        assert got == pytest.approx(expected)

    def test_inconsistent_series_is_penalised(self):
        # 半分の日が平常時(中央値)の6割を割る → consistency=0.5 → 係数0.8
        x = np.array([10.0, 0.1, 10.0, 0.1, 10.0, 0.1])
        med = np.median(x)
        cap = med * 3
        base = np.minimum(x, cap).mean()
        consistency = (x >= 0.6 * med).mean()
        expected = base * (0.6 + 0.4 * consistency)
        assert continuity_score(pd.Series(x), 6).iloc[-1] == pytest.approx(expected)
        assert consistency == pytest.approx(0.5)


class TestStrategies:
    """戦略が「当日終値までの情報だけ」でシグナルを出しているかを確認する。"""

    def _trending_df(self, n=260, seed=0):
        rng = np.random.default_rng(seed)
        close = 100 * np.cumprod(1 + rng.normal(0.0008, 0.015, n))
        vol = rng.lognormal(11, 0.4, n)
        return make_df(close, vol)

    @pytest.mark.parametrize("fn", [flow_capitulation, flow_momentum, rsi2_flow, rsi2_quiet])
    def test_signal_columns_and_no_lookahead(self, fn):
        df = self._trending_df()
        full = fn(df)
        assert set(full.columns) == {"entry", "exit", "rank"}
        assert full["entry"].dtype == bool
        cut = 230
        truncated = fn(df.iloc[:cut])
        # 切り詰めても、その時点までのシグナルは変わらない = 先読みしていない
        pd.testing.assert_series_equal(
            truncated["entry"], full["entry"].iloc[:cut], check_names=False)

    def test_flow_and_quiet_are_disjoint(self):
        """同一閾値なら rsi2_flow と rsi2_quiet は互いに排他(対照群として妥当)。"""
        df = self._trending_df(seed=3)
        a = rsi2_flow(df, buy_th=15.0, surge_th=1.5)["entry"]
        b = rsi2_quiet(df, buy_th=15.0, surge_cap=1.5)["entry"]
        assert not (a & b).any()

    def test_capitulation_requires_drop_and_surge(self):
        """急増していても上昇日なら capitulation は反応しない。"""
        n = 240
        close = np.concatenate([np.linspace(100, 150, n - 1), [160.0]])  # 最終日は上昇
        vol = np.concatenate([np.full(n - 1, 1000.0), [50000.0]])        # 出来高急増
        df = make_df(close, vol)
        assert not flow_capitulation(df)["entry"].iloc[-1]
