"""公開ガード(古いデータで上書きしない)の検証。

2026-07-30 に実際に起きた退行を再現ケースとして固定する。
"""
from __future__ import annotations

import json

import pytest

from screener.publish_guard import main, read_data_date, should_publish


class TestShouldPublish:
    def test_regression_case_2026_07_30(self):
        """19:25の実行で公開した07-30を、00:11の実行の07-29が上書きしない。"""
        assert not should_publish("2026-07-29", "2026-07-30")

    def test_newer_is_published(self):
        assert should_publish("2026-07-30", "2026-07-29")

    def test_same_day_is_published(self):
        """同日なら公開する(値の訂正・generated_at更新を反映するため)。"""
        assert should_publish("2026-07-30", "2026-07-30")

    def test_first_publish_without_existing(self):
        assert should_publish("2026-07-30", None)

    def test_missing_new_date_is_not_published(self):
        """生成側が壊れている場合は公開しない(空データで上書きしない)。"""
        assert not should_publish(None, "2026-07-30")
        assert not should_publish(None, None)

    def test_crosses_month_and_year_boundaries(self):
        """文字列比較でも日付順になっていること(桁揃えのISO形式が前提)。"""
        assert should_publish("2026-08-03", "2026-07-31")
        assert not should_publish("2026-07-31", "2026-08-03")
        assert should_publish("2027-01-04", "2026-12-30")
        assert not should_publish("2026-12-30", "2027-01-04")


class TestReadDataDate:
    def _write(self, path, obj):
        path.write_text(json.dumps(obj), encoding="utf-8")
        return str(path)

    def test_reads_field(self, tmp_path):
        p = self._write(tmp_path / "s.json", {"data_date": "2026-07-30"})
        assert read_data_date(p) == "2026-07-30"

    def test_missing_file_is_none(self, tmp_path):
        assert read_data_date(tmp_path / "no-such.json") is None

    def test_broken_json_is_none(self, tmp_path):
        p = tmp_path / "b.json"
        p.write_text("{壊れている", encoding="utf-8")
        assert read_data_date(p) is None

    def test_missing_or_empty_field_is_none(self, tmp_path):
        assert read_data_date(self._write(tmp_path / "a.json", {})) is None
        assert read_data_date(self._write(tmp_path / "b.json", {"data_date": ""})) is None


class TestCli:
    def _write(self, path, date):
        path.write_text(json.dumps({"data_date": date}), encoding="utf-8")
        return str(path)

    def test_exit_0_when_newer(self, tmp_path):
        new = self._write(tmp_path / "new.json", "2026-07-30")
        old = self._write(tmp_path / "old.json", "2026-07-29")
        assert main(["publish_guard", new, old]) == 0

    def test_exit_1_when_older(self, tmp_path):
        new = self._write(tmp_path / "new.json", "2026-07-29")
        old = self._write(tmp_path / "old.json", "2026-07-30")
        assert main(["publish_guard", new, old]) == 1

    def test_exit_0_when_no_published_file(self, tmp_path):
        new = self._write(tmp_path / "new.json", "2026-07-30")
        # 公開中ファイルが存在しない(初回)場合も公開する
        assert main(["publish_guard", new, str(tmp_path / "absent.json")]) == 0
        assert main(["publish_guard", new]) == 0

    def test_bad_usage(self, tmp_path):
        assert main(["publish_guard"]) == 2


class TestAgainstRealPayload:
    """screener.run が出す実際のpayload形状から data_date を読めること。"""

    def test_reads_from_build_json_output(self, tmp_path):
        pytest.importorskip("pandas")
        import numpy as np
        import pandas as pd
        from pathlib import Path
        from screener.run import build_json, load_registry

        rng = np.random.default_rng(0)
        idx = pd.bdate_range("2025-01-01", periods=300)
        prices = {}
        for i in range(120):
            c = 100 * np.cumprod(1 + rng.normal(0.001, 0.02, len(idx)))
            prices[str(7000 + i)] = pd.DataFrame(
                {"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                 "volume": rng.lognormal(16.1, 0.4, len(idx))}, index=idx)
        payload = build_json(prices, load_registry(Path("screener/registry.yaml")))
        p = tmp_path / "signals.json"
        p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        assert read_data_date(p) == payload["data_date"]
