import os
import sys
import sqlite3
import tempfile
import json
import importlib.util
from unittest.mock import MagicMock, MagicMock as MockModule

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "supabase" not in sys.modules:
    mock_supabase_mod = MockModule()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod

_base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if "importers.shared" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "importers.shared", os.path.join(_base, "importers", "shared.py")
    )
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules["importers.shared"] = _mod
    _spec.loader.exec_module(_mod)

sys.modules["importers.iron_log"] = type(sys)("importers.iron_log")
sys.modules["importers.iron_log"].__path__ = [
    os.path.join(_base, "importers", "iron-log")
]

_spec = importlib.util.spec_from_file_location(
    "importers.iron_log.import_ironlog",
    os.path.join(_base, "importers", "iron-log", "import_ironlog.py"),
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["importers.iron_log.import_ironlog"] = _mod
sys.modules["importers.iron_log"].import_ironlog = _mod
_spec.loader.exec_module(_mod)
import_sessions = _mod.import_sessions
import_body_metrics = _mod.import_body_metrics
import_from_json = _mod.import_from_json
import_personal_records = _mod.import_personal_records
import_measurement_goals = _mod.import_measurement_goals


def create_test_db():
    db = sqlite3.connect(":memory:")
    db.execute("""
        CREATE TABLE sessions (
            id INTEGER PRIMARY KEY,
            routine_id INTEGER,
            start_time INTEGER,
            end_time INTEGER,
            duration_minutes INTEGER,
            body_weight REAL,
            s_rpe INTEGER,
            notes TEXT,
            deleted_at INTEGER
        )
    """)
    db.execute("""
        CREATE TABLE sets (
            id INTEGER PRIMARY KEY,
            session_id INTEGER,
            exercise_name TEXT,
            exercise_id INTEGER,
            set_number INTEGER,
            weight_kg REAL,
            reps INTEGER,
            duration_seconds INTEGER,
            rir REAL,
            is_warmup INTEGER,
            deleted_at INTEGER
        )
    """)
    db.execute("""
        CREATE TABLE exercises (
            id INTEGER PRIMARY KEY,
            name TEXT,
            type TEXT
        )
    """)
    db.execute("""
        CREATE TABLE routines (
            id INTEGER PRIMARY KEY,
            name TEXT
        )
    """)
    db.execute("""
        CREATE TABLE body_metrics (
            id INTEGER PRIMARY KEY,
            date INTEGER,
            weight REAL,
            waist REAL,
            arm_right REAL,
            thigh_right REAL,
            chest REAL,
            calf REAL,
            type TEXT
        )
    """)
    return db


def insert_strength_data(db):
    db.execute("INSERT INTO routines (id, name) VALUES (1, 'Push Day')")
    db.execute("""
        INSERT INTO sessions (id, routine_id, start_time, end_time, duration_minutes, body_weight, s_rpe, notes, deleted_at)
        VALUES (1, 1, 1700000000000, 1700003600000, 60, 80.5, 7, 'Good session', NULL)
    """)
    db.execute(
        "INSERT INTO exercises (id, name, type) VALUES (1, 'Bench Press', 'strength')"
    )
    db.execute("INSERT INTO exercises (id, name, type) VALUES (2, 'OHP', 'strength')")
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (1, 1, 'Bench Press', 1, 1, 60.0, 10, NULL, 2.0, 1, NULL)
    """)
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (2, 1, 'Bench Press', 1, 2, 80.0, 5, NULL, 1.0, 0, NULL)
    """)
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (3, 1, 'Bench Press', 1, 3, 80.0, 5, NULL, 0.0, 0, NULL)
    """)
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (4, 1, 'OHP', 2, 1, 40.0, 8, NULL, 2.0, 0, NULL)
    """)
    db.commit()


def insert_cardio_data(db):
    db.execute("INSERT INTO routines (id, name) VALUES (2, 'Cardio')")
    db.execute("""
        INSERT INTO sessions (id, routine_id, start_time, end_time, duration_minutes, body_weight, s_rpe, notes, deleted_at)
        VALUES (2, 2, 1700086400000, 1700093600000, 120, NULL, 5, NULL, NULL)
    """)
    db.execute(
        "INSERT INTO exercises (id, name, type) VALUES (3, 'Running', 'duration')"
    )
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (5, 2, 'Running', 3, 1, NULL, NULL, 1800, NULL, 0, NULL)
    """)
    db.commit()


def insert_mixed_data(db):
    db.execute("INSERT INTO routines (id, name) VALUES (3, 'Full Body')")
    db.execute("""
        INSERT INTO sessions (id, routine_id, start_time, end_time, duration_minutes, body_weight, s_rpe, notes, deleted_at)
        VALUES (3, 3, 1700172800000, 1700176400000, 60, NULL, 6, NULL, NULL)
    """)
    db.execute("INSERT INTO exercises (id, name, type) VALUES (4, 'Squat', 'strength')")
    db.execute(
        "INSERT INTO exercises (id, name, type) VALUES (5, 'Rowing', 'duration')"
    )
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (6, 3, 'Squat', 4, 1, 100.0, 5, NULL, 1.0, 0, NULL)
    """)
    db.execute("""
        INSERT INTO sets (id, session_id, exercise_name, exercise_id, set_number, weight_kg, reps, duration_seconds, rir, is_warmup, deleted_at)
        VALUES (7, 3, 'Rowing', 5, 1, NULL, NULL, 600, NULL, 0, NULL)
    """)
    db.commit()


