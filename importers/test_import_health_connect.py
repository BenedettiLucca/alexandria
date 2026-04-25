import os
import sys
import sqlite3
import tempfile
import importlib.util
import pytest
from unittest.mock import MagicMock, MagicMock as MockModule
from hashlib import sha256

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "supabase" not in sys.modules:
    mock_supabase_mod = MockModule()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod

_base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location("importers.shared", os.path.join(_base, "importers", "shared.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["importers.shared"] = _mod
_spec.loader.exec_module(_mod)

sys.modules["importers.health_connect"] = type(sys)("importers.health_connect")
sys.modules["importers.health_connect"].__path__ = [os.path.join(_base, "importers", "health-connect")]

_spec = importlib.util.spec_from_file_location("importers.health_connect.import_health_connect", os.path.join(_base, "importers", "health-connect", "import_health_connect.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["importers.health_connect.import_health_connect"] = _mod
sys.modules["importers.health_connect"].import_health_connect = _mod
_spec.loader.exec_module(_mod)
import_records = _mod.import_records
import_nutrition = _mod.import_nutrition
STEPS_CONFIG = _mod.STEPS_CONFIG
SLEEP_CONFIG = _mod.SLEEP_CONFIG
EXERCISE_CONFIG = _mod.EXERCISE_CONFIG
HEART_RATE_CONFIG = _mod.HEART_RATE_CONFIG
WEIGHT_CONFIG = _mod.WEIGHT_CONFIG
BLOOD_PRESSURE_CONFIG = _mod.BLOOD_PRESSURE_CONFIG


def create_hc_db():
    db = sqlite3.connect(":memory:")
    db.execute("""
        CREATE TABLE StepsRecord (
            id INTEGER PRIMARY KEY,
            start_time INTEGER,
            end_time INTEGER,
            count INTEGER,
            steps INTEGER
        )
    """)
    db.execute("""
        CREATE TABLE SleepSessionRecord (
            id INTEGER PRIMARY KEY,
            start_time INTEGER,
            end_time INTEGER,
            stages TEXT,
            sleep_stage TEXT
        )
    """)
    db.execute("""
        CREATE TABLE ExerciseSessionRecord (
            id INTEGER PRIMARY KEY,
            start_time INTEGER,
            end_time INTEGER,
            exercise_type TEXT,
            type TEXT,
            calories REAL,
            calorie REAL,
            distance REAL,
            distance_m REAL,
            heart_rate_avg INTEGER,
            title TEXT,
            notes TEXT
        )
    """)
    db.execute("""
        CREATE TABLE HeartRateRecord (
            id INTEGER PRIMARY KEY,
            time INTEGER,
            start_time INTEGER,
            timestamp INTEGER,
            beats_per_minute INTEGER,
            bpm INTEGER,
            heart_rate INTEGER
        )
    """)
    db.execute("""
        CREATE TABLE WeightRecord (
            id INTEGER PRIMARY KEY,
            time INTEGER,
            start_time INTEGER,
            timestamp INTEGER,
            weight REAL,
            weight_kg REAL
        )
    """)
    db.execute("""
        CREATE TABLE BloodPressureRecord (
            id INTEGER PRIMARY KEY,
            time INTEGER,
            start_time INTEGER,
            systolic REAL,
            systolic_avg REAL,
            diastolic REAL,
            diastolic_avg REAL
        )
    """)
    db.execute("""
        CREATE TABLE NutritionRecord (
            id INTEGER PRIMARY KEY,
            start_time INTEGER,
            time INTEGER,
            volume REAL,
            water REAL,
            hydration REAL,
            energy REAL,
            calories REAL,
            energy_total REAL,
            protein REAL,
            fat_total REAL,
            carbs_total REAL,
            fiber REAL,
            sugar REAL,
            sodium REAL,
            caffeine REAL
        )
    """)
    return db


def save_db_to_file(db):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    sql = "\n".join(line for line in db.iterdump()
                    if line.strip() and not line.strip().startswith("COMMIT")
                    and not line.strip().startswith("BEGIN TRANSACTION"))
    conn.executescript(sql)
    conn.close()
    return path


def make_mock_supabase(existing_data=None):
    mock = MagicMock()

    def select_side(*a, **kw):
        result = MagicMock()
        result.data = existing_data or []
        chain = MagicMock()
        chain.eq.return_value.eq.return_value.execute.return_value = result
        return chain

    mock.table.return_value.select.side_effect = select_side
    mock.table.return_value.insert.return_value.execute.return_value.data = [{"id": "new"}]
    return mock


class TestImportSteps:
    def test_steps_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO StepsRecord (start_time, end_time, count) VALUES (1700000000000, 17000086400000, 8500)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, STEPS_CONFIG)

        assert imported == 1
        assert skipped == 0
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "steps"
        assert record["numeric_value"] == 8500
        assert record["tags"] == ["health-connect", "steps"]
        conn.close()
        os.unlink(path)

    def test_steps_fingerprint_dedup(self):
        db = create_hc_db()
        db.execute("INSERT INTO StepsRecord (start_time, end_time, count) VALUES (1700000000000, 17000086400000, 8500)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase(existing_data=[{"id": "1"}])

        imported, skipped = import_records(conn, mock_supabase, STEPS_CONFIG)

        assert imported == 0
        assert skipped == 1
        conn.close()
        os.unlink(path)


class TestImportSleep:
    def test_sleep_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO SleepSessionRecord (start_time, end_time, stages) VALUES (1699970000000, 1700000000000, 'deep,light,rem')")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, SLEEP_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "sleep"
        assert record["numeric_value"] is not None
        assert record["tags"] == ["health-connect", "sleep"]
        conn.close()
        os.unlink(path)


class TestImportExercise:
    def test_exercise_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO ExerciseSessionRecord (start_time, end_time, exercise_type, calories, title) VALUES (1700000000000, 1700003600000, 'running', 350.0, 'Morning Run')")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, EXERCISE_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "exercise"
        assert record["tags"] == ["health-connect", "exercise"]
        assert record["numeric_value"] == 60.0
        conn.close()
        os.unlink(path)


class TestImportHeartRate:
    def test_heart_rate_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO HeartRateRecord (time, beats_per_minute) VALUES (1700000000000, 72)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, HEART_RATE_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "heart_rate"
        assert record["numeric_value"] == 72
        assert record["tags"] == ["health-connect", "heart-rate"]
        conn.close()
        os.unlink(path)


class TestImportWeight:
    def test_weight_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO WeightRecord (time, weight) VALUES (1700000000000, 80.5)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, WEIGHT_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "weight"
        assert record["numeric_value"] == 80.5
        assert record["tags"] == ["health-connect", "weight"]
        conn.close()
        os.unlink(path)


class TestImportBloodPressure:
    def test_blood_pressure_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO BloodPressureRecord (time, systolic, diastolic) VALUES (1700000000000, 120.0, 80.0)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, BLOOD_PRESSURE_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "blood_pressure"
        assert record["numeric_value"] == 120.0
        assert record["tags"] == ["health-connect", "blood-pressure"]
        conn.close()
        os.unlink(path)


class TestImportNutrition:
    def test_water_import(self):
        db = create_hc_db()
        db.execute("INSERT INTO NutritionRecord (start_time, volume) VALUES (1700000000000, 500.0)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_nutrition(conn, mock_supabase)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["entry_type"] == "water"
        assert record["numeric_value"] == 500.0
        conn.close()
        os.unlink(path)

    def test_nutrition_import_with_macros(self):
        db = create_hc_db()
        db.execute("INSERT INTO NutritionRecord (start_time, energy, protein, fat_total, carbs_total) VALUES (1700000000000, 2200.0, 150.0, 70.0, 250.0)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_nutrition(conn, mock_supabase)

        assert imported >= 1
        nutrition_calls = [c for c in mock_supabase.table.return_value.insert.call_args_list
                           if c[0][0].get("entry_type") == "nutrition"]
        assert len(nutrition_calls) == 1
        record = nutrition_calls[0][0][0]
        assert record["value"]["protein"] == 150.0
        assert record["value"]["fat_total"] == 70.0
        assert record["value"]["carbs_total"] == 250.0
        conn.close()
        os.unlink(path)


class TestMissingFields:
    def test_missing_timestamp_skipped(self):
        db = create_hc_db()
        db.execute("INSERT INTO HeartRateRecord (bpm) VALUES (72)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, HEART_RATE_CONFIG)

        assert imported == 0
        conn.close()
        os.unlink(path)

    def test_none_fields_handled_gracefully(self):
        db = create_hc_db()
        db.execute("INSERT INTO WeightRecord (time, weight, weight_kg) VALUES (1700000000000, NULL, NULL)")
        db.commit()
        path = save_db_to_file(db)
        conn = sqlite3.connect(path)
        mock_supabase = make_mock_supabase()

        imported, skipped = import_records(conn, mock_supabase, WEIGHT_CONFIG)

        assert imported == 1
        insert_calls = mock_supabase.table.return_value.insert.call_args_list
        record = insert_calls[0][0][0]
        assert record["numeric_value"] == 0.0
        conn.close()
        os.unlink(path)
