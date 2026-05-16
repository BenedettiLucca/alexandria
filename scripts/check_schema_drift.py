#!/usr/bin/env python3
from __future__ import annotations

import difflib
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    schema_path = repo_root / "schema" / "schema.sql"
    migration_dir = repo_root / "supabase" / "migrations"
    candidates = sorted(migration_dir.glob("*_alexandria_schema.sql"))

    if not schema_path.exists():
        print(f"ERROR: missing canonical schema file: {schema_path}", file=sys.stderr)
        return 1

    if len(candidates) != 1:
        print(
            "ERROR: expected exactly one consolidated bootstrap migration matching "
            f"'*_alexandria_schema.sql', found {len(candidates)}",
            file=sys.stderr,
        )
        for candidate in candidates:
            print(f" - {candidate.relative_to(repo_root)}", file=sys.stderr)
        return 1

    migration_path = candidates[0]
    schema_text = schema_path.read_text(encoding="utf-8")
    migration_text = migration_path.read_text(encoding="utf-8")

    if schema_text == migration_text:
        print(
            "OK: schema/schema.sql matches "
            f"{migration_path.relative_to(repo_root)}"
        )
        return 0

    diff = "".join(
        difflib.unified_diff(
            migration_text.splitlines(keepends=True),
            schema_text.splitlines(keepends=True),
            fromfile=str(migration_path.relative_to(repo_root)),
            tofile=str(schema_path.relative_to(repo_root)),
        )
    )
    print("ERROR: canonical schema drift detected\n", file=sys.stderr)
    print(diff, file=sys.stderr)
    print(
        "Workflow: update schema/schema.sql first, mirror the same change into the "
        "consolidated bootstrap migration, and create/apply an incremental Supabase "
        "migration separately when an existing remote project needs the delta.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
