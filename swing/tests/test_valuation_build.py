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
        monkeypatch.setattr(b, "fetch_summary", lambda d, u=None: called.append(d))
        prev = {"doc_id": "DOC1", "eps": 120.0}
        got = b.resolve_guidance("7203", {"7203": ("DOC1", "2026-07-29T15:00", "")},
                                 {"guidance": prev}, shares=None)
        assert got == prev
        assert called == [], "同一文書を再取得している"

    def test_updates_on_newer_document(self, monkeypatch):
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d, u=None: {
            "actual": {"operating_income": 6000.0},
            "forecast": {"operating_income": 20000.0, "eps": 133.5},
            "quarter": 1, "consolidated": True})
        got = b.resolve_guidance("7203", {"7203": ("DOC2", "2026-08-05T15:00", "")},
                                 {"guidance": {"doc_id": "DOC1", "eps": 120.0}},
                                 shares=None)
        assert got["doc_id"] == "DOC2"
        assert got["eps"] == 133.5
        assert got["known_from"] == "2026-08-05"
        assert got["progress"]["quarter"] == 1

    def test_keeps_previous_when_fetch_fails(self, monkeypatch):
        """取得に失敗した回が、抽出済みの予想を消してしまわないこと。"""
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d, u=None: None)
        prev = {"doc_id": "DOC1", "eps": 120.0}
        got = b.resolve_guidance("7203", {"7203": ("DOC2", "2026-08-05T15:00", "")},
                                 {"guidance": prev}, shares=None)
        assert got == prev

    def test_none_when_never_extracted(self, monkeypatch):
        import valuation.build as b
        monkeypatch.setattr(b, "fetch_summary", lambda d, u=None: None)
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


class TestSchemaUpgrade:
    """スキーマが古いプロファイルを最優先で作り直すこと。

    v2 を足したあと、未生成を優先する順序のせいで生成済み450銘柄が v1 のまま
    残り、追加した収益性・安全性・成長・会社予想が画面にまったく出なかった。
    未生成なら「まだ集計されていません」と正直に出るが、古いスキーマは項目が
    欠けたパネルが出てしまい、機能が無いのか壊れているのか区別できない。
    """

    def test_outdated_profiles_come_before_unbuilt(self):
        universe = ["1000", "1001", "1002", "1003"]
        done = {"1000": "2026-08-01", "1001": "2026-08-01"}
        schema = {"1000": 1, "1001": 2}      # 1000 だけ古い
        batch = select_batch(universe, done, limit=2, schema=schema, current_schema=2)
        assert batch[0] == "1000", "古い版が未生成より先に来ていない"

    def test_unknown_version_is_not_treated_as_outdated(self):
        """版が分からないだけで作り直さない(一巡ぶんの生成が無駄になる)。"""
        universe = ["1000", "1001"]
        done = {"1000": "2026-08-01"}
        batch = select_batch(universe, done, limit=2, schema={}, current_schema=2)
        assert batch[0] == "1001"           # 未生成が先

    def test_priority_still_wins_among_outdated(self):
        universe = ["1000", "1001", "1002"]
        done = {c: "2026-08-01" for c in universe}
        schema = {c: 1 for c in universe}
        batch = select_batch(universe, done, limit=1, schema=schema,
                             priority=["1002"], current_schema=2)
        assert batch == ["1002"]

    def test_all_current_schema_falls_back_to_oldest_first(self):
        universe = ["1000", "1001"]
        done = {"1000": "2026-07-01", "1001": "2026-08-01"}
        schema = {c: 2 for c in universe}
        batch = select_batch(universe, done, limit=1, schema=schema, current_schema=2)
        assert batch == ["1000"]

    def test_upgrade_completes_in_a_few_cycles(self):
        """古い版が数回の実行で一掃されること。"""
        universe = [f"{1000 + i}" for i in range(10)]
        done = {c: "2026-08-01" for c in universe}
        schema = {c: 1 for c in universe}
        for _ in range(4):
            batch = select_batch(universe, done, limit=3, schema=schema, current_schema=2)
            for c in batch:
                schema[c] = 2
        assert all(v == 2 for v in schema.values())


