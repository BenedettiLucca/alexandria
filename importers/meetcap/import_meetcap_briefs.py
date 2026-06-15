#!/usr/bin/env python3
"""
Meetcap Brief Importer

Scans a vault directory (default: /home/lucca/HD2/vault/Meetings/) for .md files,
parses meeting note contents, and imports/upserts them into Alexandria's Supabase backend.
"""

import os
import sys
import re
import json
import hashlib
from datetime import datetime, timezone

# Resolve name collision with local "supabase" directory when importing
# third-party supabase package
_orig_sys_path = list(sys.path)
try:
    _project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.path = [p for p in sys.path if p not in ("", ".", _project_root, os.getcwd())]
    from supabase import create_client
finally:
    sys.path = _orig_sys_path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.shared import (
    connect_supabase,
    record_sync,
)


def get_canonical_vault_path(file_path, vault_dir=None):
    """
    Derives canonical vault path (relative to the vault root) for a given file.
    """
    abs_path = os.path.abspath(file_path).replace("\\", "/")
    
    # Check for '/vault/' segment
    if "/vault/" in abs_path:
        return abs_path.split("/vault/", 1)[1]
    if "vault/" in abs_path:
        return abs_path.split("vault/", 1)[1]
        
    # Look for standard subfolder markers
    for marker in ("/Projects/", "/Meetings/"):
        if marker in abs_path:
            return marker.lstrip("/") + abs_path.split(marker, 1)[1]
            
    # Fallback using vault_dir parent
    if vault_dir:
        abs_vault_dir = os.path.abspath(vault_dir).replace("\\", "/")
        parent_dir = os.path.dirname(abs_vault_dir.rstrip("/"))
        try:
            return os.path.relpath(abs_path, parent_dir).replace("\\", "/")
        except Exception:
            pass
            
    return os.path.basename(file_path)


def extract_inline_mentions(text):
    """
    Extracts inline mentions (@username) from markdown content.
    Mentions must be preceded by space, start of string, or punctuation.
    """
    pattern = r"(?:^|[\s,.;:!?\(\)\[\]\{\}\"'])@([a-zA-Z0-9_\-]+)"
    matches = re.findall(pattern, text)
    return list(dict.fromkeys(matches))


