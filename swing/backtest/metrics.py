"""バックテスト結果の評価指標。"""
from __future__ import annotations

import numpy as np
import pandas as pd


def trade_stats(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {"trades": 0}
    r = trades["ret"]
    wins, losses = r[r > 0], r[r <= 0]
    gross_win = wins.sum()
    gross_loss = -losses.sum()
    return {
        "trades": len(r),
        "win_rate": len(wins) / len(r),
        "avg_ret": r.mean(),
        "avg_win": wins.mean() if len(wins) else 0.0,
        "avg_loss": losses.mean() if len(losses) else 0.0,
        "profit_factor": gross_win / gross_loss if gross_loss > 0 else np.inf,
        "avg_hold_days": trades["hold_days"].mean(),
    }


def equity_stats(equity: pd.Series) -> dict:
    if len(equity) < 2:
        return {}
    ret = equity.pct_change().dropna()
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1 if years > 0 else 0.0
    dd = equity / equity.cummax() - 1.0
    sharpe = ret.mean() / ret.std() * np.sqrt(245) if ret.std() > 0 else 0.0
    return {
        "total_return": equity.iloc[-1] / equity.iloc[0] - 1.0,
        "cagr": cagr,
        "max_drawdown": dd.min(),
        "sharpe": sharpe,
    }


def yearly_stats(trades: pd.DataFrame) -> pd.DataFrame:
    """年別の件数・勝率・平均リターン・合計リターン（安定性の確認用）。"""
    if trades.empty:
        return pd.DataFrame()
    g = trades.groupby(trades["exit_date"].dt.year)["ret"]
    return pd.DataFrame({
        "trades": g.size(),
        "win_rate": g.apply(lambda s: (s > 0).mean()),
        "avg_ret": g.mean(),
        "sum_ret": g.sum(),
    })


def summarize(result, period: tuple[str, str] | None = None) -> dict:
    """期間を絞って（entry_date基準）指標を計算する。"""
    trades, equity = result.trades, result.equity
    if period is not None:
        lo, hi = pd.Timestamp(period[0]), pd.Timestamp(period[1])
        if not trades.empty:
            trades = trades[(trades["entry_date"] >= lo) & (trades["entry_date"] <= hi)]
        equity = equity[(equity.index >= lo) & (equity.index <= hi)]
    return {**trade_stats(trades), **equity_stats(equity)}
