"""
Document Text Extractor using PyMuPDF.
Extracts text page-by-page, preserving accurate page references,
and detects empty or scanned PDFs.
"""

import pymupdf as fitz
import hashlib
from typing import List, Dict, Any, Tuple


class DocumentExtractionError(Exception):
    pass


class ScannedPDFError(DocumentExtractionError):
    pass


def compute_file_hash(file_bytes: bytes) -> str:
    """Computes a SHA-256 hash of the file bytes to prevent duplicate processing."""
    return hashlib.sha256(file_bytes).hexdigest()


def extract_pages_from_pdf(pdf_bytes: bytes) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Extracts text from a PDF byte stream page-by-page.
    
    Returns:
        pages: List of dicts: [{"page_number": int, "text": str, "char_count": int}]
        metadata: Dict containing total_pages, total_chars, is_scanned_likely
    """
    pages = []
    total_chars = 0

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise DocumentExtractionError(f"Could not open PDF file: {str(e)}")

    total_pages = len(doc)
    if total_pages == 0:
        doc.close()
        raise DocumentExtractionError("PDF contains 0 pages.")

    for page_idx in range(total_pages):
        page = doc[page_idx]
        text = page.get_text("text").strip()
        char_count = len(text)
        total_chars += char_count

        if char_count > 0:
            pages.append({
                "page_number": page_idx + 1,  # 1-based human readable page
                "text": text,
                "char_count": char_count
            })

    doc.close()

    # Check for empty or scanned PDF
    # If the document has pages but total extracted characters across all pages is tiny (< 30)
    if total_chars < 30:
        raise ScannedPDFError(
            "This PDF appears to be a scanned image or contains no extractable text. "
            "OCR (Optical Character Recognition) is required to index image-only documents."
        )

    metadata = {
        "total_pages": total_pages,
        "extracted_pages": len(pages),
        "total_chars": total_chars,
        "is_scanned_likely": False
    }

    return pages, metadata


def extract_text_from_file(file_bytes: bytes, file_name: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Universal extractor supporting PDF, TXT, etc.
    """
    lower_name = file_name.lower()

    if lower_name.endswith(".pdf"):
        return extract_pages_from_pdf(file_bytes)

    elif lower_name.endswith(".txt"):
        text = file_bytes.decode("utf-8", errors="replace").strip()
        if len(text) < 10:
            raise DocumentExtractionError("Text file is empty or too short.")
        return [
            {
                "page_number": 1,
                "text": text,
                "char_count": len(text)
            }
        ], {
            "total_pages": 1,
            "extracted_pages": 1,
            "total_chars": len(text),
            "is_scanned_likely": False
        }

    else:
        # Fallback for plain text attempts
        try:
            text = file_bytes.decode("utf-8", errors="replace").strip()
            if len(text) > 20:
                return [
                    {
                        "page_number": 1,
                        "text": text,
                        "char_count": len(text)
                    }
                ], {
                    "total_pages": 1,
                    "extracted_pages": 1,
                    "total_chars": len(text),
                    "is_scanned_likely": False
                }
        except Exception:
            pass

        raise DocumentExtractionError(
            f"Unsupported file format '{file_name}'. Please upload a standard PDF or TXT file."
        )
