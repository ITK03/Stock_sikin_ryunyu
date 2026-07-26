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

# 既存の本番設定(screener/registry.yaml)と揃えたエンジン設定(平均回帰系)。
DEFAULT_ENGINE = dict(max_positions=5, slippage_bps=10.0, stop_loss=0.15,
                      max_hold=10, take_profit=0.02)

# 戦略ファミリー別のエンジン設定。
# 順張り(モメンタム)系に平均回帰系と同じ「+2%利確・最大10日」を当てると、
# 伸びる前に必ず切ってしまい、順張りの優位性が原理的に測れなくなる。
# 利確なし・保有期間長め・ストップは浅めという順張りの標準形で評価する。
# (この区別をしないと「順張りは効かない」という誤った結論になる)
ENGINE_OVERRIDES = {
    "flow_momentum": dict(take_profit=None, max_hold=30, stop_loss=0.10),
}


def engine_for(name: str) -> dict:
    return {**DEFAULT_ENGINE, **ENGINE_OVERRIDES.get(name, {})}

# 比較用に回す既存戦略(本番稼働中の2本)。
BASELINE_KEYS = ("rsi2_dip", "keltner_atr_dip")

# Part D: 頑健性チェック。最大DDの深さと手数料への耐性を測る。
# 銘柄数を増やせばDDは浅くなるはずだが、シグナルの質が薄まる分だけ
# 期待値が落ちるトレードオフがある。手数料は往復で効くので薄い優位性を消しうる。
ROBUSTNESS_TARGETS = ("rsi2_flow", "flow_accumulation",
                      "rsi2_dip(既存)", "keltner_atr_dip(既存)")
ROBUSTNESS_POSITIONS = (5, 10, 20)
ROBUSTNESS_FEES = (0.0, 5.0, 10.0)  # 片道bps(0=手数料無料コース, 5=0.05%, 10=0.10%)

# Part E: 手仕舞い設計(利確幅・最大保有日数)の探索。
# 既存の「+2%利確・最大10日」は指標の効果を分離するため固定してきたが、
# その設定自体が最適かは未検証だった。現実的な運用点(20銘柄・片道5bps)で掃く。
# take_profit=None は「利確なし=RSI回復かストップか期限まで持つ」。
EXIT_TARGETS = ("rsi2_flow", "rsi2_dip(既存)")
EXIT_BASE_ENGINE = dict(max_positions=20, slippage_bps=10.0, stop_loss=0.15, fee_bps=5.0)
EXIT_TAKE_PROFITS = (0.02, 0.03, 0.05, None)
EXIT_MAX_HOLDS = (5, 10, 20)


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
                      engine: dict | None = None,
                      min_is_trades: int = 80) -> dict | None:
    """ISでベスト設定を選び、その設定のOOS成績を返す(選択にOOSを使わない)。"""
    eng = engine or DEFAULT_ENGINE
    best = None
    max_is_trades = 0
    for params in grid:
        signals = {t: fn(df, **params) for t, df in prices.items()}
        result = run_backtest(prices, signals, EngineParams(**eng))
        is_m = summarize(result, (FAR_PAST, IS_END))
        max_is_trades = max(max_is_trades, int(is_m.get("trades", 0)))
        if is_m.get("trades", 0) < min_is_trades:
            continue
        score = is_m.get("sharpe", 0.0)
        if best is None or score > best["is_sharpe_score"]:
            oos_m = summarize(result, (OOS_START, FAR_FUTURE))
            best = {
                "strategy": name,
                "params": params,
                "engine": {k: v for k, v in eng.items()},
                "is_sharpe_score": score,
                "IS": {k: _f(v) for k, v in is_m.items()},
                "OOS": {k: _f(v) for k, v in oos_m.items()},
                "yearly": _yearly_records(result),
            }
    if best is None:
        # シグナルが少なすぎて評価できなかった場合。黙って表から消すと
        # 「優位性がない」と誤読されるため、理由を残す。
        return {"strategy": name, "insufficient": True,
                "max_is_trades": max_is_trades, "min_required": min_is_trades}
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
        results.append(run_strategy_grid(prices, name, fn, grid, engine=engine_for(name)))
        print(f"  done: {name}")
    for name in BASELINE_KEYS:
        fn, grid = BASE_STRATEGIES[name]
        results.append(run_strategy_grid(
            prices, f"{name}(既存)", fn, grid, engine=engine_for(name)))
        print(f"  done: {name}(既存)")
    evaluated = [r for r in results if not r.get("insufficient")]
    evaluated.sort(key=lambda r: (r["OOS"].get("sharpe") or -99), reverse=True)
    skipped = [r for r in results if r.get("insufficient")]
    return evaluated + skipped