class TestIndexRecordsSchema:
    def test_index_carries_schema_versions(self, tmp_path):
        import json as _json
        from valuation.build import load_schema_versions
        (tmp_path / "7203.json").write_text(
            _json.dumps({"code": "7203", "as_of": "2026-08-01", "v": 2}), encoding="utf-8")
        (tmp_path / "6758.json").write_text(
            _json.dumps({"code": "6758", "as_of": "2026-08-01", "v": 1}), encoding="utf-8")
        market_index(["7203", "6758"], tmp_path)
        idx = _json.loads((tmp_path / INDEX_FILE).read_text(encoding="utf-8"))
        assert idx["schema"] == {"7203": 2, "6758": 1}
        assert idx["outdated"] >= 1
        assert load_schema_versions(tmp_path) == {"7203": 2, "6758": 1}

    def test_missing_version_defaults_to_one(self, tmp_path):
        import json as _json
        from valuation.build import load_schema_versions
        (tmp_path / "7203.json").write_text(
            _json.dumps({"code": "7203", "as_of": "2026-08-01"}), encoding="utf-8")
        assert load_schema_versions(tmp_path) == {"7203": 1}


class TestXbrlUrlHint:
    """開示フィードが持つ実際のXBRLリンクを最優先で使うこと。

    URLの規則は公開仕様として保証されておらず、推測した3パターンは実行ログで
    すべて HTTP404 だった。一覧ページのリンクをそのまま使うのが確実。
    """

    def test_passes_feed_url_to_fetcher(self, monkeypatch):
        import valuation.build as b
        seen = {}
        monkeypatch.setattr(b, "fetch_summary",
                            lambda d, u=None: seen.update(doc=d, url=u) or None)
        b.resolve_guidance("7203", {"7203": ("DOC1", "2026-08-05T15:00",
                                             "https://example.test/x.zip")},
                           None, shares=None)
        assert seen["url"] == "https://example.test/x.zip"

    def test_missing_url_is_passed_as_none(self, monkeypatch):
        import valuation.build as b
        seen = {}
        monkeypatch.setattr(b, "fetch_summary",
                            lambda d, u=None: seen.update(url=u) or None)
        b.resolve_guidance("7203", {"7203": ("DOC1", "2026-08-05T15:00", "")},
                           None, shares=None)
        assert seen["url"] is None

    def test_feed_parsing_keeps_xbrl_url(self, monkeypatch):
        import json as _json
        import valuation.build as b

        class Resp:
            def __init__(self, p): self.p = p
            def read(self): return _json.dumps(self.p).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        feed = {"items": [{"code": "7203", "id": "D1", "time": "2026-07-29T15:00",
                           "category": "決算",
                           "xbrl_url": "https://www.release.tdnet.info/inbs/x.zip"}]}
        monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: Resp(feed))
        docs = b.latest_earnings_docs()
        assert docs["7203"][2].endswith("x.zip")


