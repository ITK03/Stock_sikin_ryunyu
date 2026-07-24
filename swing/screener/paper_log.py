"""検証ログ: 全シグナル自動ペーパートレード台帳。

「保有ポジション」タブ（ユーザーが手動登録する実際の保有）とは完全に別物。
毎回のスクリーナー実行（screener/run.py）で、両戦略が出した買いシグナルを
"仮想的に" 約定・保有・手仕舞いさせ、site/data/paper_log.json に
pending（未約定）→ open（保有中）→ closed（決済済み）として蓄積する。

執行ルールは backtest/engine.py の想定と同一にする（優先順位・指値約定判定）:
  - 新規建て: limit_price指定ありは翌営業日限りの指値、なしは翌営業日寄付成行。
    指値未達なら失効（持ち越さない）。
  - 手仕舞い判定（終値ベース、優先順位）: stop_loss > take_profit > max_hold > exit signal。
    条件成立した翌営業日の寄付で手仕舞う（当日には約定させない）。

このモジュールは以下の関数からなる小さなパイプラインで、それぞれ単体テスト可能:
  load_paper_log -> fill_pending_entries -> evaluate_open_positions
  -> fill_pending_exits -> add_new_pending -> summarize
update_paper_log() がこれらをこの順で呼び出し、ファイルへの読み書きを行う。
"""
from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from screener.bizdays import JST, next_business_day

VERSION = 1
STOP_LOSS_PCT = 0.15          # 建値-15%で損切り（registry.yamlの両戦略と一致）
MAX_HOLD_BUSINESS_DAYS = 10   # 最大保有営業日数（registry.yamlの両戦略と一致）


def empty_paper_log() -> dict:
    return {"version": VERSION, "updated_at": None, "pending": [], "open": [], "closed": []}


def load_paper_log(path: Path) -> dict:
    """既存の台帳を読み込む。存在しない・壊れている場合は空の台帳を返す。"""
    if not path.exists():
        return empty_paper_log()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return empty_paper_log()
    if not isinstance(data, dict):
        return empty_paper_log()
    data.setdefault("version", VERSION)
    data.setdefault("updated_at", None)
    data.setdefault("pending", [])
    data.setdefault("open", [])
    data.setdefault("closed", [])
    return data


def _row_at(df: pd.DataFrame | None, d_str: str) -> pd.Series | None:
    if df is None:
        return None
    ts = pd.Timestamp(d_str)
    if ts not in df.index:
        return None
    return df.loc[ts]


def _existing_ids(paper_log: dict) -> set:
    ids = set()
    for bucket in ("pending", "open", "closed"):
        for rec in paper_log.get(bucket, []):
            ids.add(rec["id"])
    return ids


def _business_days_between(start: date, end: date) -> int:
    """start(エントリー日)からend(データ日)までの営業日数。同日なら0。"""
    if end <= start:
        return 0
    count = 0
    d = start
    while d < end:
        d = next_business_day(d)
        count += 1
    return count


