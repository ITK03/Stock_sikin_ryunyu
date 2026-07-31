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
from valuation.guidance import guidance_block
from valuation.profile import build_profile
from valuation.sources.tdnet import fetch_summary
from valuation.sources.yf import fetch_quarterly, fetch_records

ROOT = Path(__file__).resolve().parent.parent
# 自己レンジを10年取るための株価履歴。営業日換算で約2500日。
PRICE_LOOKBACK_DAYS = 3800
INDEX_FILE = "index.json"

# 配信中の開示フィード。決算短信の文書IDをここから引く。
DISCLOSURES_URL = ("https://raw.githubusercontent.com/ITK03/Stock_sikin_ryunyu/"
                   "data-disclosures/disclosures.json")


def latest_earnings_docs(url: str = DISCLOSURES_URL) -> dict[str, tuple[str, str]]:
    """開示フィードから {銘柄コード: (文書ID, 開示時刻)} を作る。

    決算短信の公表日はここで確定する。yfinance で使っている「期末+45日」の
    推定と違い、これは市場が実際に知った日そのもの。
    """
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310
            feed = json.loads(resp.read())
    except Exception as exc:           # noqa: BLE001 - 開示が取れなくても続行
        print(f"WARNING: 開示フィードを取得できません: {exc}")
        return {}
    out: dict[str, tuple[str, str]] = {}
    for it in feed.get("items", []):
        if it.get("category") != "決算" or it.get("is_correction"):
            continue
        code, doc_id, t = it.get("code"), it.get("id"), it.get("time") or ""
        if not code or not doc_id:
            continue
        # 同じ銘柄が複数あれば新しいほうを採用
        if code not in out or t > out[code][1]:
            out[code] = (doc_id, t)
    return out


def load_existing(out_dir: Path, code: str) -> dict | None:
    """既に配信済みのプロファイル。会社予想を引き継ぐために読む。"""
    p = out_dir / f"{code}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def resolve_guidance(code: str, docs: dict[str, tuple[str, str]],
                     previous: dict | None, shares: float | None) -> dict | None:
    """会社予想を決める。新しい短信があれば取り直し、無ければ前回のを引き継ぐ。

    開示フィードは直近1ヶ月ぶんしか無いため、毎回取り直す方式だと決算期以外は
    会社予想が消えてしまう。抽出済みのものは保持し、より新しい短信が出たときだけ
    更新する(これが point-in-time の蓄積になる)。
    """
    prev = (previous or {}).get("guidance")
    doc = docs.get(code)
    if doc is None:
        return prev
    doc_id, disclosed_at = doc
    # 同じ短信を何度も取りに行かない
    if prev and prev.get("doc_id") == doc_id:
        return prev
    summary = fetch_summary(doc_id)
    if summary is None:
        return prev
    block = guidance_block(summary, disclosed_at[:10], shares=shares)
    if block is None:
        return prev
    block["doc_id"] = doc_id
    return block


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


def build_one(code: str, name: str, prices: pd.Series,
              docs: dict[str, tuple[str, str]] | None = None,
              previous: dict | None = None) -> dict | None:
    ticker = f"{code}.T"
    records = fetch_records(ticker)
    if not records:
        return None
    # 四半期は取れなくても年次だけで成立させる(取得失敗で銘柄ごと落とさない)
    profile = build_profile(code, name, prices, records,
                            quarterly=fetch_quarterly(ticker))
    guidance = resolve_guidance(code, docs or {}, previous, records[-1].shares)
    profile["guidance"] = guidance
    if guidance is None:
        profile["cov"]["missing"].append("guidance")
    return profile


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

    docs = latest_earnings_docs()
    print(f"開示フィードの決算短信: {len(docs)}銘柄")

    ok = skipped = with_guidance = 0
    for code in batch:
        df = prices.get(code)
        if df is None or df.empty:
            skipped += 1
            continue
        profile = build_one(code, names.get(code, code), df["close"],
                            docs, load_existing(out_dir, code))
        if profile is not None and profile.get("guidance"):
            with_guidance += 1
        if profile is None:
            skipped += 1
            continue
        (out_dir / f"{code}.json").write_text(
            json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        ok += 1

    market_index(universe, out_dir)
    total = len(list(out_dir.glob("*.json"))) - 1
    print(f"生成 {ok}件 / 失敗 {skipped}件 / 会社予想あり {with_guidance}件 "
          f"/ 累計 {total}銘柄")
    return 0


if __name__ == "__main__":
    sys.exit(main())
