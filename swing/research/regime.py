"""大相場(継続的な大幅上昇局面)の検知。

仮説(運用者の着想):
  「売買代金が時価総額に対して多く、かつ売買代金ランキングでも上位にいる銘柄は
    大相場が続いている」

これはダッシュボードの ③全市場上位 ランキングそのもの。本モジュールはこれを
検証可能な形にし、「大相場をどれだけ早く検知できるか」を測る。

## 既存の検証との違い

これまでの検証(research/flow.py)は銘柄ごとに独立した時系列指標だけを扱っていた。
一方「売買代金ランキング上位」は**銘柄横断**の情報であり、全銘柄を同じ日付軸に
並べた行列が要る。本モジュールが扱うのはそこ。

また評価するホライズンも違う。押し目買いは1〜10営業日だが、大相場は数ヶ月。
「急増×上昇は5日先では勝率5割割れ」(FINDINGS.md)という結論は短期の話であり、
数ヶ月スパンで同じとは限らないため、ここで改めて測る。

## 発行済株式数を使わない理由

時価総額比 = 売買代金/時価総額 = 出来高/発行済株式数(回転率)。過去に遡る
point-in-time な株式数は持てない(分割・増資で変わり、現在値を過去に当てると
先読みになる)ため、2条件をそれぞれ株数不要な形に置き換える:

  (a) 時価総額に対して売買代金が多い → その銘柄の平常時に対する売買代金倍率
      (rel_turnover)。同一銘柄では株数がほぼ一定なので回転率と単調に対応する
  (b) 売買代金ランキング上位      → 全市場での売買代金順位(turnover_rank)

(b)は素直に計算でき、(a)は自己正規化なのでどちらも株数に依存しない。
三菱UFJのような大型株は(b)を常に満たすので、(a)が発火して初めて検知される。
テラドローンのような小型株は(b)に上がってくること自体がシグナルになる。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# 大相場の既定定義。運用者が挙げた実例(太陽誘電・フジクラ・キオクシア等)の
# 値動きから逆算して調整する前提の初期値。
DEFAULT_HORIZON = 120        # 先読み期間(営業日)。約半年
# 実例から逆算した閾値。三菱UFJ(+63.5%)を対象外にしたことで下限が
# 東京電力の+152%になり、閾値を上げられるようになった。+100%(2倍)なら
# 残る10銘柄すべてを捕捉しつつ、小幅な上昇をノイズとして除外できる。
DEFAULT_MIN_GAIN = 1.00      # この期間で+100%(2倍)以上
DEFAULT_MAX_DD = 0.25        # 途中の最大下落が-25%以内(急騰即急落を除く)

# 「売買代金ランキング上位」の既定閾値。ダッシュボード③の topK=100 に合わせる。
DEFAULT_TOP_K = 100
# 平常時に対する売買代金倍率のしきい値。
DEFAULT_REL_TH = 1.5
# 連続何日その状態が続いたら「継続」とみなすか。
DEFAULT_PERSIST_DAYS = 3


def build_panels(prices: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """銘柄横断の行列(日付 × 銘柄)を作る。

    戻り値の各要素は同じ index(全営業日) / columns(全銘柄):
      close    … 終値
      turnover … 売買代金
      rel      … 売買代金 / その銘柄の過去60日中央値(平常時比)
      rank     … その日の全市場売買代金順位(1が最大)
    """
    close = pd.DataFrame({t: df["close"] for t, df in prices.items()}).sort_index()
    volume = pd.DataFrame({t: df["volume"] for t, df in prices.items()}).reindex_like(close)
    turnover = (close * volume).astype("float32")

    # 平常時比: 自分の過去60日中央値に対する倍率(株数不要の回転率プロキシ)
    med = turnover.rolling(60, min_periods=40).median()
    rel = (turnover / med.replace(0.0, np.nan)).astype("float32")

    # 全市場での売買代金順位。その日に取引がない銘柄は NaN のまま順位を付けない。
    rank = turnover.rank(axis=1, ascending=False, method="min").astype("float32")

    # --- 精度を上げるための価格側の確認材料 ---
    # 大相場は「安値圏でだらだら」ではなく「高値圏で出来高を伴って」始まることが
    # 多い、という前提を検証可能にする。いずれも当日終値までの情報のみ。
    sma200 = close.rolling(200, min_periods=150).mean()
    trend_up = close > sma200
    high252 = close.rolling(252, min_periods=120).max()
    near_high = (close / high252).astype("float32")   # 1.0 = 年初来高値

    # 売買代金順位が「以前より上がってきた」か(資金が集まり始めたか)。
    # 大型株は常に上位なのでこれ単独では発火せず、順位の改善幅が効く。
    rank_prev = rank.shift(60)

    return {"close": close, "turnover": turnover, "rel": rel, "rank": rank,
            "trend_up": trend_up, "near_high": near_high, "rank_prev": rank_prev}


def label_major_moves(close: pd.DataFrame, horizon: int = DEFAULT_HORIZON,
                      min_gain: float = DEFAULT_MIN_GAIN,
                      max_dd: float = DEFAULT_MAX_DD) -> pd.DataFrame:
    """各銘柄・各日について「ここから大相場が始まるか」を判定する。

    条件: 今後 horizon 営業日で最大 min_gain 以上上昇し、かつ高値を付けるまでの
    途中経過で max_dd を超える下落がない(＝上昇が持続している)。

    「最大到達点」で測るのは、大相場の途中で降りてもよいため。終点だけで測ると
    急騰後に戻した銘柄を取りこぼす。
    """
    arr = close.to_numpy(dtype=np.float32)
    n, m = arr.shape
    label = np.zeros((n, m), dtype=bool)
    gain = np.full((n, m), np.nan, dtype=np.float32)

    for i in range(n - horizon):
        base = arr[i]
        window = arr[i + 1:i + 1 + horizon]           # (horizon, m)
        with np.errstate(invalid="ignore", divide="ignore"):
            rel_path = window / base                   # 基準日からの倍率
            cols = np.arange(m)
            peak_idx = np.nanargmax(np.where(np.isnan(rel_path), -np.inf, rel_path), axis=0)
            peak = rel_path[peak_idx, cols]
            # 高値到達までの最大ドローダウン(基準日比で一度どこまで下げたか)。
            # 累積最小を先に取っておけば、高値到達時点の値を1回のindexingで拾える。
            # 銘柄ごとにPythonループを回すと (営業日数 × 銘柄数) 回になり、
            # 全市場3,900銘柄では実行時間が現実的でなくなる。
            running_min = np.fmin.accumulate(rel_path, axis=0)
            trough = running_min[peak_idx, cols]
            ok = (peak - 1.0 >= min_gain) & (trough - 1.0 >= -max_dd)
        label[i] = np.where(np.isnan(peak), False, ok)
        gain[i] = peak - 1.0

    return pd.DataFrame(label, index=close.index, columns=close.columns), \
        pd.DataFrame(gain, index=close.index, columns=close.columns)


def detect(panels: dict[str, pd.DataFrame], top_k: int = DEFAULT_TOP_K,
           rel_th: float = DEFAULT_REL_TH,
           persist_days: int = DEFAULT_PERSIST_DAYS) -> pd.DataFrame:
    """運用者の仮説そのままの検知: 売買代金ランキング上位 かつ 平常時比が高い。

    persist_days 日連続で条件を満たした日を検知日とする(1日だけの飛び値を除く)。
    """
    cond = (panels["rank"] <= top_k) & (panels["rel"] >= rel_th)
    if persist_days <= 1:
        return cond.fillna(False)
    # 直近 persist_days 日すべてで成立
    sustained = cond.fillna(False).rolling(persist_days).sum() >= persist_days
    return sustained.fillna(False)


def detect_advanced(panels: dict[str, pd.DataFrame], top_k: int = DEFAULT_TOP_K,
                    rel_th: float = DEFAULT_REL_TH,
                    persist_days: int = DEFAULT_PERSIST_DAYS,
                    require_trend: bool = False,
                    near_high_th: float | None = None,
                    rank_improve_from: int | None = None) -> pd.DataFrame:
    """基本条件(ランキング上位×平常時比)に、価格側の確認を足した検知。

    精度を上げるための追加条件(いずれも任意):
      require_trend      … 終値がSMA200より上(長期トレンドが生きている)
      near_high_th       … 終値が年初来高値の near_high_th 倍以上(高値圏)
      rank_improve_from  … 60営業日前の売買代金順位がこれより下だった
                           (＝順位を大きく上げてきた＝資金が集まり始めた)

    再現率は落ちるが、運用者は「雰囲気を掴みながら」使うためノイズを減らし
    精度を優先する方針。
    """
    cond = (panels["rank"] <= top_k) & (panels["rel"] >= rel_th)
    if require_trend:
        cond &= panels["trend_up"].fillna(False)
    if near_high_th is not None:
        cond &= (panels["near_high"] >= near_high_th).fillna(False)
    if rank_improve_from is not None:
        cond &= (panels["rank_prev"] > rank_improve_from).fillna(False)
    cond = cond.fillna(False)
    if persist_days <= 1:
        return cond
    return (cond.rolling(persist_days).sum() >= persist_days).fillna(False)


def latest_detections(panels: dict[str, pd.DataFrame], sig: pd.DataFrame,
                      names: dict[str, str] | None = None,
                      within_days: int = 60) -> list[dict]:
    """直近 within_days 営業日に新規検知された銘柄を監視リストとして返す。

    運用者が日々眺めるための実用出力。エピソード先頭(新規に条件を満たした日)
    だけを出し、大相場中に毎日出続けないようにする。
    """
    if sig.empty:
        return []
    cutoff = sig.index[max(0, len(sig) - within_days)]
    rows = []
    for ticker, date in first_signals(sig):
        if date < cutoff:
            continue
        close = panels["close"][ticker]
        px = float(close.loc[date])
        after = close.loc[date:]
        def _v(key):
            x = panels[key].at[date, ticker]
            return float(x) if np.isfinite(x) else None
        rows.append({
            "code": ticker,
            "name": (names or {}).get(ticker, ticker),
            "検知日": str(date.date()),
            "検知時株価": round(px, 1),
            "現在値": round(float(after.iloc[-1]), 1) if len(after) else None,
            "検知後": round(float(after.iloc[-1] / px - 1.0), 3) if len(after) and px else None,
            "売買代金順位": int(_v("rank")) if _v("rank") is not None else None,
            "平常時比": round(_v("rel"), 2) if _v("rel") is not None else None,
            "年初来高値比": round(_v("near_high"), 3) if _v("near_high") is not None else None,
        })
    rows.sort(key=lambda r: r["検知日"], reverse=True)
    return rows


def first_signals(sig: pd.DataFrame, cooldown: int = 120) -> list[tuple[str, pd.Timestamp]]:
    """連続する検知をまとめ、各エピソードの最初の日だけを返す。

    大相場中は条件を満たし続けるため、そのまま数えると1回の相場が何十回にも
    なってしまう。cooldown 営業日以内の再検知は同じエピソードとみなす。
    """
    out = []
    for ticker in sig.columns:
        s = sig[ticker]
        idx = np.flatnonzero(s.to_numpy())
        last = -10**9
        for i in idx:
            if i - last > cooldown:
                out.append((ticker, s.index[i]))
            last = i
    return out


def evaluate(panels: dict[str, pd.DataFrame], sig: pd.DataFrame, label: pd.DataFrame,
             gain: pd.DataFrame, horizon: int = DEFAULT_HORIZON,
             period: tuple[str, str] | None = None) -> dict:
    """検知の的中率と、母集団の基準率(base rate)を比較する。

    検知した日から先 horizon 日で大相場条件を満たしたか、をそのまま的中とする。
    基準率(何もせずランダムに選んだ場合)より高くなければ検知に価値はない。
    """
    episodes = first_signals(sig)
    lo = pd.Timestamp(period[0]) if period else None
    hi = pd.Timestamp(period[1]) if period else None
    hits, gains = 0, []
    kept = 0
    for ticker, date in episodes:
        if lo is not None and not (lo <= date <= hi):
            continue
        if ticker not in label.columns or date not in label.index:
            continue
        kept += 1
        if bool(label.at[date, ticker]):
            hits += 1
        g = gain.at[date, ticker]
        if np.isfinite(g):
            gains.append(float(g))

    # 基準率: 検知の有無を問わず、全銘柄日のうち大相場開始だった割合。
    # 検知の的中率はこれと比べて初めて意味を持つ(同じ期間で比較する)。
    valid = label.iloc[:-horizon] if len(label) > horizon else label
    if lo is not None:
        valid = valid.loc[(valid.index >= lo) & (valid.index <= hi)]
    base_rate = float(valid.to_numpy().mean()) if valid.size else float("nan")

    n = kept
    return {
        "episodes": n,
        "hit_rate": hits / n if n else float("nan"),
        "base_rate": base_rate,
        "lift": (hits / n / base_rate) if n and base_rate > 0 else float("nan"),
        "avg_forward_gain": float(np.mean(gains)) if gains else float("nan"),
        "median_forward_gain": float(np.median(gains)) if gains else float("nan"),
    }


def lead_time_analysis(panels: dict[str, pd.DataFrame], sig: pd.DataFrame,
                       label: pd.DataFrame, horizon: int = DEFAULT_HORIZON) -> dict:
    """「どれだけ早く」検知できたかを測る。

    各銘柄について、大相場開始日(labelが立った最初の日)と検知日の差を取る。
    負(検知が先)なら早期検知、正なら出遅れ。あわせて「検知時点で相場の何%が
    まだ残っていたか」を出す ― 早さの実質的な意味はここにある。
    """
    diffs, remaining = [], []
    dates = label.index
    pos = {d: i for i, d in enumerate(dates)}

    for ticker in label.columns:
        lab = label[ticker].to_numpy()
        starts = np.flatnonzero(lab)
        if starts.size == 0:
            continue
        # 大相場エピソードの開始(連続する開始日の先頭)
        episode_starts = [starts[0]]
        for a, b in zip(starts, starts[1:]):
            if b - a > horizon:
                episode_starts.append(b)

        s = sig[ticker].to_numpy() if ticker in sig.columns else np.zeros(len(dates), bool)
        det = np.flatnonzero(s)
        close = panels["close"][ticker].to_numpy(dtype=float)

        for st in episode_starts:
            # その相場の開始前後で最初に出た検知
            after = det[(det >= st - horizon) & (det <= st + horizon)]
            if after.size == 0:
                continue
            d = int(after[0])
            diffs.append(d - st)
            end = min(st + horizon, len(close) - 1)
            peak = np.nanmax(close[st:end + 1])
            if np.isfinite(close[d]) and close[d] > 0 and np.isfinite(peak):
                remaining.append(peak / close[d] - 1.0)

    return {
        "matched_episodes": len(diffs),
        "median_lead_days": float(np.median(diffs)) if diffs else float("nan"),
        "pct_detected_before_or_at_start": (
            float(np.mean([d <= 0 for d in diffs])) if diffs else float("nan")),
        "median_remaining_gain": float(np.median(remaining)) if remaining else float("nan"),
    }


def named_example_report(panels: dict[str, pd.DataFrame], sig: pd.DataFrame,
                         examples: dict[str, str],
                         since: str = "2023-01-01") -> list[dict]:
    """運用者が挙げた実例について、検知がいつ出たかと実際の値動きを並べる。

    検証の妥当性は最終的にここで確かめる。統計が良くても実例で反応しなければ
    使えないし、逆に実例で早く反応していれば納得感がある。
    """
    rows = []
    close = panels["close"]
    for code, name in examples.items():
        if code not in close.columns:
            rows.append({"code": code, "name": name, "status": "ユニバース外/データなし"})
            continue
        c = close[code].loc[since:]
        c = c.dropna()
        if c.empty:
            rows.append({"code": code, "name": name, "status": "期間内データなし"})
            continue
        s = sig[code].loc[c.index] if code in sig.columns else pd.Series(False, index=c.index)
        det = c.index[s.to_numpy()]

        # 「安値→高値」は安値が高値より前にある区間で測る。単純に期間全体の
        # min/max を取ると、高値のあとに安値が来た銘柄(東電など)で
        # 実際には取れない上昇率を出してしまう。
        arr = c.to_numpy(dtype=float)
        run_min = np.minimum.accumulate(arr)
        ratio = arr / run_min
        hi = int(np.argmax(ratio))
        lo = int(np.argmin(arr[:hi + 1]))
        row = {
            "code": code, "name": name, "status": "ok",
            "安値日": str(c.index[lo].date()), "安値": round(float(arr[lo]), 1),
            "高値日": str(c.index[hi].date()), "高値": round(float(arr[hi]), 1),
            "安値→高値": round(float(arr[hi] / arr[lo] - 1.0), 3),
            "検知回数": int(s.sum()),
        }
        if len(det):
            first = det[0]
            px = float(c.loc[first])
            after = c.loc[first:]
            row["初回検知日"] = str(first.date())
            row["検知時株価"] = round(px, 1)
            # 検知から一定期間だけ保有した場合の成績。全期間の最高値までの伸びは
            # 数年保有・途中の暴落を無視した数字になるため、実運用に近い形も併記する。
            for h, tag in ((60, "60日"), (120, "120日")):
                seg = after.iloc[:h + 1]
                if len(seg) > 1:
                    row[f"検知後{tag}最大"] = round(float(seg.max() / px - 1.0), 3)
                    row[f"検知後{tag}終値"] = round(float(seg.iloc[-1] / px - 1.0), 3)
            # 検知後に一度どこまで下げたか(耐えられるかどうかの目安)
            if len(after) > 1:
                row["検知後の最大下落"] = round(float(after.min() / px - 1.0), 3)
                row["検知後の最高値まで"] = round(float(after.max() / px - 1.0), 3)
        else:
            row["初回検知日"] = "—"
        rows.append(row)
    return rows
