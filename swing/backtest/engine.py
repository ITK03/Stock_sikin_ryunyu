"""ポートフォリオ・バックテストエンジン。

ルール（現実的な執行を模す）:
- シグナル判定は日次終値時点。執行は翌営業日の寄付（始値）。
- 買い: 始値 * (1 + slippage)、売り: 始値 * (1 - slippage)。
- 損切り・利確・最大保有日数・手仕舞いシグナルはすべて終値で判定し翌寄りで
  執行（ザラ場逆指値より保守的な想定）。優先順位: stop_loss > take_profit >
  max_hold > exit signal。
- 同時シグナルが枠を超える場合は rank の降順で採用。
- ポジションサイズは「発注時点の総資産 / max_positions」の等金額。
  端株を許容する（戦略評価目的。実運用の単元株制約は仕様書で扱う）。

## take_profit（任意）
終値ベースで `close >= entry_fill * (1 + take_profit)` になった翌営業日の
寄付で成行売り（stop_lossが同時成立時は常にstopを優先。価格的に両方が
同時に成立することはない）。

## limit_entry（任意）
シグナルが終値D（close_D）で発生した銘柄について:
  - limit_entry=None: 従来どおり成行（翌営業日D+1の寄付で無条件に買う）。
  - limit_entry=x (>0): D+1に指値注文 `limit_price = close_D * (1 - x)` を
    「D+1のみ有効」で発注する。D+1の約定判定（優先順位）:
      1. D+1の始値 <= limit_price -> 寄付で約定（ギャップダウン）。
         約定価格 = 始値 * (1+slippage)
      2. 1が成立せず、D+1の安値 <= limit_price -> 指値で約定したとみなす。
         約定価格 = limit_price * (1+slippage)
      3. 1,2とも不成立 -> 不約定。シグナルは失効しD+2には持ち越さない
         （枠は消費しない。次順位の候補が空いた枠を使える）。
  ルックアヘッドなし: limit_priceの計算はシグナル判定日(D)の終値のみに依存
  し、D+1の情報（約定判定に使うopen/lowを除く）は一切使わない。

両パラメータともNone（既定）のときは拡張前の挙動と完全に一致する。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class EngineParams:
    max_positions: int = 5
    slippage_bps: float = 10.0          # 片道0.10%
    stop_loss: float | None = 0.08      # 終値ベース-8%で翌寄り損切り
    take_profit: float | None = None    # 終値ベース+take_profit%で翌寄り利確
    limit_entry: float | None = None    # close_D*(1-limit_entry)の指値でD+1のみ発注
    max_hold: int | None = 10           # 営業日
    initial_capital: float = 10_000_000.0


@dataclass
class Result:
    trades: pd.DataFrame
    equity: pd.Series
    params: EngineParams = field(repr=False, default=None)


def run_backtest(data: dict[str, pd.DataFrame],
                 signals: dict[str, pd.DataFrame],
                 params: EngineParams) -> Result:
    tickers = sorted(set(data) & set(signals))
    calendar = pd.DatetimeIndex(
        sorted(set().union(*[data[t].index for t in tickers]))
    )
    n = len(calendar)
    slip = params.slippage_bps / 10_000.0

    # master calendar に整列した numpy 配列
    arr: dict[str, dict[str, np.ndarray]] = {}
    # (rank, ticker, signal_close) のリスト。signal_closeはシグナル発生日(D)の
    # 終値（limit_entry計算用。limit_entry=Noneのときは未使用）。
    entries_by_day: dict[int, list[tuple[float, str, float]]] = {}
    for t in tickers:
        d = data[t].reindex(calendar)
        s = signals[t].reindex(calendar)
        a = {
            "open": d["open"].to_numpy(float),
            "low": d["low"].to_numpy(float),
            "close": d["close"].to_numpy(float),
            "entry": s["entry"].fillna(False).to_numpy(bool),
            "exit": s["exit"].fillna(False).to_numpy(bool),
            "rank": s["rank"].fillna(-np.inf).to_numpy(float),
        }
        arr[t] = a
        for i in np.flatnonzero(a["entry"]):
            entries_by_day.setdefault(int(i), []).append(
                (a["rank"][i], t, a["close"][i]))

    cash = params.initial_capital
    positions: dict[str, dict] = {}       # ticker -> {shares, entry_px, entry_i}
    last_close: dict[str, float] = {}
    pending_exit: dict[str, str] = {}      # ticker -> reason
    pending_entry: list[tuple[float, str, float]] = []
    trades: list[dict] = []
    equity_curve = np.empty(n)
    fills = 0
    misses = 0

    for i in range(n):
        # 1) 寄りで手仕舞い
        for t, reason in list(pending_exit.items()):
            if t not in positions:
                pending_exit.pop(t)
                continue
            px = arr[t]["open"][i]
            if np.isnan(px):
                continue  # 売買停止等 → 翌日に持ち越し
            pos = positions.pop(t)
            sell_px = px * (1.0 - slip)
            cash += pos["shares"] * sell_px
            trades.append({
                "ticker": t,
                "entry_date": calendar[pos["entry_i"]],
                "exit_date": calendar[i],
                "entry_px": pos["entry_px"],
                "exit_px": sell_px,
                "ret": sell_px / pos["entry_px"] - 1.0,
                "hold_days": i - pos["entry_i"],
                "reason": reason,
            })
            pending_exit.pop(t)

        # 2) 寄り（または指値）で新規建て（rank降順）
        if pending_entry and len(positions) < params.max_positions:
            mtm = cash + sum(pos["shares"] * last_close.get(t2, pos["entry_px"])
                             for t2, pos in positions.items())
            size = mtm / params.max_positions
            for _, t, sig_close in sorted(pending_entry, key=lambda x: x[0], reverse=True):
                if len(positions) >= params.max_positions:
                    break
                if t in positions or t in pending_exit:
                    continue
                open_px = arr[t]["open"][i]
                if np.isnan(open_px) or open_px <= 0:
                    continue
                if params.limit_entry is None:
                    fill_px = open_px
                else:
                    limit_price = sig_close * (1.0 - params.limit_entry)
                    low_px = arr[t]["low"][i]
                    if open_px <= limit_price:
                        fill_px = open_px  # 寄付が指値以下でギャップダウン → 寄付で約定
                    elif not np.isnan(low_px) and low_px <= limit_price:
                        fill_px = limit_price  # ザラ場中に指値到達 → 指値で約定
                    else:
                        misses += 1
                        continue  # 不約定。シグナル失効（D+2に持ち越さない）
                    fills += 1
                buy_px = fill_px * (1.0 + slip)
                budget = min(size, cash)
                if budget <= 0:
                    continue
                shares = budget / buy_px
                cash -= shares * buy_px
                positions[t] = {"shares": shares, "entry_px": buy_px, "entry_i": i}
        pending_entry = []

        # 3) 終値で手仕舞い判定
        #    優先順位: stop_loss > take_profit > max_hold > exit signal
        for t, pos in positions.items():
            c = arr[t]["close"][i]
            if not np.isnan(c):
                last_close[t] = c
            else:
                c = last_close.get(t, pos["entry_px"])
            if t in pending_exit:
                continue
            if params.stop_loss is not None and c <= pos["entry_px"] * (1.0 - params.stop_loss):
                pending_exit[t] = "stop"
            elif params.take_profit is not None and c >= pos["entry_px"] * (1.0 + params.take_profit):
                pending_exit[t] = "target"
            elif params.max_hold is not None and i - pos["entry_i"] >= params.max_hold:
                pending_exit[t] = "time"
            elif arr[t]["exit"][i]:
                pending_exit[t] = "signal"

        # 4) 翌日寄り(or指値)のエントリー候補
        for rank, t, sig_close in entries_by_day.get(i, []):
            if t in positions or t in pending_exit:
                continue
            pending_entry.append((rank, t, sig_close))

        equity_curve[i] = cash + sum(
            pos["shares"] * last_close.get(t, pos["entry_px"])
            for t, pos in positions.items()
        )

    trades_df = pd.DataFrame(trades)
    equity = pd.Series(equity_curve, index=calendar, name="equity")
    result = Result(trades=trades_df, equity=equity, params=params)
    result.limit_fill_stats = {"fills": fills, "misses": misses}  # type: ignore[attr-defined]
    return result
