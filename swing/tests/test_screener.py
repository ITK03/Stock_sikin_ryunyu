import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from screener import run as sr

ROOT = Path(__file__).resolve().parent.parent


def make_prices(n=260, last="2026-07-10", up=True):
    idx = pd.bdate_range(end=last, periods=n)
    rng = np.random.default_rng(0)
    drift = 0.001 if up else -0.001
    close = 1000 * np.exp(np.cumsum(rng.normal(drift, 0.01, n)))
    df = pd.DataFrame({
        "open": close, "high": close * 1.01, "low": close * 0.99,
        "close": close, "volume": [2_000_000.0] * n,
    }, index=idx)
    return df


def test_load_registry_resolves_functions():
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    assert entries and all(callable(e.fn) for e in entries)
    assert entries[0].id == "rsi2_dip"


def test_load_registry_unknown_id(tmp_path):
    bad = tmp_path / "r.yaml"
    bad.write_text("strategies:\n  - id: no_such_fn\n    enabled: true\n"
                   "    display_name: x\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no_such_fn"):
        sr.load_registry(bad)


def test_business_days():
    # 2026-07-10は金曜。翌営業日は月曜(7/13)
    assert sr.next_business_day(date(2026, 7, 10)) == date(2026, 7, 13)
    jp = pytest.importorskip("jpholiday")
    # 2026-07-20 海の日(月) → 金曜7/17の翌営業日は7/21(火)
    assert sr.next_business_day(date(2026, 7, 17)) == date(2026, 7, 21)


def test_compute_strategy_ordering_and_cap():
    """entry銘柄がrank降順でpriority付けされ、10件で切られる。"""
    prices = {f"90{i:02d}": make_prices() for i in range(12)}
    ranks = {t: float(i) for i, t in enumerate(sorted(prices))}

    def fake_fn(df, **kw):
        s = pd.DataFrame(index=df.index)
        s["entry"] = False
        s["exit"] = False
        # tickerはclose値からは分からないのでrankはmeta経由で外から差し込む
        s["rank"] = fake_fn.current_rank
        s.loc[s.index[-1], "entry"] = True
        return s

    entry = sr.StrategyEntry(id="fake", fn=None, meta={
        "display_name": "t", "params": {},
        "rank_display": {"label": "R", "sign": 1, "fmt": "{:.1f}"},
    })

    def dispatch(df, **kw):
        return fake_fn(df, **kw)
    entry.fn = dispatch

    # 各ticker毎にrankを変えるため逐次実行
    results = []
    data_date = date(2026, 7, 10)
    # compute_strategyはprices全体を回すので、rankをticker依存にする細工:
    class FnWrap:
        def __call__(self, df, **kw):
            key = round(float(df["close"].iloc[0]), 6)
            fake_fn.current_rank = self.rank_by_close[key]
            return fake_fn(df, **kw)
    wrap = FnWrap()
    wrap.rank_by_close = {round(float(df["close"].iloc[0]), 6): ranks[t]
                          for t, df in prices.items()}
    entry.fn = wrap

    out = sr.compute_strategy(prices, entry, data_date)
    cands = out["buy_candidates"]
    assert len(cands) == 10  # 12件中10件で切る
    got_ranks = [c["rank_value"] for c in cands]
    assert got_ranks == sorted(got_ranks, reverse=True)
    assert [c["priority"] for c in cands] == list(range(1, 11))
    assert all("_rank" not in c for c in cands)


def test_build_json_schema_and_trade_date():
    prices = {f"91{i:02d}": make_prices() for i in range(101)}
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    payload = sr.build_json(prices, entries)
    for key in ("version", "generated_at", "data_date", "trade_date",
                "status", "universe_count", "strategies"):
        assert key in payload
    assert payload["data_date"] == "2026-07-10"
    assert payload["trade_date"] == "2026-07-13"  # 金→月
    s = payload["strategies"][0]
    for key in ("id", "display_name", "oos_stats", "buy_candidates",
                "universe_status"):
        assert key in s
    assert len(s["universe_status"]) == 101


