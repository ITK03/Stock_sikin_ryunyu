"""資金フロー指標(ダッシュボードのランキング指標)の予測力を検証する研究スクリプト。

3部構成:
  Part A イベントスタディ … 指標の水準ごとに「その後どうなったか」を実測する。
         戦略を作る前に、指標そのものに予測力があるのか・向きはどちらかを見る。
  Part B ポートフォリオ検証 … Aの結果を戦略化し、既存エンジン(翌寄り執行・
         スリッページ・枠制限あり)で既存戦略と比較する。
  Part C 使い方の導出 … A/Bの数値からランキングの実務的な使い方を書き出す。

検証設計(過剰最適化の回避):
  - IS: 〜2021-12-31 でパラメータを選ぶ
  - OOS: 2022-01-01〜 で選んだ設定だけを評価する
  - イベントスタディもIS/OOSを分けて出し、OOSで符号が反転する指標は棄却する

前向きリターンの定義:
  シグナルは終値時点で確定し、執行は翌営業日の寄付。したがって評価も
  「翌寄り→k日後の寄付」(open-to-open)で測る。終値→終値で測ると、
  実際には取れない当日引けの動きを成績に含めてしまうため。

使い方:
  python -m research.study --source full   # data/full/*.parquet を使う
  python -m research.study --source cache  # data/jp_prices.csv.gz を使う
  python -m research.study --source synth  # 合成データ(配線確認用・研究には使わない)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from backtest.engine import EngineParams, run_backtest
from backtest.metrics import summarize, yearly_stats
from backtest.strategies import STRATEGIES as BASE_STRATEGIES
from research.flow import RESEARCH_STRATEGIES, add_flow_features

ROOT = Path(__file__).resolve().parent.parent
IS_END = "2021-12-31"
OOS_START = "2022-01-01"
FAR_PAST, FAR_FUTURE = "1900-01-01", "2100-01-01"

# 前向きリターンの評価ホライズン(営業日)。スイングの保有期間に合わせる。
HORIZONS = (1, 3, 5, 10)

# 既存の本番設定(screener/registry.yaml)と揃えたエンジン設定。
DEFAULT_ENGINE = dict(max_positions=5, slippage_bps=10.0, stop_loss=0.15,
                      max_hold=10, take_profit=0.02)

# 比較用に回す既存戦略(本番稼働中の2本)。
BASELINE_KEYS = ("rsi2_dip", "keltner_atr_dip")


# ---------------------------------------------------------------------------
# データ読み込み
# ---------------------------------------------------------------------------

def load_prices(source: str) -> dict[str, pd.DataFrame]:
    if source == "full":
        from backtest.data_full import load_full
        return load_full()
    if source == "cache":
        from backtest.data import load
        return load()
    if source == "synth":
        return _synthetic_prices()
    raise ValueError(f"unknown source: {source}")


def _synthetic_prices(n_tickers: int = 60, n_days: int = 1600,
                      seed: int = 7) -> dict[str, pd.DataFrame]:
    """配線確認専用の合成データ。

    「出来高急増を伴う下落の翌日は反発しやすい」という既知の構造を埋め込んである。
    これは *コードが構造を検出できるか* を確かめるためのものであり、
    ここから得られる数値に投資的な意味はない(研究の結論には使わない)。
    """
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2016-01-01", periods=n_days)
    out = {}
    for i in range(n_tickers):
        ret = rng.normal(0.0004, 0.016, n_days)
        # 終値1000円前後 × 出来高1e6株 ≈ 売買代金10億円。流動性フィルタ(5億円)を
        # 通る水準にしておかないとパネルが空になり、配線確認にならない。
        vol = rng.lognormal(13.8, 0.5, n_days)
        # 20日に1回程度、出来高急増を伴う急落を起こし、翌日に反発を仕込む
        shock = rng.random(n_days) < 0.05
        ret[shock] -= 0.05
        vol[shock] *= 6.0
        bounce = np.roll(shock, 1)
        bounce[0] = False
        ret[bounce] += 0.028
        close = 1000 * np.cumprod(1 + ret)
        open_ = close / (1 + ret * 0.5)
        high = np.maximum(open_, close) * (1 + rng.random(n_days) * 0.006)
        low = np.minimum(open_, close) * (1 - rng.random(n_days) * 0.006)
        out[f"T{i:04d}"] = pd.DataFrame(
            {"open": open_, "high": high, "low": low, "close": close, "volume": vol},
            index=idx)
    return out


# ---------------------------------------------------------------------------
# Part A: イベントスタディ
# ---------------------------------------------------------------------------

def build_panel(prices: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """全銘柄・全営業日の (特徴量, 前向きリターン) パネルを作る。

    前向きリターンは open-to-open(翌寄りで建て、k日後の寄りで decay)。
    シグナルは当日終値時点で確定しているため、これが実際に取れるリターン。
    """
    frames = []
    for ticker, df in prices.items():
        if len(df) < 260:
            continue
        feat = add_flow_features(df)
        op = df["open"]
        entry_px = op.shift(-1)  # 翌営業日の寄付(執行価格)
        for h in HORIZONS:
            feat[f"fwd{h}"] = op.shift(-(1 + h)) / entry_px - 1.0
        feat["ticker"] = ticker
        feat["date"] = df.index
        frames.append(feat)
    panel = pd.concat(frames, ignore_index=True)
    # 流動性がなく実際には売買できない行は最初から除く
    panel = panel[panel["liquid"].fillna(False)]
    panel = panel.dropna(subset=["surge1", "rsi2", "fwd5"])
    # 全銘柄×全営業日で数百万行になるため、集計精度に影響しない列はfloat32へ落とす
    # (ランナーのメモリ不足でジョブが落ちるのを防ぐ)。
    for c in panel.columns:
        if panel[c].dtype == np.float64:
            panel[c] = panel[c].astype(np.float32)
    return panel


def _stats(g: pd.DataFrame) -> dict:
    out = {"n": int(len(g))}
    for h in HORIZONS:
        col = f"fwd{h}"
        r = g[col].dropna()
        out[f"mean{h}"] = float(r.mean()) if len(r) else float("nan")
        out[f"win{h}"] = float((r > 0).mean()) if len(r) else float("nan")
    return out


def bucket_study(panel: pd.DataFrame, feature: str, edges: list[float],
                 labels: list[str]) -> pd.DataFrame:
    """指標の水準(バケット)ごとに、その後の平均リターンと勝率を集計する。"""
    b = pd.cut(panel[feature], bins=edges, labels=labels, right=False)
    rows = []
    for label, g in panel.groupby(b, observed=True):
        rows.append({"bucket": str(label), **_stats(g)})
    return pd.DataFrame(rows)


def conditional_study(panel: pd.DataFrame) -> pd.DataFrame:
    """急増 × その日の値動きの方向(上げ/下げ)の組み合わせで集計する。

    ④急増ランキングは「上げて急増」も「下げて急増」も同じ上位に並ぶ。
    両者は意味が正反対のはずで、ここを分けて見ることがランキング活用の核心。
    """
    p = panel.copy()
    p["surge_b"] = pd.cut(p["surge1"], bins=[0, 1.5, 3.0, 6.0, np.inf],
                          labels=["〜1.5倍", "1.5-3倍", "3-6倍", "6倍〜"], right=False)
    p["dir"] = np.where(p["day_ret"] >= 0.02, "上昇(+2%〜)",
                np.where(p["day_ret"] <= -0.02, "下落(〜-2%)", "横ばい"))
    rows = []
    for (sb, d), g in p.groupby(["surge_b", "dir"], observed=True):
        rows.append({"surge": str(sb), "当日": d, **_stats(g)})
    return pd.DataFrame(rows)


def trend_conditional_study(panel: pd.DataFrame) -> pd.DataFrame:
    """急増×下落を、長期トレンド(SMA200の上/下)で分けて見る。

    「トレンドが生きている銘柄の投げ売りだけ拾う」という条件付けが
    実際に効いているかを確認する。
    """
    p = panel[(panel["surge1"] >= 2.0) & (panel["day_ret"] <= -0.02)].copy()
    rows = []
    for tr, g in p.groupby(p["trend_up"].fillna(False), observed=True):
        rows.append({"長期トレンド": "上昇(終値>SMA200)" if tr else "下降(終値<SMA200)",
                     **_stats(g)})
    return pd.DataFrame(rows)


def run_event_study(panel: pd.DataFrame) -> dict:
    """IS/OOS を分けてイベントスタディを実行する。"""
    is_p = panel[panel["date"] <= IS_END]
    oos_p = panel[panel["date"] >= OOS_START]
    surge_edges = [0, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, np.inf]
    surge_labels = ["〜1倍", "1-1.5倍", "1.5-2倍", "2-3倍", "3-5倍", "5-10倍", "10倍〜"]
    cont_edges = [0, 0.8, 1.0, 1.3, 1.8, np.inf]
    cont_labels = ["〜0.8", "0.8-1.0", "1.0-1.3", "1.3-1.8", "1.8〜"]

    def block(p: pd.DataFrame) -> dict:
        return {
            "surge": bucket_study(p, "surge1", surge_edges, surge_labels).to_dict("records"),
            "continuity": bucket_study(p, "continuity10", cont_edges, cont_labels).to_dict("records"),
            "surge_x_direction": conditional_study(p).to_dict("records"),
            "surge_down_x_trend": trend_conditional_study(p).to_dict("records"),
            "n_rows": int(len(p)),
        }

    return {"IS": block(is_p), "OOS": block(oos_p)}


# ---------------------------------------------------------------------------
# Part B: ポートフォリオ検証
# ---------------------------------------------------------------------------

def run_strategy_grid(prices: dict[str, pd.DataFrame], name: str, fn, grid: list[dict],
                      min_is_trades: int = 80) -> dict | None:
    """ISでベスト設定を選び、その設定のOOS成績を返す(選択にOOSを使わない)。"""
    best = None
    for params in grid:
        signals = {t: fn(df, **params) for t, df in prices.items()}
        result = run_backtest(prices, signals, EngineParams(**DEFAULT_ENGINE))
        is_m = summarize(result, (FAR_PAST, IS_END))
        if is_m.get("trades", 0) < min_is_trades:
            continue
        score = is_m.get("sharpe", 0.0)
        if best is None or score > best["is_sharpe_score"]:
            oos_m = summarize(result, (OOS_START, FAR_FUTURE))
            best = {
                "strategy": name,
                "params": params,
                "is_sharpe_score": score,
                "IS": {k: _f(v) for k, v in is_m.items()},
                "OOS": {k: _f(v) for k, v in oos_m.items()},
                "yearly": _yearly_records(result),
            }
    return best


def _f(v):
    """JSON化のためnumpy型・非有限値を素のPython値へ落とす。"""
    if isinstance(v, (np.floating, float)):
        v = float(v)
        return None if not np.isfinite(v) else round(v, 6)
    if isinstance(v, (np.integer, int)):
        return int(v)
    return v


def _yearly_records(result) -> list[dict]:
    y = yearly_stats(result.trades)
    if y.empty:
        return []
    y = y.reset_index().rename(columns={"exit_date": "year"})
    return [{k: _f(v) for k, v in rec.items()} for rec in y.to_dict("records")]


def run_backtests(prices: dict[str, pd.DataFrame]) -> list[dict]:
    """研究戦略 + 既存ベースラインを同じエンジン設定で比較する。"""
    results = []
    for name, (fn, grid) in RESEARCH_STRATEGIES.items():
        r = run_strategy_grid(prices, name, fn, grid)
        if r:
            results.append(r)
        print(f"  done: {name}")
    for name in BASELINE_KEYS:
        fn, grid = BASE_STRATEGIES[name]
        r = run_strategy_grid(prices, f"{name}(既存)", fn, grid)
        if r:
            results.append(r)
        print(f"  done: {name}(既存)")
    results.sort(key=lambda r: (r["OOS"].get("sharpe") or -99), reverse=True)
    return results


# ---------------------------------------------------------------------------
# レポート出力
# ---------------------------------------------------------------------------

def _fmt_pct(v, digits=2):
    return "—" if v is None or (isinstance(v, float) and not np.isfinite(v)) else f"{v*100:.{digits}f}%"


def _event_table(records: list[dict], key: str, key_label: str) -> str:
    head = f"| {key_label} | 件数 | 1日後 | 3日後 | 5日後 | 10日後 | 5日勝率 |\n"
    head += "|---|---:|---:|---:|---:|---:|---:|\n"
    rows = []
    for r in records:
        rows.append(
            f"| {r[key]} | {r['n']:,} | {_fmt_pct(r['mean1'])} | {_fmt_pct(r['mean3'])} | "
            f"{_fmt_pct(r['mean5'])} | {_fmt_pct(r['mean10'])} | {_fmt_pct(r['win5'],1)} |")
    return head + "\n".join(rows)


def _cond_table(records: list[dict]) -> str:
    head = "| 急増率 | 当日の値動き | 件数 | 1日後 | 3日後 | 5日後 | 5日勝率 |\n"
    head += "|---|---|---:|---:|---:|---:|---:|\n"
    rows = []
    for r in records:
        rows.append(
            f"| {r['surge']} | {r['当日']} | {r['n']:,} | {_fmt_pct(r['mean1'])} | "
            f"{_fmt_pct(r['mean3'])} | {_fmt_pct(r['mean5'])} | {_fmt_pct(r['win5'],1)} |")
    return head + "\n".join(rows)


def _bt_table(results: list[dict]) -> str:
    head = ("| 戦略 | 選択パラメータ | IS取引 | IS勝率 | IS PF | OOS取引 | OOS勝率 | "
            "OOS PF | OOS平均 | OOS Sharpe | OOS最大DD |\n")
    head += "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
    rows = []
    for r in results:
        i, o = r["IS"], r["OOS"]
        rows.append(
            f"| {r['strategy']} | `{json.dumps(r['params'], ensure_ascii=False)}` | "
            f"{i.get('trades', 0):,} | {_fmt_pct(i.get('win_rate'),1)} | "
            f"{(i.get('profit_factor') or float('nan')):.2f} | "
            f"{o.get('trades', 0):,} | {_fmt_pct(o.get('win_rate'),1)} | "
            f"{(o.get('profit_factor') or float('nan')):.2f} | "
            f"{_fmt_pct(o.get('avg_ret'))} | {(o.get('sharpe') or float('nan')):.2f} | "
            f"{_fmt_pct(o.get('max_drawdown'),1)} |")
    return head + "\n".join(rows)


def write_report(out_dir: Path, event: dict, backtests: list[dict], meta: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(
        json.dumps({"meta": meta, "event_study": event, "backtests": backtests},
                   ensure_ascii=False, indent=1), encoding="utf-8")

    md = [
        "# 資金フロー指標の予測力検証レポート",
        "",
        f"- データ: {meta['tickers']}銘柄 / {meta['start']}〜{meta['end']} / "
        f"パネル {meta['panel_rows']:,}行",
        f"- IS: 〜{IS_END}(パラメータ選択) / OOS: {OOS_START}〜(評価のみ)",
        "- 前向きリターンは open-to-open(翌寄りで建て、k日後の寄りで手仕舞い)。"
        "終値ベースで測ると実際には取れない値を含むため。",
        "- 流動性フィルタ(20日中央値売買代金5億円以上)を通した行のみ集計。",
        "",
        "## Part A: イベントスタディ(指標そのものの予測力)",
        "",
        "### A-1. 売買代金急増率(④急増)の水準別",
        "",
        "**IS(〜2021)**", "", _event_table(event["IS"]["surge"], "bucket", "急増率"), "",
        "**OOS(2022〜)**", "", _event_table(event["OOS"]["surge"], "bucket", "急増率"), "",
        "### A-2. 急増 × 当日の値動きの向き(最重要)",
        "",
        "④急増ランキングは「上げて急増」も「下げて急増」も同じ上位に並ぶ。"
        "この2つを分けないと指標の意味が打ち消し合う。",
        "",
        "**IS(〜2021)**", "", _cond_table(event["IS"]["surge_x_direction"]), "",
        "**OOS(2022〜)**", "", _cond_table(event["OOS"]["surge_x_direction"]), "",
        "### A-3. 急増を伴う下落を、長期トレンドで分けた場合",
        "",
        "**IS(〜2021)**", "",
        _event_table(event["IS"]["surge_down_x_trend"], "長期トレンド", "長期トレンド"), "",
        "**OOS(2022〜)**", "",
        _event_table(event["OOS"]["surge_down_x_trend"], "長期トレンド", "長期トレンド"), "",
        "### A-4. 連日継続スコア(②連日継続)の水準別",
        "",
        "**IS(〜2021)**", "", _event_table(event["IS"]["continuity"], "bucket", "継続スコア"), "",
        "**OOS(2022〜)**", "", _event_table(event["OOS"]["continuity"], "bucket", "継続スコア"), "",
        "## Part B: ポートフォリオ検証(翌寄り執行・スリッページ0.1%・最大5銘柄)",
        "",
        "パラメータはISのSharpeのみで選択し、OOSは評価にしか使っていない。",
        "",
        _bt_table(backtests),
        "",
    ]
    (out_dir / "REPORT.md").write_text("\n".join(md), encoding="utf-8")
    print(f"レポート出力: {out_dir}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["full", "cache", "synth"], default="full")
    ap.add_argument("--out", default="research/results")
    args = ap.parse_args()

    print(f"価格データ読み込み: source={args.source}")
    prices = load_prices(args.source)
    print(f"  {len(prices)}銘柄")

    print("パネル構築(イベントスタディ用)…")
    panel = build_panel(prices)
    dates = panel["date"]
    meta = {
        "source": args.source,
        "tickers": len(prices),
        "start": str(dates.min().date()),
        "end": str(dates.max().date()),
        "panel_rows": int(len(panel)),
    }
    print(f"  {meta['panel_rows']:,}行 ({meta['start']}〜{meta['end']})")

    print("Part A: イベントスタディ…")
    event = run_event_study(panel)

    print("Part B: ポートフォリオ検証…")
    backtests = run_backtests(prices)

    write_report(ROOT / args.out, event, backtests, meta)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