def run_robustness(prices: dict[str, pd.DataFrame], backtests: list[dict]) -> list[dict]:
    """採用候補について、銘柄数(分散)と手数料の感応度を測る。

    シグナルはエンジン設定に依存しないため、戦略ごとに1回だけ計算して
    9通りのエンジン設定で使い回す(再計算すると9倍遅くなる)。
    """
    fn_by_name = dict(RESEARCH_STRATEGIES)
    for k in BASELINE_KEYS:
        fn_by_name[f"{k}(既存)"] = BASE_STRATEGIES[k]

    rows = []
    for r in backtests:
        name = r["strategy"]
        if r.get("insufficient") or name not in ROBUSTNESS_TARGETS:
            continue
        fn = fn_by_name[name][0]
        signals = {t: fn(df, **r["params"]) for t, df in prices.items()}
        base_eng = dict(r.get("engine") or DEFAULT_ENGINE)
        for pos in ROBUSTNESS_POSITIONS:
            for fee in ROBUSTNESS_FEES:
                eng = {**base_eng, "max_positions": pos, "fee_bps": fee}
                res = run_backtest(prices, signals, EngineParams(**eng))
                # IS も出す。銘柄数の効果はOOSだけ見て決めるとOOSでの選択になるため、
                # 同じ向きがIS期間でも成り立つかを確認できるようにする(追加計算なし)。
                rows.append({
                    "strategy": name, "max_positions": pos, "fee_bps": fee,
                    "IS": {k: _f(v) for k, v in summarize(res, (FAR_PAST, IS_END)).items()},
                    "OOS": {k: _f(v) for k, v in summarize(res, (OOS_START, FAR_FUTURE)).items()},
                })
        print(f"  robustness done: {name}")
    return rows


def run_exit_study(prices: dict[str, pd.DataFrame], backtests: list[dict]) -> list[dict]:
    """手仕舞い設計(利確幅 × 最大保有日数)を、現実的な運用点で掃く。

    ISとOOSの両方を出す。ここで OOS の最良値を選ぶと過剰最適化になるため、
    レポートでは「ISで選ぶとどれになり、そのOOSはどうだったか」を示す。
    """
    fn_by_name = dict(RESEARCH_STRATEGIES)
    for k in BASELINE_KEYS:
        fn_by_name[f"{k}(既存)"] = BASE_STRATEGIES[k]

    rows = []
    for r in backtests:
        name = r["strategy"]
        if r.get("insufficient") or name not in EXIT_TARGETS:
            continue
        fn = fn_by_name[name][0]
        signals = {t: fn(df, **r["params"]) for t, df in prices.items()}
        for tp in EXIT_TAKE_PROFITS:
            for mh in EXIT_MAX_HOLDS:
                eng = {**EXIT_BASE_ENGINE, "take_profit": tp, "max_hold": mh}
                res = run_backtest(prices, signals, EngineParams(**eng))
                rows.append({
                    "strategy": name, "take_profit": tp, "max_hold": mh,
                    "IS": {k: _f(v) for k, v in summarize(res, (FAR_PAST, IS_END)).items()},
                    "OOS": {k: _f(v) for k, v in summarize(res, (OOS_START, FAR_FUTURE)).items()},
                })
        print(f"  exit study done: {name}")
    return rows


