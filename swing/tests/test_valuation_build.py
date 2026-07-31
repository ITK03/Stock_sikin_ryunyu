"""ローリング生成の選択ロジックの検証(ネットワーク不要)。

数日で一巡すること・優先銘柄が先に埋まること・同じ銘柄ばかり選び続けない
ことを固定する。
"""
from __future__ import annotations

import json

from valuation.build import INDEX_FILE, load_index, market_index, select_batch

UNIVERSE = [f"{7000 + i}" for i in range(20)]


class TestSelectBatch:
    def test_unbuilt_codes_come_first(self):
        done = {c: "2026-07-31" for c in UNIVERSE[:15]}
        batch = select_batch(UNIVERSE, done, limit=5)
        assert set(batch) == set(UNIVERSE[15:])

    def test_priority_codes_are_built_first(self):
        batch = select_batch(UNIVERSE, {}, limit=3, priority=["7019", "7018"])
        assert batch[:2] == ["7019", "7018"]

    def test_priority_ignores_codes_outside_universe(self):
        batch = select_batch(UNIVERSE, {}, limit=3, priority=["9999", "7019"])
        assert "9999" not in batch
        assert batch[0] == "7019"

    def test_oldest_first_once_everything_is_built(self):
        done = {c: f"2026-07-{(i % 28) + 1:02d}" for i, c in enumerate(UNIVERSE)}
        batch = select_batch(UNIVERSE, done, limit=3)
        assert batch == sorted(UNIVERSE, key=lambda c: done[c])[:3]

    def test_full_cycle_covers_universe_without_repeats(self):
        """毎回同じ銘柄を選び続けず、数回で全銘柄を一巡すること。"""
        done: dict[str, str] = {}
        seen: list[str] = []
        for day in range(4):
            batch = select_batch(UNIVERSE, done, limit=5)
            seen += batch
            for c in batch:
                done[c] = f"2026-08-{day + 1:02d}"
        assert sorted(set(seen)) == sorted(UNIVERSE)
        assert len(seen) == len(set(seen)), "一巡する前に同じ銘柄を再取得している"

    def test_no_duplicates_when_priority_overlaps_unbuilt(self):
        batch = select_batch(UNIVERSE, {}, limit=6, priority=["7000", "7001"])
        assert len(batch) == len(set(batch))

    def test_limit_larger_than_universe(self):
        assert len(select_batch(UNIVERSE, {}, limit=999)) == len(UNIVERSE)


class TestIndex:
    def _write(self, d, code, as_of):
        (d / f"{code}.json").write_text(
            json.dumps({"code": code, "as_of": as_of}), encoding="utf-8")

    def test_index_lists_generated_profiles(self, tmp_path):
        self._write(tmp_path, "7203", "2026-07-31")
        self._write(tmp_path, "6758", "2026-07-30")
        market_index(["7203", "6758"], tmp_path)
        idx = json.loads((tmp_path / INDEX_FILE).read_text(encoding="utf-8"))
        assert idx["count"] == 2
        assert idx["as_of"]["7203"] == "2026-07-31"

    def test_index_roundtrips_into_load_index(self, tmp_path):
        self._write(tmp_path, "7203", "2026-07-31")
        market_index(["7203"], tmp_path)
        assert load_index(tmp_path) == {"7203": "2026-07-31"}

    def test_load_index_tolerates_missing_or_broken_file(self, tmp_path):
        assert load_index(tmp_path) == {}
        (tmp_path / INDEX_FILE).write_text("{壊れている", encoding="utf-8")
        assert load_index(tmp_path) == {}

    def test_index_skips_profiles_without_as_of(self, tmp_path):
        """履歴不足で as_of が入らなかったものは未生成として扱う(次回再試行)。"""
        self._write(tmp_path, "7203", "2026-07-31")
        (tmp_path / "999A.json").write_text(
            json.dumps({"code": "999A", "as_of": None}), encoding="utf-8")
        market_index(["7203", "999A"], tmp_path)
        assert load_index(tmp_path) == {"7203": "2026-07-31"}

    def test_index_itself_is_not_counted(self, tmp_path):
        self._write(tmp_path, "7203", "2026-07-31")
        market_index(["7203"], tmp_path)
        market_index(["7203"], tmp_path)      # 2回目でindex.jsonが既に存在する
        idx = json.loads((tmp_path / INDEX_FILE).read_text(encoding="utf-8"))
        assert idx["count"] == 1


