import os
import sys
import tempfile
import json
import pytest
from unittest.mock import patch, MagicMock

# Ensure importers is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Mock supabase module if not already mocked/loaded
if "supabase" not in sys.modules:
    mock_supabase_mod = MagicMock()
    mock_supabase_mod.create_client = MagicMock()
    sys.modules["supabase"] = mock_supabase_mod

from importers.meetcap.import_meetcap_briefs import (
    parse_markdown_content,
    compute_brief_content_hash,
    get_canonical_vault_path,
    import_meetcap_briefs,
)


def test_parse_frontmatter():
    """
    1. Parsing markdown frontmatter -> title, date, participants, topics, project_refs
    """
    content = """---
title: "Project Kickoff"
date: "2026-06-15"
participants: ["Alice", "Bob"]
topics: ["kickoff", "admin"]
project_refs: ["my-proj"]
---
# Main Heading
Some text.
- [ ] Task 1
- [ ] Task 2
"""
    result = parse_markdown_content(content, "/vault/Meetings/meeting.md")
    assert result["title"] == "Project Kickoff"
    assert result["date"] == "2026-06-15"
    assert result["participants"] == ["Alice", "Bob"]
    assert "Main Heading" in result["topics"]
    assert "kickoff" in result["topics"]
    assert "my-proj" in result["project_refs"]


def test_parse_title_from_heading_when_no_frontmatter():
    """
    2. Parsing title from first heading when no frontmatter
    """
    content = """# First Heading
Some body text.
"""
    result = parse_markdown_content(content, "/vault/Meetings/meeting.md")
    assert result["title"] == "First Heading"


def test_deriving_date_from_filename_when_no_frontmatter_date():
    """
    3. Deriving date from filename when no frontmatter date
    """
    content = """# Title
Some text.
"""
    result = parse_markdown_content(content, "/vault/Meetings/2026-05-20-sync.md")
    assert result["date"] == "2026-05-20"


def test_extracting_project_ref_from_path():
    """
    4. Extracting project_ref from path like Projects/<project>/Meetings/
    """
    content = """# Title
Some text.
"""
    result = parse_markdown_content(content, "/vault/Projects/my-cool-project/Meetings/meeting.md")
    assert "my-cool-project" in result["project_refs"]


def test_counting_tasks_in_body():
    """
    5. Counting tasks (- [ ] lines) in body
    """
    content = """# Title
- [ ] Task 1
  - [ ] Indented Task 2
Not a task:
- [x] Completed task
- [ ]Task with no space after bracket
- [ ] Another valid task
"""
    result = parse_markdown_content(content, "/vault/Meetings/meeting.md")
    assert result["task_count"] == 3  # Task 1, Indented Task 2, Another valid task


def test_computing_content_hash_deterministically():
    """
    6. Computing content_hash deterministically
    """
    h1 = compute_brief_content_hash(
        source_job="meetcap",
        title="Morning Brief",
        brief_date="2026-06-06",
        kind="meeting-room",
        body_markdown="## Summary\nLine 1\nLine 2\n"
    )
    h2 = compute_brief_content_hash(
        source_job="meetcap",
        title="Morning Brief",
        brief_date="2026-06-06",
        kind="meeting-room",
        body_markdown="\r\n## Summary\r\nLine 1\r\nLine 2\r\n"
    )
    assert h1 == h2


class TestImportMeetcapBriefsSupabase:
    @patch("importers.meetcap.import_meetcap_briefs.record_sync")
    def test_idempotent_import_and_update(self, mock_record_sync):
        """
        7. Idempotent import (same file twice -> no duplicate)
        8. Update on content change (same path, different hash -> update)
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = os.path.join(tmpdir, "2026-06-15-meeting.md")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write("""---
title: "Idempotency Test"
date: "2026-06-15"
participants: ["Alice"]
---
# Welcome
- [ ] Task A
""")

            # 1. Setup mock Supabase
            mock_supabase = MagicMock()
            
            # Response for empty/not-exists
            mock_response_empty = MagicMock()
            mock_response_empty.data = []
            
            # Default behavior: not exists in query_1 or query_2
            mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value = mock_response_empty
            mock_supabase.table.return_value.select.return_value.eq.return_value.filter.return_value.maybe_single.return_value.execute.return_value = mock_response_empty
            
            # Execute first import (insert new record)
            imported, skipped, failed = import_meetcap_briefs(tmpdir, mock_supabase)
            
            assert imported == 1
            assert skipped == 0
            assert failed == 0
            mock_supabase.table.return_value.insert.assert_called_once()
            mock_supabase.table.return_value.update.assert_not_called()
            
            # 2. Reset mock calls
            mock_supabase.reset_mock()
            
            # Response for exact match (dedup skip)
            mock_response_exists = MagicMock()
            mock_response_exists.data = [{"id": "uuid-123", "content_hash": "some-hash"}]
            
            # Setup query_1 (by hash) to return exists
            mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value = mock_response_exists
            
            # Execute second import (exact duplicate by hash)
            imported, skipped, failed = import_meetcap_briefs(tmpdir, mock_supabase)
            assert imported == 0
            assert skipped == 1
            assert failed == 0
            mock_supabase.table.return_value.insert.assert_not_called()
            mock_supabase.table.return_value.update.assert_not_called()

            # 3. Reset mock calls
            mock_supabase.reset_mock()

            # Setup query_1 (by hash) to return empty
            mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value = mock_response_empty
            # Setup query_2 (by path) to return existing (content changed but path exists)
            mock_supabase.table.return_value.select.return_value.eq.return_value.filter.return_value.maybe_single.return_value.execute.return_value = mock_response_exists
            
            # Execute third import (update existing path)
            imported, skipped, failed = import_meetcap_briefs(tmpdir, mock_supabase)
            
            assert imported == 1
            assert skipped == 0
            assert failed == 0
            mock_supabase.table.return_value.update.assert_called_once()
            mock_supabase.table.return_value.insert.assert_not_called()


    @patch("importers.meetcap.import_meetcap_briefs.connect_supabase")
    @patch("importers.meetcap.import_meetcap_briefs.import_meetcap_briefs")
    @patch("importers.meetcap.import_meetcap_briefs.record_sync")
    @patch("sys.argv", ["import_meetcap_briefs.py", "/vault/Meetings/"])
    @patch("os.path.exists", return_value=True)
    def test_main_calls_record_sync(self, mock_exists, mock_record_sync, mock_import, mock_connect):
        """
        9. Record sync is called
        """
        from importers.meetcap.import_meetcap_briefs import main
        mock_import.return_value = (5, 2, 0)
        main()
        mock_record_sync.assert_called_once()
        call_args = mock_record_sync.call_args[1]
        assert call_args["processed"] == 7
        assert call_args["imported"] == 5
        assert call_args["skipped"] == 2
        assert call_args["failed"] == 0
