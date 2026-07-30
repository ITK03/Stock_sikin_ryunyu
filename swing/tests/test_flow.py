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


class TestProductionIntegration:
    """本番コード側(backtest/indicators, strategies, engine)に入れた変更の検証。"""

    def test_indicators_surge_matches_research(self):
        """本番の turnover_surge と研究用 surge が同一値であること。"""
        from backtest.indicators import turnover_surge
        rng = np.random.default_rng(1)
        n = 120
        df = make_df(100 + rng.normal(0, 5, n), rng.lognormal(14, 0.5, n))
        pd.testing.assert_series_equal(turnover_surge(df, 1), surge(df, 1),
                                       check_names=False)
        pd.testing.assert_series_equal(turnover_surge(df, 3), surge(df, 3),
                                       check_names=False)

    def test_rsi2_flow_is_subset_of_rsi2_dip(self):
        """フィルタ版は無条件版の部分集合(条件を足しただけ)であること。"""
        from backtest.strategies import rsi2_dip, rsi2_flow
        rng = np.random.default_rng(5)
        n = 400
        close = 100 * np.cumprod(1 + rng.normal(0.001, 0.02, n))
        df = make_df(close, rng.lognormal(16.1, 0.5, n))
        dip = rsi2_dip(df, buy_th=15.0, sell_th=70.0, trend_n=200)["entry"]
        flow = rsi2_flow(df, buy_th=15.0, sell_th=70.0, trend_n=200)["entry"]
        assert not (flow & ~dip).any()

    def test_registry_loads_all_strategies(self):
        """registry.yaml の全戦略が実際に解決できること(本番の起動時チェック)。"""
        from pathlib import Path
        from screener.run import load_registry
        ids = [e.id for e in load_registry(Path("screener/registry.yaml"))]
        assert "rsi2_flow" in ids

    def test_engine_fee_defaults_to_no_change(self):
        """fee_bps の既定値0では従来と完全に同一の結果になること(後方互換)。"""
        from backtest.engine import EngineParams
        assert EngineParams().fee_bps == 0.0
        a = EngineParams(slippage_bps=10.0)
        b = EngineParams(slippage_bps=10.0, fee_bps=0.0)
        assert a.slippage_bps + a.fee_bps == b.slippage_bps + b.fee_bps

    def test_engine_fee_reduces_returns(self):
        """手数料を入れるとリターンが必ず悪化すること。"""
        from backtest.engine import EngineParams, run_backtest
        from backtest.strategies import rsi2_dip
        rng = np.random.default_rng(11)
        n, prices, signals = 500, {}, {}
        for i in range(6):
            close = 100 * np.cumprod(1 + rng.normal(0.0008, 0.02, n))
            df = make_df(close, rng.lognormal(16.1, 0.4, n))
            prices[f"T{i}"] = df
            signals[f"T{i}"] = rsi2_dip(df, buy_th=20.0, trend_n=100)
        free = run_backtest(prices, signals, EngineParams(fee_bps=0.0))
        paid = run_backtest(prices, signals, EngineParams(fee_bps=25.0))
        assert len(free.trades) > 0
        assert paid.trades["ret"].mean() < free.trades["ret"].mean()


class TestExpectedValueOrdering:
    """掲載順が期待値(oos_stats.avg_ret)の降順になっていること。"""

    def _prices(self, n_tickers=120, n_days=300, seed=3):
        rng = np.random.default_rng(seed)
        idx = pd.bdate_range("2024-01-01", periods=n_days)
        out = {}
        for i in range(n_tickers):
            c = 100 * np.cumprod(1 + rng.normal(0.001, 0.02, n_days))
            out[str(7000 + i)] = pd.DataFrame(
                {"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                 "volume": rng.lognormal(16.1, 0.4, n_days)}, index=idx)
        return out

    def test_strategies_sorted_by_avg_ret_desc(self):
        from pathlib import Path
        from screener.run import build_json, load_registry
        reg = load_registry(Path("screener/registry.yaml"))
        payload = build_json(self._prices(), reg)
        avg = [s["oos_stats"].get("avg_ret") for s in payload["strategies"]]
        assert all(a is not None for a in avg), "全戦略に avg_ret が必要"
        assert avg == sorted(avg, reverse=True), f"期待値の降順になっていない: {avg}"

    def test_candidate_count_matches_max_positions(self):
        """掲載する買い候補数が保有上限と一致すること。

        以前は10件に固定されており、max_positions=20 にしても枠を埋められなかった。
        """
        from pathlib import Path
        from screener.run import build_json, load_registry
        reg = load_registry(Path("screener/registry.yaml"))
        payload = build_json(self._prices(n_tickers=200), reg)
        for s in payload["strategies"]:
            cap = next(e.meta["engine"]["max_positions"] for e in reg if e.id == s["id"])
            assert len(s["buy_candidates"]) <= cap
            prios = [c["priority"] for c in s["buy_candidates"]]
            assert prios == list(range(1, len(prios) + 1)), f"{s['id']}: 優先順位が連番でない"
        # 候補が上限に達する戦略が最低1つはある(= 10件で頭打ちになっていない)
        assert any(len(s["buy_candidates"]) > 10 for s in payload["strategies"]), \
            "どの戦略も候補が10件を超えず、上限緩和が効いていない"

    def test_all_registry_entries_have_avg_ret_and_20_positions(self):
        """並び替えキーの欠落と、銘柄数設定の取りこぼしを防ぐ。"""
        import yaml
        from pathlib import Path
        reg = yaml.safe_load(Path("screener/registry.yaml").read_text(encoding="utf-8"))
        for st in reg["strategies"]:
            if not st.get("enabled"):
                continue
            assert "avg_ret" in st["oos_stats"], f"{st['id']}: avg_ret 未設定"
            assert st["engine"]["max_positions"] == 20, f"{st['id']}: 銘柄数が20でない"
