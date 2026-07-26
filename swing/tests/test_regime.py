"""大相場検知(research/regime.py)のロジック検証。

銘柄横断のランキングを扱うため、既存の指標テストとは別に用意する。
特に「先読みしていないか」「順位が正しく付いているか」を固定する。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from research.regime import (build_panels, detect, first_signals,
                             label_major_moves, lead_time_analysis)


def mk(close, volume, start="2020-01-01"):
    idx = pd.bdate_range(start, periods=len(close))
    close = np.asarray(close, dtype=float)
    volume = np.asarray(volume, dtype=float)
    return pd.DataFrame({"open": close, "high": close * 1.01, "low": close * 0.99,
                         "close": close, "volume": volume}, index=idx)


class TestBuildPanels:
    def test_turnover_rank_is_cross_sectional(self):
        """順位はその日の全銘柄の中で付く(1が最大の売買代金)。"""
        n = 80
        prices = {
            "A": mk([100] * n, [1000] * n),   # 売買代金 100,000 → 3位
            "B": mk([100] * n, [3000] * n),   # 300,000 → 1位
            "C": mk([100] * n, [2000] * n),   # 200,000 → 2位
        }
        p = build_panels(prices)
        last = p["rank"].iloc[-1]
        assert last["B"] == 1
        assert last["C"] == 2
        assert last["A"] == 3

    def test_rel_is_relative_to_own_history(self):
        """平常時比は自分の過去中央値に対する倍率(他銘柄と無関係)。"""
        n = 80
        vol = [1000] * (n - 1) + [3000]
        prices = {"A": mk([100] * n, vol), "B": mk([100] * n, [50_000] * n)}
        p = build_panels(prices)
        # Aは自分比3倍。Bは絶対額が大きくても平常時比は1倍
        assert p["rel"].iloc[-1]["A"] == pytest.approx(3.0, rel=1e-3)
        assert p["rel"].iloc[-1]["B"] == pytest.approx(1.0, rel=1e-3)

    def test_large_cap_alone_does_not_trigger(self):
        """常に売買代金トップの大型株でも、平常時比が上がらなければ検知しない。

        三菱UFJのような銘柄が毎日検知され続けるのを防げているかの確認。
        """
        n = 90
        prices = {
            "MEGA": mk([100] * n, [1_000_000] * n),   # 常にランキング1位・平常時比1倍
            "SMALL": mk([100] * n, [1000] * n),
        }
        p = build_panels(prices)
        sig = detect(p, top_k=1, rel_th=1.5, persist_days=3)
        assert not sig["MEGA"].any()


class TestLabelMajorMoves:
    def test_labels_a_sustained_rise(self):
        # 60日で2倍に上昇 → horizon=60, min_gain=0.6 で開始日にラベルが立つ
        close = np.concatenate([np.full(20, 100.0), np.linspace(100, 200, 60)])
        prices = {"A": mk(close, [1000] * len(close))}
        p = build_panels(prices)
        label, gain = label_major_moves(p["close"], horizon=60, min_gain=0.6, max_dd=0.25)
        assert bool(label["A"].iloc[19])          # 上昇開始の直前でラベルON
        assert gain["A"].iloc[19] == pytest.approx(1.0, rel=0.05)

    def test_rejects_spike_then_crash(self):
        """急騰後すぐ暴落した銘柄は、途中の下落条件で弾かれる。"""
        # 一度-40%まで下げてから2倍になる → max_dd=0.25 を超えるので不成立
        close = np.concatenate([[100.0], np.full(30, 60.0), np.full(29, 200.0)])
        prices = {"A": mk(close, [1000] * len(close))}
        p = build_panels(prices)
        label, _ = label_major_moves(p["close"], horizon=59, min_gain=0.6, max_dd=0.25)
        assert not bool(label["A"].iloc[0])

    def test_flat_series_never_labeled(self):
        close = np.full(100, 100.0)
        prices = {"A": mk(close, [1000] * 100)}
        p = build_panels(prices)
        label, _ = label_major_moves(p["close"], horizon=60, min_gain=0.6)
        assert not label["A"].any()


class TestDetect:
    def test_requires_both_conditions(self):
        """ランキング上位だけ、平常時比だけ、では検知しない。"""
        n = 90
        vol_a = [1000] * (n - 5) + [5000] * 5     # 平常時比は高いが絶対額は小さい
        prices = {
            "A": mk([100] * n, vol_a),
            "BIG": mk([100] * n, [1_000_000] * n),  # 絶対額は大きいが平常時比1倍
        }
        p = build_panels(prices)
        sig = detect(p, top_k=1, rel_th=1.5, persist_days=3)
        assert not sig["A"].any()    # ランキング1位になれない
        assert not sig["BIG"].any()  # 平常時比が上がらない

    def test_persist_days_filters_single_day_spikes(self):
        n = 90
        vol = [1000] * (n - 1) + [5000]  # 最終日だけ急増
        prices = {"A": mk([100] * n, vol)}
        p = build_panels(prices)
        assert detect(p, top_k=1, rel_th=1.5, persist_days=1)["A"].iloc[-1]
        assert not detect(p, top_k=1, rel_th=1.5, persist_days=3)["A"].iloc[-1]

    def test_no_lookahead(self):
        """ある日の検知は、その日までのデータだけで決まる。"""
        rng = np.random.default_rng(0)
        n = 150
        prices = {f"T{i}": mk(100 * np.cumprod(1 + rng.normal(0, 0.02, n)),
                              rng.lognormal(13, 0.5, n)) for i in range(5)}
        p_full = build_panels(prices)
        sig_full = detect(p_full)
        cut = 120
        p_cut = build_panels({t: df.iloc[:cut] for t, df in prices.items()})
        sig_cut = detect(p_cut)
        pd.testing.assert_frame_equal(sig_cut, sig_full.iloc[:cut])


class TestFirstSignals:
    def test_collapses_continuous_detection_into_one_episode(self):
        """大相場中は条件を満たし続けるため、1エピソードに畳む必要がある。"""
        idx = pd.bdate_range("2020-01-01", periods=200)
        s = pd.DataFrame({"A": [False] * 10 + [True] * 100 + [False] * 90}, index=idx)
        eps = first_signals(s, cooldown=120)
        assert len(eps) == 1
        assert eps[0][1] == idx[10]

    def test_separate_episodes_beyond_cooldown(self):
        idx = pd.bdate_range("2020-01-01", periods=400)
        flags = [False] * 400
        flags[10] = True
        flags[300] = True  # cooldown(120)より先 → 別エピソード
        eps = first_signals(pd.DataFrame({"A": flags}, index=idx), cooldown=120)
        assert len(eps) == 2
