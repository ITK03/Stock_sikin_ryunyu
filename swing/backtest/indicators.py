"""テクニカル指標（すべてpandasベース、当日終値までの情報のみ使用）。"""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 2) -> pd.Series:
    """Wilder方式のRSI。"""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / n, min_periods=n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / n, min_periods=n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    return out.fillna(100.0).where(close.notna())


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / n, min_periods=n, adjust=False).mean()


def rolling_high(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).max()


def rolling_low(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).min()


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(close, n)
    std = close.rolling(n, min_periods=n).std(ddof=0)
    return mid - k * std, mid, mid + k * std


def median_turnover(df: pd.DataFrame, n: int = 20) -> pd.Series:
    """売買代金（円）のn日中央値。流動性フィルタ用。"""
    return (df["close"] * df["volume"]).rolling(n, min_periods=n).median()


def turnover_surge(df: pd.DataFrame, n: int = 1, baseline_days: int = 25) -> pd.Series:
    """売買代金急増率 = 直近n日平均 ÷ その手前 baseline_days 日平均。

    統合ダッシュボードの④急増ランキング(src/core/rankings.ts buildSurge)と
    同一の窓取り: 基準(平常時)の窓は直近ウィンドウの手前へn日ずらす。
    こうすると「数日前から噴いている銘柄」は基準が上がって倍率が下がり、
    当日始まった初動が浮かぶ。

    基準は25日窓のうち最低6割(15日)のデータを要求する(本家と同一)。
    """
    t = df["close"] * df["volume"]
    recent = t.rolling(n, min_periods=n).mean()
    min_base = int(np.ceil(baseline_days * 0.6))
    base = t.shift(n).rolling(baseline_days, min_periods=min_base).mean()
    return recent / base.replace(0.0, np.nan)