class TestGuidancePriority:
    """決算を出した銘柄を、短信がフィードに載っているうちに作り直すこと。

    開示フィードは当日+前日しか持たない。ローリング生成は一巡に約3日かかる
    ため、順番待ちに任せると短信が消えたあとで番が回ってくる。会社予想が
    450銘柄中0件だった原因の半分はこれ(残り半分はXBRLのURL)。
    """

    def test_reported_code_beats_unbuilt(self):
        """決算銘柄は未生成銘柄より先。未生成は次の一巡でも作れるが、
        短信には期限がある。"""
        done = {"7000": "2026-07-01"}
        batch = select_batch(UNIVERSE, done, limit=2, priority=["7000"])
        assert batch[0] == "7000"

    def test_outdated_schema_still_first(self):
        """表示項目が欠けたパネルの解消は、期限つきの決算取得より先。
        スキーマ移行は数日で終わるので、両立できないのはその間だけ。"""
        done = {c: "2026-07-01" for c in UNIVERSE}
        schema = {c: 3 for c in UNIVERSE} | {"7005": 1}
        batch = select_batch(UNIVERSE, done, limit=2, priority=["7000"],
                             schema=schema, current_schema=3)
        assert batch[0] == "7005"
        assert batch[1] == "7000"

    def test_skips_codes_that_already_have_the_same_document(self, tmp_path):
        """同じ文書IDの予想を既に持つ銘柄は入れない(結果が変わらないのに
        ローリング更新の枠を食う)。"""
        from valuation.build import guidance_priority
        (tmp_path / "7203.json").write_text(json.dumps(
            {"code": "7203", "guidance": {"doc_id": "DOC1"}}), encoding="utf-8")
        docs = {"7203": ("DOC1", "2026-07-31T15:00", "")}
        assert guidance_priority(tmp_path, docs) == []

    def test_includes_code_with_newer_document(self, tmp_path):
        from valuation.build import guidance_priority
        (tmp_path / "7203.json").write_text(json.dumps(
            {"code": "7203", "guidance": {"doc_id": "DOC1"}}), encoding="utf-8")
        docs = {"7203": ("DOC2", "2026-08-05T15:00", "")}
        assert guidance_priority(tmp_path, docs) == ["7203"]

    def test_includes_code_without_any_guidance(self, tmp_path):
        from valuation.build import guidance_priority
        (tmp_path / "7203.json").write_text(json.dumps(
            {"code": "7203"}), encoding="utf-8")
        assert guidance_priority(
            tmp_path, {"7203": ("DOC1", "2026-07-31T15:00", "")}) == ["7203"]

    def test_includes_ungenerated_code(self, tmp_path):
        from valuation.build import guidance_priority
        assert guidance_priority(
            tmp_path, {"7203": ("DOC1", "2026-07-31T15:00", "")}) == ["7203"]


class TestEarningsDocSelection:
    """「決算」には短信・説明会資料・補足資料が混ざる。会社予想が入っているのは
    短信のXBRLだけなので、そちらを選ぶこと。"""

    @staticmethod
    def _docs(monkeypatch, items):
        import json as _json
        import valuation.build as b

        class Resp:
            def read(self): return _json.dumps({"items": items}).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: Resp())
        return b.latest_earnings_docs()

    def test_prefers_xbrl_over_newer_presentation(self, monkeypatch):
        """説明会資料が短信より後に出ても、短信のXBRLを落とさないこと。
        実データで2銘柄がこれに当たっていた。"""
        docs = self._docs(monkeypatch, [
            {"code": "3835", "id": "TANSHIN", "time": "2026-07-31T13:30",
             "category": "決算",
             "xbrl_url": "https://www.release.tdnet.info/inbs/a.zip"},
            {"code": "3835", "id": "SETSUMEI", "time": "2026-07-31T16:00",
             "category": "決算"},
        ])
        assert docs["3835"][0] == "TANSHIN"
        assert docs["3835"][2].endswith("a.zip")

    def test_newest_wins_among_xbrl_documents(self, monkeypatch):
        docs = self._docs(monkeypatch, [
            {"code": "7203", "id": "OLD", "time": "2026-05-01T15:00",
             "category": "決算", "xbrl_url": "https://x.test/old.zip"},
            {"code": "7203", "id": "NEW", "time": "2026-07-31T15:00",
             "category": "決算", "xbrl_url": "https://x.test/new.zip"},
        ])
        assert docs["7203"][0] == "NEW"

    def test_newest_wins_when_none_have_xbrl(self, monkeypatch):
        docs = self._docs(monkeypatch, [
            {"code": "9999", "id": "OLD", "time": "2026-05-01T15:00", "category": "決算"},
            {"code": "9999", "id": "NEW", "time": "2026-07-31T15:00", "category": "決算"},
        ])
        assert docs["9999"][0] == "NEW"
        assert docs["9999"][2] == ""
