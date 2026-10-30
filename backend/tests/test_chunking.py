"""
Tests for sentence-aware chunking and page attribution preservation.
"""

from backend.app.chunker import chunk_pages


def test_chunking_preserves_page_numbers():
    pages = [
        {
            "page_number": 1,
            "text": "This is page one content discussing relational algebra and database models."
        },
        {
            "page_number": 2,
            "text": "This is page two content discussing query optimization and indexing techniques."
        }
    ]

    chunks = chunk_pages(pages, chunk_size=200, chunk_overlap=30)
    assert len(chunks) >= 2

    # Verify each chunk has a valid page number matching its source
    page1_chunks = [c for c in chunks if c["page_number"] == 1]
    page2_chunks = [c for c in chunks if c["page_number"] == 2]

    assert len(page1_chunks) >= 1
    assert len(page2_chunks) >= 1
    assert "relational algebra" in page1_chunks[0]["content"]
    assert "query optimization" in page2_chunks[0]["content"]


def test_chunking_respects_max_chunks():
    pages = [
        {
            "page_number": 1,
            "text": "Sentence repeated. " * 50
        }
    ]
    max_limit = 3
    chunks = chunk_pages(pages, chunk_size=50, chunk_overlap=10, max_chunks=max_limit)
    assert len(chunks) <= max_limit
