"""公開済みより古いデータで上書きしないためのガード。

yfinance は同じ銘柄でも取得タイミングによって最終営業日ぶんを返したり返さなかったり
する。実際に 2026-07-30 の実行では

    19:25 JST  status=ok    data_date=2026-07-30   ← 正しい
    00:11 JST  status=stale data_date=2026-07-29   ← 前日ぶんしか取れなかった

となり、後者が前者を force-push で上書きしたため、公開データが1営業日巻き戻った。
スクリーナー自体は冪等でも「毎回そのまま公開する」と退行しうる、という穴だった。

そこで公開前に、生成した data_date が公開済みのものより古くないかを確認する。
古ければ公開を見送り、次回の実行に任せる(スケジュールは1日3回あるため、
一度見送っても最新データが取れ次第すぐ公開される)。

使い方:
    python swing/screener/publish_guard.py <生成したsignals.json> [<公開中のsignals.json>]
    終了コード 0 = 公開してよい / 1 = 見送る
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def read_data_date(path: str | Path) -> str | None:
    """signals.json から data_date を読む。読めなければ None。"""
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f).get("data_date")
    except (OSError, ValueError):
        return None
    return v if isinstance(v, str) and v else None


def should_publish(new_date: str | None, published_date: str | None) -> bool:
    """公開してよいか。

    - 公開済みが読めない(初回・壊れている)なら公開する。
    - 生成側の data_date が読めないのは異常なので公開しない。
    - 同日なら公開する(値の訂正や generated_at の更新を反映するため)。
    - 生成側が古い場合だけ見送る。ISO形式(YYYY-MM-DD)なので文字列比較で日付順になる。
    """
    if not new_date:
        return False
    if not published_date:
        return True
    return new_date >= published_date


def main(argv: list[str]) -> int:
    if not 2 <= len(argv) <= 3:
        print(__doc__, file=sys.stderr)
        return 2
    new_date = read_data_date(argv[1])
    published_date = read_data_date(argv[2]) if len(argv) == 3 else None

    if should_publish(new_date, published_date):
        print(f"公開します: data_date={new_date} (公開中={published_date or 'なし'})")
        return 0
    print(f"公開を見送ります: 生成 data_date={new_date} が公開中 {published_date} より古い")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
