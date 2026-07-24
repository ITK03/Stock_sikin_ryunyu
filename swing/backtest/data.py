"""価格データの取得とキャッシュ。

yfinance で調整済み日足OHLCVを取得し、1本のcsv.gz
(columns: date,ticker,open,high,low,close,volume) に保存する。
ネットワーク制限のある環境では GitHub Actions 上で --fetch を実行し、
生成された data/jp_prices.csv.gz をコミットして持ち帰る運用を想定。
"""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "jp_prices.csv.gz"
START_DATE = "2015-01-01"


def fetch(tickers: list[str], start: str = START_DATE,
          out: Path | None = CACHE_PATH, chunk: int = 100) -> pd.DataFrame:
    """outにNoneを渡すと保存せずDataFrameのみ返す（スクリーナーの日次取得用）。

    プライム全銘柄(約1,600)を捌くため、chunk銘柄ずつ一括ダウンロードする。
    yfinanceは複数銘柄を渡すと列がMultiIndex(ticker, field)になる。
    """
    import yfinance as yf

    cols = ["open", "high", "low", "close", "volume"]
    frames = []
    failed = []
    total = len(tickers)
    for i in range(0, total, chunk):
        batch = tickers[i:i + chunk]
        data = None
        for attempt in range(3):
            try:
                data = yf.download(batch, start=start, auto_adjust=True,
                                   progress=False, group_by="ticker",
                                   threads=True)
                break
            except Exception:
                time.sleep(2 * (attempt + 1))
                data = None
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
            if not set(cols).issubset(df.columns):
                failed.append(t)
                continue
            df = df[cols].dropna(how="all")
            if df.empty:
                failed.append(t)
                continue
            df.index.name = "date"
            df = df.reset_index()
            df["ticker"] = t.replace(".T", "")
            frames.append(df)
        time.sleep(1.0)  # レートリミット対策（チャンク間）
        print(f"fetched {min(i + chunk, total)}/{total}")
    if failed:
        print(f"WARNING: {len(failed)} failed tickers (先頭20件): {failed[:20]}")
    if not frames:
        raise RuntimeError("no data fetched")
    all_df = pd.concat(frames, ignore_index=True)
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        all_df.to_csv(out, index=False, compression="gzip")
        print(f"saved {len(all_df)} rows for {all_df['ticker'].nunique()} tickers -> {out}")
    return all_df


def frame_to_dict(raw: pd.DataFrame, min_rows: int = 300) -> dict[str, pd.DataFrame]:
    """縦持ちDataFrameを ticker -> OHLCV DataFrame(date index, 昇順) の辞書へ。"""
    out: dict[str, pd.DataFrame] = {}
    for ticker, g in raw.groupby("ticker"):
        g = g.set_index("date").sort_index()[["open", "high", "low", "close", "volume"]]
        g = g[~g.index.duplicated(keep="last")].dropna(subset=["close"])
        # 出来高ゼロ（特別気配等）の日はエントリー判定から外れるが行は残す
        if len(g) >= min_rows:
            out[ticker] = g
    return out


def load(path: Path = CACHE_PATH) -> dict[str, pd.DataFrame]:
    """キャッシュを読み、ticker -> OHLCV DataFrame(date index, 昇順) の辞書を返す。"""
    raw = pd.read_csv(path, dtype={"ticker": str}, parse_dates=["date"])
    return frame_to_dict(raw)
