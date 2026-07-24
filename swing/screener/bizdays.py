"""営業日ユーティリティ。

screener/run.py と screener/paper_log.py の両方から参照されるため、
循環importを避ける目的で独立モジュールに切り出している
（run.py はこのモジュールの関数をre-exportする形で従来どおり
`screener.run.is_business_day` 等としても参照できる）。
"""
from __future__ import annotations

from datetime import date, timedelta
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def is_business_day(d: date) -> bool:
    if d.weekday() >= 5:
        return False
    try:
        import jpholiday
        return not jpholiday.is_holiday(d)
    except ImportError:
        return True  # jpholiday未導入時は土日のみ考慮（結果は翌営業日表示のみに影響）


def next_business_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def prev_business_day(d: date) -> date:
    while not is_business_day(d):
        d -= timedelta(days=1)
    return d
