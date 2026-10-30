"""
Configuration and Settings for SSAS AI Backend.
Loads environment variables from .env file or host environment.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from typing import Optional


class Settings(BaseSettings):
    # Supabase credentials
    SUPABASE_URL: str = Field(..., description="Supabase project URL")
    SUPABASE_ANON_KEY: str = Field(..., description="Supabase public/anon key")
    SUPABASE_SERVICE_ROLE_KEY: str = Field(..., description="Supabase service role key (backend only)")
    SUPABASE_JWT_SECRET: Optional[str] = Field(None, description="Supabase Auth JWT secret (optional if using client verification)")

    # Groq API configuration
    GROQ_API_KEY: str = Field(..., description="Groq API key for LLM generation")
    GROQ_MODEL: str = Field("llama-3.1-8b-instant", description="Groq model name")

    # Embedding configuration
    EMBEDDING_MODEL_NAME: str = Field("all-MiniLM-L6-v2", description="SentenceTransformers model")
    EMBEDDING_DIMENSION: int = Field(384, description="Expected vector dimension")

    # Document Chunking settings
    CHUNK_SIZE: int = Field(450, description="Target character size per chunk")
    CHUNK_OVERLAP: int = Field(60, description="Character overlap between consecutive chunks")
    MAX_CHUNKS_PER_DOC: int = Field(200, description="Safety cap on chunks per document")

    # Server settings
    HOST: str = Field("127.0.0.1", description="API host")
    PORT: int = Field(8000, description="API port")
    CORS_ORIGINS: list[str] = Field(["*"], description="Allowed CORS origins")

    model_config = SettingsConfigDict(
        env_file="backend/.env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