def insert_body_metrics(db):
    db.executemany(
        """
        INSERT INTO body_metrics (id, date, weight, waist, arm_right, thigh_right, chest, calf, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """,
        [
            (1, 1700000000000, 80.5, 85.0, 33.0, 58.0, 100.0, 38.0, "measurements"),
            (2, 1700086400000, 80.2, None, None, None, None, None, None),
            (3, 1700172800000, None, 84.5, 32.5, 57.0, 99.0, 37.5, "measurements"),
        ],
    )
    db.commit()


def create_mock_supabase(dedup_exists=False):
    mock_supabase = MagicMock()
    mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = (
        [{"id": "existing"}] if dedup_exists else []
    )
    mock_supabase.table.return_value.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = (
        [{"id": "existing"}] if dedup_exists else []
    )

    _last_insert_record = {}

    def insert_side_effect(record, **kwargs):
        _last_insert_record["record"] = record
        builder = MagicMock()
        builder.execute.return_value.data = (
            []
            if (not record or not record.get("name") and not record.get("entry_type"))
            else [{"id": "new"}]
        )
        return builder

    mock_supabase.table.return_value.insert.side_effect = insert_side_effect
    return mock_supabase


class TestImportSessions:
    def test_groups_sets_by_exercise_name(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("name")
        ]
        assert len(insert_calls) == 1
        record = insert_calls[0][0][0]
        exercise_names = [e["name"] for e in record["exercises"]]
        assert "Bench Press" in exercise_names
        assert "OHP" in exercise_names
        bench = [e for e in record["exercises"] if e["name"] == "Bench Press"][0]
        assert len(bench["sets"]) == 3
        db.close()

    def test_volume_excludes_warmup_sets(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("name")
        ]
        record = insert_calls[0][0][0]
        expected_volume = 80.0 * 5 + 80.0 * 5 + 40.0 * 8
        assert record["volume_kg"] == expected_volume
        db.close()

    def test_workout_type_strength(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("workout_type")
        ]
        assert insert_calls[0][0][0]["workout_type"] == "strength"
        db.close()

    def test_workout_type_cardio(self):
        db = create_test_db()
        insert_cardio_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("workout_type")
        ]
        assert insert_calls[0][0][0]["workout_type"] == "cardio"
        db.close()

    def test_workout_type_other_mixed(self):
        db = create_test_db()
        insert_mixed_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("workout_type")
        ]
        assert insert_calls[0][0][0]["workout_type"] == "other"
        db.close()

    def test_dedup_skips_existing(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase(dedup_exists=True)

        imported, skipped = import_sessions(db_path, mock_supabase)

        assert imported == 0
        assert skipped >= 1
        actual_inserts = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("name")
        ]
        assert len(actual_inserts) == 0
        db.close()

    def test_duration_from_timestamps(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("duration_s")
        ]
        assert insert_calls[0][0][0]["duration_s"] == 3600
        db.close()


class TestImportBodyMetrics:
    def test_weight_imports_as_weight_entry(self):
        db = create_test_db()
        insert_body_metrics(db)
        db_path = db_filename(db)
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        import_body_metrics(db_path, mock_supabase)

        weight_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("entry_type") == "weight"
        ]
        assert len(weight_calls) >= 2
        assert weight_calls[0][0][0]["numeric_value"] == 80.5
        db.close()

    def test_measurements_import_as_body_composition(self):
        db = create_test_db()
        insert_body_metrics(db)
        db_path = db_filename(db)
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        import_body_metrics(db_path, mock_supabase)

        bc_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("entry_type") == "body_composition"
        ]
        assert len(bc_calls) >= 2
        for c in bc_calls:
            assert c[0][0]["entry_type"] == "body_composition"
            assert c[0][0]["tags"] == ["iron-log", "body-measurements"]
        db.close()

    def test_measurements_not_nutrition(self):
        db = create_test_db()
        insert_body_metrics(db)
        db_path = db_filename(db)
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        import_body_metrics(db_path, mock_supabase)

        for c in mock_supabase.table.return_value.insert.call_args_list:
            assert c[0][0].get("entry_type") != "nutrition"
        db.close()

    def test_only_measurements_no_weight_still_imports(self):
        db = create_test_db()
        insert_body_metrics(db)
        db_path = db_filename(db)
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        import_body_metrics(db_path, mock_supabase)

        metric3_bc = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("external_id") == "1700172800000-measurements"
        ]
        assert len(metric3_bc) == 1
        assert metric3_bc[0][0][0]["value"]["waist"] == 84.5
        db.close()