def test_future_business_days_starts_after_data_date_and_skips_weekends():
    # 2026-07-10は金曜。翌営業日から15件、土日を挟んで連続していること。
    days = sr.future_business_days(date(2026, 7, 10), n=15)
    assert len(days) == 15
    assert days[0] == "2026-07-13"  # 月
    assert all(sr.is_business_day(date.fromisoformat(d)) for d in days)
    assert days == sorted(days)  # 昇順・重複なし


def test_build_json_includes_calendar():
    prices = {f"91{i:02d}": make_prices() for i in range(101)}
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    payload = sr.build_json(prices, entries)
    assert "calendar" in payload
    fbd = payload["calendar"]["future_business_days"]
    assert len(fbd) == 15
    assert fbd[0] == payload["trade_date"]


def test_load_registry_lineup():
    """掲載ラインナップ。

    v3最終決定の2戦略(rsi2_dip / keltner_atr_dip)に、資金フロー検証
    (research/FINDINGS.md)を経て rsi2_flow を追加した3戦略構成。
    """
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    ids = [e.id for e in entries]
    assert ids == ["rsi2_dip", "keltner_atr_dip", "rsi2_flow"]
    rsi2_meta = entries[0].meta
    assert rsi2_meta["engine"]["take_profit"] == pytest.approx(0.02)
    assert rsi2_meta["engine"]["limit_entry"] == pytest.approx(0.01)
    assert rsi2_meta["risks"]  # 非空リスト
    keltner_meta = entries[1].meta
    assert keltner_meta["engine"]["take_profit"] == pytest.approx(0.02)
    assert "limit_entry" not in keltner_meta["engine"]  # 成行戦略
    assert keltner_meta["risks"]
    flow_meta = entries[2].meta
    assert flow_meta["params"]["surge_th"] == pytest.approx(1.2)
    assert flow_meta["engine"]["limit_entry"] == pytest.approx(0.01)  # 指値戦略
    assert flow_meta["risks"]


def _dip_price_series(n=260, last="2026-07-10"):
    """最終日にRSI(2)<15かつ終値>SMA200を満たす合成系列（rsi2_dipのentry用）。"""
    idx = pd.bdate_range(end=last, periods=n)
    close = np.empty(n)
    close[0] = 1000.0
    for i in range(1, n - 1):
        close[i] = close[i - 1] * 1.003
    close[-1] = close[-2] * 0.90  # 最終日に急落してRSI(2)を急低下させる
    return pd.DataFrame({
        "open": close, "high": close * 1.01, "low": close * 0.99,
        "close": close, "volume": [2_000_000.0] * n,
    }, index=idx)


def test_compute_strategy_includes_limit_price_for_limit_entry_strategy():
    """T4: limit_entryを持つ戦略の買い候補にlimit_priceが入り、成行戦略には入らない。"""
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    rsi2_entry = next(e for e in entries if e.id == "rsi2_dip")
    keltner_entry = next(e for e in entries if e.id == "keltner_atr_dip")
    prices = {"9999": _dip_price_series()}
    data_date = date(2026, 7, 10)

    rsi2_out = sr.compute_strategy(prices, rsi2_entry, data_date)
    assert rsi2_out["limit_entry"] == pytest.approx(0.01)
    assert len(rsi2_out["buy_candidates"]) == 1
    cand = rsi2_out["buy_candidates"][0]
    close = cand["close"]
    assert cand["limit_price"] == round(close * (1 - 0.01), 1)
    assert rsi2_out["risks"]

    keltner_out = sr.compute_strategy(prices, keltner_entry, data_date)
    assert keltner_out["limit_entry"] is None
    for c in keltner_out["buy_candidates"]:
        assert "limit_price" not in c


def test_build_json_error_on_few_tickers():
    prices = {"9000": make_prices()}
    entries = sr.load_registry(ROOT / "screener" / "registry.yaml")
    payload = sr.build_json(prices, entries)
    assert payload["status"] == "error"


