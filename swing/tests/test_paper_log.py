from datetime import date

import numpy as np
import pandas as pd
import pytest

from screener import paper_log as pl
from screener.run import StrategyEntry


def make_df(index, open_, high=None, low=None, close=None):
    n = len(index)
    open_ = np.asarray(open_, dtype=float)
    close = np.asarray(close, dtype=float) if close is not None else open_.copy()
    high = np.asarray(high, dtype=float) if high is not None else np.maximum(open_, close) * 1.01
    low = np.asarray(low, dtype=float) if low is not None else np.minimum(open_, close) * 0.99
    return pd.DataFrame({
        "open": open_, "high": high, "low": low, "close": close,
        "volume": [1_000_000.0] * n,
    }, index=index)


def no_exit_entry(strategy_id="mkt", take_profit=None):
    def fn(df, **kw):
        out = pd.DataFrame(index=df.index)
        out["entry"] = False
        out["exit"] = False
        out["rank"] = 0.0
        return out
    engine = {"take_profit": take_profit} if take_profit else {}
    return StrategyEntry(id=strategy_id, fn=fn, meta={"engine": engine, "params": {}})


def always_exit_entry(strategy_id="sig"):
    def fn(df, **kw):
        out = pd.DataFrame(index=df.index)
        out["entry"] = False
        out["exit"] = True
        out["rank"] = 0.0
        return out
    return StrategyEntry(id=strategy_id, fn=fn, meta={"engine": {}, "params": {}})


# ---------------------------------------------------------------------------
# fill_pending_entries
# ---------------------------------------------------------------------------

def test_market_order_fill():
    idx = pd.bdate_range("2026-07-06", periods=3)  # Mon,Tue,Wed
    df = make_df(idx, open_=[999, 1000, 1010])
    prices = {"7203": df}
    paper_log = pl.empty_paper_log()
    paper_log["pending"].append({
        "id": "mkt_7203_2026-07-06", "strategy_id": "mkt", "code": "7203",
        "name": "トヨタ", "signal_date": "2026-07-06", "trade_date": "2026-07-07",
        "limit_price": None,
    })
    registry = [no_exit_entry("mkt", take_profit=0.02)]

    pl.fill_pending_entries(paper_log, prices, date(2026, 7, 7), registry)

    assert paper_log["pending"] == []
    assert len(paper_log["open"]) == 1
    pos = paper_log["open"][0]
    assert pos["entry_price"] == 1000.0
    assert pos["stop_price"] == round(1000 * 0.85, 2)
    assert pos["target_price"] == round(1000 * 1.02, 2)
    assert pos["deadline_date"] > "2026-07-07"
    assert pos["pending_exit"] is False


def test_limit_order_fill_gap_down_and_touch_and_expiry():
    idx = pd.bdate_range("2026-07-06", periods=2)  # Mon, Tue
    registry = [no_exit_entry("lim")]

    # A: 寄付が指値以下 → 寄付で約定
    df_a = make_df(idx, open_=[999, 95], low=[989, 90])
    paper_log_a = pl.empty_paper_log()
    paper_log_a["pending"].append({
        "id": "lim_A_2026-07-06", "strategy_id": "lim", "code": "A",
        "name": "A", "signal_date": "2026-07-06", "trade_date": "2026-07-07",
        "limit_price": 100.0,
    })
    pl.fill_pending_entries(paper_log_a, {"A": df_a}, date(2026, 7, 7), registry)
    assert len(paper_log_a["open"]) == 1
    assert paper_log_a["open"][0]["entry_price"] == 95.0

    # B: 寄付は指値超だが安値が指値到達 → 指値で約定
    df_b = make_df(idx, open_=[999, 105], low=[989, 98])
    paper_log_b = pl.empty_paper_log()
    paper_log_b["pending"].append({
        "id": "lim_B_2026-07-06", "strategy_id": "lim", "code": "B",
        "name": "B", "signal_date": "2026-07-06", "trade_date": "2026-07-07",
        "limit_price": 100.0,
    })
    pl.fill_pending_entries(paper_log_b, {"B": df_b}, date(2026, 7, 7), registry)
    assert len(paper_log_b["open"]) == 1
    assert paper_log_b["open"][0]["entry_price"] == 100.0

    # C: 寄付・安値とも指値未達 → 失効（破棄、openにもpendingにも残らない）
    df_c = make_df(idx, open_=[999, 105], low=[989, 102])
    paper_log_c = pl.empty_paper_log()
    paper_log_c["pending"].append({
        "id": "lim_C_2026-07-06", "strategy_id": "lim", "code": "C",
        "name": "C", "signal_date": "2026-07-06", "trade_date": "2026-07-07",
        "limit_price": 100.0,
    })
    pl.fill_pending_entries(paper_log_c, {"C": df_c}, date(2026, 7, 7), registry)
    assert paper_log_c["open"] == []
    assert paper_log_c["pending"] == []  # 黙って破棄（次回に持ち越さない）


