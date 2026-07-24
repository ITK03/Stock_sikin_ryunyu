"""拡大ユニバース（東証プライム全銘柄、最大約1,531銘柄）向けの価格キャッシュ
I/Oモジュール（新規追加ファイル）。

**既存の backtest/data.py（fetch/load/frame_to_dict、CACHE_PATH=
data/jp_prices.csv.gz）は一切変更しない。** screener/run.py・backtest/run.py が
使う日次スクリーナーの本番パスはそのまま `data/jp_prices.csv.gz` +
`backtest.data.load()` を使い続ける。本モジュールはそれとは完全に独立した
並行キャッシュ `data/full/year=YYYY.parquet` を提供する（読み込みも書き込みも
別ディレクトリ・別関数であり、既存の呼び出し元の挙動には一切影響しない）。

ストレージ設計は research/round4/universe_plan.md のPart D設計を実装したもの:
  - parquet形式（zstd圧縮、OHLCV列はfloat32）
  - 年ごとに1ファイルへ分割（`data/full/year=2015.parquet` 等）
    -> 1,531銘柄 x 11.5年でも1ファイルあたり約9MBの見込みで、GitHubの
       単一ファイル100MB上限を大きく下回る。
  - 過去年ファイルは一度確定したら不変。日次更新（--backfillなし）では
    当年ファイルのみ再取得・上書きする。

使い方:
  python -m backtest.data_full              # 当年分のみ増分更新
  python -m backtest.data_full --backfill    # 2015年〜の全期間を再取得（初回用）
  python -m backtest.data_full --backfill --shard 0/4   # ユニバースを4分割し
                                               # 0番目のシャードのみ取得
                                               # （レート制限対策で複数回に分割
                                               # 実行する場合用）
"""
from __future__ import annotations

import argparse
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .data import START_DATE, frame_to_dict

FULL_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "full"
DEFAULT_CHUNK = 50        # 既存data.fetch()の既定100より小さく（レート制限対策）
DEFAULT_SLEEP = 2.0       # 既存data.fetch()の既定1.0秒より長く（レート制限対策）
DEFAULT_RETRIES = 3
OHLCV_COLS = ["open", "high", "low", "close", "volume"]


def _current_year() -> int:
    return datetime.now(timezone.utc).year


def _download_chunk(batch: list[str], start: str, retries: int = DEFAULT_RETRIES):
    """yfinanceから1チャンク分をダウンロードする。失敗時は指数バックオフで再試行。"""
    import yfinance as yf

    for attempt in range(retries):
        try:
            data = yf.download(batch, start=start, auto_adjust=True, progress=False,
                                group_by="ticker", threads=True)
            if data is not None and not data.empty:
                return data
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2 * (attempt + 1))
    return None


def fetch_full(tickers: list[str], start: str = START_DATE,
                out_dir: Path = FULL_CACHE_DIR, chunk: int = DEFAULT_CHUNK,
                sleep_between: float = DEFAULT_SLEEP,
                shard: tuple[int, int] | None = None,
                backfill: bool = False) -> pd.DataFrame:
    """拡大ユニバースの日次OHLCVをyfinanceから取得し、年ごとのparquetへ保存する。

    Args:
        tickers: yfinance形式のティッカー一覧（例: "7203.T"）。
        start: 取得開始日（backfill=Falseのときは当年1/1に自動的に切り上げる）。
        out_dir: 保存先ディレクトリ（既定 data/full/）。
        chunk: 1回のyf.downloadで取得する銘柄数（既定50、レート制限対策で
            既存data.fetch()の100より保守的）。
        sleep_between: チャンク間の待機秒数（既定2.0秒、既存data.fetch()の
            1.0秒より保守的）。
        shard: (k, m) を渡すとティッカーをソートしてインデックス%m==kのものだけ
            取得する。1回の実行でレート制限に引っかかった場合に、ワークフローを
            複数回に分けて段階的にユニバース全体をバックフィルするためのもの。
        backfill: Trueなら`start`からの全期間を再取得し、対象年の全parquotを
            上書きする（初回バックフィル用）。Falseなら当年分のみ再取得し、
            当年ファイルのみ上書きする（日次/週次の増分更新用、過去年ファイルは
            不変のまま温存 — API呼び出しを最小化する）。

    Returns:
        取得した縦持ちDataFrame（date, ticker, open, high, low, close, volume）。
    """
    all_tickers = sorted(set(tickers))
    if shard is not None:
        k, m = shard
        if not (0 <= k < m):
            raise ValueError(f"shard must satisfy 0<=k<m, got {shard}")
        all_tickers = [t for i, t in enumerate(all_tickers) if i % m == k]

    if not backfill:
        # 増分更新モード: 当年分のみ取得（過去分は既存の年別parquetを信頼する）
        this_year_start = f"{_current_year()}-01-01"
        start = max(start, this_year_start)

    frames: list[pd.DataFrame] = []
    failed: list[str] = []
    total = len(all_tickers)
    for i in range(0, total, chunk):
        batch = all_tickers[i:i + chunk]
        data = _download_chunk(batch, start)
        if data is None or data.empty:
            failed.extend(batch)
            continue
        for t in batch:
            try:
                df = data[t] if len(batch) > 1 else data
            except KeyError:
                failed.append(t)
                continue
            df = df.rename(columns=str.lower)
            if not set(OHLCV_COLS).issubset(df.columns):
                failed.append(t)
                continue
            df = df[OHLCV_COLS].dropna(how="all")
            if df.empty:
                failed.append(t)
                continue
            df.index.name = "date"
            df = df.reset_index()
            df["ticker"] = t.replace(".T", "")
            frames.append(df)
        time.sleep(sleep_between)
        print(f"[data_full] fetched {min(i + chunk, total)}/{total}")

    if failed:
        print(f"[data_full] WARNING: {len(failed)} failed tickers (先頭20件): {failed[:20]}")
    if not frames:
        raise RuntimeError("data_full.fetch_full: no data fetched")

    all_df = pd.concat(frames, ignore_index=True)
    overwrite_years = None if backfill else {_current_year()}
    write_year_parquet(all_df, out_dir, overwrite_years=overwrite_years)
    print(f"[data_full] saved {len(all_df)} rows for {all_df['ticker'].nunique()} tickers -> {out_dir}")
    return all_df


