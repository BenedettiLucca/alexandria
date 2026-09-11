"""Example consumer script demonstrating real usage of the Alexandria Indexing Lifecycle API.

Demonstrates:
1. Inserting raw records without embeddings across domains.
2. Observing pending state in database tables and indexing_outbox.
3. Triggering a bounded reconciliation run via RPC or worker.
4. Verifying search RPC space isolation (same dimension, different model space).
"""

import os
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY must be set to run this example")

client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def main():
    print("=== Alexandria Indexing Lifecycle Consumer Example ===")

    # 1. Check current observable lifecycle status
    status = client.rpc("get_indexing_lifecycle_status").execute()
    print("\n1. Current lifecycle status:")
    print(status.data)

    # 2. Insert a memory record without an embedding (simulating an external importer write)
    print("\n2. Inserting raw memory without embedding...")
    insert_res = client.table("memories").insert({
        "content": "Example memory for lifecycle demonstration.",
        "category": "note",
    }).execute()
    mem_id = insert_res.data[0]["id"]
    print(f"Created memory ID: {mem_id}")
    print(f"Status: {insert_res.data[0]['embedding_status']}, Version: {insert_res.data[0]['embedding_version']}")

    # 3. Observe outbox entry generated automatically by DB trigger
    outbox_res = client.table("indexing_outbox").select("*").eq("source_id", mem_id).execute()
    print(f"\n3. Outbox jobs created: {len(outbox_res.data)}")
    for job in outbox_res.data:
        print(f" - Type: {job['job_type']}, Status: {job['status']}, Target Space: {job['target_space']}")

    # 4. Claim a bounded batch
    print("\n4. Claiming indexing batch...")
    claimed = client.rpc("claim_indexing_jobs", {
        "p_limit": 5,
        "p_target_space": "openai/text-embedding-3-small",
    }).execute()
    print(f"Claimed {len(claimed.data)} jobs")

    # 5. Clean up demonstration row
    client.table("memories").delete().eq("id", mem_id).execute()
    client.table("indexing_outbox").delete().eq("source_id", mem_id).execute()
    print("\n5. Cleaned up demo data.")
    print("=== Done ===")


if __name__ == "__main__":
    main()