def test_pending_entry_not_yet_due_is_kept():
    idx = pd.bdate_range("2026-07-06", periods=2)
    df = make_df(idx, open_=[999, 1000])
    paper_log = pl.empty_paper_log()
    paper_log["pending"].append({
        "id": "mkt_7203_2026-07-07", "strategy_id": "mkt", "code": "7203",
        "name": "トヨタ", "signal_date": "2026-07-07", "trade_date": "2026-07-08",
        "limit_price": None,
    })
    pl.fill_pending_entries(paper_log, {"7203": df}, date(2026, 7, 7), [no_exit_entry("mkt")])
    assert len(paper_log["pending"]) == 1
    assert paper_log["open"] == []


# ---------------------------------------------------------------------------
# evaluate_open_positions: 優先順位 stop_loss > take_profit > max_hold > exit_signal
# ---------------------------------------------------------------------------

def _base_open_pos(**overrides):
    pos = {
        "id": "x_1_2026-07-06", "strategy_id": "x", "code": "C",
        "name": "テスト", "entry_date": "2026-07-06", "entry_price": 1000.0,
        "stop_price": 850.0, "target_price": 1020.0, "deadline_date": "2026-07-20",
        "pending_exit": False, "exit_reason": None,
    }
    pos.update(overrides)
    return pos


def test_evaluate_stop_loss_priority():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[1000], close=[800])  # close<=stop(850)
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos())
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 6), [always_exit_entry("x")])
    assert paper_log["open"][0]["pending_exit"] is True
    assert paper_log["open"][0]["exit_reason"] == "stop_loss"


def test_evaluate_take_profit():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[1000], close=[1030])  # close>=target(1020), > stop
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos())
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 6), [always_exit_entry("x")])
    assert paper_log["open"][0]["exit_reason"] == "take_profit"


def test_evaluate_max_hold_over_exit_signal():
    idx = pd.bdate_range("2026-07-20", periods=1)
    df = make_df(idx, open_=[1000], close=[1000])  # 損切りも利確も該当しない
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos(deadline_date="2026-07-20"))
    # always_exit_entryはexit=True常時 → max_holdが優先されるはず
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 20), [always_exit_entry("x")])
    assert paper_log["open"][0]["exit_reason"] == "max_hold"


def test_evaluate_exit_signal_when_no_other_condition():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[1000], close=[1000])
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos(deadline_date="2026-07-20"))
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 6), [always_exit_entry("x")])
    assert paper_log["open"][0]["exit_reason"] == "exit_signal"


def test_evaluate_no_condition_hit_stays_untouched():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[1000], close=[1000])
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos(deadline_date="2026-07-20"))
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 6), [no_exit_entry("x")])
    assert paper_log["open"][0]["pending_exit"] is False
    assert paper_log["open"][0]["exit_reason"] is None