def write_year_parquet(df: pd.DataFrame, out_dir: Path,
                        overwrite_years: set[int] | None = None) -> list[Path]:
    """縦持ちDataFrame(date,ticker,open,high,low,close,volume)を年ごとに分割し、
    parquet(zstd圧縮, OHLCV列はfloat32)で保存する。

    overwrite_years=None なら df に含まれる全年のファイルを（存在すれば）上書き。
    overwrite_years={year,...} が指定されていれば、その年のファイルのみ書き込み、
    それ以外の年は（dfに含まれていても）スキップする
    （日次更新で当年ファイルだけ差し替え、過去年ファイルを不変のまま保つため）。

    Returns: 実際に書き込んだファイルパスのリスト。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    for c in OHLCV_COLS:
        df[c] = df[c].astype("float32")
    df["ticker"] = df["ticker"].astype(str)

    written: list[Path] = []
    for year, g in df.groupby(df["date"].dt.year):
        year = int(year)
        if overwrite_years is not None and year not in overwrite_years:
            continue
        path = out_dir / f"year={year}.parquet"
        g = g.sort_values(["ticker", "date"]).reset_index(drop=True)
        g.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
        written.append(path)
        print(f"[data_full] wrote {path} ({len(g)} rows)")
    return written


def load_full(path: Path = FULL_CACHE_DIR, min_rows: int = 300) -> dict[str, pd.DataFrame]:
    """data/full/year=*.parquet を読み込み、backtest.data.load() と同じ形の
    ticker -> OHLCV DataFrame(date index, 昇順, open/high/low/close/volume列) の
    辞書を返す（frame_to_dictを再利用するため呼び出し側の期待するshapeは同一）。
    """
    files = sorted(Path(path).glob("year=*.parquet"))
    if not files:
        raise FileNotFoundError(f"data_full.load_full: no parquet files found under {path}")
    frames = [pd.read_parquet(f) for f in files]
    raw = pd.concat(frames, ignore_index=True)
    raw["ticker"] = raw["ticker"].astype(str)
    raw["date"] = pd.to_datetime(raw["date"])
    return frame_to_dict(raw, min_rows=min_rows)


def main() -> None:
    from .universe import yf_tickers

    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true",
                    help="2015年〜の全期間を再取得し、対象年ファイルを全て上書きする（初回用）")
    ap.add_argument("--shard", default=None,
                    help="N/M形式でユニバースをmodulo分割して実行する（例: 0/4）")
    ap.add_argument("--chunk", type=int, default=DEFAULT_CHUNK)
    ap.add_argument("--sleep", type=float, default=DEFAULT_SLEEP)
    ap.add_argument("--out", default=str(FULL_CACHE_DIR))
    args = ap.parse_args()

    shard = None
    if args.shard:
        k_str, m_str = args.shard.split("/")
        shard = (int(k_str), int(m_str))

    tickers = yf_tickers()
    print(f"[data_full] universe size: {len(tickers)} tickers, "
          f"backfill={args.backfill}, shard={shard}, chunk={args.chunk}, sleep={args.sleep}")
    fetch_full(tickers, out_dir=Path(args.out), chunk=args.chunk,
               sleep_between=args.sleep, shard=shard, backfill=args.backfill)


if __name__ == "__main__":
    main()
