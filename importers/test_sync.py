import os
import sys
import importlib.util
from unittest import TestCase as _UTCase
from unittest.mock import patch, MagicMock



_base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "importers.shared", os.path.join(_base, "importers", "shared.py")
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["importers.shared"] = _mod
_spec.loader.exec_module(_mod)

sys.modules["importers.health_connect"] = type(sys)("importers.health_connect")
sys.modules["importers.health_connect"].__path__ = [
    os.path.join(_base, "importers", "health-connect")
]

_spec = importlib.util.spec_from_file_location(
    "importers.health_connect.sync",
    os.path.join(_base, "importers", "health-connect", "sync.py"),
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["importers.health_connect.sync"] = _mod
sys.modules["importers.health_connect"].sync = _mod
_spec.loader.exec_module(_mod)
_api_get = _mod._api_get
sync_steps = _mod.sync_steps
sync_weight = _mod.sync_weight
sync_heart_rate = _mod.sync_heart_rate
sync_sleep = _mod.sync_sleep
sync_exercise = _mod.sync_exercise

SYNC_MOD = "importers.health_connect.sync"


def make_mock_creds():
    creds = MagicMock()
    creds.token = "test-token"
    return creds


def make_mock_supabase():
    mock = MagicMock()
    mock.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
    mock.table.return_value.insert.return_value.execute.return_value.data = [
        {"id": "new"}
    ]
    return mock


AGGREGATE_RESPONSE_STEPS = {
    "bucket": [
        {
            "dataset": [
                {
                    "point": [
                        {
                            "startTimeNanos": "1700000000000000000",
                            "value": [{"intVal": 8500}],
                        }
                    ]
                }
            ]
        }
    ]
}

AGGREGATE_RESPONSE_WEIGHT = {
    "bucket": [
        {
            "dataset": [
                {
                    "point": [
                        {
                            "startTimeNanos": "1700000000000000000",
                            "value": [{"fpVal": 80.5}],
                        }
                    ]
                }
            ]
        }
    ]
}

AGGREGATE_RESPONSE_HR = {
    "bucket": [
        {
            "dataset": [
                {
                    "point": [
                        {
                            "startTimeNanos": "1700000000000000000",
                            "value": [{"fpVal": 72.3}],
                        }
                    ]
                }
            ]
        }
    ]
}

SLEEP_SESSIONS_RESPONSE = {
    "session": [
        {
            "startTimeMillis": "1699970000000",
            "endTimeMillis": "1700000000000",
            "name": "Night Sleep",
        }
    ]
}

EXERCISE_SESSIONS_RESPONSE = {
    "session": [
        {
            "startTimeMillis": "1700000000000",
            "endTimeMillis": "1700003600000",
            "name": "Running",
            "activityType": 8,
        }
    ]
}


class TestSyncSteps(_UTCase):
    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_zero_steps_as_valid_value(self, mock_api):
        """Zero é dado válido: dia sedentário não pode ser descartado."""
        mock_api.return_value = {
            "bucket": [{
                "dataset": [{
                    "point": [{
                        "startTimeNanos": "1700000000000000000",
                        "endTimeNanos": "1700008640000000000",
                        "value": [{"intVal": 0}],
                    }]
                }]
            }]
        }
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        imported, skipped = sync_steps(creds, supabase, 1700000000000, 1700008640000)
        self.assertEqual(imported, 1)
        self.assertEqual(skipped, 0)

    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_steps_correctly(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        rpc_call = supabase.rpc.call_args_list[-1]
        record = {k[2:] if k.startswith("p_") else k: v for k, v in rpc_call[0][1].items()}
        assert record["entry_type"] == "steps"
        assert record["numeric_value"] == 8500
        assert record["value"] == {"count": 8500}
        assert record["tags"] == ["health-connect", "steps"]

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_existing(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1

    @patch(f"{SYNC_MOD}._api_get")
    def test_no_data_returns_zero(self, mock_api):
        mock_api.return_value = None
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 0


class TestSyncWeight:
    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_weight_correctly(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_WEIGHT
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_weight(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        rpc_call = supabase.rpc.call_args_list[-1]
        record = {k[2:] if k.startswith("p_") else k: v for k, v in rpc_call[0][1].items()}
        assert record["entry_type"] == "weight"
        assert record["numeric_value"] == 80.5
        assert record["value"] == {"weight_kg": 80.5}

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_existing(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_WEIGHT
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_weight(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1


class TestSyncHeartRate:
    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_heart_rate_correctly(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_HR
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_heart_rate(
            creds, supabase, 1699900000000, 1700100000000
        )

        assert imported == 1
        rpc_call = supabase.rpc.call_args_list[-1]
        record = {k[2:] if k.startswith("p_") else k: v for k, v in rpc_call[0][1].items()}
        assert record["entry_type"] == "heart_rate"
        assert record["numeric_value"] == 72
        assert record["value"] == {"bpm": 72}

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_existing(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_HR
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_heart_rate(
            creds, supabase, 1699900000000, 1700100000000
        )

        assert imported == 0
        assert skipped == 1


class TestSyncSleep(_UTCase):
    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_sleep_correctly(self, mock_sleep):
        mock_sleep.return_value = SLEEP_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        rpc_call = supabase.rpc.call_args_list[-1]
        record = {k[2:] if k.startswith("p_") else k: v for k, v in rpc_call[0][1].items()}
        assert record["entry_type"] == "sleep"
        duration_hours = (1700000000000 - 1699970000000) / 1000 / 3600
        assert record["numeric_value"] == round(duration_hours, 1)
        assert record["duration_s"] == int((1700000000000 - 1699970000000) / 1000)
        assert record["value"]["name"] == "Night Sleep"
        assert record["tags"] == ["health-connect", "sleep"]

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_existing(self, mock_sleep):
        mock_sleep.return_value = SLEEP_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        # Semântica nova: upsert atômico regrava (imported), não "skipa"
        self.assertEqual(imported, 1)
        self.assertEqual(skipped, 0)

    @patch(f"{SYNC_MOD}._api_get")
    def test_no_data_returns_zero(self, mock_sleep):
        mock_sleep.return_value = None
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 0


class TestSyncExercise(_UTCase):
    @patch(f"{SYNC_MOD}._api_get")
    def test_imports_exercise_correctly(self, mock_api):
        mock_api.return_value = EXERCISE_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        rpc_call = supabase.rpc.call_args_list[-1]
        record = {k[2:] if k.startswith("p_") else k: v for k, v in rpc_call[0][1].items()}
        assert record["entry_type"] == "exercise"
        assert record["numeric_value"] == 60
        assert record["duration_s"] == 3600
        assert record["value"]["name"] == "Running"
        assert record["value"]["activity_type"] == 8
        assert record["tags"] == ["health-connect", "exercise"]

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_sleep_sessions(self, mock_api):
        mock_api.return_value = {"session": [{"startTimeMillis": "1700000000000", "endTimeMillis": "1700036000000", "name": "Sleep", "activityType": 72}]}
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0

    @patch(f"{SYNC_MOD}._api_get")
    def test_skips_existing(self, mock_api):
        mock_api.return_value = EXERCISE_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        # Semântica nova: upsert atômico regrava (imported), não "skipa"
        self.assertEqual(imported, 1)
        self.assertEqual(skipped, 0)


class TestSyncLogWritten(_UTCase):
    @patch(f"{SYNC_MOD}._api_get")
    def test_sync_log_written_after_sync(self, mock_api):
        mock_api.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        sync_steps(creds, supabase, 1699900000000, 1700100000000)

        rpc_call = supabase.rpc.call_args_list[-1]
        assert supabase.rpc.call_count >= 1


class TestSyncExceptions:
    @patch(f"{SYNC_MOD}._api_get")
    @patch(f"{SYNC_MOD}.logger")
    def test_api_get_failure_returns_none(self, mock_logger, mock_api):
        mock_api.side_effect = RuntimeError("boom")

        result = _api_get(make_mock_creds(), "https://example.com")

        assert result is None
        mock_logger.warning.assert_called_once()

    @patch(f"{SYNC_MOD}._api_get")
    @patch(f"{SYNC_MOD}.logger")
    def test_sync_exercise_handles_api_error(self, mock_logger, mock_api):
        mock_api.return_value = None
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 0, 0)
        assert imported == 0
        assert skipped == 0
