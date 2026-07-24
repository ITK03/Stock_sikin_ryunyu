"""戦略定義。

各戦略は ticker毎のOHLCV DataFrame を受け取り、
entry(bool) / exit(bool) / rank(float) の3列を持つDataFrameを返す。
すべて当日終値までの情報のみで計算する（翌寄り執行はエンジン側）。

学術的知見（モメンタムは日本市場では歴史的に弱く、短期リバーサルは
比較的頑健）を踏まえ、平均回帰系を中心にモメンタム系を対照として置く。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import (atr, bollinger, median_turnover, rolling_high,
                         rolling_low, rsi, sma)

MIN_TURNOVER = 5e8  # 20日中央値売買代金 5億円以上（流動性フィルタ）


def _base(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["entry"] = False
    out["exit"] = False
    out["rank"] = 0.0
    return out


def _liquid(df: pd.DataFrame) -> pd.Series:
    return median_turnover(df, 20) >= MIN_TURNOVER


def rsi2_dip(df: pd.DataFrame, rsi_n: int = 2, buy_th: float = 10.0,
             sell_th: float = 65.0, trend_n: int = 100) -> pd.DataFrame:
    """Connors流RSI(2)押し目買い: 長期上昇トレンド中の短期売られすぎを買う。"""
    out = _base(df)
    r = rsi(df["close"], rsi_n)
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (r < buy_th) & trend & _liquid(df)
    out["exit"] = r > sell_th
    out["rank"] = -r  # RSIが低いほど優先
    return out


def pullback(df: pd.DataFrame, drop_n: int = 5, drop_th: float = -0.06,
             trend_n: int = 75, exit_n: int = 5) -> pd.DataFrame:
    """トレンド中の急落買い: n日で drop_th 以上下落した銘柄を買い、
    終値がSMA(exit_n)を上回ったら手仕舞い。"""
    out = _base(df)
    ret_n = df["close"].pct_change(drop_n)
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (ret_n < drop_th) & trend & _liquid(df)
    out["exit"] = df["close"] > sma(df["close"], exit_n)
    out["rank"] = -ret_n  # 下落率が大きいほど優先
    return out


def bb_meanrev(df: pd.DataFrame, n: int = 20, k: float = 2.0,
               trend_n: int = 100) -> pd.DataFrame:
    """ボリンジャーバンド逆張り: 上昇トレンド中に-kσ割れで買い、
    ミッドバンド回帰で手仕舞い。"""
    out = _base(df)
    lower, mid, _ = bollinger(df["close"], n, k)
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (df["close"] < lower) & trend & _liquid(df)
    out["exit"] = df["close"] >= mid
    out["rank"] = (lower - df["close"]) / df["close"]  # 乖離が大きいほど優先
    return out


def gap_down_reversal(df: pd.DataFrame, gap_th: float = -0.03,
                      trend_n: int = 100, exit_n: int = 3) -> pd.DataFrame:
    """ギャップダウン翌日の反発取り: 上昇トレンド中に前日終値比 gap_th 以上の
    急落（終値ベース）が出た日を買い、SMA(exit_n)回復で手仕舞い。"""
    out = _base(df)
    day_ret = df["close"].pct_change()
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (day_ret < gap_th) & trend & _liquid(df)
    out["exit"] = df["close"] > sma(df["close"], exit_n)
    out["rank"] = -day_ret
    return out


def keltner_atr_dip(df: pd.DataFrame, n: int = 20, k: float = 2.5,
                    trend_n: int = 200) -> pd.DataFrame:
    """ATRチャネル逆張り: 長期上昇トレンド中にSMA(n)-k*ATR(n)を割れる深押しを買い、
    終値がSMA(n)を回復したら手仕舞い。"""
    out = _base(df)
    mid = sma(df["close"], n)
    a = atr(df, n)
    lower = mid - k * a
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (df["close"] < lower) & trend & _liquid(df)
    out["exit"] = df["close"] >= mid
    out["rank"] = (lower - df["close"]) / df["close"]  # 乖離が大きいほど優先
    return out


def breakout(df: pd.DataFrame, high_n: int = 20, exit_n: int = 10,
             trend_n: int = 100) -> pd.DataFrame:
    """高値ブレイクアウト（モメンタム系・対照用）: n日高値更新で買い、
    exit_n日安値割れで手仕舞い。"""
    out = _base(df)
    hh = rolling_high(df["close"], high_n).shift(1)
    ll = rolling_low(df["close"], exit_n).shift(1)
    trend = df["close"] > sma(df["close"], trend_n)
    a = atr(df, 14)
    out["entry"] = (df["close"] > hh) & trend & _liquid(df)
    out["exit"] = df["close"] < ll
    out["rank"] = ((df["close"] - hh) / a).fillna(0.0)
    return out


# 戦略名 -> (関数, パラメータグリッド)。グリッドは過剰最適化を避け小さめに。
STRATEGIES: dict[str, tuple] = {
    "rsi2_dip": (rsi2_dip, [
        {"buy_th": b, "sell_th": s, "trend_n": t}
        for b in (5.0, 10.0, 15.0) for s in (60.0, 70.0) for t in (100, 200)
    ]),
    "pullback": (pullback, [
        {"drop_n": n, "drop_th": th, "trend_n": t}
        for n in (3, 5) for th in (-0.05, -0.07, -0.09) for t in (75, 200)
    ]),
    "bb_meanrev": (bb_meanrev, [
        {"n": n, "k": k, "trend_n": t}
        for n in (20,) for k in (2.0, 2.5) for t in (100, 200)
    ]),
    "keltner_atr_dip": (keltner_atr_dip, [
        {"n": n, "k": k, "trend_n": t}
        for n in (14, 20) for k in (2.0, 2.5, 3.0) for t in (100, 200)
    ]),
    "gap_down_reversal": (gap_down_reversal, [
        {"gap_th": g, "exit_n": e, "trend_n": t}
        for g in (-0.03, -0.05) for e in (3, 5) for t in (100, 200)
    ]),
    "breakout": (breakout, [
        {"high_n": h, "exit_n": e, "trend_n": t}
        for h in (20, 55) for e in (10, 20) for t in (100, 200)
    ]),
}
