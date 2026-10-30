"""
Tests for SentenceTransformers embedding generation and dimension matching.
"""

from backend.app.embeddings import generate_embedding, generate_embeddings_batch
from backend.app.config import settings


def test_embedding_dimension_and_normalization():
    text = "Relational database normalization 3NF."
    vector = generate_embedding(text)

    # Must match settings dimension (384 for all-MiniLM-L6-v2)
    assert len(vector) == settings.EMBEDDING_DIMENSION
    assert all(isinstance(v, float) for v in vector)

    # Since vector is normalized, norm ~ 1.0 (dot product with self ~ 1.0)
    norm = sum(v * v for v in vector) ** 0.5
    assert abs(norm - 1.0) < 1e-4


def test_batch_embeddings():
    texts = [
        "First normal form atomicity.",
        "Second normal form partial dependencies.",
        "Third normal form transitive dependencies."
    ]
    vectors = generate_embeddings_batch(texts)
    assert len(vectors) == 3
    assert len(vectors[0]) == settings.EMBEDDING_DIMENSION
    assert len(vectors[1]) == settings.EMBEDDING_DIMENSION
    assert len(vectors[2]) == settings.EMBEDDING_DIMENSION
