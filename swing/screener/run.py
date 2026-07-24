"""日次スクリーニングバッチ。

使い方:
  python -m screener.run --source fetch   # yfinanceから直近データ取得（Actions用）
  python -m screener.run --source cache   # data/jp_prices.csv.gz を使用（ローカル検証用）

出力（--out site 既定）:
  site/data/signals.json  … フロントとの契約データ（docs/screener_design.md §5.2）
  site/index.html         … 単体で開ける完全なHTML（template.htmlにJSONを注入）
  site/artifact.html      … Claude Artifact用フラグメント（doctype/head/bodyなし）
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path

import pandas as pd
import yaml

from backtest import data as data_mod
from backtest import strategies as strat_mod
from backtest.universe import load_universe, yf_tickers
from screener import paper_log as paper_log_mod
from screener.bizdays import JST, is_business_day, next_business_day, prev_business_day

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 1
LOOKBACK_CALENDAR_DAYS = 500  # SMA200 + バッファに十分な営業日を確保

# code -> 銘柄名。get_prices() 実行時にユニバースから設定する（テストでは空のまま）。
_NAMES: dict[str, str] = {}


@dataclass
class StrategyEntry:
    id: str
    fn: object
    meta: dict  # registry.yamlのエントリそのまま


def load_registry(path: Path) -> list[StrategyEntry]:
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries = []
    for item in cfg["strategies"]:
        if not item.get("enabled", False):
            continue
        fn = getattr(strat_mod, item["id"], None)
        if fn is None:
            raise ValueError(f"registry: 戦略関数が見つかりません: {item['id']}")
        entries.append(StrategyEntry(id=item["id"], fn=fn, meta=item))
    if not entries:
        raise ValueError("registry: 有効な戦略がありません")
    return entries


def drop_incomplete_bar(prices: dict[str, pd.DataFrame],
                        now_jst: datetime) -> tuple[dict[str, pd.DataFrame], int]:
    """ザラ場中（営業日15:40 JST前）の実行時、当日の未確定バーを全銘柄から除外する。

    yfinanceは場中に当日の部分バーを返すため、そのまま使うと不完全な
    OHLCでシグナルを計算してしまう。戻り値は (除外後dict, 除外行数)。
    """
    today = now_jst.date()
    if not (is_business_day(today) and now_jst.time() < dt_time(15, 40)):
        return prices, 0
    ts = pd.Timestamp(today)
    out, dropped = {}, 0
    for t, df in prices.items():
        if len(df) and df.index[-1] == ts:
            df = df.iloc[:-1]
            dropped += 1
        out[t] = df
    return out, dropped


def get_prices(source: str) -> dict[str, pd.DataFrame]:
    _NAMES.update(load_universe())  # 銘柄名解決用（JPX取得 or フォールバック）
    if source == "cache":
        return data_mod.load()
    start = (datetime.now(JST).date() - timedelta(days=LOOKBACK_CALENDAR_DAYS)).isoformat()
    raw = data_mod.fetch(yf_tickers(), start=start, out=None)
    prices = data_mod.frame_to_dict(raw, min_rows=250)
    prices, dropped = drop_incomplete_bar(prices, datetime.now(JST))
    if dropped:
        print(f"ザラ場中のため当日未確定バーを除外: {dropped}銘柄")
    return prices


def data_status(prices: dict[str, pd.DataFrame]) -> tuple[str, date, str]:
    """(status, data_date, reason) を返す。データ最終日はユニバースの最頻値。"""
    if len(prices) < 100:
        return "error", date.today(), f"銘柄数不足: {len(prices)}"
    last_dates = pd.Series([df.index[-1].date() for df in prices.values()])
    data_date = last_dates.mode().iloc[0]
    today = datetime.now(JST).date()
    # 直近の営業日（今日が営業日なら今日）よりデータが1営業日超古ければstale
    ref = prev_business_day(today)
    if data_date < prev_business_day(ref - timedelta(days=1)):
        return "stale", data_date, f"データが古い: {data_date}"
    return "ok", data_date, ""


def compute_strategy(prices: dict[str, pd.DataFrame], entry: StrategyEntry,
                     data_date: date) -> dict:
    meta = entry.meta
    rd = meta.get("rank_display", {"label": "rank", "sign": 1, "fmt": "{:.2f}"})
    engine = meta.get("engine", {}) or {}
    limit_entry = engine.get("limit_entry")
    candidates, universe_status = [], []
    ts = pd.Timestamp(data_date)

    for ticker, df in prices.items():
        if df.index[-1] != ts:      # データ最終日が揃わない銘柄は判定不能として除外
            continue
        sig = entry.fn(df, **meta.get("params", {}))
        last = sig.iloc[-1]
        close = float(df["close"].iloc[-1])
        rank = float(last["rank"])
        disp_val = rank * rd["sign"]
        rank_label = f"{rd['label']}={rd['fmt'].format(disp_val)}"
        row = {
            "code": ticker,
            "name": _NAMES.get(ticker, ticker),
            "close": round(close, 1),
            "entry": bool(last["entry"]),
            "exit": bool(last["exit"]),
            "rank_label": rank_label,
            "trend_ok": bool(close > df["close"].rolling(200).mean().iloc[-1])
            if len(df) >= 200 else False,
        }
        universe_status.append(row)
        if row["entry"]:
            cand = {
                "code": ticker, "name": row["name"], "close": row["close"],
                "rank_value": round(disp_val, 2), "rank_label": rank_label,
                "unit_cost": int(round(close * 100)), "_rank": rank,
            }
            if limit_entry is not None:
                cand["limit_price"] = round(close * (1 - limit_entry), 1)
            candidates.append(cand)

    candidates.sort(key=lambda c: c["_rank"], reverse=True)
    for i, c in enumerate(candidates[:10], start=1):
        c["priority"] = i
        del c["_rank"]
    candidates = candidates[:10]
    universe_status.sort(key=lambda r: r["code"])

    return {
        "id": entry.id,
        "display_name": meta["display_name"],
        "description": meta.get("description", ""),
        "oos_stats": meta.get("oos_stats", {}),
        "validated_at": meta.get("validated_at", ""),
        "rule_note": meta.get("rule_note", ""),
        "limit_entry": limit_entry,
        # 手仕舞いルールの数値（保有ポジションの「今後どうするか」判定にフロントが使う）。
        # take_profit=+利確率, stop_loss=災害ストップ率, max_hold=最大保有営業日。
        "exit_rules": {
            "take_profit": engine.get("take_profit"),
            "stop_loss": engine.get("stop_loss"),
            "max_hold": engine.get("max_hold"),
        },
        "risks": meta.get("risks", []),
        "buy_candidates": candidates,
        "universe_status": universe_status,
    }


def future_business_days(data_date: date, n: int = 15) -> list[str]:
    """data_date翌営業日からn日分の営業日ISO文字列リストを返す（保有ポジションの
    期限表示・カレンダー用。祝日はjpholidayが使えれば考慮、なければ土日のみ）。"""
    out = []
    d = data_date
    for _ in range(n):
        d = next_business_day(d)
        out.append(d.isoformat())
    return out


def build_json(prices, registry: list[StrategyEntry],
               paper_log_path: Path | None = None) -> dict:
    status, data_date, reason = data_status(prices)
    trade_date = next_business_day(data_date)
    payload = {
        "version": SCHEMA_VERSION,
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "data_date": data_date.isoformat(),
        "trade_date": trade_date.isoformat(),
        "status": status,
        "status_reason": reason,
        "universe_count": len(prices),
        "strategies": [compute_strategy(prices, e, data_date) for e in registry],
        "calendar": {"future_business_days": future_business_days(data_date)},
    }
    # 検証ログ（全シグナル自動ペーパートレード）: paper_log_pathが指定された場合のみ
    # site/data/paper_log.json を読み書きする。既存テストはNone既定で副作用なし。
    if status != "error" and paper_log_path is not None:
        _, summary = paper_log_mod.update_paper_log(
            prices, registry, payload["strategies"], data_date, trade_date, paper_log_path)
        payload["paper_log_summary"] = summary
    return payload


HTML_HEAD = ('<!doctype html><html lang="ja"><head><meta charset="utf-8">'
             '<meta name="viewport" content="width=device-width,initial-scale=1">'
             '<title>日本株スイングスクリーナー</title></head><body>')
PLACEHOLDER = "/*__SIGNALS_JSON__*/null"


def render_site(payload: dict, site_dir: Path) -> None:
    template = (site_dir / "template.html").read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        raise ValueError("template.html: プレースホルダが見つかりません")
    # </script> 早期終了を防ぐエスケープ
    blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    fragment = template.replace(PLACEHOLDER, blob, 1)
    # Artifact用: タブ表示名のため<title>を先頭に付与（本文には描画されない）
    artifact_doc = "<title>日本株スイングスクリーナー</title>" + fragment
    (site_dir / "artifact.html").write_text(artifact_doc, encoding="utf-8")
    # 公開URL v2（旧artifact URLの配信不良により切替え。site/jp-screener.html が正）
    (site_dir / "jp-screener.html").write_text(artifact_doc, encoding="utf-8")
    (site_dir / "index.html").write_text(HTML_HEAD + fragment + "</body></html>",
                                         encoding="utf-8")
    data_dir = site_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "signals.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["fetch", "cache"], default="fetch")
    ap.add_argument("--out", default="site")
    args = ap.parse_args()

    registry = load_registry(ROOT / "screener" / "registry.yaml")
    prices = get_prices(args.source)
    out_dir = ROOT / args.out
    payload = build_json(prices, registry, paper_log_path=out_dir / "data" / "paper_log.json")
    if payload["status"] == "error":
        print(f"ERROR: {payload['status_reason']}", file=sys.stderr)
        return 1
    render_site(payload, out_dir)
    n = sum(len(s["buy_candidates"]) for s in payload["strategies"])
    print(f"status={payload['status']} data_date={payload['data_date']} "
          f"trade_date={payload['trade_date']} candidates={n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
