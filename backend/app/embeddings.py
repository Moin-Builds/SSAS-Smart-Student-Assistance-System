"""
Embedding generation using SentenceTransformers.
Produces 384-dimensional normalized vector embeddings locally.
"""

from sentence_transformers import SentenceTransformer
from typing import List
from backend.app.config import settings

_model_instance = None


def get_embedding_model() -> SentenceTransformer:
    """Lazy-loads and caches the SentenceTransformer model in memory."""
    global _model_instance
    if _model_instance is None:
        _model_instance = SentenceTransformer(settings.EMBEDDING_MODEL_NAME)
    return _model_instance


def generate_embedding(text: str) -> List[float]:
    """Generates a 384-dimensional normalized embedding vector for a single text."""
    model = get_embedding_model()
    # normalize_embeddings=True ensures cosine similarity <=> dot product
    vector = model.encode(text, normalize_embeddings=True)
    return vector.tolist()


def generate_embeddings_batch(texts: List[str], batch_size: int = 32) -> List[List[float]]:
    """Generates 384-dimensional normalized embeddings for a batch of texts."""
    if not texts:
        return []
    model = get_embedding_model()
    vectors = model.encode(texts, batch_size=batch_size, normalize_embeddings=True)
    return [v.tolist() for v in vectors]
