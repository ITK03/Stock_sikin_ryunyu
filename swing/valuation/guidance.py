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

# 利益の行どうしがこれ以上食い違ったら、進捗の判定を断定しない。
# 実データ239銘柄の分布は 中央値1.12倍・75%点1.28倍・90%点1.96倍。2.5倍超は
# 約8%で、大半の会社には影響しない。
SPREAD_LIMIT = 2.5

# 抽出ロジックの版。上げると、同じ短信から抽出済みの銘柄でも取り直す。
#
# 会社予想は「同じ文書IDなら再取得しない」という作りになっている。決算期以外に
# 予想が消えないための仕組みだが、抽出側のバグを直しても配信済みの値が古い
# ままになるという副作用がある。実際、連結/非連結の取り違えを直しても、抽出
# 済みの279件はそのままだった。スキーマ版と同じで、直したら必ずここを上げる。
#
# 2: 実績と予想を同じ基準(連結/非連結)で揃える。当期予想を翌期予想より優先。
# 3: 利益の行が食い違うときは進捗の判定を断定しない(spread / mixed)。
GUIDANCE_VERSION = 3


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

    # 利益3行の食い違い。予想が小さい行では進捗率が跳ねるため、代表指標1つを
    # 断定的に見せると実態を誤って伝える。実データではユタカフーズの営業利益が
    # 330%、同じ会社の経常が99%・純利益が75%だった(営業利益の予想が小さい会社)。
    # 中央値は1.12倍で大半は一致しており、食い違うのは1割程度。
    profits = [out[f] for f in ("operating_income", "ordinary_income", "net_income")
               if out.get(f) is not None and out[f] > 0]
    if len(profits) >= 2:
        out["spread"] = round(max(profits) / min(profits), 2)

    out["verdict"] = verdict(lead, elapsed, out.get("spread"))
    return out


def verdict(ratio: float | None, elapsed: float,
            spread: float | None = None) -> str:
    """進捗を経過率と比べた評価。単独の進捗率だけでは判断できない。

    利益の行どうしが大きく食い違う場合は "mixed" を返す。営業利益の予想が
    小さい会社では営業利益進捗率だけが跳ね、経常や純利益とまったく違う話に
    なる。そこで片方だけを取って「上振れ」と言い切ると事実を歪める。
    """
    if ratio is None:
        return "unknown"
    if spread is not None and spread > SPREAD_LIMIT:
        return "mixed"
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
        # 抽出ロジックの版。古い版で抽出した値を作り直す判定に使う。
        "gv": GUIDANCE_VERSION,
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
