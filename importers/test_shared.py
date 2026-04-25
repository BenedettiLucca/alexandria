import os
import sys
import pytest
from unittest.mock import patch, MagicMock, MagicMock as MockModule

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "supabase" not in sys.modules:
    mock_supabase_mod = MockModule()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod

from importers.shared import (
    connect_supabase,
    dedup_by_external_id,
    upsert_record,
    record_sync,
    format_timestamp,
    format_date,
    extract_numeric_value,
)


class TestConnectSupabase:
    @patch.dict(os.environ, {"SUPABASE_URL": "https://test.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "key123"})
    @patch("supabase.create_client")
    def test_creates_client_with_env_vars(self, mock_create):
        # Reload shared to pick up the patched create_client
        import importlib
        import shared as shared_mod
        importlib.reload(shared_mod)
        shared_mod.connect_supabase()
        mock_create.assert_called_once_with("https://test.supabase.co", "key123")

    @patch.dict(os.environ, {}, clear=True)
    @patch("importers.shared.create_client")
    def test_exits_when_vars_missing(self, mock_create):
        with pytest.raises(SystemExit):
            connect_supabase()
        mock_create.assert_not_called()

    @patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": ""})
    @patch("importers.shared.create_client")
    def test_exits_when_vars_empty(self, mock_create):
        with pytest.raises(SystemExit):
            connect_supabase()
        mock_create.assert_not_called()


class TestDedupByExternalId:
    def test_returns_true_when_exists(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [{"id": "1"}]
        assert dedup_by_external_id(mock_supabase, "health_entries", "hc", "ext1") is True

    def test_returns_false_when_not_exists(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        assert dedup_by_external_id(mock_supabase, "health_entries", "hc", "ext2") is False

    def test_returns_false_when_external_id_is_none(self):
        mock_supabase = MagicMock()
        assert dedup_by_external_id(mock_supabase, "health_entries", "hc", None) is False
        mock_supabase.table.assert_not_called()

    def test_returns_false_when_external_id_is_empty(self):
        mock_supabase = MagicMock()
        assert dedup_by_external_id(mock_supabase, "health_entries", "hc", "") is False


class TestUpsertRecord:
    def test_insert_when_no_external_id(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [{"id": "1"}]
        record = {"name": "test"}
        result = upsert_record(mock_supabase, "health_entries", record, "hc", None)
        mock_supabase.table.return_value.insert.assert_called_once_with(record)
        assert result.data == [{"id": "1"}]

    def test_insert_when_external_id_and_no_existing(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [{"id": "2"}]
        record = {"name": "test"}
        result = upsert_record(mock_supabase, "health_entries", record, "hc", "ext1")
        mock_supabase.table.return_value.insert.assert_called_once_with(record)
        assert result.data == [{"id": "2"}]

    def test_update_when_external_id_and_existing(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [{"id": "1"}]
        mock_supabase.table.return_value.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = [{"id": "1"}]
        record = {"name": "updated"}
        result = upsert_record(mock_supabase, "health_entries", record, "hc", "ext1")
        mock_supabase.table.return_value.update.assert_called_once_with(record)
        assert result.data == [{"id": "1"}]


class TestRecordSync:
    def test_inserts_sync_log_on_success(self):
        mock_supabase = MagicMock()
        record_sync(mock_supabase, "iron-log", processed=10, imported=8, skipped=2)
        mock_supabase.table.return_value.insert.assert_called_once()
        call_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert call_args["source"] == "iron-log"
        assert call_args["status"] == "completed"
        assert call_args["records_processed"] == 10
        assert call_args["records_imported"] == 8
        assert call_args["records_skipped"] == 2
        assert "completed_at" in call_args

    def test_sets_status_failed_on_error(self):
        mock_supabase = MagicMock()
        record_sync(mock_supabase, "iron-log", error="something went wrong")
        call_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert call_args["status"] == "failed"
        assert call_args["error_message"] == "something went wrong"

    def test_catches_exception_gracefully(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.insert.return_value.execute.side_effect = Exception("db error")
        record_sync(mock_supabase, "iron-log")

    def test_includes_started_at_when_provided(self):
        mock_supabase = MagicMock()
        record_sync(mock_supabase, "iron-log", started_at="2024-01-01T00:00:00Z")
        call_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert call_args["started_at"] == "2024-01-01T00:00:00Z"


class TestFormatTimestamp:
    def test_none_returns_none(self):
        assert format_timestamp(None) is None

    def test_zero_returns_none(self):
        assert format_timestamp(0) is None

    def test_typical_epoch_ms(self):
        result = format_timestamp(1700000000000)
        assert result is not None
        assert "T" in result
        assert result.endswith("+00:00")

    def test_epoch_start(self):
        result = format_timestamp(1)
        assert result is not None


class TestFormatDate:
    def test_none_returns_none(self):
        assert format_date(None) is None

    def test_zero_returns_none(self):
        assert format_date(0) is None

    def test_typical_epoch_ms(self):
        result = format_date(1700000000000)
        assert result == "2023-11-14"

    def test_epoch_start(self):
        assert format_date(1) == "1970-01-01"


class TestExtractNumericValue:
    def test_steps_returns_int(self):
        assert extract_numeric_value("steps", {"count": 10000}) == 10000

    def test_heart_rate_returns_float(self):
        assert extract_numeric_value("heart_rate", {"bpm": 72}) == 72.0

    def test_weight_returns_float(self):
        assert extract_numeric_value("weight", {"weight_kg": 75.5}) == 75.5

    def test_sleep_returns_rounded_float(self):
        assert extract_numeric_value("sleep", {"duration_hours": 7.53}) == 7.5

    def test_blood_pressure_returns_float(self):
        assert extract_numeric_value("blood_pressure", {"systolic": 120}) == 120.0

    def test_body_composition_returns_float(self):
        assert extract_numeric_value("body_composition", {"weight_kg": 80.0}) == 80.0

    def test_exercise_duration_min(self):
        assert extract_numeric_value("exercise", {"duration_min": 30}) == 30.0

    def test_exercise_duration_s_converted(self):
        assert extract_numeric_value("exercise", {"duration_s": 1800}) == 30.0

    def test_exercise_calories(self):
        assert extract_numeric_value("exercise", {"calories": 500}) == 500.0

    def test_unknown_type_returns_none(self):
        assert extract_numeric_value("unknown", {"some_field": 42}) is None

    def test_none_value_returns_none(self):
        assert extract_numeric_value("steps", None) is None

    def test_empty_dict_returns_none(self):
        assert extract_numeric_value("steps", {}) is None

    def test_non_dict_value_returns_none(self):
        assert extract_numeric_value("steps", "not a dict") is None

    def test_dict_with_unparseable_value(self):
        assert extract_numeric_value("steps", {"count": "abc"}) is None
