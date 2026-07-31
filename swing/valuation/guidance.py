"""会社予想と進捗率。

進捗率は「通期の会社予想に対して、累計実績がどこまで来ているか」。単独では
意味を持たず、**経過率(その四半期までに1年のどれだけが過ぎたか)と比べて初めて
判断材料になる**。第1四半期で進捗25%は平常、40%なら上振れ、10%なら遅れ。

会社予想はアナリスト予想と違い、日本では正式な開示であり、修正も適時開示に
出る。yfinance からは取れないため決算短信XBRLを使う。
"""
from __future__ import annotations

import math

# 各四半期までの標準的な経過率。単純な期割り(1/4刻み)。
# 実際には季節性があるが、業種ごとの季節性まで持ち出すと根拠が薄くなるので
# 「期割りと比べてどうか」という素直な基準に留める。
ELAPSED_BY_QUARTER = {1: 0.25, 2: 0.50, 3: 0.75, 4: 1.00}

# 進捗が経過率からこれだけ離れたら「上振れ/遅れ」と呼ぶ。
DEVIATION_THRESHOLD = 0.10


def _ratio(actual: float | None, forecast: float | None) -> float | None:
    """進捗率。予想が0以下だと率が意味を持たない(赤字予想など)。"""
    if actual is None or forecast is None or forecast <= 0:
        return None
    v = actual / forecast
    return v if math.isfinite(v) else None


def progress(summary: dict) -> dict | None:
    """短信サマリーから進捗率を組み立てる。

    通期の本決算(quarter=4 または四半期情報なし)では進捗という概念が無いので
    None を返す。予想が無い場合も同様。
    """
    if not summary:
        return None
    q = summary.get("quarter")
    actual = summary.get("actual") or {}
    forecast = summary.get("forecast") or {}
    if not forecast or q not in (1, 2, 3):
        return None

    elapsed = ELAPSED_BY_QUARTER[q]
    out: dict = {"quarter": q, "elapsed": elapsed}
    any_ratio = False
    for field in ("revenue", "operating_income", "ordinary_income", "net_income"):
        r = _ratio(actual.get(field), forecast.get(field))
        if r is not None:
            out[field] = round(r, 4)
            any_ratio = True
    if not any_ratio:
        return None

    # 代表指標は営業利益。無ければ経常→純利益→売上の順に落とす。
    lead = next((out[f] for f in ("operating_income", "ordinary_income",
                                  "net_income", "revenue") if f in out), None)
    out["lead"] = lead
    out["verdict"] = verdict(lead, elapsed)
    return out


def verdict(ratio: float | None, elapsed: float) -> str:
    """進捗を経過率と比べた評価。単独の進捗率だけでは判断できない。"""
    if ratio is None:
        return "unknown"
    d = ratio - elapsed
    if d >= DEVIATION_THRESHOLD:
        return "ahead"
    if d <= -DEVIATION_THRESHOLD:
        return "behind"
    return "ontrack"


def guidance_block(summary: dict | None, known_from: str | None,
                   shares: float | None = None) -> dict | None:
    """配信プロファイルに載せる会社予想ブロック。

    金額は桁が大きいので、1株あたりに直せるものは直して持つ(株価と比べられる)。
    """
    if not summary:
        return None
    forecast = summary.get("forecast") or {}
    if not forecast:
        return None

    block: dict = {
        "known_from": known_from,
        "consolidated": bool(summary.get("consolidated")),
        # 会社予想の1株利益と配当。株価があればブラウザ側で予想PER・利回りを出せる。
        "eps": forecast.get("eps"),
        "dps": forecast.get("dps"),
    }
    if block["eps"] is None and shares:
        ni = forecast.get("net_income")
        if ni is not None:
            block["eps"] = round(ni / shares, 2)

    prog = progress(summary)
    if prog:
        block["progress"] = prog
    # 何も中身が無いなら載せない(空のブロックで「予想あり」に見せない)
    if block["eps"] is None and block["dps"] is None and "progress" not in block:
        return None
    return block
