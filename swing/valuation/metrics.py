"""財務の健全性・収益性・成長率を、決算レコードから組み立てる。

PER/PBR は「安いか」しか答えない。安い会社が安い理由は、たいてい
「稼げていない」「借金が重い」「縮んでいる」のどれかで、そこを見ずに
バリュエーションだけ見ると必ず判断を誤る。ここではその3つを数値にする。

方針:
- 割り算の分母が0や欠測なら None を返す。0で埋めない(「情報が無い」と
  「ゼロという事実」を混同させない)。
- 1株あたりに直せるものは1株あたりで返す。株価はブラウザ側が持っているので、
  利回り(FCF利回り・配当利回り)は向こうで計算できる。
"""
from __future__ import annotations

import math

from valuation.history import FundamentalRecord


def _div(a: float | None, b: float | None) -> float | None:
    """安全な割り算。分母が0・欠測・非有限なら None。"""
    if a is None or b is None:
        return None
    try:
        if b == 0 or not math.isfinite(a) or not math.isfinite(b):
            return None
        v = a / b
    except (TypeError, ZeroDivisionError):
        return None
    return v if math.isfinite(v) else None


def _round(v: float | None, digits: int = 4) -> float | None:
    return None if v is None else round(v, digits)


def financial_metrics(rec: FundamentalRecord) -> dict:
    """最新期の財務指標。

    net_cash_ps(1株あたりネットキャッシュ)は日本株で特に重要で、現金が時価総額の
    数割を占める企業が珍しくない。これを見ないとPERが機械的に割高に見える。
    """
    net_cash = None
    if rec.cash is not None and rec.total_debt is not None:
        net_cash = rec.cash - rec.total_debt
    fcf = None
    if rec.operating_cf is not None and rec.capex is not None:
        # capex は負値で入ることが多いため絶対値で引く
        fcf = rec.operating_cf - abs(rec.capex)

    dps = None
    if rec.dividends_paid is not None and rec.shares:
        dps = abs(rec.dividends_paid) / rec.shares

    return {
        # 収益性
        "gross_margin": _round(_div(rec.gross_profit, rec.revenue)),
        "op_margin": _round(_div(rec.operating_income, rec.revenue)),
        "roa": _round(_div(rec.net_income, rec.total_assets)),
        # 安全性
        "equity_ratio": _round(_div(rec.equity, rec.total_assets)),
        "de": _round(_div(rec.total_debt, rec.equity)),
        "current_ratio": _round(_div(rec.current_assets, rec.current_liabilities), 2),
        "interest_cover": _round(
            _div(rec.operating_income, abs(rec.interest_expense))
            if rec.interest_expense else None, 1),
        "net_cash_ps": _round(_div(net_cash, rec.shares), 1),
        # キャッシュ創出・還元
        "ocf_ps": _round(_div(rec.operating_cf, rec.shares), 1),
        "fcf_ps": _round(_div(fcf, rec.shares), 1),
        "dps": _round(dps, 1),
        "payout": _round(_div(dps, rec.eps) if dps is not None else None),
    }


def _growth(new: float | None, old: float | None) -> float | None:
    """成長率。基準が0以下だと率が意味を持たない(赤字からの回復など)ので None。"""
    if new is None or old is None or old <= 0:
        return None
    v = new / old - 1.0
    return v if math.isfinite(v) else None


def _cagr(new: float | None, old: float | None, years: int) -> float | None:
    if new is None or old is None or old <= 0 or new <= 0 or years <= 0:
        return None
    v = (new / old) ** (1.0 / years) - 1.0
    return v if math.isfinite(v) else None


def growth_metrics(records: list[FundamentalRecord]) -> dict:
    """前期比と3年CAGR。レコードは古い順であること。"""
    out = {k: None for k in
           ("rev_yoy", "op_yoy", "eps_yoy", "rev_cagr3", "op_cagr3", "eps_cagr3")}
    if len(records) < 2:
        return out
    last, prev = records[-1], records[-2]
    out["rev_yoy"] = _round(_growth(last.revenue, prev.revenue))
    out["op_yoy"] = _round(_growth(last.operating_income, prev.operating_income))
    out["eps_yoy"] = _round(_growth(last.eps, prev.eps))
    if len(records) >= 4:
        base = records[-4]
        n = 3
        out["rev_cagr3"] = _round(_cagr(last.revenue, base.revenue, n))
        out["op_cagr3"] = _round(_cagr(last.operating_income, base.operating_income, n))
        out["eps_cagr3"] = _round(_cagr(last.eps, base.eps, n))
    return out


def yearly_history(records: list[FundamentalRecord]) -> dict:
    """年次推移(スパークライン用)。売上・営業利益は絶対値の最大を100とした指数。

    実額をそのまま持つと桁が大きくサイズを食ううえ、推移の形しか見ないので
    指数化のほうが読みやすい。EPS・ROE・自己資本比率は実値のまま。

    基準の取り方に注意がいる。以前は「最初の非ゼロ値」を100としていたが、
    これには二つ問題があった。

    - 基準年の営業利益がゼロ近傍だと指数が桁違いに振れる(実測で絶対値1000超が
      47銘柄)。線形変換なのでスパークラインの形自体は変わらないが、値としては
      意味を持たない。
    - **基準年が赤字だと系列全体の符号が反転する。** 指数の先頭は常に +100 に
      なるので、published のデータからは反転しているかどうか判別すらできない。
      赤字から立ち直った会社の推移が、黙って上下逆さまに描かれることになる。

    絶対値の最大で割れば、範囲は -100〜100 に収まり、符号も形もそのまま残る。
    """
    if not records:
        return {"years": [], "rev": [], "op": [], "eps": [], "roe": [], "eq": []}

    def index_of(attr: str) -> list[float | None]:
        vals = [getattr(r, attr) for r in records]
        scale = max((abs(v) for v in vals if v is not None), default=None)
        if not scale:
            return [None] * len(vals)
        return [None if v is None else round(v / scale * 100.0, 1) for v in vals]

    return {
        "years": [r.period_end.year for r in records],
        "rev": index_of("revenue"),
        "op": index_of("operating_income"),
        "eps": [None if r.eps is None else round(r.eps, 1) for r in records],
        "roe": [None if r.roe is None else round(r.roe, 4) for r in records],
        "eq": [_round(_div(r.equity, r.total_assets)) for r in records],
    }


def quarterly_history(records: list[FundamentalRecord]) -> dict:
    """四半期の推移と前年同期比。レコードは古い順、直近8期まで。

    会社予想に対する進捗率はここでは出せない。yfinance が会社予想を返さない
    ためで、決算短信XBRL を繋いだ時点で追加できる。予想が無いまま「進捗率」を
    名乗る数字を出すと誤解を招くので、実績の推移と前年同期比に留める。
    """
    rs = records[-8:]
    labels, rev, op, rev_yoy, op_yoy = [], [], [], [], []
    for i, r in enumerate(rs):
        q = (r.period_end.month - 1) // 3 + 1
        labels.append(f"{r.period_end.year % 100:02d}Q{q}")
        rev.append(_round(r.revenue, 0) if r.revenue is not None else None)
        op.append(_round(r.operating_income, 0) if r.operating_income is not None else None)
        # 前年同期 = 4期前
        prev = rs[i - 4] if i >= 4 else None
        rev_yoy.append(_round(_growth(r.revenue, prev.revenue)) if prev else None)
        op_yoy.append(_round(_growth(r.operating_income, prev.operating_income)) if prev else None)
    return {"labels": labels, "rev": rev, "op": op,
            "rev_yoy": rev_yoy, "op_yoy": op_yoy}
