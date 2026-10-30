"""
Tests for PDF text extraction with exact page tracking.
"""

import pymupdf as fitz
import pytest
from backend.app.pdf_processor import (
    extract_pages_from_pdf,
    compute_file_hash,
    ScannedPDFError,
    DocumentExtractionError
)


def create_sample_pdf() -> bytes:
    """Creates a 2-page test PDF in-memory using fitz."""
    doc = fitz.open()
    
    # Page 1
    page1 = doc.new_page()
    page1.insert_text(
        (50, 50),
        "Database Systems Lecture 3.\nNormalization is the process of organizing data in a database.\n"
        "First Normal Form (1NF) requires atomic values."
    )
    
    # Page 2
    page2 = doc.new_page()
    page2.insert_text(
        (50, 50),
        "Second Normal Form (2NF) eliminates partial functional dependencies.\n"
        "Third Normal Form (3NF) eliminates transitive functional dependencies."
    )
    
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def create_empty_pdf() -> bytes:
    """Creates a blank PDF with no selectable text to simulate scanned pages."""
    doc = fitz.open()
    doc.new_page()
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def test_pdf_extraction_page_count_and_content():
    pdf_bytes = create_sample_pdf()
    pages, meta = extract_pages_from_pdf(pdf_bytes)

    assert meta["total_pages"] == 2
    assert len(pages) == 2
    
    # Verify page 1
    assert pages[0]["page_number"] == 1
    assert "First Normal Form" in pages[0]["text"]
    
    # Verify page 2
    assert pages[1]["page_number"] == 2
    assert "Third Normal Form" in pages[1]["text"]


def test_scanned_or_empty_pdf_raises_error():
    empty_pdf = create_empty_pdf()
    with pytest.raises(ScannedPDFError):
        extract_pages_from_pdf(empty_pdf)


def test_file_hash_consistency():
    pdf_bytes = create_sample_pdf()
    hash1 = compute_file_hash(pdf_bytes)
    hash2 = compute_file_hash(pdf_bytes)
    assert hash1 == hash2
    assert len(hash1) == 64
