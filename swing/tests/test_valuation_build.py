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
