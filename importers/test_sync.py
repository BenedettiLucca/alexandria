import os
import sys
import importlib.util
from unittest.mock import patch, MagicMock, MagicMock as MockModule

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "supabase" not in sys.modules:
    mock_supabase_mod = MockModule()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod

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
get_credentials = _mod.get_credentials
make_aggregate_request = _mod.make_aggregate_request
get_sleep_sessions = _mod.get_sleep_sessions
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


class TestSyncSteps:
    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_imports_steps_correctly(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        insert_calls = supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "steps"
        assert record["numeric_value"] == 8500
        assert record["value"] == {"count": 8500}
        assert record["tags"] == ["health-connect", "steps"]

    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_skips_existing(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1

    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_no_data_returns_zero(self, mock_agg):
        mock_agg.return_value = None
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_steps(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 0


class TestSyncWeight:
    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_imports_weight_correctly(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_WEIGHT
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_weight(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        insert_calls = supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "weight"
        assert record["numeric_value"] == 80.5
        assert record["value"] == {"weight_kg": 80.5}

    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_skips_existing(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_WEIGHT
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_weight(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1


class TestSyncHeartRate:
    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_imports_heart_rate_correctly(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_HR
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_heart_rate(
            creds, supabase, 1699900000000, 1700100000000
        )

        assert imported == 1
        insert_calls = supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "heart_rate"
        assert record["numeric_value"] == 72
        assert record["value"] == {"bpm": 72}

    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_skips_existing(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_HR
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


class TestSyncSleep:
    @patch("importers.health_connect.sync.get_sleep_sessions")
    def test_imports_sleep_correctly(self, mock_sleep):
        mock_sleep.return_value = SLEEP_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        insert_calls = supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "sleep"
        duration_hours = (1700000000000 - 1699970000000) / 1000 / 3600
        assert record["numeric_value"] == round(duration_hours, 1)
        assert record["duration_s"] == int((1700000000000 - 1699970000000) / 1000)
        assert record["value"]["name"] == "Night Sleep"
        assert record["tags"] == ["health-connect", "sleep"]

    @patch("importers.health_connect.sync.get_sleep_sessions")
    def test_skips_existing(self, mock_sleep):
        mock_sleep.return_value = SLEEP_SESSIONS_RESPONSE
        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1

    @patch("importers.health_connect.sync.get_sleep_sessions")
    def test_no_data_returns_zero(self, mock_sleep):
        mock_sleep.return_value = None
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_sleep(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 0


class TestSyncExercise:
    @patch("urllib.request.urlopen")
    def test_imports_exercise_correctly(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"session": [{"startTimeMillis": "1700000000000", "endTimeMillis": "1700003600000", "name": "Running", "activityType": 8}]}'
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 1
        insert_calls = supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "exercise"
        assert record["numeric_value"] == 60
        assert record["duration_s"] == 3600
        assert record["value"]["name"] == "Running"
        assert record["value"]["activity_type"] == 8
        assert record["tags"] == ["health-connect", "exercise"]

    @patch("urllib.request.urlopen")
    def test_skips_sleep_sessions(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"session": [{"startTimeMillis": "1700000000000", "endTimeMillis": "1700036000000", "name": "Sleep", "activityType": 72}]}'
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        creds = make_mock_creds()
        supabase = make_mock_supabase()

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0

    @patch("urllib.request.urlopen")
    def test_skips_existing(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"session": [{"startTimeMillis": "1700000000000", "endTimeMillis": "1700003600000", "name": "Running", "activityType": 8}]}'
        mock_resp.__enter__ = MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        creds = make_mock_creds()
        supabase = make_mock_supabase()
        supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "1"}
        ]

        imported, skipped = sync_exercise(creds, supabase, 1699900000000, 1700100000000)

        assert imported == 0
        assert skipped == 1


class TestSyncLogWritten:
    @patch("importers.health_connect.sync.make_aggregate_request")
    def test_sync_log_written_after_sync(self, mock_agg):
        mock_agg.return_value = AGGREGATE_RESPONSE_STEPS
        creds = make_mock_creds()
        supabase = make_mock_supabase()

        sync_steps(creds, supabase, 1699900000000, 1700100000000)

        insert_calls = supabase.table.return_value.insert.call_args_list
        assert len(insert_calls) >= 1