def _exit_table(rows: list[dict]) -> str:
    if not rows:
        return ""
    out = []
    for name in EXIT_TARGETS:
        sub = [r for r in rows if r["strategy"] == name]
        if not sub:
            continue
        # ISのSharpeで選ぶとどれになるか(選択にOOSを使わない)
        best = max(sub, key=lambda r: (r["IS"].get("sharpe") or -99))
        out += [f"### {name}", "",
                "| 利確 | 最大保有 | IS Sharpe | IS PF | OOS取引 | OOS勝率 | OOS平均 | "
                "OOS PF | OOS Sharpe | OOS最大DD |",
                "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for r in sub:
            i, o = r["IS"], r["OOS"]
            tp = "なし" if r["take_profit"] is None else f"+{r['take_profit']*100:.0f}%"
            mark = " ★" if r is best else ""
            out.append(
                f"| {tp}{mark} | {r['max_hold']}日 | "
                f"{(i.get('sharpe') or float('nan')):.2f} | "
                f"{(i.get('profit_factor') or float('nan')):.2f} | "
                f"{o.get('trades', 0):,} | {_fmt_pct(o.get('win_rate'),1)} | "
                f"{_fmt_pct(o.get('avg_ret'))} | "
                f"{(o.get('profit_factor') or float('nan')):.2f} | "
                f"{(o.get('sharpe') or float('nan')):.2f} | "
                f"{_fmt_pct(o.get('max_drawdown'),1)} |")
        tp_b = "なし" if best["take_profit"] is None else f"+{best['take_profit']*100:.0f}%"
        out += ["", f"★ = ISのSharpeで選んだ設定(利確{tp_b}・最大{best['max_hold']}日)。"
                    f"そのOOSは Sharpe {(best['OOS'].get('sharpe') or float('nan')):.2f}・"
                    f"PF {(best['OOS'].get('profit_factor') or float('nan')):.2f}。", ""]
    return "\n".join(out)


def run_production_config_study(prices: dict[str, pd.DataFrame]) -> list[dict]:
    """registry.yaml の本番設定「そのまま」で銘柄数・手数料の感応度を測る。

    Part D は IS で選んだパラメータを使っており、本番設定とは別物になっている
    (例: rsi2_dip は本番 buy_th=15.0 に対し Part D は 5.0、keltner は本番 n=20,k=2.5
    に対し 14,2.0)。さらに本番は limit_entry(前日終値-1%の指値)で建てるのに対し
    Part D は成行だった。本番の運用設定を変えるかどうかの判断には、
    本番と同一条件で測ったこちらを使う。
    """
    import yaml
    from backtest import strategies as strat_mod

    reg = yaml.safe_load((ROOT / "screener" / "registry.yaml").read_text(encoding="utf-8"))
    rows = []
    for item in reg["strategies"]:
        if not item.get("enabled", False):
            continue
        fn = getattr(strat_mod, item["id"], None)
        if fn is None:
            continue
        em = item.get("engine", {}) or {}
        signals = {t: fn(df, **item.get("params", {})) for t, df in prices.items()}
        for pos in ROBUSTNESS_POSITIONS:
            for fee in ROBUSTNESS_FEES:
                eng = dict(max_positions=pos, slippage_bps=10.0, fee_bps=fee,
                           stop_loss=em.get("stop_loss", 0.15),
                           max_hold=em.get("max_hold", 10),
                           take_profit=em.get("take_profit"),
                           limit_entry=em.get("limit_entry"))
                res = run_backtest(prices, signals, EngineParams(**eng))
                rows.append({
                    "strategy": item["id"], "max_positions": pos, "fee_bps": fee,
                    "current": pos == em.get("max_positions"),
                    "IS": {k: _f(v) for k, v in summarize(res, (FAR_PAST, IS_END)).items()},
                    "OOS": {k: _f(v) for k, v in summarize(res, (OOS_START, FAR_FUTURE)).items()},
                })
        print(f"  production config done: {item['id']}")
    return rows


def _production_table(rows: list[dict]) -> str:
    if not rows:
        return ""
    out = []
    for name in dict.fromkeys(r["strategy"] for r in rows):
        sub = [r for r in rows if r["strategy"] == name]
        out += [f"### {name}(本番設定)", "",
                "| 銘柄数 | 手数料 | IS平均 | IS PF | IS最大DD | OOS平均 | OOS PF | OOS最大DD |",
                "|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for r in sub:
            i, o = r["IS"], r["OOS"]
            ipf, opf = i.get("profit_factor"), o.get("profit_factor")
            mark = " ←現行" if r["current"] and r["fee_bps"] == 5.0 else ""
            out.append(
                f"| {r['max_positions']}{mark} | {r['fee_bps']:.0f}bps | "
                f"{_fmt_pct(i.get('avg_ret'))} | {'—' if ipf is None else f'{ipf:.2f}'} | "
                f"{_fmt_pct(i.get('max_drawdown'),1)} | "
                f"{_fmt_pct(o.get('avg_ret'))} | {'—' if opf is None else f'{opf:.2f}'} | "
                f"{_fmt_pct(o.get('max_drawdown'),1)} |")
        out.append("")
    return "\n".join(out)


def _robustness_table(rows: list[dict]) -> str:
    if not rows:
        return ""
    out = []
    for name in ROBUSTNESS_TARGETS:
        sub = [r for r in rows if r["strategy"] == name]
        if not sub:
            continue
        out += [f"### {name}", "",
                "| 銘柄数 | 手数料(片道) | IS平均 | IS PF | OOS取引 | OOS勝率 | OOS平均 | "
                "OOS PF | OOS Sharpe | OOS最大DD |",
                "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for r in sub:
            i, o = r.get("IS", {}), r["OOS"]
            pf, sh = o.get("profit_factor"), o.get("sharpe")
            ipf = i.get("profit_factor")
            out.append(
                f"| {r['max_positions']} | {r['fee_bps']:.0f}bps | "
                f"{_fmt_pct(i.get('avg_ret'))} | "
                f"{'—' if ipf is None else f'{ipf:.2f}'} | "
                f"{o.get('trades', 0):,} | "
                f"{_fmt_pct(o.get('win_rate'),1)} | {_fmt_pct(o.get('avg_ret'))} | "
                f"{'—' if pf is None else f'{pf:.2f}'} | "
                f"{'—' if sh is None else f'{sh:.2f}'} | "
                f"{_fmt_pct(o.get('max_drawdown'),1)} |")
        out.append("")
    return "\n".join(out)


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


def _engine_note(eng: dict) -> str:
    tp = eng.get("take_profit")
    return (f"利確{'なし' if tp is None else f'+{tp*100:.0f}%'}"
            f"/損切-{eng.get('stop_loss', 0)*100:.0f}%"
            f"/最大{eng.get('max_hold')}日")


def _bt_table(results: list[dict]) -> str:
    head = ("| 戦略 | 選択パラメータ | 手仕舞い設定 | IS取引 | IS勝率 | IS PF | OOS取引 | OOS勝率 | "
            "OOS PF | OOS平均 | OOS Sharpe | OOS最大DD |\n")
    head += "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
    rows = []
    for r in results:
        if r.get("insufficient"):
            continue
        i, o = r["IS"], r["OOS"]
        rows.append(
            f"| {r['strategy']} | `{json.dumps(r['params'], ensure_ascii=False)}` | "
            f"{_engine_note(r.get('engine', {}))} | "
            f"{i.get('trades', 0):,} | {_fmt_pct(i.get('win_rate'),1)} | "
            f"{(i.get('profit_factor') or float('nan')):.2f} | "
            f"{o.get('trades', 0):,} | {_fmt_pct(o.get('win_rate'),1)} | "
            f"{(o.get('profit_factor') or float('nan')):.2f} | "
            f"{_fmt_pct(o.get('avg_ret'))} | {(o.get('sharpe') or float('nan')):.2f} | "
            f"{_fmt_pct(o.get('max_drawdown'),1)} |")
    return head + "\n".join(rows)


def _skipped_note(results: list[dict]) -> str:
    """シグナル不足で評価できなかった戦略を明示する(沈黙は誤読を生む)。"""
    sk = [r for r in results if r.get("insufficient")]
    if not sk:
        return ""
    lines = ["**評価対象外(ISのシグナル数が不足し、統計的に評価できなかったもの)**", ""]
    for r in sk:
        lines.append(f"- {r['strategy']}: IS取引数 最大{r['max_is_trades']}件 "
                     f"(必要{r['min_required']}件)。優位性の否定ではなく、"
                     f"サンプル不足で判断不能という意味。")
    return "\n".join(lines)


def write_report(out_dir: Path, event: dict, backtests: list[dict], meta: dict,
                 robustness: list[dict] | None = None,
                 exits: list[dict] | None = None,
                 production: list[dict] | None = None) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    findings = derive_findings(event, backtests)
    (out_dir / "report.json").write_text(
        json.dumps({"meta": meta, "event_study": event, "backtests": backtests,
                    "findings": findings, "robustness": robustness or [],
                    "exit_study": exits or [], "production_config": production or []},
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
        _skipped_note(backtests),
        "",
        findings_markdown(findings),
        "",
        "## Part D: 頑健性(銘柄数を増やす / 手数料を入れる)",
        "",
        "銘柄数を増やすと分散が効いて最大DDは浅くなるが、シグナルの質が薄まる分"
        "期待値は落ちる。手数料は往復で効くため、薄い優位性はこれで消えうる。"
        "いずれもOOS(2022〜)のみで評価している。",
        "",
        _robustness_table(robustness or []),
        "",
        "## Part E: 手仕舞い設計(利確幅 × 最大保有日数)",
        "",
        "既存の「+2%利確・最大10日」は、指標の効果を分離するため固定してきた設定であり、"
        "それ自体が最適かは未検証だった。現実的な運用点(20銘柄・片道5bps・損切-15%)で掃く。"
        "★はISのSharpeで選んだ設定(選択にOOSは使っていない)。",
        "",
        _exit_table(exits or []),
        "",
        "## Part F: 本番設定そのままでの銘柄数・手数料感応度",
        "",
        "Part B〜E は IS で選んだパラメータを使っており、本番設定(registry.yaml)とは"
        "別物になっている。さらに本番は limit_entry(前日終値-1%の指値)で建てるのに対し"
        "Part D は成行だった。**本番の運用設定を変えるかどうかの判断は、本番と完全に"
        "同一条件で測ったこの表だけを根拠にする。**",
        "",
        _production_table(production or []),
        "",
        "## 前提と限界",
        "",
        "- ユニバースは現在のJPXプライム上場銘柄。過去に上場廃止された銘柄を含まない"
        "ため、絶対リターンには上方バイアスがある。ただし本レポートの主目的は"
        "「同一ユニバース上での戦略間の相対比較」であり、そこへの影響は限定的。",
        "- 手数料は考慮していない(スリッページ片道0.1%のみ)。",
        "- 分割・増資を跨ぐ発行済株式数を過去に遡って持てないため、①時価総額比は"
        "時系列版(自分の平常時比)で代用している。",
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

    print("Part D: 頑健性(銘柄数 × 手数料)…")
    robustness = run_robustness(prices, backtests)

    print("Part E: 手仕舞い設計(利確幅 × 最大保有日数)…")
    exits = run_exit_study(prices, backtests)

    print("Part F: 本番設定そのままでの感応度…")
    production = run_production_config_study(prices)

    write_report(ROOT / args.out, event, backtests, meta, robustness, exits, production)
    return 0



# ---------------------------------------------------------------------------
# 自動的な所見抽出
# ---------------------------------------------------------------------------
# 表を人間が眺めて結論を書くと、都合のいいセルだけ拾う危険がある。
# 主要な比較は機械的に取り出し、IS/OOS の符号が一致するものだけを
# 「頑健」として扱う。

def _cell(records: list[dict], surge: str, direction: str) -> dict | None:
    for r in records:
        if r["surge"] == surge and r["当日"] == direction:
            return r
    return None


def derive_findings(event: dict, backtests: list[dict]) -> list[dict]:
    findings = []

    # 1) 急増 × 値動きの向き: IS/OOS 双方で符号が一致するセルだけを採用する
    for surge in ("1.5-3倍", "3-6倍", "6倍〜"):
        for direction in ("上昇(+2%〜)", "下落(〜-2%)"):
            i = _cell(event["IS"]["surge_x_direction"], surge, direction)
            o = _cell(event["OOS"]["surge_x_direction"], surge, direction)
            if not i or not o or i["n"] < 200 or o["n"] < 200:
                continue
            same = np.sign(i["mean5"]) == np.sign(o["mean5"])
            findings.append({
                "type": "surge_x_direction",
                "条件": f"急増{surge} × 当日{direction}",
                "IS_5日": i["mean5"], "IS_勝率": i["win5"], "IS_n": i["n"],
                "OOS_5日": o["mean5"], "OOS_勝率": o["win5"], "OOS_n": o["n"],
                "頑健": bool(same),
            })

    # 2) 「フロー指標は既存の押し目買いに上乗せ価値があるか」の直接比較
    by_name = {r["strategy"]: r for r in backtests if not r.get("insufficient")}
    trio = ["rsi2_flow", "rsi2_quiet", "rsi2_dip(既存)"]
    if all(k in by_name for k in trio):
        findings.append({
            "type": "flow_value_add",
            "比較": {k: {"OOS勝率": by_name[k]["OOS"].get("win_rate"),
                        "OOS平均": by_name[k]["OOS"].get("avg_ret"),
                        "OOS_PF": by_name[k]["OOS"].get("profit_factor"),
                        "OOS取引": by_name[k]["OOS"].get("trades")} for k in trio},
        })

    # 3) 急増を伴う下落における長期トレンドの効果
    for tag in ("IS", "OOS"):
        rec = event[tag]["surge_down_x_trend"]
        if len(rec) == 2:
            up = next((r for r in rec if "上昇" in r["長期トレンド"]), None)
            dn = next((r for r in rec if "下降" in r["長期トレンド"]), None)
            if up and dn:
                findings.append({
                    "type": "trend_filter", "期間": tag,
                    "トレンド上_5日": up["mean5"], "トレンド上_n": up["n"],
                    "トレンド下_5日": dn["mean5"], "トレンド下_n": dn["n"],
                    "差": up["mean5"] - dn["mean5"],
                })
    return findings


def findings_markdown(findings: list[dict]) -> str:
    lines = ["## 自動抽出した所見(表から機械的に取り出した主要比較)", ""]

    cond = [f for f in findings if f["type"] == "surge_x_direction"]
    if cond:
        lines += [
            "### 急増×値動きの向き(IS/OOSで符号が一致したものだけを「頑健」とする)", "",
            "| 条件 | IS 5日 | IS 勝率 | OOS 5日 | OOS 勝率 | 頑健 |",
            "|---|---:|---:|---:|---:|:--:|",
        ]
        for f in cond:
            lines.append(
                f"| {f['条件']} | {_fmt_pct(f['IS_5日'])} | {_fmt_pct(f['IS_勝率'],1)} | "
                f"{_fmt_pct(f['OOS_5日'])} | {_fmt_pct(f['OOS_勝率'],1)} | "
                f"{'○' if f['頑健'] else '×'} |")
        lines.append("")

    tf = [f for f in findings if f["type"] == "trend_filter"]
    if tf:
        lines += ["### 急増を伴う下落: 長期トレンドで分けたときの5日リターン差", "",
                  "| 期間 | トレンド上 | トレンド下 | 差 |", "|---|---:|---:|---:|"]
        for f in tf:
            lines.append(f"| {f['期間']} | {_fmt_pct(f['トレンド上_5日'])} "
                         f"({f['トレンド上_n']:,}件) | {_fmt_pct(f['トレンド下_5日'])} "
                         f"({f['トレンド下_n']:,}件) | {_fmt_pct(f['差'])} |")
        lines.append("")

    va = next((f for f in findings if f["type"] == "flow_value_add"), None)
    if va:
        lines += ["### フロー指標は既存の押し目買いに上乗せ価値があるか", "",
                  "同一エンジン設定で、急増フィルタあり(flow)/なし(quiet)/無条件(既存)を比較。", "",
                  "| 戦略 | OOS取引 | OOS勝率 | OOS平均 | OOS PF |", "|---|---:|---:|---:|---:|"]
        for k, v in va["比較"].items():
            pf = v["OOS_PF"]
            lines.append(f"| {k} | {v['OOS取引']:,} | {_fmt_pct(v['OOS勝率'],1)} | "
                         f"{_fmt_pct(v['OOS平均'])} | "
                         f"{'—' if pf is None else f'{pf:.2f}'} |")
        lines.append("")
    return "\n".join(lines)

if __name__ == "__main__":
    raise SystemExit(main())