def test_evaluate_skips_already_flagged_position():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[1000], close=[800])
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos(pending_exit=True, exit_reason="stop_loss"))
    # 既にフラグが立っているポジションは再評価しない（reasonが変わらないはず）
    pl.evaluate_open_positions(paper_log, {"C": df}, date(2026, 7, 6), [always_exit_entry("x")])
    assert paper_log["open"][0]["exit_reason"] == "stop_loss"


# ---------------------------------------------------------------------------
# fill_pending_exits: 前回フラグ済みのみ当日寄付で約定、今回フラグ分は翌回に回す
# ---------------------------------------------------------------------------

def test_fill_pending_exits_only_prior_run_flagged():
    idx = pd.bdate_range("2026-07-06", periods=1)
    df = make_df(idx, open_=[790])
    paper_log = pl.empty_paper_log()
    prior_flagged = _base_open_pos(id="prior", pending_exit=True, exit_reason="stop_loss")
    this_run_flagged = _base_open_pos(id="thisrun", pending_exit=True, exit_reason="stop_loss")
    paper_log["open"] = [prior_flagged, this_run_flagged]

    pl.fill_pending_exits(paper_log, {"C": df}, date(2026, 7, 6), {"prior"})

    remaining_ids = {p["id"] for p in paper_log["open"]}
    assert remaining_ids == {"thisrun"}
    assert len(paper_log["closed"]) == 1
    closed = paper_log["closed"][0]
    assert closed["id"] == "prior"
    assert closed["exit_price"] == 790.0
    assert closed["return_pct"] == pytest.approx((790.0 - 1000.0) / 1000.0 * 100, abs=1e-6)
    assert closed["exit_reason"] == "stop_loss"


def test_fill_pending_exits_missing_price_data_retries_next_run():
    paper_log = pl.empty_paper_log()
    pos = _base_open_pos(id="nodata", pending_exit=True, exit_reason="stop_loss")
    paper_log["open"] = [pos]
    pl.fill_pending_exits(paper_log, {}, date(2026, 7, 6), {"nodata"})
    assert len(paper_log["open"]) == 1  # データなしで持ち越し
    assert paper_log["closed"] == []


# ---------------------------------------------------------------------------
# add_new_pending: 同日再実行での重複排除
# ---------------------------------------------------------------------------

def test_add_new_pending_dedup_on_rerun():
    paper_log = pl.empty_paper_log()
    strategies_payload = [{
        "id": "mkt",
        "buy_candidates": [
            {"code": "7203", "name": "トヨタ", "close": 1000.0},
            {"code": "9984", "name": "SBG", "close": 5000.0, "limit_price": 4950.0},
        ],
    }]
    pl.add_new_pending(paper_log, strategies_payload, date(2026, 7, 10), date(2026, 7, 13))
    assert len(paper_log["pending"]) == 2

    # 同日ワークフロー再実行を模擬（同じ候補を再度追加しても増えない）
    pl.add_new_pending(paper_log, strategies_payload, date(2026, 7, 10), date(2026, 7, 13))
    assert len(paper_log["pending"]) == 2

    rec = next(p for p in paper_log["pending"] if p["code"] == "9984")
    assert rec["limit_price"] == 4950.0
    assert rec["trade_date"] == "2026-07-13"


def test_add_new_pending_skips_ids_already_open_or_closed():
    paper_log = pl.empty_paper_log()
    paper_log["open"].append(_base_open_pos(id="mkt_7203_2026-07-10"))
    strategies_payload = [{"id": "mkt", "buy_candidates": [{"code": "7203", "name": "T", "close": 1000.0}]}]
    pl.add_new_pending(paper_log, strategies_payload, date(2026, 7, 10), date(2026, 7, 13))
    assert paper_log["pending"] == []


# ---------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------