def compute_brief_content_hash(source_job, title, brief_date, kind, body_markdown):
    """
    Computes content_hash using hashlib.sha256 over canonical JSON.
    Matches the TS computeBriefContentHash pattern.
    """
    normalized_body = body_markdown.replace("\r\n", "\n").strip()
    canonical_dict = {
        "source_job": source_job.strip(),
        "title": title.strip(),
        "brief_date": brief_date.strip(),
        "kind": kind.strip().lower(),
        "body_markdown": normalized_body
    }
    canonical_json = json.dumps(canonical_dict, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def parse_markdown_content(content, file_path):
    """
    Parses frontmatter, title, date, participants, topics, project refs,
    and tasks from a markdown file content.
    """
    frontmatter = {}
    body_markdown = content
    
    # Parse frontmatter delimited by --- at start
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            frontmatter_str = parts[1]
            # Strip frontmatter from body — only keep content after closing ---
            body_markdown = parts[2].lstrip("\n").rstrip()
            # simple YAML key-value/list parser
            current_key = None
            for line in frontmatter_str.splitlines():
                line_stripped = line.strip()
                if not line_stripped or line_stripped.startswith("#"):
                    continue
                
                # Check if it's a list item
                if line_stripped.startswith("- ") and current_key:
                    item = line_stripped[2:].strip()
                    if item.startswith('"') and item.endswith('"'):
                        item = item[1:-1]
                    elif item.startswith("'") and item.endswith("'"):
                        item = item[1:-1]
                    
                    if not isinstance(frontmatter.get(current_key), list):
                        frontmatter[current_key] = []
                    frontmatter[current_key].append(item)
                    continue
                
                if ":" in line:
                    key, val = line.split(":", 1)
                    key = key.strip()
                    val = val.strip()
                    
                    if not val:
                        frontmatter[key] = []
                        current_key = key
                    else:
                        if val.startswith("[") and val.endswith("]"):
                            items = [x.strip() for x in val[1:-1].split(",") if x.strip()]
                            cleaned_items = []
                            for item in items:
                                if item.startswith('"') and item.endswith('"'):
                                    item = item[1:-1]
                                elif item.startswith("'") and item.endswith("'"):
                                    item = item[1:-1]
                                cleaned_items.append(item)
                            frontmatter[key] = cleaned_items
                        else:
                            if val.startswith('"') and val.endswith('"'):
                                val = val[1:-1]
                            elif val.startswith("'") and val.endswith("'"):
                                val = val[1:-1]
                            
                            # Split comma-separated lists for specific keys
                            if key in ("participants", "topics", "project_refs", "entity_refs") and "," in val:
                                parts_list = [x.strip() for x in val.split(",") if x.strip()]
                                cleaned_parts = []
                                for p in parts_list:
                                    if p.startswith('"') and p.endswith('"'):
                                        p = p[1:-1]
                                    elif p.startswith("'") and p.endswith("'"):
                                        p = p[1:-1]
                                    cleaned_parts.append(p)
                                frontmatter[key] = cleaned_parts
                            else:
                                frontmatter[key] = val
                        current_key = key

    # Title extraction
    title = frontmatter.get("title")
    if not title:
        # Search for first # heading
        for line in body_markdown.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
    if not title:
        title = os.path.splitext(os.path.basename(file_path))[0]
        
    # Date extraction
    date_val = frontmatter.get("date")
    if not date_val:
        match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(file_path))
        if match:
            date_val = match.group(1)
    if not date_val:
        date_val = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        
    # Participants extraction
    participants_set = set()
    frontmatter_participants = frontmatter.get("participants", [])
    if isinstance(frontmatter_participants, list):
        for p in frontmatter_participants:
            if isinstance(p, str) and p.strip():
                participants_set.add(p.strip())
    elif isinstance(frontmatter_participants, str):
        parts_list = [x.strip() for x in frontmatter_participants.split(",") if x.strip()]
        for p in parts_list:
            participants_set.add(p)
            
    # Extract inline mentions
    inline_participants = extract_inline_mentions(content)
    for p in inline_participants:
        participants_set.add(p)
        
    participants = sorted(list(participants_set))
    
    # Project refs extraction
    project_refs_set = set()
    frontmatter_projects = frontmatter.get("project_refs", [])
    if isinstance(frontmatter_projects, list):
        for p in frontmatter_projects:
            if isinstance(p, str) and p.strip():
                project_refs_set.add(p.strip())
    elif isinstance(frontmatter_projects, str):
        parts_list = [x.strip() for x in frontmatter_projects.split(",") if x.strip()]
        for p in parts_list:
            project_refs_set.add(p)
            
    normalized_path = os.path.abspath(file_path).replace("\\", "/")
    match_proj = re.search(r"[pP]rojects/([^/]+)/[mM]eetings/", normalized_path)
    if match_proj:
        project_refs_set.add(match_proj.group(1))
        
    project_refs = sorted(list(project_refs_set))
    
    # Topics extraction
    topics_set = set()
    frontmatter_topics = frontmatter.get("topics", [])
    if isinstance(frontmatter_topics, list):
        for t in frontmatter_topics:
            if isinstance(t, str) and t.strip():
                topics_set.add(t.strip())
    elif isinstance(frontmatter_topics, str):
        parts_list = [x.strip() for x in frontmatter_topics.split(",") if x.strip()]
        for t in parts_list:
            topics_set.add(t)
            
    for line in body_markdown.splitlines():
        m = re.match(r"^#{1,6}\s+(.+)$", line)
        if m:
            heading = m.group(1).strip()
            if heading:
                topics_set.add(heading)
                
    topics = sorted(list(topics_set))
    
    # Entity refs extraction
    entity_refs_set = set()
    frontmatter_entities = frontmatter.get("entity_refs", [])
    if isinstance(frontmatter_entities, list):
        for e in frontmatter_entities:
            if isinstance(e, str) and e.strip():
                entity_refs_set.add(e.strip())
    elif isinstance(frontmatter_entities, str):
        parts_list = [x.strip() for x in frontmatter_entities.split(",") if x.strip()]
        for e in parts_list:
            entity_refs_set.add(e)
            
    entity_refs = sorted(list(entity_refs_set))
    
    # Task count count of - [ ] lines
    task_count = 0
    for line in body_markdown.splitlines():
        if re.match(r"^\s*-\s*\[ \](?:\s|$)", line):
            task_count += 1
            
    canonical_vault_path = get_canonical_vault_path(file_path)
    
    return {
        "title": title,
        "date": date_val,
        "body_markdown": body_markdown,
        "participants": participants,
        "project_refs": project_refs,
        "topics": topics,
        "entity_refs": entity_refs,
        "task_count": task_count,
        "canonical_vault_path": canonical_vault_path
    }


