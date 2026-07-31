"""過去バリュエーションの時系列を組み立て、現在の水準を評価する。

中核となる考え方は3つ。

1. **その日に見えていた数字だけを使う(point-in-time)**
   決算は期末ではなく「公表日」に初めて市場から見える。EPSやBPSを期末日に
   紐づけると、まだ誰も知らない数字で過去のPERを計算することになり、過去
   レンジが実態より低く(=今が割高に)歪む。ここでは known_from(公表日)で
   階段状に更新する。

2. **市場全体の水準変化を取り除く**
   同じPER15倍でも、市場平均が20倍の局面と12倍の局面では意味が逆になる。
   自社PERを市場平均PERで割った「相対PER」の自己レンジも併せて見る。

3. **収益力の変化で説明できる部分を取り除く**
   ROEが12%から7%へ落ちた会社のPBRが下がるのは当然で、それは割安ではない。
   自社の過去における ROE と PBR の関係を回帰し、今のROEから妥当PBRを求めて
   その残差を見る。他社を一切使わずにバリュートラップを識別できる。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

# 自己レンジを取る既定の期間。長すぎると事業構造が変わった過去まで含み、
# 短すぎると景気循環の1局面しか映さない。
DEFAULT_YEARS = 10
# パーセンタイル/回帰を出すのに最低限必要な観測数(営業日)。
MIN_OBSERVATIONS = 250


@dataclass(frozen=True)
class FundamentalRecord:
    """ある決算で公表された1株あたり指標。

    known_from はその数字が市場から見えるようになった日(短信・有報の公表日)。
    period_end(決算期末)ではないことが重要。
    """

    period_end: date
    known_from: date
    eps: float | None = None      # 1株利益(実績・年換算)
    bps: float | None = None      # 1株純資産
    roe: float | None = None      # 自己資本利益率(小数。0.12 = 12%)
    sps: float | None = None      # 1株売上高
    eps_guidance: float | None = None  # 会社予想EPS(今期)

    # ── 以下は財務の健全性・成長率の算出に使う実額 ──────────────────
    # 「安いか」だけでなく「そもそも買ってよい会社か」を見るために必要。
    # 取得できない項目は None のままにし、指標側で欠測として扱う。
    shares: float | None = None
    revenue: float | None = None
    gross_profit: float | None = None
    operating_income: float | None = None
    net_income: float | None = None
    total_assets: float | None = None
    equity: float | None = None
    total_debt: float | None = None
    cash: float | None = None
    current_assets: float | None = None
    current_liabilities: float | None = None
    interest_expense: float | None = None
    operating_cf: float | None = None
    capex: float | None = None
    dividends_paid: float | None = None

    def __post_init__(self) -> None:
        if self.known_from < self.period_end:
            raise ValueError(
                f"公表日({self.known_from})が決算期末({self.period_end})より前になっている"
            )


def point_in_time_frame(records: list[FundamentalRecord],
                        index: pd.DatetimeIndex) -> pd.DataFrame:
    """各日付について「その時点で公表済みの最新決算」の値を並べた表を返す。

    公表前の期間は NaN(まだ何も分からない)。同じ日に複数の公表がある場合は
    期末が新しいほうを採用する(訂正・本決算と四半期の重複を想定)。
    """
    cols = ["eps", "bps", "roe", "sps", "eps_guidance"]
    if not records:
        return pd.DataFrame(np.nan, index=index, columns=cols)

    # 公表日順に並べ、同一公表日は期末が新しいものを後ろへ(=後勝ち)
    ordered = sorted(records, key=lambda r: (r.known_from, r.period_end))
    rows = pd.DataFrame(
        [[getattr(r, c) for c in cols] for r in ordered],
        index=pd.DatetimeIndex([pd.Timestamp(r.known_from) for r in ordered]),
        columns=cols,
        dtype="float64",
    )
    rows = rows[~rows.index.duplicated(keep="last")].sort_index()

    # 各日付に「その日以前で最も新しい公表」を割り当てる(階段状に更新)
    return rows.reindex(rows.index.union(index)).ffill().reindex(index)


def valuation_frame(prices: pd.Series,
                    records: list[FundamentalRecord]) -> pd.DataFrame:
    """日次の PER / PBR / PSR を組み立てる。

    prices は終値の時系列(index=DatetimeIndex)。EPSが0以下の期間のPERは
    定義できないため NaN にする(赤字企業を機械的に「割高」と誤判定しない)。
    """
    prices = prices.dropna().sort_index()
    pit = point_in_time_frame(records, prices.index)

    out = pd.DataFrame(index=prices.index)
    out["close"] = prices
    for name, col in (("per", "eps"), ("pbr", "bps"), ("psr", "sps")):
        denom = pit[col].where(pit[col] > 0)
        out[name] = prices / denom
    out["roe"] = pit["roe"]
    out["eps"] = pit["eps"]
    out["bps"] = pit["bps"]
    return out


def _tail_years(s: pd.Series, years: int) -> pd.Series:
    if s.empty:
        return s
    cutoff = s.index[-1] - pd.DateOffset(years=years)
    return s[s.index >= cutoff]


def percentile_rank(s: pd.Series, years: int = DEFAULT_YEARS) -> float | None:
    """直近値が自己の過去レンジで何パーセンタイルかを返す(0=最安、100=最高)。

    観測数が足りない場合は None(新規上場などで判断材料が無いことを隠さない)。
    """
    s = _tail_years(s.dropna(), years)
    if len(s) < MIN_OBSERVATIONS:
        return None
    latest = s.iloc[-1]
    return float((s < latest).mean() * 100.0)


def band(s: pd.Series, years: int = DEFAULT_YEARS) -> dict | None:
    """自己の過去レンジ(五分位点と現在値)を返す。表示用。"""
    s = _tail_years(s.dropna(), years)
    if len(s) < MIN_OBSERVATIONS:
        return None
    q = s.quantile([0.1, 0.25, 0.5, 0.75, 0.9])
    return {
        "current": float(s.iloc[-1]),
        "p10": float(q.loc[0.1]), "p25": float(q.loc[0.25]),
        "median": float(q.loc[0.5]),
        "p75": float(q.loc[0.75]), "p90": float(q.loc[0.9]),
        "years": years, "observations": int(len(s)),
    }


def market_adjusted(own: pd.Series, market: pd.Series) -> pd.Series:
    """市場全体の水準で割った相対値。

    市場平均が切り上がっただけの局面で「自己レンジの上位」と誤読するのを防ぐ。
    """
    aligned = market.reindex(own.index).ffill()
    return own / aligned.where(aligned > 0)


@dataclass(frozen=True)
class ExplainedLevel:
    """収益力から説明される水準と、実際との乖離。"""

    fair: float          # 今のROEから導かれる妥当PBR
    actual: float        # 実際のPBR
    gap_pct: float       # (実際 - 妥当) / 妥当 * 100。マイナスが割安
    r2: float            # 自社時系列での説明力(比率法では0.0)
    observations: int
    # "regression" = 自社時系列の回帰 / "ratio" = 自社平均のPBR÷ROE比率
    method: str = "regression"


# 乖離がこれを超えたら、割高割安ではなくモデルが壊れていると判断して何も出さない。
# 実データで fair=0.0 に潰れて +977273% と出た例があった。
MAX_ABS_GAP_PCT = 200.0


# 観測範囲の外へどこまで当てはめを許すか(範囲幅に対する割合)。
# 0にすると、ROEが緩やかに低下し続けている銘柄で不当に不利になる。推定から
# 直近3ヶ月を外している以上、今のROEが観測範囲をわずかに超えるのは正常なため。
EXTRAPOLATION_MARGIN = 0.25


def _clamp(value: float, observed: pd.Series) -> float:
    """推定に使ったROEの範囲(に少し余裕を持たせた範囲)へ丸める。

    範囲外への大きな外挿は根拠が無く、exp() が0や巨大値に飛ぶ原因になる。
    一方で完全に閉じ込めると、ROEが趨勢的に動いている銘柄で歪む。
    """
    lo, hi = float(observed.min()), float(observed.max())
    pad = (hi - lo) * EXTRAPOLATION_MARGIN
    return float(min(max(value, lo - pad), hi + pad))


def _build(fair: float, actual: float, r2: float, n: int,
           method: str) -> ExplainedLevel | None:
    """妥当水準が数値として成立している場合だけ結果を返す。"""
    if not np.isfinite(fair) or fair <= 0 or not np.isfinite(actual) or actual <= 0:
        return None
    gap = (actual - fair) / fair * 100.0
    if not np.isfinite(gap) or abs(gap) > MAX_ABS_GAP_PCT:
        return None
    return ExplainedLevel(fair=fair, actual=actual, gap_pct=gap,
                          r2=r2, observations=int(n), method=method)


# 関係を推定する際に除外する直近期間(営業日)。約3ヶ月。
# 直近の異常値を推定に含めると、その異常が「その会社の平常」として基準線に
# 取り込まれ、乖離を自分で薄めてしまう(実測で -30% の乖離が -18% に化けた)。
DEFAULT_EXCLUDE_RECENT_DAYS = 60


def explain_pbr_by_roe(v: pd.DataFrame,
                       years: int = DEFAULT_YEARS,
                       min_r2: float = 0.2,
                       exclude_recent_days: int = DEFAULT_EXCLUDE_RECENT_DAYS,
                       ) -> ExplainedLevel | None:
    """自社の過去における「ROE ↔ PBR」の関係から、今の妥当PBRを求める。

    残余利益モデルでは妥当PBRはROEの増加関数になる。ここでは他社を使わず、
    その会社自身の履歴で log(PBR) = a + b*ROE を推定する。ROEが落ちたことで
    説明できるPBR低下は「割安」とみなさない、という判定がこれで自動化できる。

    関係の推定には直近 exclude_recent_days を使わない。今の水準を、それ以前に
    成立していた関係に照らして評価するためで、これをしないと直近の割安さが
    基準線に吸収されて検出できなくなる。逆に言うと、割安な状態がこの期間より
    長く続けば、いずれ「その会社の新しい平常」として扱われる。

    説明力(r2)が低い場合は None を返す。関係が無いのに乖離を語らないため。
    """
    df = _tail_years(v[["pbr", "roe"]].dropna(), years)
    df = df[df["pbr"] > 0]
    if len(df) < MIN_OBSERVATIONS:
        return None

    fit = df.iloc[:-exclude_recent_days] if exclude_recent_days > 0 else df
    if len(fit) < MIN_OBSERVATIONS:
        fit = df       # 履歴が短い銘柄では除外せず全期間で推定する
    # ROEがほぼ一定だと回帰の傾きが定まらない。比率法なら傾きを理論から
    # 固定するので、この場合でも妥当水準を出せる。
    if float(fit["roe"].std()) < 1e-4:
        return _explain_by_ratio(df, fit)

    y = np.log(fit["pbr"].to_numpy())
    x = fit["roe"].to_numpy()
    b, a = np.polyfit(x, y, 1)
    pred = a + b * x
    ss_res = float(((y - pred) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    if r2 < min_r2:
        # 決算が4〜5期しか無いとROEが数個の値しか取らず、日次PBRの変動の大半が
        # 「同じROEの中での値動き」になって決定係数が上がらない。関係が無いのでは
        # なく推定方法が合っていないので、傾きを理論から固定する比率法に落とす。
        return _explain_by_ratio(df, fit)

    # 推定した関係は、観測されたROEの範囲でしか意味を持たない。範囲外へ外挿すると
    # exp() が0や巨大値に飛ぶ。実データで fair=0.0 → 乖離+977273% という表示が
    # 出たため、今のROEを観測範囲に丸めてから当てる。
    roe_now = _clamp(float(df["roe"].iloc[-1]), fit["roe"])
    fair = float(np.exp(a + b * roe_now))
    return _build(fair, float(df["pbr"].iloc[-1]), float(r2), len(fit), "regression")


def _explain_by_ratio(df: pd.DataFrame, fit: pd.DataFrame) -> ExplainedLevel | None:
    """自社の平均的な「PBR ÷ ROE」倍率から妥当PBRを求める(比率法)。

    残余利益モデルでは、成長ゼロなら 妥当PBR = ROE / 株主資本コスト となり、
    PBRはROEに比例する。つまり PBR/ROE は本来その会社の資本コストを表す定数で、
    自社の過去平均から推定できる。

    回帰法より弱い仮定に見えるが、履歴が短いときはむしろこちらが妥当である。
    決算が4〜5期しか無いとROEは4〜5個の値しか取らず、日次PBRの変動の大半が
    「同じROEの中での値動き」になるため、自由な傾きの回帰は決定係数が上がらず
    棄却されてしまう(実測で成立率45%)。比率法は傾きを理論から固定するので、
    観測数が少なくても安定する。

    ROEが0以下の期は比率が意味を持たないため除く。
    """
    usable = fit[fit["roe"] > 0]
    if len(usable) < 60:
        return None
    roe_now = float(df["roe"].iloc[-1])
    if roe_now <= 0:
        return None
    ratios = (usable["pbr"] / usable["roe"]).replace([np.inf, -np.inf], np.nan).dropna()
    if len(ratios) < 60:
        return None
    # 外れ値に引きずられないよう中央値を使う(実質の株主資本コストの逆数)
    ratio = float(ratios.median())
    if ratio <= 0:
        return None
    # 倍率自体が安定していなければ基準として使えない。「関係が無いのに乖離を
    # 語らない」という回帰法の原則を比率法でも守る。閾値は実測で決めた:
    #   関係なし(ランダム) 0.63 / ROE一定でPBR2倍 0.33 / 5期の実例 0.16
    q1, q3 = ratios.quantile([0.25, 0.75])
    if (q3 - q1) / ratio > 0.45:
        return None
    # 回帰法と同じく、観測されたROEの範囲を超えて当てはめない。
    fair = ratio * _clamp(roe_now, usable["roe"])
    return _build(fair, float(df["pbr"].iloc[-1]), 0.0, len(usable), "ratio")