class TestImportSessionsTwice:
    def test_second_run_imports_zero(self):
        db = create_test_db()
        insert_strength_data(db)
        db_path = db_filename(db)
        mock_supabase = MagicMock()

        def mock_select_side_effect(*args, **kwargs):
            result = MagicMock()
            result.data = [{"id": "existing"}]
            chain = MagicMock()
            chain.eq.return_value.eq.return_value.execute.return_value = result
            return chain

        mock_supabase.table.return_value.select.side_effect = mock_select_side_effect
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        import_sessions(db_path, mock_supabase)
        imported1, _ = import_sessions(db_path, mock_supabase)

        assert imported1 == 0
        db.close()


class TestImportFromJson:
    def test_imports_sessions_and_metrics(self, tmp_path):
        json_data = {
            "export_version": 1,
            "exported_at": "2026-04-26T15:30:00Z",
            "sessions": [
                {
                    "external_id": "session-42",
                    "workout_date": "2026-04-25",
                    "workout_type": "strength",
                    "name": "Upper A",
                    "exercises": [],
                    "duration_s": 3600,
                    "volume_kg": 2400,
                    "rpe": 8,
                    "notes": "Bom treino",
                    "tags": ["iron-log", "strength"],
                    "metadata": {},
                }
            ],
            "body_metrics": [
                {
                    "external_id": "metric-1700000000000",
                    "entry_type": "weight",
                    "timestamp": "2023-11-14T22:13:20+00:00",
                    "numeric_value": 80.5,
                    "value": {"weight_kg": 80.5},
                    "source": "iron-log",
                    "tags": ["iron-log"],
                }
            ],
            "personal_records": [],
            "measurement_goals": [],
        }
        json_path = tmp_path / "export.json"
        json_path.write_text(json.dumps(json_data))

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        imported, skipped = import_from_json(str(json_path), mock_supabase)

        assert imported == 2
        assert skipped == 0

        session_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("external_id") == "session-42"
        ]
        assert len(session_calls) == 1
        assert session_calls[0][0][0]["workout_type"] == "strength"

        metric_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("external_id") == "metric-1700000000000"
        ]
        assert len(metric_calls) == 1
        assert metric_calls[0][0][0]["entry_type"] == "weight"

    def test_imports_prs_and_goals(self, tmp_path):
        json_data = {
            "export_version": 1,
            "exported_at": "2026-04-26T15:30:00Z",
            "sessions": [],
            "body_metrics": [],
            "personal_records": [
                {
                    "external_id": "pr-weight-1",
                    "exercise_name": "Supino Reto (Barra)",
                    "record_type": "weight",
                    "value": 100,
                    "weight_kg": 100,
                    "reps": 1,
                    "estimated_1rm": 100,
                    "date": "2026-04-20T10:00:00+00:00",
                }
            ],
            "measurement_goals": [
                {
                    "external_id": "goal-waist-1",
                    "type": "waist",
                    "target_value": 80.0,
                    "start_date": "2026-01-01T00:00:00+00:00",
                    "target_date": "2026-06-30T00:00:00+00:00",
                    "achieved": False,
                }
            ],
        }
        json_path = tmp_path / "export.json"
        json_path.write_text(json.dumps(json_data))

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        imported, skipped = import_from_json(str(json_path), mock_supabase)

        assert imported == 2
        assert skipped == 0

        pr_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("external_id") == "pr-weight-1"
        ]
        assert len(pr_calls) == 1
        assert pr_calls[0][0][0]["entry_type"] == "personal_record"
        assert pr_calls[0][0][0]["value"]["exercise_name"] == "Supino Reto (Barra)"

        goal_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("external_id") == "goal-waist-1"
        ]
        assert len(goal_calls) == 1
        assert goal_calls[0][0][0]["entry_type"] == "measurement_goal"
        assert goal_calls[0][0][0]["value"]["goal_type"] == "waist"

    def test_dedup_on_reimport(self, tmp_path):
        json_data = {
            "export_version": 1,
            "exported_at": "2026-04-26T15:30:00Z",
            "sessions": [
                {
                    "external_id": "session-42",
                    "workout_date": "2026-04-25",
                    "workout_type": "strength",
                    "name": "Upper A",
                    "exercises": [],
                    "duration_s": 3600,
                    "volume_kg": 2400,
                    "rpe": 8,
                    "notes": "Bom treino",
                    "tags": ["iron-log", "strength"],
                    "metadata": {},
                }
            ],
            "body_metrics": [],
            "personal_records": [],
            "measurement_goals": [],
        }
        json_path = tmp_path / "export.json"
        json_path.write_text(json.dumps(json_data))

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "existing"}
        ]
        mock_supabase.table.return_value.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "existing"}
        ]

        imported, skipped = import_from_json(str(json_path), mock_supabase)

        assert imported == 1  # session upserted (update counts as processed)
        assert skipped == 0

    def test_empty_json(self, tmp_path):
        json_data = {
            "export_version": 1,
            "exported_at": "2026-04-26T15:30:00Z",
            "sessions": [],
            "body_metrics": [],
            "personal_records": [],
            "measurement_goals": [],
        }
        json_path = tmp_path / "export.json"
        json_path.write_text(json.dumps(json_data))

        mock_supabase = MagicMock()

        imported, skipped = import_from_json(str(json_path), mock_supabase)

        assert imported == 0
        assert skipped == 0

    def test_malformed_json_raises_error(self, tmp_path):
        json_path = tmp_path / "export.json"
        json_path.write_text("not valid json")

        mock_supabase = MagicMock()

        try:
            import_from_json(str(json_path), mock_supabase)
            assert False, "Expected JSONDecodeError"
        except Exception:
            pass


