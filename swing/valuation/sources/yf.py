"""yfinance の財務諸表を FundamentalRecord に変換する。

yfinance は行が勘定科目・列が決算期末の DataFrame を返す。科目名は銘柄や
会計基準によって揺れるため、候補名を順に探す方式にしている。

制約を2つ、正直に書いておく。

1. **公表日が取れない。** yfinance が返すのは期末日だけなので、決算短信までの
   標準的な日数(45日)を足して推定する。過去レンジにわずかな先読みが混じるが、
   期末に紐づける(=数十日ぶん先読みする)よりは実態に近い。決算短信XBRLを
   繋いだ時点で実際の公表日に置き換わる。
2. **修正後の数値しか返らない。** 遡って修正された決算はその修正後の値になる。
   表示用のレンジとしては実害が小さいが、戦略の検証には使えない。検証用の
   point-in-time は決算短信XBRLの蓄積で別途作る。
"""
from __future__ import annotations

import math
from datetime import date

import pandas as pd

from valuation.history import FundamentalRecord
from valuation.profile import estimate_known_from

# 科目名の候補。yfinance/Yahoo の表記揺れを吸収する。上から順に探す。
EPS_ROWS = ["Diluted EPS", "Basic EPS"]
NET_INCOME_ROWS = [
    "Net Income Common Stockholders", "Net Income From Continuing Operation Net Minority Interest",
    "Net Income", "Net Income Including Noncontrolling Interests",
]
EQUITY_ROWS = [
    "Stockholders Equity", "Common Stock Equity",
    "Total Equity Gross Minority Interest",
]
SHARES_ROWS = [
    "Diluted Average Shares", "Basic Average Shares", "Share Issued", "Ordinary Shares Number",
]
REVENUE_ROWS = ["Total Revenue", "Operating Revenue"]
GROSS_PROFIT_ROWS = ["Gross Profit"]
OPERATING_INCOME_ROWS = ["Operating Income", "Total Operating Income As Reported",
                         "EBIT"]
TOTAL_ASSETS_ROWS = ["Total Assets"]
TOTAL_DEBT_ROWS = ["Total Debt", "Net Debt"]
CASH_ROWS = ["Cash Cash Equivalents And Short Term Investments",
             "Cash And Cash Equivalents", "Cash Financial"]
CURRENT_ASSETS_ROWS = ["Current Assets", "Total Current Assets"]
CURRENT_LIABILITIES_ROWS = ["Current Liabilities", "Total Current Liabilities"]
INTEREST_ROWS = ["Interest Expense", "Interest Expense Non Operating"]
OCF_ROWS = ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"]
CAPEX_ROWS = ["Capital Expenditure", "Purchase Of PPE"]
DIVIDENDS_ROWS = ["Cash Dividends Paid", "Common Stock Dividend Paid"]


def _pick(df: pd.DataFrame, names: list[str], col) -> float | None:
    """候補の科目名から最初に見つかった有効な数値を返す。"""
    if df is None or df.empty or col not in df.columns:
        return None
    for n in names:
        if n in df.index:
            v = df.loc[n, col]
            if isinstance(v, pd.Series):     # 同名行が複数あることがある
                v = v.iloc[0]
            try:
                f = float(v)
            except (TypeError, ValueError):
                continue
            if math.isfinite(f):
                return f
    return None


def _as_date(col) -> date | None:
    try:
        return pd.Timestamp(col).date()
    except (TypeError, ValueError):
        return None


def records_from_statements(income: pd.DataFrame,
                            balance: pd.DataFrame,
                            cashflow: pd.DataFrame | None = None,
                            lag_days: int | None = None) -> list[FundamentalRecord]:
    """損益計算書と貸借対照表から、期ごとの1株指標を組み立てる。

    ROE は「当期純利益 ÷ 期首期末平均自己資本」。期末自己資本だけで割ると、
    増資や自己株買いのあった期でROEが実態からずれるため、前期の値があれば
    平均を使う。
    """
    if income is None or income.empty or balance is None or balance.empty:
        return []

    # 列(期末日)を古い順に並べる
    cols = [c for c in income.columns if _as_date(c) is not None]
    cols.sort(key=lambda c: pd.Timestamp(c))

    out: list[FundamentalRecord] = []
    prev_equity: float | None = None
    for col in cols:
        pe = _as_date(col)
        if pe is None:
            continue
        equity = _pick(balance, EQUITY_ROWS, col)
        shares = _pick(income, SHARES_ROWS, col) or _pick(balance, SHARES_ROWS, col)
        net = _pick(income, NET_INCOME_ROWS, col)
        revenue = _pick(income, REVENUE_ROWS, col)
        eps = _pick(income, EPS_ROWS, col)
        if eps is None and net is not None and shares:
            eps = net / shares

        bps = equity / shares if (equity is not None and shares) else None
        sps = revenue / shares if (revenue is not None and shares) else None

        roe = None
        if net is not None and equity:
            base = (equity + prev_equity) / 2 if prev_equity else equity
            if base:
                roe = net / base
        prev_equity = equity if equity else prev_equity

        if eps is None and bps is None:
            continue    # 何も取れなかった期は作らない(空レコードで水増ししない)

        kf = estimate_known_from(pe) if lag_days is None else \
            estimate_known_from(pe, lag_days)
        cf = cashflow
        out.append(FundamentalRecord(
            period_end=pe, known_from=kf, eps=eps, bps=bps, roe=roe, sps=sps,
            shares=shares, revenue=revenue, net_income=net,
            gross_profit=_pick(income, GROSS_PROFIT_ROWS, col),
            operating_income=_pick(income, OPERATING_INCOME_ROWS, col),
            total_assets=_pick(balance, TOTAL_ASSETS_ROWS, col),
            equity=equity,
            total_debt=_pick(balance, TOTAL_DEBT_ROWS, col),
            cash=_pick(balance, CASH_ROWS, col),
            current_assets=_pick(balance, CURRENT_ASSETS_ROWS, col),
            current_liabilities=_pick(balance, CURRENT_LIABILITIES_ROWS, col),
            interest_expense=_pick(income, INTEREST_ROWS, col),
            operating_cf=_pick(cf, OCF_ROWS, col),
            capex=_pick(cf, CAPEX_ROWS, col),
            dividends_paid=_pick(cf, DIVIDENDS_ROWS, col),
        ))
    return out


def fetch_records(ticker: str) -> list[FundamentalRecord]:
    """yfinance から1銘柄ぶんの年次財務を取得する。失敗時は空リスト。

    ネットワーク・API仕様変更で落とさない(1銘柄の失敗で全体を止めない)。
    """
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        return records_from_statements(t.income_stmt, t.balance_sheet, t.cashflow)
    except Exception as exc:           # noqa: BLE001 - 可用性優先
        print(f"WARNING: {ticker} の財務取得に失敗: {exc}")
        return []


def fetch_quarterly(ticker: str) -> list[FundamentalRecord]:
    """四半期の実績推移。前年同期比の算出に使う(8期あれば4期ぶんのYoYが出る)。"""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        return records_from_statements(t.quarterly_income_stmt,
                                       t.quarterly_balance_sheet,
                                       t.quarterly_cashflow)
    except Exception as exc:           # noqa: BLE001 - 可用性優先
        print(f"WARNING: {ticker} の四半期取得に失敗: {exc}")
        return []
