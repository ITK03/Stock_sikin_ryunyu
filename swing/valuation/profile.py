"""配信用の銘柄プロファイルを組み立てる。

プロファイルには**株価を入れない**。入れるのは EPS/BPS/SPS と、過去10年の
バリュエーション分布(分位グリッドと年次レンジ)、そして ROE→PBR の回帰係数だけ。
現在のPERはブラウザ側で `株価 ÷ EPS` として計算し、分位グリッド上の位置を引く。

こうする利点が2つある。
- ザラ場中に株価が動けば評価もその場で動く(日次バッチの鮮度に縛られない)
- プロファイルは決算のときしか変わらない = 再生成が年4回で済む

サイズも設計要件になっている。1銘柄あたり約1KB、全1526銘柄で約1.5MB。
orphanブランチへ force-push するので履歴は1コミットのまま増えず、年次レンジは
10年ローリングで項目数が固定なので、何年運用しても総量が変わらない。
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from valuation.history import (DEFAULT_YEARS, MIN_OBSERVATIONS,
                               FundamentalRecord, explain_pbr_by_roe,
                               market_adjusted, valuation_frame)
from valuation.metrics import (financial_metrics, growth_metrics,
                               quarterly_history, yearly_history)

# 3: 会社予想(決算短信XBRL)を追加。
# 2 のまま足したせいで、guidance を持たない v2 が「最新版」と誤認され再生成
# されなかった。表示項目を足したら必ずここを上げること。
# 4: 年次推移の指数化の基準を「最初の非ゼロ値」から「絶対値の最大」に変更。
# 項目は増えていないが中身の意味が変わるので、こちらも版を上げる必要がある。
SCHEMA_VERSION = 4
# 分位グリッドの点数。0%,5%,…,100% の21点。これ以上細かくしても表示は変わらず、
# サイズだけ増える。
GRID_POINTS = 21

# yfinance は「その数字がいつ公表されたか」を返さない。日本企業の決算短信は
# 期末からおおむね35〜45日で出るため、その日数を公表日の推定値として使う。
# 推定であることは profile の cov.known_from_estimated に必ず出す。
# 決算短信XBRLから実際の公表日を取れるようになったら不要になる。
DEFAULT_DISCLOSURE_LAG_DAYS = 45


def estimate_known_from(period_end: date,
                        lag_days: int = DEFAULT_DISCLOSURE_LAG_DAYS) -> date:
    """公表日が不明な場合の推定。期末 + 決算発表までの標準的な日数。"""
    return period_end + timedelta(days=lag_days)


def quantile_grid(s: pd.Series, points: int = GRID_POINTS,
                  digits: int = 2) -> list[float] | None:
    """0%〜100%を等間隔に刻んだ分位点。ブラウザ側はこの上を線形補間する。"""
    s = s.dropna()
    if len(s) < MIN_OBSERVATIONS:
        return None
    qs = np.linspace(0.0, 1.0, points)
    return [round(float(v), digits) for v in s.quantile(qs)]


def percentile_from_grid(grid: list[float], value: float) -> float:
    """分位グリッド上での位置(0〜100)。フロント側と同じ計算をテストで固定する用。

    グリッドは昇順の等間隔分位点。値が両端を超える場合は 0 / 100 で頭打ちにする。
    """
    n = len(grid)
    if n < 2 or not np.isfinite(value):
        return float("nan")
    if value <= grid[0]:
        return 0.0
    if value >= grid[-1]:
        return 100.0
    i = int(np.searchsorted(grid, value, side="right")) - 1
    lo, hi = grid[i], grid[i + 1]
    frac = 0.0 if hi == lo else (value - lo) / (hi - lo)
    return float((i + frac) / (n - 1) * 100.0)


def yearly_ranges(s: pd.Series, digits: int = 2) -> list[list]:
    """年ごとの [年, 最小, 中央, 最大]。10年ぶんで約200バイト。

    日次系列(2450点)をそのまま持つと1銘柄5.7KBになり全体で8MBを超える。
    スマホでは点の折れ線より年次のレンジ帯のほうが読みやすいので、表示としても
    こちらのほうが良い。
    """
    s = s.dropna()
    if s.empty:
        return []
    out = []
    for year, g in s.groupby(s.index.year):
        if len(g) < 20:      # 数日しかない年は誤解を招くので出さない
            continue
        out.append([int(year), round(float(g.min()), digits),
                    round(float(g.median()), digits), round(float(g.max()), digits)])
    return out


# スパークライン用の月次点数。5年で60点。日次(1250点)をそのまま持つと1銘柄
# 5KBを超えるが、月次なら数百バイトで推移の形は十分伝わる。
SPARK_MONTHS = 60


def monthly_series(s: pd.Series, digits: int = 2,
                   months: int = SPARK_MONTHS) -> list[float | None]:
    """月末値の系列(スパークライン用)。欠測月は None のまま残す。"""
    s = s.dropna()
    if s.empty:
        return []
    m = s.resample("ME").last().tail(months)
    return [None if pd.isna(v) else round(float(v), digits) for v in m]


def _latest(v: pd.DataFrame, col: str) -> float | None:
    s = v[col].dropna()
    return round(float(s.iloc[-1]), 4) if len(s) else None


def build_profile(code: str, name: str, prices: pd.Series,
                  records: list[FundamentalRecord],
                  market_per: pd.Series | None = None,
                  years: int = DEFAULT_YEARS,
                  source: str = "yfinance",
                  known_from_estimated: bool = True,
                  quarterly: list[FundamentalRecord] | None = None) -> dict:
    """配信するプロファイル1件を組み立てる。

    データが足りない項目は None のまま残し、cov.missing に列挙する。欠測を
    黙って埋めると「判断材料が無い」ことと「平均的な水準」の区別がつかなくなる。
    """
    v = valuation_frame(prices, records)
    if not v.empty:
        cutoff = v.index[-1] - pd.DateOffset(years=years)
        v = v[v.index >= cutoff]

    profile: dict = {
        "v": SCHEMA_VERSION,
        "code": code,
        "name": name,
        "as_of": (v.index[-1].date().isoformat() if len(v) else None),
        "src": source,
        # 現在値の算出に使う分母。株価はブラウザ側が当てる。
        "eps": _latest(v, "eps"),
        "bps": _latest(v, "bps"),
        "roe": _latest(v, "roe"),
    }

    missing: list[str] = []
    for key, col in (("per_q", "per"), ("pbr_q", "pbr")):
        grid = quantile_grid(v[col]) if col in v else None
        profile[key] = grid
        if grid is None:
            missing.append(col)
    profile["per_y"] = yearly_ranges(v["per"]) if "per" in v else []
    profile["pbr_y"] = yearly_ranges(v["pbr"]) if "pbr" in v else []
    # スパークライン用の月次推移
    profile["per_m"] = monthly_series(v["per"]) if "per" in v else []
    profile["pbr_m"] = monthly_series(v["pbr"]) if "pbr" in v else []

    # 市場全体の水準変化を除いた相対PER。市場平均が切り上がっただけの局面を
    # 「自己レンジの上位」と誤読しないため。
    if market_per is not None and "per" in v and not v.empty:
        rel = market_adjusted(v["per"], market_per)
        profile["rel_q"] = quantile_grid(rel, digits=3)
        profile["mkt_per"] = round(float(market_per.dropna().iloc[-1]), 2) \
            if len(market_per.dropna()) else None
    else:
        profile["rel_q"] = None
        profile["mkt_per"] = None
        missing.append("rel_per")

    # ROEから説明される妥当PBRとの乖離。関係が弱ければ explain_pbr_by_roe が
    # None を返すので、その場合は何も語らない。
    e = explain_pbr_by_roe(v, years=years) if not v.empty else None
    if e is None:
        profile["roe_pbr"] = None
        missing.append("roe_pbr")
    else:
        profile["roe_pbr"] = {"fair": round(e.fair, 3), "gap": round(e.gap_pct, 1),
                              "r2": round(e.r2, 3), "n": e.observations,
                              "method": e.method}

    # 実際にバリュエーションを計算できた期間。要求した窓(years)ではなく実測を
    # 出す。yfinance の財務は4〜5年しか遡れず、10年を要求しても中身は5年ぶん
    # しか無い。「過去10年レンジの下位8%」と表示してしまうと事実と違う。
    valid = v["per"].dropna() if "per" in v else pd.Series(dtype=float)
    if valid.empty and "pbr" in v:
        valid = v["pbr"].dropna()
    span = ([int(valid.index[0].year), int(valid.index[-1].year)]
            if len(valid) else None)

    # 「安いか」だけでなく「そもそも買ってよい会社か」を見るための指標群。
    # 収益性・安全性・成長がここに入る。
    profile["fin"] = financial_metrics(records[-1]) if records else {}
    profile["growth"] = growth_metrics(records)
    profile["hist"] = yearly_history(records)
    profile["q"] = quarterly_history(quarterly or [])
    if not profile["q"]["labels"]:
        missing.append("quarterly")

    profile["cov"] = {
        # 要求した窓の上限。実際の収録期間は span を見る。
        "years_max": years,
        "span": span,
        "span_years": (round(len(valid) / 245.0, 1) if len(valid) else 0.0),
        "obs": int(len(valid)),
        "price_obs": int(len(v)),
        "records": len(records),
        # 公表日が推定値かどうか。推定のままだと過去レンジにわずかな先読みが
        # 混じるため、画面にもそのまま出す。
        "known_from_estimated": known_from_estimated,
        "missing": missing,
    }
    return profile