class TestSoftDeleteFiltering:
    def test_deleted_session_skipped(self):
        db = create_test_db()
        insert_strength_data(db)
        db.execute("UPDATE sessions SET deleted_at = 1700000000000 WHERE id = 1")
        db.commit()
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        imported, skipped = import_sessions(db_path, mock_supabase)

        assert imported == 0
        assert skipped == 0
        db.close()

    def test_deleted_set_excluded_from_volume(self):
        db = create_test_db()
        insert_strength_data(db)
        db.execute("UPDATE sets SET deleted_at = 1700000000000 WHERE id = 2")
        db.commit()
        db_path = db_filename(db)
        mock_supabase = create_mock_supabase()

        import_sessions(db_path, mock_supabase)

        insert_calls = [
            c
            for c in mock_supabase.table.return_value.insert.call_args_list
            if c[0][0].get("name")
        ]
        record = insert_calls[0][0][0]
        expected_volume = 80.0 * 5 + 40.0 * 8  # one 80x5 set deleted
        assert record["volume_kg"] == expected_volume
        db.close()


class TestImportPersonalRecords:
    def test_maps_pr_to_health_entry(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        prs = [
            {
                "external_id": "pr-1",
                "exercise_name": "Squat",
                "record_type": "weight",
                "value": 150,
                "weight_kg": 150,
                "reps": 1,
                "estimated_1rm": 150,
                "date": "2026-04-20T10:00:00+00:00",
            }
        ]

        imported, skipped = import_personal_records(prs, mock_supabase)

        assert imported == 1
        assert skipped == 0
        call = mock_supabase.table.return_value.insert.call_args_list[0]
        assert call[0][0]["entry_type"] == "personal_record"
        assert call[0][0]["value"]["exercise_name"] == "Squat"
        assert call[0][0]["tags"] == ["iron-log", "personal-record", "weight"]

    def test_skips_pr_without_external_id(self):
        mock_supabase = MagicMock()

        prs = [
            {
                "exercise_name": "Squat",
                "record_type": "weight",
                "value": 150,
            }
        ]

        imported, skipped = import_personal_records(prs, mock_supabase)

        assert imported == 0
        assert skipped == 1


class TestImportMeasurementGoals:
    def test_maps_goal_to_health_entry(self):
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "new"}
        ]

        goals = [
            {
                "external_id": "goal-1",
                "type": "waist",
                "target_value": 80.0,
                "start_date": "2026-01-01T00:00:00+00:00",
                "target_date": "2026-06-30T00:00:00+00:00",
                "achieved": False,
            }
        ]

        imported, skipped = import_measurement_goals(goals, mock_supabase)

        assert imported == 1
        assert skipped == 0
        call = mock_supabase.table.return_value.insert.call_args_list[0]
        assert call[0][0]["entry_type"] == "measurement_goal"
        assert call[0][0]["value"]["goal_type"] == "waist"
        assert call[0][0]["tags"] == ["iron-log", "measurement-goal"]

    def test_skips_goal_without_external_id(self):
        mock_supabase = MagicMock()

        goals = [
            {
                "type": "waist",
                "target_value": 80.0,
            }
        ]

        imported, skipped = import_measurement_goals(goals, mock_supabase)

        assert imported == 0
        assert skipped == 1


def db_filename(db):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    backup = sqlite3.connect(path)
    db.backup(backup)
    backup.close()
    return path
