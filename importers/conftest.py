import os
import sys
import tempfile
import sqlite3
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if "supabase" not in sys.modules:
    mock_supabase_mod = MagicMock()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod


def db_to_file(db):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    backup = sqlite3.connect(path)
    db.backup(backup)
    backup.close()
    return path
