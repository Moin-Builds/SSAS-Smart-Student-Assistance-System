"""
Text chunking module with accurate page number attribution.
Chunks text with overlaps while preserving source page references.
"""

from typing import List, Dict, Any
import re


def chunk_pages(
    pages: List[Dict[str, Any]],
    chunk_size: int = 450,
    chunk_overlap: int = 60,
    max_chunks: int = 200
) -> List[Dict[str, Any]]:
    """
    Chunks extracted pages while preserving the exact page number.
    By chunking page-by-page, each chunk is strictly attributed to the
    exact physical page of the document from which it originated.

    Returns:
        List of dicts: [
            {
                "chunk_index": int,
                "page_number": int,
                "content": str,
                "char_length": int
            }
        ]
    """
    chunks = []
    chunk_index = 0

    for page in pages:
        page_num = page["page_number"]
        raw_text = page["text"]

        # Clean consecutive whitespace but preserve paragraph breaks
        cleaned_text = re.sub(r'[ \t]+', ' ', raw_text)
        cleaned_text = re.sub(r'\n{3,}', '\n\n', cleaned_text).strip()

        if not cleaned_text:
            continue

        # If the page text fits comfortably in one chunk
        if len(cleaned_text) <= chunk_size:
            chunks.append({
                "chunk_index": chunk_index,
                "page_number": page_num,
                "content": cleaned_text,
                "char_length": len(cleaned_text)
            })
            chunk_index += 1
            if len(chunks) >= max_chunks:
                break
            continue

        # Otherwise, split with sliding window over paragraphs/sentences
        start = 0
        text_len = len(cleaned_text)

        while start < text_len:
            end = min(start + chunk_size, text_len)

            # Try not to break in the middle of a word if possible
            if end < text_len:
                last_space = cleaned_text.rfind(' ', start, end)
                if last_space > start + int(chunk_size * 0.6):
                    end = last_space

            slice_text = cleaned_text[start:end].strip()

            if len(slice_text) >= 20:  # Ignore trivial remnants
                chunks.append({
                    "chunk_index": chunk_index,
                    "page_number": page_num,
                    "content": slice_text,
                    "char_length": len(slice_text)
                })
                chunk_index += 1
                if len(chunks) >= max_chunks:
                    break

            if end >= text_len:
                break

            # Advance by step size (chunk_size - chunk_overlap)
            step = max(chunk_size - chunk_overlap, 50)
            start += step

        if len(chunks) >= max_chunks:
            break

    return chunks