def fill_pending_entries(paper_log: dict, prices: dict, data_date: date,
                         registry) -> None:
    """未約定候補(pending)のうち trade_date <= data_date のものを約定判定する。

    backtest/engine.py の limit_entry と同じ判定（寄付 <= 指値ならギャップダウンで
    寄付約定、次に安値 <= 指値なら指値約定、いずれも不成立なら失効・破棄）。
    limit_price が無い（成行戦略の）候補は無条件でその日の寄付で約定する。
    """
    meta_by_id = {e.id: e.meta for e in registry}
    d_str = data_date.isoformat()
    kept = []
    for p in paper_log["pending"]:
        if p["trade_date"] > d_str:
            kept.append(p)  # まだ約定判定日に達していない
            continue
        row = _row_at(prices.get(p["code"]), p["trade_date"])
        if row is None:
            continue  # データなし（上場廃止・データ欠落等）→ 黙って失効
        open_px = float(row["open"])
        limit_price = p.get("limit_price")
        fill_px = None
        if limit_price is None:
            if open_px > 0:
                fill_px = open_px
        else:
            low_px = float(row["low"])
            if open_px <= limit_price:
                fill_px = open_px          # ギャップダウン→寄付で約定
            elif low_px <= limit_price:
                fill_px = limit_price       # ザラ場中に指値到達→指値で約定
            # else: 不約定。持ち越さず失効（枠は消費しない）
        if fill_px is None or fill_px <= 0:
            continue

        entry_date_str = p["trade_date"]
        meta = meta_by_id.get(p["strategy_id"], {})
        take_profit = (meta.get("engine") or {}).get("take_profit")
        stop_price = round(fill_px * (1.0 - STOP_LOSS_PCT), 2)
        target_price = round(fill_px * (1.0 + take_profit), 2) if take_profit else None

        d = date.fromisoformat(entry_date_str)
        for _ in range(MAX_HOLD_BUSINESS_DAYS):
            d = next_business_day(d)
        deadline_date_str = d.isoformat()

        paper_log["open"].append({
            "id": p["id"],
            "strategy_id": p["strategy_id"],
            "code": p["code"],
            "name": p.get("name", ""),
            "entry_date": entry_date_str,
            "entry_price": round(fill_px, 2),
            "stop_price": stop_price,
            "target_price": target_price,
            "deadline_date": deadline_date_str,
            "pending_exit": False,
            "exit_reason": None,
        })
    paper_log["pending"] = kept


def evaluate_open_positions(paper_log: dict, prices: dict, data_date: date,
                            registry) -> None:
    """保有中(open)ポジションの手仕舞い条件を data_date の終値で判定する。

    優先順位は backtest/engine.py と同一: stop_loss > take_profit > max_hold >
    exit signal。条件が成立したポジションは pending_exit=True・exit_reason を
    セットするのみ（このタイミングでは決済しない。翌営業日の寄付で
    fill_pending_exits が決済する）。
    """
    entry_by_id = {e.id: e for e in registry}
    d_str = data_date.isoformat()
    ts = pd.Timestamp(data_date)
    for pos in paper_log["open"]:
        if pos.get("pending_exit"):
            continue
        df = prices.get(pos["code"])
        row = _row_at(df, d_str)
        if row is None:
            continue  # データなし → 今回は判定見送り
        close = float(row["close"])
        reason = None
        if close <= pos["stop_price"]:
            reason = "stop_loss"
        elif pos.get("target_price") is not None and close >= pos["target_price"]:
            reason = "take_profit"
        elif d_str >= pos["deadline_date"]:
            reason = "max_hold"
        else:
            entry = entry_by_id.get(pos["strategy_id"])
            if entry is not None:
                df_upto = df.loc[:ts]  # ルックアヘッド防止（data_date以前のみ使用）
                if len(df_upto) and df_upto.index[-1] == ts:
                    sig = entry.fn(df_upto, **entry.meta.get("params", {}))
                    if len(sig) and bool(sig["exit"].iloc[-1]):
                        reason = "exit_signal"
        if reason:
            pos["pending_exit"] = True
            pos["exit_reason"] = reason


def fill_pending_exits(paper_log: dict, prices: dict, data_date: date,
                       prior_pending_exit_ids) -> None:
    """前回実行までにpending_exitが立っていたポジションを、当日(data_date)の
    寄付で決済しclosedへ移す。今回実行中に新規で立ったpending_exitは対象外
    （＝シグナル判定日の翌営業日寄付で執行、というルールを守るため）。
    """
    d_str = data_date.isoformat()
    remaining = []
    for pos in paper_log["open"]:
        if pos.get("pending_exit") and pos["id"] in prior_pending_exit_ids:
            row = _row_at(prices.get(pos["code"]), d_str)
            if row is not None and float(row["open"]) > 0:
                exit_price = round(float(row["open"]), 2)
                entry_price = pos["entry_price"]
                paper_log["closed"].append({
                    "id": pos["id"],
                    "strategy_id": pos["strategy_id"],
                    "code": pos["code"],
                    "name": pos.get("name", ""),
                    "entry_date": pos["entry_date"],
                    "entry_price": entry_price,
                    "exit_date": d_str,
                    "exit_price": exit_price,
                    "exit_reason": pos.get("exit_reason"),
                    "return_pct": round((exit_price - entry_price) / entry_price * 100, 2),
                    "hold_days": _business_days_between(
                        date.fromisoformat(pos["entry_date"]), data_date),
                })
                continue  # 決済済み。openから除外
            # データなし（売買停止等）→ 翌回に持ち越し
        remaining.append(pos)
    paper_log["open"] = remaining


