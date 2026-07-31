"""プロファイルを一定件数ずつ生成するバッチ。

全1526銘柄を毎回作り直すと yfinance への財務リクエストが1銘柄1回必要で
現実的な実行時間に収まらない。ファンダメンタルズは四半期単位でしか変わらない
ので、1回あたり一定件数だけ更新して数日で一巡させる(ローリング)。

優先順位は「実際に見たくなる銘柄」から。資金流入上位・スイング候補・直近の
決算開示に出た銘柄を先に埋め、残りを古い順に回す。

使い方:
  python -m valuation.build --limit 150 --out ../public/data/valuation
  python -m valuation.build --codes 7203,6758 --out /tmp/v   # 指定銘柄だけ
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from backtest import data as data_mod
from backtest.universe import load_universe_all, yf_tickers_all
from screener.bizdays import JST
from valuation.profile import build_profile
from valuation.sources.yf import fetch_records

ROOT = Path(__file__).resolve().parent.parent
# 自己レンジを10年取るための株価履歴。営業日換算で約2500日。
PRICE_LOOKBACK_DAYS = 3800
INDEX_FILE = "index.json"


def load_index(out_dir: Path) -> dict[str, str]:
    """既に生成済みのプロファイルの {コード: as_of} を返す。"""
    p = out_dir / INDEX_FILE
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("as_of", {})
    except (OSError, ValueError):
        return {}


def select_batch(universe: list[str], done: dict[str, str], limit: int,
                 priority: list[str] | None = None) -> list[str]:
    """今回更新する銘柄を選ぶ。

    1. 未生成の銘柄(優先リストにあるものを先に)
    2. 生成済みのうち as_of が古いもの

    優先リストは「実際に開かれる可能性が高い銘柄」を先に埋めるためのもの。
    全銘柄が揃うまでの間、見たい銘柄が未取得である確率を下げる。
    """
    priority = [c for c in (priority or []) if c in set(universe)]
    seen: set[str] = set()
    ordered: list[str] = []

    def push(codes):
        for c in codes:
            if c not in seen:
                seen.add(c)
                ordered.append(c)

    push([c for c in priority if c not in done])          # 未生成かつ優先
    push([c for c in universe if c not in done])          # 未生成
    push(sorted((c for c in universe if c in done),       # 生成済みは古い順
                key=lambda c: done[c]))
    return ordered[:limit]


def market_index(codes: list[str], out_dir: Path) -> None:
    """index.json を書き出す。フロントは未取得銘柄をこれで判別する。"""
    as_of: dict[str, str] = {}
    for p in sorted(out_dir.glob("*.json")):
        if p.name == INDEX_FILE:
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("as_of"):
            as_of[d["code"]] = d["as_of"]
    (out_dir / INDEX_FILE).write_text(json.dumps({
        "v": 1,
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "count": len(as_of),
        "as_of": as_of,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build_one(code: str, name: str, prices: pd.Series) -> dict | None:
    records = fetch_records(f"{code}.T")
    if not records:
        return None
    return build_profile(code, name, prices, records)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=150)
    ap.add_argument("--codes", default="", help="カンマ区切りで銘柄を指定(検証用)")
    ap.add_argument("--priority", default="", help="優先する銘柄コード(カンマ区切り)")
    ap.add_argument("--out", default="../public/data/valuation")
    args = ap.parse_args(argv)

    out_dir = (ROOT / args.out).resolve() if not Path(args.out).is_absolute() \
        else Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    names = load_universe_all()
    universe = sorted(names)
    if args.codes:
        batch = [c.strip() for c in args.codes.split(",") if c.strip() in names]
    else:
        batch = select_batch(universe, load_index(out_dir), args.limit,
                             [c.strip() for c in args.priority.split(",") if c.strip()])
    if not batch:
        print("対象銘柄なし")
        return 0
    print(f"対象 {len(batch)}銘柄 / ユニバース {len(universe)}銘柄")

    start = (datetime.now(JST).date() - timedelta(days=PRICE_LOOKBACK_DAYS)).isoformat()
    raw = data_mod.fetch([f"{c}.T" for c in batch], start=start, out=None)
    prices = data_mod.frame_to_dict(raw, min_rows=250)

    ok = skipped = 0
    for code in batch:
        df = prices.get(code)
        if df is None or df.empty:
            skipped += 1
            continue
        profile = build_one(code, names.get(code, code), df["close"])
        if profile is None:
            skipped += 1
            continue
        (out_dir / f"{code}.json").write_text(
            json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        ok += 1

    market_index(universe, out_dir)
    total = len(list(out_dir.glob("*.json"))) - 1
    print(f"生成 {ok}件 / 失敗 {skipped}件 / 累計 {total}銘柄")
    return 0


if __name__ == "__main__":
    sys.exit(main())