def import_meetcap_briefs(vault_dir, supabase):
    """
    Imports and upserts meetcap brief markdown files from vault_dir into Supabase.
    """
    md_files = []
    if os.path.isfile(vault_dir):
        md_files = [vault_dir]
    elif os.path.isdir(vault_dir):
        for root, dirs, files in os.walk(vault_dir):
            for file in files:
                if file.endswith(".md"):
                    md_files.append(os.path.join(root, file))
    else:
        print(f"Path not found: {vault_dir}")
        return 0, 0, 0
        
    md_files = sorted(md_files)
    
    imported = 0
    skipped = 0
    failed = 0
    
    for file_path in md_files:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
                
            parsed = parse_markdown_content(content, file_path)
            
            content_hash = compute_brief_content_hash(
                source_job="meetcap",
                title=parsed["title"],
                brief_date=parsed["date"],
                kind="meeting-room",
                body_markdown=parsed["body_markdown"]
            )
            
            note_path = parsed["canonical_vault_path"]
            
            # Query by content hash
            query_1 = supabase.table("briefs").select("id, content_hash").eq("source_job", "meetcap").eq("content_hash", content_hash)
            existing = query_1.maybe_single().execute() if hasattr(query_1, "maybe_single") else query_1.maybeSingle().execute()
            
            existing_data = existing.data
            if isinstance(existing_data, list) and existing_data:
                existing_data = existing_data[0]
            elif not isinstance(existing_data, dict):
                existing_data = None
                
            if existing_data:
                skipped += 1
                continue
                
            # Query by path to check if same file has updated content
            query_2 = supabase.table("briefs").select("id, content_hash").eq("source_job", "meetcap").filter("metadata->>note_path", "eq", note_path)
            existing_by_path = query_2.maybe_single().execute() if hasattr(query_2, "maybe_single") else query_2.maybeSingle().execute()
            
            existing_by_path_data = existing_by_path.data
            if isinstance(existing_by_path_data, list) and existing_by_path_data:
                existing_by_path_data = existing_by_path_data[0]
            elif not isinstance(existing_by_path_data, dict):
                existing_by_path_data = None
                
            record = {
                "source_job": "meetcap",
                "title": parsed["title"],
                "brief_date": parsed["date"],
                "kind": "meeting-room",
                "body_markdown": parsed["body_markdown"],
                "topics": parsed["topics"],
                "project_refs": parsed["project_refs"],
                "entity_refs": parsed["entity_refs"],
                "content_hash": content_hash,
                "metadata": {
                    "external_id": note_path,
                    "note_path": note_path,
                    "participants": parsed["participants"],
                    "task_count": parsed["task_count"]
                }
            }
            
            if existing_by_path_data:
                # Content changed — update
                supabase.table("briefs").update(record).eq("id", existing_by_path_data["id"]).execute()
            else:
                # New record
                supabase.table("briefs").insert(record).execute()
                
            imported += 1
            print(f"  Imported: {parsed['date']} - {parsed['title']}")
            
        except Exception as e:
            print(f"Error importing {file_path}: {e}")
            failed += 1
            
    return imported, skipped, failed


def main():
    vault_dir = sys.argv[1] if len(sys.argv) > 1 else "/home/lucca/HD2/vault/Meetings/"
    
    if not os.path.exists(vault_dir):
        print(f"Vault directory not found: {vault_dir}")
        sys.exit(1)
        
    start_time = datetime.now(timezone.utc).isoformat()
    print(f"Importing meetcap briefs from {vault_dir}...")
    
    supabase = connect_supabase()
    imported, skipped, failed = import_meetcap_briefs(vault_dir, supabase)
    
    total_processed = imported + skipped + failed
    
    record_sync(
        supabase,
        "meetcap",
        started_at=start_time,
        processed=total_processed,
        imported=imported,
        skipped=skipped,
        failed=failed,
    )
    print(f"\nBriefs: {imported} imported, {skipped} skipped, {failed} failed")
    print("Done!")


if __name__ == "__main__":
    main()
