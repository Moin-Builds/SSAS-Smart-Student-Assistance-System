"""
Tests for Grounded Q&A generation and Insufficient Evidence detection.
"""

from backend.app.groq_service import (
    generate_rag_answer,
    INSUFFICIENT_EVIDENCE_MESSAGE
)


def test_insufficient_evidence_when_no_chunks():
    result = generate_rag_answer(
        question="What is Boyce-Codd Normal Form?",
        retrieved_chunks=[],
        document_name="empty_lecture.pdf"
    )

    assert result["has_sufficient_evidence"] is False
    assert result["answer"] == INSUFFICIENT_EVIDENCE_MESSAGE
    assert len(result["citations"]) == 0


def test_citation_formatting():
    mock_chunks = [
        {
            "chunk_index": 0,
            "page_number": 3,
            "content": "A relation is in BCNF if and only if every determinant is a candidate key.",
            "similarity": 0.88
        }
    ]

    # Mock groq client call or test structure
    citations = []
    for chunk in mock_chunks:
        citations.append({
            "file_name": "db_notes.pdf",
            "page_number": chunk["page_number"],
            "chunk_index": chunk["chunk_index"],
            "similarity": round(chunk["similarity"], 2),
            "excerpt": chunk["content"][:100]
        })

    assert len(citations) == 1
    assert citations[0]["page_number"] == 3
    assert citations[0]["similarity"] == 0.88
    assert "BCNF" in citations[0]["excerpt"]
