"""資金フロー指標(統合ダッシュボードのランキング指標)と、それを使う戦略。

ダッシュボード(src/core/rankings.ts)が出している4指標を、バックテスト可能な
時系列指標としてPythonへ移植する。定義は本家と一致させてある。

指標の対応:
  ① 時価総額比 ratio = turnover / marketCap
       = (close*volume) / (close*shares) = volume / shares
     価格が約分されるため、これは数学的に「発行済株式数の何%が売買されたか」
     = 回転率そのもの。銘柄間の比較には shares が要るが、同一銘柄の時系列では
     shares はほぼ一定なので「自分の平常時に対する出来高の倍率」と等価になる。
     本モジュールは point-in-time な shares を持てない(過去の株式数は
     分割・増資で変わり、現在値を過去に当てると先読みになる)ため、
     時系列版として rel_turnover(自分の過去中央値に対する倍率)を使う。
  ② 連日継続 = continuity_score(ratio系列)。単発スパイクを抑えつつ
     「毎日コンスタントに入っているか」を重み付けする本家と同一式。
  ③ 全市場上位 = ②を売買代金上位K銘柄に限定したもの。
     時系列版では「売買代金の絶対水準が高い」= turnover_rank で表現する。
  ④ 急増 surge = 直近n日平均売買代金 / その手前25日平均。本家と同一の窓取り。

すべて「当日終値までの情報のみ」で計算する(執行は翌寄り、エンジン側)。
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from backtest.indicators import median_turnover, rsi, sma

# ダッシュボードの定数(src/core/periods.ts)と一致させる。
SURGE_BASELINE_DAYS = 25
SURGE_MIN_BASELINE_RATIO = 0.6

# 流動性フィルタ。strategies.py と同じ 5億円。
MIN_TURNOVER = 5e8


def turnover(df: pd.DataFrame) -> pd.Series:
    """売買代金(円)= 終値 × 出来高。ダッシュボードの turnover と同一。"""
    return df["close"] * df["volume"]


def surge(df: pd.DataFrame, n: int = 1,
          baseline_days: int = SURGE_BASELINE_DAYS) -> pd.Series:
    """④ 売買代金急増率。直近n日平均 ÷ その手前 baseline_days 日平均。

    ダッシュボード buildSurge と同じ窓取り: 基準(平常時)の窓は直近ウィンドウの
    手前へn日ずらす。こうすると「数日前から噴いている銘柄」は基準が上がって
    倍率が下がり、当日始まった初動が浮かぶ。
    """
    t = turnover(df)
    recent = t.rolling(n, min_periods=n).mean()
    min_base = int(np.ceil(baseline_days * SURGE_MIN_BASELINE_RATIO))
    base = t.shift(n).rolling(baseline_days, min_periods=min_base).mean()
    return recent / base.replace(0.0, np.nan)


def rel_turnover(df: pd.DataFrame, n: int = SURGE_BASELINE_DAYS) -> pd.Series:
    """① 時価総額比の時系列版。自分の平常時(n日中央値)に対する売買代金倍率。

    ratio = volume/shares であり shares は短期的に一定なので、同一銘柄の
    時系列では「平常時に対する出来高倍率」と単調に対応する。
    """
    t = turnover(df)
    med = t.rolling(n, min_periods=n).median()
    return t / med.replace(0.0, np.nan)


def _winsor_mean(w: np.ndarray, med: np.ndarray) -> np.ndarray:
    """各窓を「中央値×3」で上限クリップしてから平均(本家 winsorMean と同一)。"""
    cap = med * 3.0
    capped = np.minimum(w, np.where(cap > 0, cap, np.inf)[:, None])
    return capped.mean(axis=1)


def continuity_score(s: pd.Series, n: int) -> pd.Series:
    """② 連日継続スコア。本家 continuityScore と同一式をローリングで適用する。

        base = winsorMean(x)                       # 単発スパイクを抑えた平均
        consistency = mean(x >= 0.6 * median(x))   # 普段の水準を保てた日の割合
        score = base * (0.6 + 0.4 * consistency)   # ムラのある銘柄は最大0.6倍まで減衰

    「1日だけ大商い」より「毎日コンスタントに入っている」を高く評価する指標。
    """
    v = s.to_numpy(dtype=float)
    out = np.full(v.shape, np.nan)
    if len(v) >= n:
        w = sliding_window_view(v, n)
        valid = ~np.isnan(w).any(axis=1)
        # 助走期間の窓は全欠損になりうる。valid で捨てるので警告だけ抑制する。
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(w, axis=1)
        base = _winsor_mean(w, med)
        consistency = (w >= (SURGE_MIN_BASELINE_RATIO * med)[:, None]).mean(axis=1)
        score = base * (0.6 + 0.4 * consistency)
        out[n - 1:] = np.where(valid, score, np.nan)
    return pd.Series(out, index=s.index)


def flow_continuity(df: pd.DataFrame, n: int = 10) -> pd.Series:
    """②の時系列版: 相対売買代金(自分の平常時比)に連日継続スコアを適用する。

    絶対額ではなく相対値に適用することで、大型株ほど高く出る偏りを除き
    「その銘柄としては連日多い」状態を検出する。
    """
    return continuity_score(rel_turnover(df), n)


def liquid(df: pd.DataFrame, min_turnover: float = MIN_TURNOVER) -> pd.Series:
    """③に相当する流動性フィルタ: 20日中央値売買代金が閾値以上。"""
    return median_turnover(df, 20) >= min_turnover


def add_flow_features(df: pd.DataFrame) -> pd.DataFrame:
    """イベントスタディ用に、当日終値時点で確定する特徴量をまとめて付与する。"""
    out = pd.DataFrame(index=df.index)
    out["close"] = df["close"]
    out["turnover"] = turnover(df)
    out["surge1"] = surge(df, 1)
    out["surge3"] = surge(df, 3)
    out["rel_turnover"] = rel_turnover(df)
    out["continuity10"] = flow_continuity(df, 10)
    out["rsi2"] = rsi(df["close"], 2)
    out["day_ret"] = df["close"].pct_change()
    out["ret5"] = df["close"].pct_change(5)
    sma200 = sma(df["close"], 200)
    out["trend_up"] = df["close"] > sma200
    out["liquid"] = liquid(df)
    return out


# ---------------------------------------------------------------------------
# 戦略。backtest/strategies.py と同じ契約(entry/exit/rank の3列)。
# ---------------------------------------------------------------------------


def _base(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["entry"] = False
    out["exit"] = False
    out["rank"] = 0.0
    return out


def flow_capitulation(df: pd.DataFrame, surge_th: float = 2.0,
                      drop_th: float = -0.04, trend_n: int = 200,
                      exit_n: int = 5) -> pd.DataFrame:
    """急増 × 下落 = 投げ売り(セリングクライマックス)を拾う。

    ④急増ランキングの上位に「その日大きく下げた銘柄」が出るのは、悪材料への
    パニック売りで出来高が膨らんだ状態。長期上昇トレンドが崩れていなければ
    短期の売られすぎとして反発を取りにいく、という仮説。
    """
    out = _base(df)
    sg = surge(df, 1)
    day_ret = df["close"].pct_change()
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (sg >= surge_th) & (day_ret <= drop_th) & trend & liquid(df)
    out["exit"] = df["close"] > sma(df["close"], exit_n)
    out["rank"] = sg.fillna(0.0)  # 急増率が高いほど優先
    return out


def flow_momentum(df: pd.DataFrame, surge_th: float = 3.0,
                  rise_th: float = 0.03, trend_n: int = 200,
                  exit_n: int = 10) -> pd.DataFrame:
    """急増 × 上昇 = 初動モメンタム。④ランキングの素直な使い方の検証用。

    「売買代金が急増しながら上げている＝資金が入り始めた初動」という
    一般的な解釈をそのまま戦略化し、本当に順張りで取れるのかを検証する。
    """
    out = _base(df)
    sg = surge(df, 1)
    day_ret = df["close"].pct_change()
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (sg >= surge_th) & (day_ret >= rise_th) & trend & liquid(df)
    out["exit"] = df["close"] < sma(df["close"], exit_n)
    out["rank"] = sg.fillna(0.0)
    return out


def rsi2_flow(df: pd.DataFrame, buy_th: float = 15.0, sell_th: float = 70.0,
              trend_n: int = 200, surge_th: float = 1.5) -> pd.DataFrame:
    """既存 rsi2_dip に「資金流入(急増)」フィルタを足したもの。

    本命の検証: 押し目買いの中でも「出来高を伴って投げが出た押し目」だけを
    選ぶと勝率・期待値が上がるのか(＝フロー指標が既存戦略に上乗せ価値を持つか)。
    """
    out = _base(df)
    r = rsi(df["close"], 2)
    trend = df["close"] > sma(df["close"], trend_n)
    sg = surge(df, 1)
    out["entry"] = (r < buy_th) & trend & liquid(df) & (sg >= surge_th)
    out["exit"] = r > sell_th
    out["rank"] = -r
    return out


def rsi2_quiet(df: pd.DataFrame, buy_th: float = 15.0, sell_th: float = 70.0,
               trend_n: int = 200, surge_cap: float = 1.5) -> pd.DataFrame:
    """対照群: rsi2_dip のうち「出来高が膨らんでいない静かな押し目」だけ。

    rsi2_flow と表裏。どちらが優れるかで、フロー指標が持つ情報の向きが分かる。
    """
    out = _base(df)
    r = rsi(df["close"], 2)
    trend = df["close"] > sma(df["close"], trend_n)
    sg = surge(df, 1)
    out["entry"] = (r < buy_th) & trend & liquid(df) & (sg < surge_cap)
    out["exit"] = r > sell_th
    out["rank"] = -r
    return out


def flow_accumulation(df: pd.DataFrame, cont_th: float = 1.3, buy_th: float = 20.0,
                      trend_n: int = 200, sell_th: float = 70.0) -> pd.DataFrame:
    """② 連日継続 × 押し目。「資金が連日入り続けている銘柄の押し目」を買う。

    単発の急増ではなく、②連日継続ランキングが捉える「継続的な資金流入」に
    妙味があるのかを検証する。
    """
    out = _base(df)
    cont = flow_continuity(df, 10)
    r = rsi(df["close"], 2)
    trend = df["close"] > sma(df["close"], trend_n)
    out["entry"] = (cont >= cont_th) & (r < buy_th) & trend & liquid(df)
    out["exit"] = r > sell_th
    out["rank"] = cont.fillna(0.0)
    return out


# 研究対象の戦略とパラメータグリッド(過剰最適化を避けるため小さめ)。
RESEARCH_STRATEGIES: dict[str, tuple] = {
    "flow_capitulation": (flow_capitulation, [
        {"surge_th": s, "drop_th": d, "exit_n": e}
        for s in (1.5, 2.0, 3.0) for d in (-0.03, -0.05) for e in (3, 5)
    ]),
    "flow_momentum": (flow_momentum, [
        {"surge_th": s, "rise_th": r, "exit_n": e}
        for s in (2.0, 3.0, 5.0) for r in (0.02, 0.05) for e in (5, 10)
    ]),
    "rsi2_flow": (rsi2_flow, [
        {"buy_th": b, "surge_th": s, "trend_n": 200}
        for b in (10.0, 15.0) for s in (1.2, 1.5, 2.0)
    ]),
    "rsi2_quiet": (rsi2_quiet, [
        {"buy_th": b, "surge_cap": s, "trend_n": 200}
        for b in (10.0, 15.0) for s in (1.2, 1.5, 2.0)
    ]),
    "flow_accumulation": (flow_accumulation, [
        {"cont_th": c, "buy_th": b, "trend_n": 200}
        for c in (1.1, 1.3, 1.6) for b in (15.0, 20.0)
    ]),
}