def add_new_pending(paper_log: dict, strategies_payload, data_date: date,
                    trade_date: date) -> None:
    """今回計算した買い候補(buy_candidates)を新規pendingとして追加する。

    id（strategy_id + code + signal_date）で重複排除するため、同日に
    ワークフローを再実行しても二重登録されない。
    """
    existing = _existing_ids(paper_log)
    d_str = data_date.isoformat()
    t_str = trade_date.isoformat()
    for st in strategies_payload:
        sid = st.get("id")
        for c in st.get("buy_candidates", []):
            rec_id = f"{sid}_{c['code']}_{d_str}"
            if rec_id in existing:
                continue
            paper_log["pending"].append({
                "id": rec_id,
                "strategy_id": sid,
                "code": c["code"],
                "name": c.get("name", ""),
                "signal_date": d_str,
                "trade_date": t_str,
                "limit_price": c.get("limit_price"),
            })
            existing.add(rec_id)


def summarize(paper_log: dict) -> dict:
    """closedのみから集計した簡易サマリー（signals.jsonのpaper_log_summaryに使う）。"""
    closed = paper_log.get("closed", [])
    if not closed:
        return {"closed_trades": 0, "win_rate": None, "avg_ret": None, "by_strategy": {}}
    n = len(closed)
    wins = sum(1 for c in closed if c["return_pct"] > 0)
    avg_ret = sum(c["return_pct"] for c in closed) / n
    buckets: dict[str, dict] = {}
    for c in closed:
        b = buckets.setdefault(c["strategy_id"], {"closed_trades": 0, "wins": 0, "sum_ret": 0.0})
        b["closed_trades"] += 1
        if c["return_pct"] > 0:
            b["wins"] += 1
        b["sum_ret"] += c["return_pct"]
    by_strategy = {
        sid: {
            "closed_trades": b["closed_trades"],
            "win_rate": round(b["wins"] / b["closed_trades"], 4),
            "avg_ret": round(b["sum_ret"] / b["closed_trades"], 2),
        }
        for sid, b in buckets.items()
    }
    return {
        "closed_trades": n,
        "win_rate": round(wins / n, 4),
        "avg_ret": round(avg_ret, 2),
        "by_strategy": by_strategy,
    }


def update_paper_log(prices: dict, registry, strategies_payload, data_date: date,
                     trade_date: date, path: Path) -> tuple[dict, dict]:
    """台帳を1サイクル分更新し、site/data/paper_log.json に書き出す。

    戻り値は (更新後の台帳dict, summarize()の結果)。
    """
    paper_log = load_paper_log(path)
    # 「前回実行までに手仕舞いフラグが立っていたか」を、今回のevaluateで
    # 新たに立つフラグと区別するために先にスナップショットしておく。
    prior_pending_exit_ids = {
        pos["id"] for pos in paper_log["open"] if pos.get("pending_exit")
    }

    fill_pending_entries(paper_log, prices, data_date, registry)
    evaluate_open_positions(paper_log, prices, data_date, registry)
    fill_pending_exits(paper_log, prices, data_date, prior_pending_exit_ids)
    add_new_pending(paper_log, strategies_payload, data_date, trade_date)

    paper_log["updated_at"] = datetime.now(JST).isoformat(timespec="seconds")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(paper_log, ensure_ascii=False, indent=1), encoding="utf-8")

    return paper_log, summarize(paper_log)