class TestGuidanceCarryOver:
    """会社予想の引き継ぎ。

    開示フィードは直近1ヶ月ぶんしか無いので、毎回取り直す方式だと決算期以外は
    会社予想が消えてしまう。抽出済みは保持し、新しい短信が出たときだけ更新する。
    """

    def test_keeps_previous_when_no_new_disclosure(self):
        from valuation.build import resolve_guidance
        prev = {"doc_id": "OLD", "eps": 120.0}
        got = resolve_guidance("7203", {}, {"guidance": prev}, shares=None)
        assert got == prev

    def test_keeps_previous_when_same_document(self, monkeypatch):
        """同じ短信を何度も取りに行かない。"""
        import valuation.build as b
        called = []
        monkeypatch.setattr(b, "fetch_summary", lambda d: called.append(d))
        prev = {"doc_id": "DOC1", "eps": 120.0}
        got = b.resolve_guidance("7203", {"7203": ("DOC1", "2026-07-29T15:00")},
                                 {"guidance": prev}, shares=None)
        assert got == prev
        assert called == [], "同一文書を再取得している"

    def test_updates_on_newer_document(self, monkeypatch):
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d: {
            "actual": {"operating_income": 6000.0},
            "forecast": {"operating_income": 20000.0, "eps": 133.5},
            "quarter": 1, "consolidated": True})
        got = b.resolve_guidance("7203", {"7203": ("DOC2", "2026-08-05T15:00")},
                                 {"guidance": {"doc_id": "DOC1", "eps": 120.0}},
                                 shares=None)
        assert got["doc_id"] == "DOC2"
        assert got["eps"] == 133.5
        assert got["known_from"] == "2026-08-05"
        assert got["progress"]["quarter"] == 1

    def test_keeps_previous_when_fetch_fails(self, monkeypatch):
        """取得に失敗した回が、抽出済みの予想を消してしまわないこと。"""
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d: None)
        prev = {"doc_id": "DOC1", "eps": 120.0}
        got = b.resolve_guidance("7203", {"7203": ("DOC2", "2026-08-05T15:00")},
                                 {"guidance": prev}, shares=None)
        assert got == prev

    def test_none_when_never_extracted(self, monkeypatch):
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d: None)
        assert b.resolve_guidance("7203", {}, None, shares=None) is None


class TestLatestEarningsDocs:
    def _feed(self, items):
        return {"items": items}

    def test_picks_newest_per_code(self, monkeypatch):
        import json as _json
        import valuation.build as b

        class Resp:
            def __init__(self, payload): self.payload = payload
            def read(self): return _json.dumps(self.payload).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        feed = self._feed([
            {"code": "7203", "id": "D1", "time": "2026-05-10T15:00", "category": "決算"},
            {"code": "7203", "id": "D2", "time": "2026-07-29T15:00", "category": "決算"},
            {"code": "6758", "id": "D3", "time": "2026-07-30T15:00", "category": "決算"},
            {"code": "9999", "id": "D4", "time": "2026-07-30T15:00", "category": "配当"},
            {"code": "8888", "id": "D5", "time": "2026-07-30T15:00", "category": "決算",
             "is_correction": True},
        ])
        monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: Resp(feed))
        docs = b.latest_earnings_docs()
        assert docs["7203"][0] == "D2"          # 新しいほう
        assert docs["6758"][0] == "D3"
        assert "9999" not in docs               # 決算以外は対象外
        assert "8888" not in docs               # 訂正は対象外

    def test_network_failure_is_not_fatal(self, monkeypatch):
        import valuation.build as b
        def boom(*a, **k):
            raise OSError("network down")
        monkeypatch.setattr("urllib.request.urlopen", boom)
        assert b.latest_earnings_docs() == {}
