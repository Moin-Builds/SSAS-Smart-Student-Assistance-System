"""
Vector store interface with Supabase PostgreSQL and pgvector.
Handles chunk insertion, similarity retrieval, and resource status tracking.
"""

from typing import List, Dict, Any, Optional
from backend.app.auth import supabase_admin


def get_student_resource(student_id: str, resource_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetches a resource row while strictly verifying student ownership.
    """
    res = supabase_admin.from_("resources") \
        .select("id, student_id, file_name, storage_path, processing_status, file_hash, is_indexed") \
        .eq("id", resource_id) \
        .eq("student_id", student_id) \
        .execute()
    
    if res.data and len(res.data) > 0:
        return res.data[0]
    return None


def find_existing_by_hash(student_id: str, file_hash: str) -> Optional[Dict[str, Any]]:
    """
    Checks if this student has already processed this exact file version (same SHA-256).
    """
    res = supabase_admin.from_("resources") \
        .select("id, file_name, is_indexed, chunk_count") \
        .eq("student_id", student_id) \
        .eq("file_hash", file_hash) \
        .eq("is_indexed", True) \
        .execute()

    if res.data and len(res.data) > 0:
        return res.data[0]
    return None


def update_resource_status(
    resource_id: str,
    status: str,
    chunk_count: Optional[int] = None,
    file_hash: Optional[str] = None,
    error_msg: Optional[str] = None
):
    """
    Updates the indexing and processing metadata on the resources table.
    """
    payload: Dict[str, Any] = {
        "processing_status": status,
        "is_indexed": (status == "indexed")
    }
    if chunk_count is not None:
        payload["chunk_count"] = chunk_count
    if file_hash is not None:
        payload["file_hash"] = file_hash
    if error_msg is not None:
        payload["processing_error"] = error_msg
    elif status == "indexed":
        payload["processing_error"] = None

    supabase_admin.from_("resources") \
        .update(payload) \
        .eq("id", resource_id) \
        .execute()


def save_chunks_with_embeddings(
    student_id: str,
    resource_id: str,
    chunks: List[Dict[str, Any]],
    embeddings: List[List[float]]
):
    """
    Deletes existing chunks for this resource and saves newly generated chunks + embeddings.
    """
    # Clean previous chunks if any
    supabase_admin.from_("document_chunks") \
        .delete() \
        .eq("resource_id", resource_id) \
        .execute()

    # Prepare rows for batch insert
    rows = []
    for chunk, emb in zip(chunks, embeddings):
        rows.append({
            "student_id": student_id,
            "resource_id": resource_id,
            "chunk_index": chunk["chunk_index"],
            "page_number": chunk["page_number"],
            "content": chunk["content"],
            "embedding": emb
        })

    # Insert in batches of 50
    batch_size = 50
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        res = supabase_admin.from_("document_chunks").insert(batch).execute()
        if hasattr(res, "error") and res.error:
            raise RuntimeError(f"Database chunk insertion failed: {res.error}")


def search_similar_chunks(
    student_id: str,
    query_vector: List[float],
    resource_id: Optional[str] = None,
    top_k: int = 5,
    threshold: float = 0.35
) -> List[Dict[str, Any]]:
    """
    Executes match_document_chunks RPC with pgvector cosine similarity.
    Ensures strict student_id matching at database level.
    """
    params = {
        "query_embedding": query_vector,
        "match_student_id": student_id,
        "match_resource_id": resource_id,
        "match_count": top_k,
        "match_threshold": threshold
    }

    rpc_res = supabase_admin.rpc("match_document_chunks", params).execute()
    if hasattr(rpc_res, "error") and rpc_res.error:
        raise RuntimeError(f"Vector search failed: {rpc_res.error}")

    return rpc_res.data or []
