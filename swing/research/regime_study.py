"""大相場検知の検証スクリプト。

運用者の仮説「売買代金が時価総額に対して多く、かつ売買代金ランキング上位の銘柄は
大相場が続いている」を、全市場ユニバースで検証する。

構成:
  Part 1 実例プロファイル … 運用者が挙げた11銘柄が実際どう動いたかを測り、
         「大相場」の定義(上昇率・期間)を実例から逆算する
  Part 2 検知性能        … 的中率を母集団の基準率と比較する。基準率を超えなければ
         「ランキング上位を見る」ことに情報価値はない
  Part 3 早期性          … 大相場の開始からどれだけ早く検知できたか、検知時点で
         相場の何%が残っていたか
  Part 4 閾値の感応度    … topK・平常時比・継続日数を振って安定性を見る
  Part 5 実例での検知    … 11銘柄それぞれで、いつ検知が出たか

使い方:
  python -m research.regime_study --source full-all   # 全市場キャッシュ
  python -m research.regime_study --source synth      # 合成データ(配線確認用)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from research.regime import (DEFAULT_HORIZON, DEFAULT_MAX_DD, DEFAULT_MIN_GAIN,
                             build_panels, detect, evaluate, label_major_moves,
                             lead_time_analysis, named_example_report)

ROOT = Path(__file__).resolve().parent.parent

# 運用者が「大相場だった」と挙げた実例。検知の妥当性はここで確かめる。
# コードは東証。テラドローン(278A)・キオクシア(285A)は2024年以降の新規上場。
NAMED_EXAMPLES = {
    "6976": "太陽誘電",
    "6981": "村田製作所",
    "278A": "テラドローン",
    "6227": "AIメカテック",
    "6525": "KOKUSAI ELECTRIC",
    "5801": "古河電気工業",
    "5803": "フジクラ",
    "285A": "キオクシア",
    "6324": "ハーモニック・ドライブ・システムズ",
    "9501": "東京電力HD",
    "8306": "三菱UFJフィナンシャル・グループ",
}

# 期間分割。閾値をこの前半で見て、後半で確かめる(グリッドから最良を選ぶ行為が
# 後知恵にならないようにするため)。
IS_PERIOD = ("1900-01-01", "2021-12-31")
OOS_PERIOD = ("2022-01-01", "2100-01-01")

# 閾値の感応度を見るグリッド。
TOP_K_GRID = (50, 100, 200)
REL_GRID = (1.2, 1.5, 2.0)
PERSIST_GRID = (1, 3, 5)


def load_prices(source: str) -> dict[str, pd.DataFrame]:
    if source == "full-all":
        from backtest.data_full import load_full
        return load_full(Path(__file__).resolve().parent.parent / "data" / "full_all")
    if source == "full":
        from backtest.data_full import load_full
        return load_full()
    if source == "synth":
        return _synth()
    raise ValueError(source)


def _synth(n_tickers: int = 200, n_days: int = 1200, seed: int = 11):
    """配線確認用。一部の銘柄に「出来高増を伴う大相場」を埋め込む。"""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2021-01-01", periods=n_days)
    out = {}
    for i in range(n_tickers):
        ret = rng.normal(0.0002, 0.018, n_days)
        vol = rng.lognormal(13.0 + (i % 5) * 0.6, 0.4, n_days)
        if i % 20 == 0:  # 5%の銘柄で大相場を起こす
            st = rng.integers(200, n_days - 300)
            ret[st:st + 120] += 0.006          # 半年で約2倍
            vol[st:st + 120] *= 4.0            # 出来高も増える
        close = 500 * np.cumprod(1 + ret)
        out[f"{1000+i}"] = pd.DataFrame(
            {"open": close, "high": close * 1.01, "low": close * 0.99,
             "close": close, "volume": vol}, index=idx)
    return out


def profile_examples(panels: dict[str, pd.DataFrame], horizon: int) -> list[dict]:
    """実例が実際どれだけ上げたかを測り、大相場の定義を逆算する材料にする。"""
    close = panels["close"]
    rows = []
    for code, name in NAMED_EXAMPLES.items():
        if code not in close.columns:
            rows.append({"code": code, "name": name, "status": "ユニバース外"})
            continue
        c = close[code].dropna()
        if len(c) < horizon + 20:
            rows.append({"code": code, "name": name, "status": f"データ不足({len(c)}日)"})
            continue
        # 各日から horizon 日先までの最大上昇率。その最大値がこの銘柄の「最大の相場」
        arr = c.to_numpy(dtype=float)
        best, best_i = 0.0, 0
        for i in range(len(arr) - horizon):
            peak = np.nanmax(arr[i + 1:i + 1 + horizon])
            g = peak / arr[i] - 1.0
            if g > best:
                best, best_i = g, i
        rows.append({
            "code": code, "name": name, "status": "ok",
            "最大上昇率": round(best, 3),
            "起点日": str(c.index[best_i].date()),
            "起点株価": round(float(arr[best_i]), 1),
            "データ期間": f"{c.index[0].date()}〜{c.index[-1].date()}",
        })
    return rows


def sensitivity(panels, label, gain, horizon) -> list[dict]:
    """閾値グリッドをIS/OOS両方で評価する。

    ISだけ見て最良を選ぶと後知恵になるため、両期間を並べて「ISで良い設定が
    OOSでも良いか」を確認できる形にする。
    """
    rows = []
    for k in TOP_K_GRID:
        for rel in REL_GRID:
            for persist in PERSIST_GRID:
                sig = detect(panels, top_k=k, rel_th=rel, persist_days=persist)
                is_m = evaluate(panels, sig, label, gain, horizon, IS_PERIOD)
                oos_m = evaluate(panels, sig, label, gain, horizon, OOS_PERIOD)
                rows.append({"top_k": k, "rel_th": rel, "persist": persist,
                             "IS": is_m, "OOS": oos_m})
    return rows


def _f(v):
    if isinstance(v, (np.floating, float)):
        v = float(v)
        return None if not np.isfinite(v) else round(v, 5)
    if isinstance(v, (np.integer, int)):
        return int(v)
    return v


def _pct(v, d=1):
    return "—" if v is None or (isinstance(v, float) and not np.isfinite(v)) else f"{v*100:.{d}f}%"


def _lift_text(m: dict) -> str:
    v = m.get("lift")
    return "—" if v is None or not np.isfinite(v) else f"{v:.2f}倍"


def _baseline_row(tag: str, b: dict) -> str:
    return (f"| {tag} | {b['episodes']:,} | **{_pct(b['hit_rate'])}** | "
            f"{_pct(b['base_rate'], 2)} | **{_lift_text(b)}** | "
            f"{_pct(b['avg_forward_gain'])} |")


def write_report(out_dir: Path, meta, profiles, base, sens, lead, named):
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"meta": meta, "example_profiles": profiles, "baseline": base,
               "sensitivity": sens, "lead_time": lead, "named_detection": named}
    (out_dir / "regime_report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1, default=_f), encoding="utf-8")

    md = [
        "# 大相場検知の検証レポート",
        "",
        f"- ユニバース: {meta['tickers']}銘柄(全市場) / {meta['start']}〜{meta['end']}",
        f"- 大相場の定義: {meta['horizon']}営業日で最大 +{meta['min_gain']*100:.0f}% 以上、"
        f"かつ高値到達までの下落が -{meta['max_dd']*100:.0f}% 以内",
        f"- 検知条件: 売買代金ランキング {meta['top_k']}位以内 かつ 平常時比 "
        f"{meta['rel_th']}倍以上 が {meta['persist']}日continuous",
        "",
        "## Part 1: 挙げていただいた実例のプロファイル",
        "",
        "「大相場」の定義を実例から逆算するための計測。各銘柄について、"
        f"任意の起点から{meta['horizon']}営業日先までの最大上昇率を全期間で探した最大値。",
        "",
        "| コード | 銘柄 | 最大上昇率 | 起点日 | 起点株価 | 状態 |",
        "|---|---|---:|---|---:|---|",
    ]
    for r in profiles:
        if r.get("status") != "ok":
            md.append(f"| {r['code']} | {r['name']} | — | — | — | {r['status']} |")
        else:
            md.append(f"| {r['code']} | {r['name']} | **{_pct(r['最大上昇率'])}** | "
                      f"{r['起点日']} | {r['起点株価']:,} | ok |")

    md += [
        "",
        "## Part 2: 検知性能(基準率との比較)",
        "",
        "**基準率を超えなければ「ランキング上位を見る」ことに情報価値はない。**",
        "",
        "| 期間 | 検知数 | 的中率 | 基準率 | リフト | 平均最大上昇率 |",
        "|---|---:|---:|---:|---:|---:|",
        *[_baseline_row(tag, b) for tag, b in base.items()],
        "",
        "リフトが1倍を大きく超えていなければ、条件を満たす銘柄を選ぶ意味はない。",
        "",
        "## Part 3: 早期性",
        "",
        f"- 大相場と対応づいた検知: {lead['matched_episodes']:,}件",
        f"- 検知の遅速(中央値): **{lead['median_lead_days']:+.0f}営業日**"
        if lead.get("median_lead_days") is not None else "- 検知の遅速: —",
        f"  (負なら相場開始より前に検知、正なら出遅れ)",
        f"- 相場開始時点までに検知できた割合: {_pct(lead['pct_detected_before_or_at_start'])}",
        f"- **検知時点で残っていた上昇率(中央値): {_pct(lead['median_remaining_gain'])}**",
        "  ← 早期性の実質的な意味。検知してから取れる分がどれだけあったか",
        "",
        "## Part 4: 閾値の感応度",
        "",
        "ISで良く見える設定がOOSでも良いかを確認する。片方でしか良くない設定は採らない。",
        "",
        "| topK | 平常時比 | 継続日 | IS検知数 | IS的中率 | ISリフト | OOS検知数 | OOS的中率 | OOSリフト |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    def _lift_key(x):
        v = x["OOS"].get("lift")
        return -v if v is not None and np.isfinite(v) else 0.0
    for r in sorted(sens, key=_lift_key):
        i, o = r["IS"], r["OOS"]
        md.append(f"| {r['top_k']} | {r['rel_th']} | {r['persist']} | "
                  f"{i['episodes']:,} | {_pct(i['hit_rate'])} | {_lift_text(i)} | "
                  f"{o['episodes']:,} | {_pct(o['hit_rate'])} | {_lift_text(o)} |")

    md += [
        "",
        "## Part 5: 実例での検知タイミング",
        "",
        "統計が良くても実例で反応しなければ使えない。逆に実例で早く反応していれば納得感がある。",
        "",
        "| コード | 銘柄 | 安値日 | 高値日 | 安値→高値 | 初回検知日 | 検知時株価 | 検知後の伸び |",
        "|---|---|---|---|---:|---|---:|---:|",
    ]
    for r in named:
        if r.get("status") != "ok":
            md.append(f"| {r['code']} | {r['name']} | — | — | — | {r.get('status','')} | — | — |")
            continue
        md.append(
            f"| {r['code']} | {r['name']} | {r['期間内安値日']} | {r['期間内高値日']} | "
            f"{_pct(r['安値→高値'])} | {r.get('初回検知日','—')} | "
            f"{r.get('検知時株価','—')} | {_pct(r.get('検知後の伸び'))} |")

    md += ["", "## 前提と限界", "",
           "- ユニバースは現在の上場銘柄。過去に上場廃止された銘柄を含まないため、"
           "大相場の頻度・上昇率とも上方バイアスがある",
           "- 「大相場」は事後的な価格条件で定義した便宜的なラベルであり、"
           "市場で合意された定義があるわけではない",
           "- 検知は当日終値時点の情報のみで計算している(先読みなし)。"
           "ただし売買代金ランキングはその日の全銘柄が確定して初めて決まるため、"
           "実運用では引け後の算出になる",
           ""]
    (out_dir / "REGIME_REPORT.md").write_text("\n".join(md), encoding="utf-8")
    print(f"レポート出力: {out_dir}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["full-all", "full", "synth"], default="full-all")
    ap.add_argument("--out", default="research/results")
    ap.add_argument("--horizon", type=int, default=DEFAULT_HORIZON)
    ap.add_argument("--min-gain", type=float, default=DEFAULT_MIN_GAIN)
    ap.add_argument("--top-k", type=int, default=100)
    ap.add_argument("--rel-th", type=float, default=1.5)
    ap.add_argument("--persist", type=int, default=3)
    args = ap.parse_args()

    print(f"価格データ読み込み: {args.source}")
    prices = load_prices(args.source)
    print(f"  {len(prices)}銘柄")

    print("銘柄横断パネル構築…")
    panels = build_panels(prices)
    print(f"  {panels['close'].shape[0]}営業日 × {panels['close'].shape[1]}銘柄")

    print("大相場ラベル付け…")
    label, gain = label_major_moves(panels["close"], args.horizon,
                                    args.min_gain, DEFAULT_MAX_DD)
    print(f"  大相場開始と判定された銘柄日: {int(label.to_numpy().sum()):,}")

    print("Part 1: 実例プロファイル…")
    profiles = profile_examples(panels, args.horizon)

    print("Part 2/3: 検知性能・早期性…")
    sig = detect(panels, args.top_k, args.rel_th, args.persist)
    base = {"ALL": evaluate(panels, sig, label, gain, args.horizon),
            "IS": evaluate(panels, sig, label, gain, args.horizon, IS_PERIOD),
            "OOS": evaluate(panels, sig, label, gain, args.horizon, OOS_PERIOD)}
    lead = lead_time_analysis(panels, sig, label, args.horizon)

    print("Part 4: 閾値の感応度…")
    sens = sensitivity(panels, label, gain, args.horizon)

    print("Part 5: 実例での検知…")
    named = named_example_report(panels, sig, NAMED_EXAMPLES)

    meta = {
        "tickers": len(prices),
        "start": str(panels["close"].index[0].date()),
        "end": str(panels["close"].index[-1].date()),
        "horizon": args.horizon, "min_gain": args.min_gain, "max_dd": DEFAULT_MAX_DD,
        "top_k": args.top_k, "rel_th": args.rel_th, "persist": args.persist,
    }
    write_report(ROOT / args.out, meta, profiles, base, sens, lead, named)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
