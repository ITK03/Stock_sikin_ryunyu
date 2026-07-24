import numpy as np
import pandas as pd
import pytest

from backtest.indicators import bollinger, rsi, sma


def test_sma_needs_full_window():
    s = pd.Series([1.0, 2.0, 3.0, 4.0])
    m = sma(s, 3)
    assert m.isna().sum() == 2
    assert m.iloc[2] == pytest.approx(2.0)
    assert m.iloc[3] == pytest.approx(3.0)


def test_rsi_bounds_and_direction():
    up = pd.Series(np.linspace(100, 200, 50))
    down = pd.Series(np.linspace(200, 100, 50))
    assert rsi(up, 2).iloc[-1] == pytest.approx(100.0)
    assert rsi(down, 2).iloc[-1] == pytest.approx(0.0, abs=1e-6)
    mixed = pd.Series([100, 102, 101, 103, 99, 104, 100, 105] * 5, dtype=float)
    r = rsi(mixed, 2).dropna()
    assert ((r >= 0) & (r <= 100)).all()


def test_bollinger_symmetry():
    rng = np.random.default_rng(0)
    s = pd.Series(100 + rng.normal(0, 1, 100).cumsum())
    lower, mid, upper = bollinger(s, 20, 2.0)
    valid = mid.notna()
    assert ((upper[valid] - mid[valid]) - (mid[valid] - lower[valid])).abs().max() < 1e-9
    assert (upper[valid] >= lower[valid]).all()


def test_no_lookahead_in_signals():
    """シグナル計算が未来の値に依存しないこと: 末尾を切っても過去のシグナルが不変。"""
    from backtest.strategies import STRATEGIES
    rng = np.random.default_rng(1)
    n = 400
    close = pd.Series(1000 * np.exp(rng.normal(0.0003, 0.02, n).cumsum()))
    idx = pd.bdate_range("2020-01-01", periods=n)
    df = pd.DataFrame({
        "open": close.values * (1 + rng.normal(0, 0.005, n)),
        "close": close.values,
        "volume": rng.integers(500_000, 5_000_000, n).astype(float),
    }, index=idx)
    df["high"] = df[["open", "close"]].max(axis=1) * 1.01
    df["low"] = df[["open", "close"]].min(axis=1) * 0.99

    for name, (fn, _grid) in STRATEGIES.items():
        full = fn(df)
        trunc = fn(df.iloc[:300])
        pd.testing.assert_frame_equal(full.iloc[:300], trunc, check_dtype=False,
                                      obj=f"strategy {name}")