def test_summarize_empty():
    s = pl.summarize(pl.empty_paper_log())
    assert s == {"closed_trades": 0, "win_rate": None, "avg_ret": None, "by_strategy": {}}


def test_summarize_stats():
    paper_log = pl.empty_paper_log()
    paper_log["closed"] = [
        {"strategy_id": "a", "return_pct": 2.0},
        {"strategy_id": "a", "return_pct": -1.0},
        {"strategy_id": "b", "return_pct": 3.0},
    ]
    s = pl.summarize(paper_log)
    assert s["closed_trades"] == 3
    assert s["win_rate"] == pytest.approx(2 / 3, abs=1e-3)
    assert s["avg_ret"] == pytest.approx((2.0 - 1.0 + 3.0) / 3, abs=1e-2)
    assert s["by_strategy"]["a"]["closed_trades"] == 2
    assert s["by_strategy"]["a"]["win_rate"] == pytest.approx(0.5)
    assert s["by_strategy"]["b"]["win_rate"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# update_paper_log: pending -> open -> closed の一連の流れ（複数日シナリオ）
# ---------------------------------------------------------------------------

def test_update_paper_log_full_scenario(tmp_path):
    path = tmp_path / "paper_log.json"
    idx = pd.bdate_range("2026-07-06", periods=5)  # Mon..Fri
    # D1=07/06(entry signal) D2=07/07(fill@1000) D3=07/08(900) D4=07/09(800,stop flag)
    # D5=07/10(fill exit @790)
    opens = [999, 1000, 900, 800, 790]
    df = make_df(idx, open_=opens, close=opens)
    prices = {"7203": df}
    registry = [no_exit_entry("mkt")]  # take_profitなし・exitシグナルなし

    d1, d2, d3, d4, d5 = [d.date() for d in idx]

    # D1: 新規シグナル → pending追加
    payload_d1 = [{"id": "mkt", "buy_candidates": [{"code": "7203", "name": "トヨタ", "close": 999.0}]}]
    log, summary = pl.update_paper_log(prices, registry, payload_d1, d1, d2, path)
    assert len(log["pending"]) == 1
    assert log["open"] == []
    assert summary["closed_trades"] == 0

    # D2: 約定してopenへ
    log, _ = pl.update_paper_log(prices, registry, [{"id": "mkt", "buy_candidates": []}], d2, d3, path)
    assert log["pending"] == []
    assert len(log["open"]) == 1
    assert log["open"][0]["entry_price"] == 1000.0
    assert log["open"][0]["pending_exit"] is False

    # D3: まだ損切りに達しない
    log, _ = pl.update_paper_log(prices, registry, [{"id": "mkt", "buy_candidates": []}], d3, d4, path)
    assert log["open"][0]["pending_exit"] is False

    # D4: 終値800 <= stop_price(850) → フラグが立つがまだ決済しない
    log, _ = pl.update_paper_log(prices, registry, [{"id": "mkt", "buy_candidates": []}], d4, d5, path)
    assert len(log["open"]) == 1
    assert log["open"][0]["pending_exit"] is True
    assert log["open"][0]["exit_reason"] == "stop_loss"
    assert log["closed"] == []

    # D5: 前回フラグ分を寄付(790)で決済
    log, summary = pl.update_paper_log(prices, registry, [{"id": "mkt", "buy_candidates": []}], d5, d5, path)
    assert log["open"] == []
    assert len(log["closed"]) == 1
    closed = log["closed"][0]
    assert closed["entry_price"] == 1000.0
    assert closed["exit_price"] == 790.0
    assert closed["exit_reason"] == "stop_loss"
    assert closed["return_pct"] == pytest.approx(-21.0, abs=1e-6)
    assert summary["closed_trades"] == 1
    assert summary["win_rate"] == 0.0

    # ファイルに永続化されている（次回実行がload_paper_logから再開できる）
    reloaded = pl.load_paper_log(path)
    assert len(reloaded["closed"]) == 1