def test_render_site_injection(tmp_path):
    site = tmp_path / "site"
    site.mkdir()
    (site / "template.html").write_text(
        "<style></style><div id=\"app\"></div>"
        "<script>window.SIGNALS = /*__SIGNALS_JSON__*/null;</script>",
        encoding="utf-8")
    payload = {"version": 1, "note": "テスト</script>攻撃"}
    sr.render_site(payload, site)
    frag = (site / "artifact.html").read_text(encoding="utf-8")
    idx = (site / "index.html").read_text(encoding="utf-8")
    assert "/*__SIGNALS_JSON__*/" not in frag
    assert "<\\/script>" in frag           # </script>がエスケープされる
    assert not frag.lstrip().startswith("<!doctype")
    assert idx.startswith("<!doctype html>")
    assert json.loads((site / "data" / "signals.json").read_text(encoding="utf-8"))


class TestJpxListingUrl:
    """JPXの一覧ファイルURLを直書きに頼らないこと。

    ファイル本体は .../misc/<ハッシュ>-att/data_j.xls という形で、この
    <ハッシュ> は JPX 側の都合で入れ替わる。直書きしていた
    tvdivq0000001vg2-att は実際に 404 になり、ユニバース取得が失敗して129銘柄の
    フォールバックで動き続けていた(signals.json の universe_count が 128)。
    推測で書き換えても次の入れ替えでまた壊れるので、配布ページから読む。
    通信はせず、抽出だけを固定する。
    """

    PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"

    def test_resolves_relative_link(self):
        from backtest.universe import extract_jpx_listing_urls
        html = '<a href="/markets/statistics-equities/misc/abc123-att/data_j.xls">一覧</a>'
        assert extract_jpx_listing_urls(html, self.PAGE) == [
            "https://www.jpx.co.jp/markets/statistics-equities/misc/abc123-att/data_j.xls"]

    def test_hash_change_does_not_break_it(self):
        from backtest.universe import extract_jpx_listing_urls
        got = extract_jpx_listing_urls('<a href="./zzzz9999-att/data_j.xls">x</a>', self.PAGE)
        assert got and got[0].endswith("zzzz9999-att/data_j.xls")

    def test_accepts_xlsx(self):
        from backtest.universe import extract_jpx_listing_urls
        got = extract_jpx_listing_urls('<a href="/a-att/data_j.xlsx">x</a>', self.PAGE)
        assert got[0].endswith("data_j.xlsx")

    def test_dedupes(self):
        from backtest.universe import extract_jpx_listing_urls
        html = '<a href="/a-att/data_j.xls">1</a><a href="/a-att/data_j.xls">2</a>'
        assert len(extract_jpx_listing_urls(html, self.PAGE)) == 1

    def test_ignores_unrelated_links(self):
        from backtest.universe import extract_jpx_listing_urls
        html = '<a href="/a-att/data_e.xls">英語版</a><a href="/b.pdf">pdf</a>'
        assert extract_jpx_listing_urls(html, self.PAGE) == []

    def test_empty_page_yields_nothing(self):
        """空なら呼び出し側が旧URLへ落ちる。"""
        from backtest.universe import extract_jpx_listing_urls
        assert extract_jpx_listing_urls("<html></html>", self.PAGE) == []

    def test_legacy_url_is_always_a_candidate(self, monkeypatch):
        """配布ページが読めなくても旧URLは必ず試す。"""
        import backtest.universe as u
        monkeypatch.setattr(u, "extract_jpx_listing_urls", lambda *a, **k: [])
        monkeypatch.setattr("urllib.request.urlopen",
                            lambda *a, **k: (_ for _ in ()).throw(OSError("blocked")))
        assert u._jpx_candidates() == [u.JPX_URL]


class TestExcelReaders:
    """JPXの一覧を読むための依存が揃っていること。

    JPXは同じディレクトリのまま data_j.xls → data_j.xlsx に切り替えた。
    xlrd 2.x は .xlsx のサポートを外しているため openpyxl が要る。無いと
    pandas.read_excel が `Import openpyxl failed` で落ち、ユニバースが
    129銘柄のフォールバックに縮む(実際スイングが128銘柄で動いていた)。
    例外が握りつぶされてフォールバックに落ちる作りなので、依存の欠落は
    実行時には警告1行にしかならない。ここで落として気づけるようにする。
    """

    def test_can_read_xlsx(self):
        import openpyxl  # noqa: F401

    def test_can_read_xls(self):
        """JPXが .xls に戻す可能性もあるので両方保持する。"""
        import xlrd  # noqa: F401
