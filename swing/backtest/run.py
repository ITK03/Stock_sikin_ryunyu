"""バックテスト実行CLI。

使い方:
  python -m backtest.run --fetch          # データ取得のみ（要ネットワーク）
  python -m backtest.run --run            # キャッシュ済みデータで全戦略を実行
  python -m backtest.run --fetch --run

検証設計:
  - イン・サンプル(IS): 開始〜2021-12-31 でパラメータ選択
  - アウト・オブ・サンプル(OOS): 2022-01-01〜最新 で選択済み設定を評価
  シミュレーションは全期間で1回行い、トレードのエントリー日で期間を分けて
  集計する（パラメータ選択にOOS情報は使わない）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from . import data as data_mod
from .engine import EngineParams, run_backtest
from .metrics import summarize, yearly_stats
from .strategies import STRATEGIES
from .universe import yf_tickers

IS_END = "2021-12-31"
OOS_START = "2022-01-01"


def market_regime(prices: dict[str, pd.DataFrame], n: int = 200) -> pd.Series:
    """地合いフィルタ: ユニバース等ウェイト指数がSMA(n)より上ならTrue。

    個別銘柄のシグナルとは独立に、市場全体の下落局面で新規建てを止める。
    """
    rets = pd.DataFrame({t: df["close"].pct_change() for t, df in prices.items()})
    index = (1.0 + rets.mean(axis=1)).cumprod()
    return index > index.rolling(n, min_periods=n).mean()

# 戦略ファミリー毎のエンジン設定
# 平均回帰系はタイトな損切りが成績を悪化させる（検証済み）ため、
# 個別株の急落に備えた広い「災害ストップ」-15% + 時間切れ10日を採用。
ENGINE_OVERRIDES = {
    "breakout": dict(stop_loss=0.08, max_hold=60),
}
DEFAULT_ENGINE = dict(max_positions=5, slippage_bps=10.0, stop_loss=0.15, max_hold=10)


def run_all(prices: dict[str, pd.DataFrame], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    far_past, far_future = "1900-01-01", "2100-01-01"
    rows = []
    best_results = {}

    market_ok = market_regime(prices)
    for name, (fn, grid) in STRATEGIES.items():
        eng_kwargs = {**DEFAULT_ENGINE, **ENGINE_OVERRIDES.get(name, {})}
        best = None
        for params in grid:
            base_signals = {t: fn(df, **params) for t, df in prices.items()}
            for mf in (False, True):
                if mf:
                    signals = {}
                    for t, s in base_signals.items():
                        s = s.copy()
                        s["entry"] &= market_ok.reindex(s.index).fillna(False)
                        signals[t] = s
                else:
                    signals = base_signals
                result = run_backtest(prices, signals, EngineParams(**eng_kwargs))
                is_m = summarize(result, (far_past, IS_END))
                oos_m = summarize(result, (OOS_START, far_future))
                score = is_m.get("sharpe", 0.0) if is_m.get("trades", 0) >= 100 else float("-inf")
                full_params = {**params, "market_filter": mf}
                rows.append({
                    "strategy": name, "params": json.dumps(full_params),
                    "is_score": score,
                    **{f"is_{k}": v for k, v in is_m.items()},
                    **{f"oos_{k}": v for k, v in oos_m.items()},
                })
                if best is None or score > best[0]:
                    best = (score, full_params, result, is_m, oos_m)
                print(f"{name} {full_params}: IS sharpe={is_m.get('sharpe', 0):.2f} "
                      f"trades={is_m.get('trades', 0)} wr={is_m.get('win_rate', 0):.1%} | "
                      f"OOS wr={oos_m.get('win_rate', 0):.1%} pf={oos_m.get('profit_factor', 0):.2f}")
        best_results[name] = best

    pd.DataFrame(rows).to_csv(out_dir / "all_runs.csv", index=False)
    _write_summary(best_results, out_dir)


def _fmt(m: dict) -> str:
    if m.get("trades", 0) == 0:
        return "| 0 | - | - | - | - | - | - | - |"
    return ("| {trades} | {win_rate:.1%} | {avg_ret:.2%} | {profit_factor:.2f} "
            "| {avg_hold_days:.1f} | {cagr:.1%} | {max_drawdown:.1%} | {sharpe:.2f} |").format(**m)


def _write_summary(best_results: dict, out_dir: Path) -> None:
    lines = [
        "# 日本株スイングトレード バックテスト結果",
        "",
        f"- ユニバース: 東証大型・高流動性 約120銘柄 / データ: yfinance調整済み日足",
        f"- 執行モデル: 終値シグナル→翌寄り執行、スリッページ片道0.10%、手数料0円",
        f"- リスク管理: 等金額5分散、災害ストップ-15%（終値判定）、最大保有10営業日（breakoutのみ-8%/60日）",
        f"- IS(パラメータ選択): 〜{IS_END} / OOS(検証): {OOS_START}〜",
        "",
        "| 戦略 | 期間 | 取引数 | 勝率 | 平均損益 | PF | 平均保有日 | CAGR | 最大DD | Sharpe |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, best in best_results.items():
        if best is None:
            continue
        _, params, result, is_m, oos_m = best
        lines.append(f"| **{name}** {json.dumps(params)} | IS " + _fmt(is_m))
        lines.append(f"| | OOS " + _fmt(oos_m))

    lines += ["", "## 年別成績（各戦略の最良設定）", ""]
    for name, best in best_results.items():
        if best is None:
            continue
        _, params, result, _, _ = best
        ys = yearly_stats(result.trades)
        lines += [f"### {name} {json.dumps(params)}", ""]
        if ys.empty:
            lines += ["(取引なし)", ""]
            continue
        lines += ["| 年 | 取引数 | 勝率 | 平均損益 | 合計損益(単純和) |", "|---|---|---|---|---|"]
        for year, row in ys.iterrows():
            lines.append(f"| {year} | {int(row['trades'])} | {row['win_rate']:.1%} "
                         f"| {row['avg_ret']:.2%} | {row['sum_ret']:.1%} |")
        lines.append("")
        result.trades.to_csv(out_dir / f"trades_{name}.csv", index=False)
        result.equity.to_csv(out_dir / f"equity_{name}.csv")

    (out_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwrote {out_dir}/summary.md")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--out", default="results")
    args = ap.parse_args()

    if args.fetch:
        data_mod.fetch(yf_tickers())
    if args.run:
        prices = data_mod.load()
        print(f"loaded {len(prices)} tickers")
        run_all(prices, Path(args.out))


if __name__ == "__main__":
    main()
