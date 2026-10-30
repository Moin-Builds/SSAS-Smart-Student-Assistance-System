"""
LLM service for Grounded Document Question Answering.
Generates factually grounded answers backed by retrieved context passages,
with structured citations and honest insufficient-evidence fallback.
"""

from typing import List, Dict, Any, Optional
from backend.app.gemini_service import generate_text


INSUFFICIENT_EVIDENCE_MESSAGE = (
    "I cannot find sufficient evidence in your uploaded document(s) to answer this question. "
    "Please make sure this topic is covered in your uploaded notes or try rephrasing."
)


def generate_rag_answer(
    question: str,
    retrieved_chunks: List[Dict[str, Any]],
    document_name: str,
    chat_history: Optional[List[Dict[str, str]]] = None
) -> Dict[str, Any]:
    """
    Synthesizes an answer grounded strictly in retrieved chunks.
    
    Returns:
        {
            "answer": str,
            "has_sufficient_evidence": bool,
            "citations": List[Dict[str, Any]]
        }
    """
    if not retrieved_chunks:
        return {
            "answer": INSUFFICIENT_EVIDENCE_MESSAGE,
            "has_sufficient_evidence": False,
            "citations": []
        }

    # Format context passages with explicit page citations
    context_blocks = []
    citations = []

    for chunk in retrieved_chunks:
        page_num = chunk.get("page_number", 1)
        chunk_idx = chunk.get("chunk_index", 0)
        content = chunk.get("content", "").strip()
        similarity = round(float(chunk.get("similarity", 0.0)), 2)

        context_blocks.append(
            f"--- [PASSAGE from '{document_name}' | Page {page_num} | Index {chunk_idx + 1}] ---\n{content}"
        )

        citations.append({
            "file_name": document_name,
            "page_number": page_num,
            "chunk_index": chunk_idx,
            "similarity": similarity,
            "excerpt": (content[:180] + "...") if len(content) > 180 else content
        })

    combined_context = "\n\n".join(context_blocks)

    system_prompt = (
        "You are an academic study assistant helping a student understand their uploaded course materials.\n"
        "RULES:\n"
        "1. Answer ONLY using the facts directly stated in the PROVIDED DOCUMENT PASSAGES below.\n"
        "2. When explaining concepts, explicitly cite the relevant source page (e.g., 'According to Page X...').\n"
        "3. If the provided passages do NOT contain enough information to answer the question accurately, "
        f"reply clearly: '{INSUFFICIENT_EVIDENCE_MESSAGE}'. Do NOT invent details.\n"
        "4. Be clear, academic, structured, and pedagogical."
    )

    user_prompt = (
        f"DOCUMENT NAME: {document_name}\n\n"
        f"PROVIDED DOCUMENT PASSAGES:\n{combined_context}\n\n"
        f"STUDENT QUESTION:\n{question}\n\n"
        "ANSWER:"
    )

    messages = [{"role": "system", "content": system_prompt}]

    # Include recent conversational history if present (for follow-ups)
    if chat_history:
        for msg in chat_history[-4:]:  # last 2 turns
            if msg.get("role") in ("user", "assistant") and msg.get("content"):
                messages.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })

    messages.append({"role": "user", "content": user_prompt})

    answer_text = generate_text(messages, max_tokens=750)

    # Verify if model gave an insufficient evidence response
    has_evidence = INSUFFICIENT_EVIDENCE_MESSAGE.lower() not in answer_text.lower()

    return {
        "answer": answer_text,
        "has_sufficient_evidence": has_evidence,
        "citations": citations if has_evidence else []
    }
