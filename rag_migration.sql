-- ================================================================
-- SSAS — RAG Feature Migration
-- Run in Supabase SQL Editor AFTER the existing supabase_schema.sql
-- ================================================================
-- What this adds:
--   1. pgvector extension
--   2. Two columns on existing `resources` table (is_indexed, chunk_count)
--   3. New `document_chunks` table with 384-dim embeddings
--   4. Indexes (btree + IVFFlat cosine)
--   5. RLS policies — students read/delete only their own chunks
-- ================================================================

-- ---------------------------------------------------------------
-- 1. pgvector extension
-- ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;


-- ---------------------------------------------------------------
-- 2. Extend the existing `resources` table
--    is_indexed        — true once processing finishes
--    chunk_count       — how many chunks were produced
--    processing_status — pending, processing, indexed, failed, scanned_image_no_text
--    processing_error  — detailed message if extraction/indexing fails
--    file_hash         — SHA-256 hash to prevent duplicate processing
-- ---------------------------------------------------------------
ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS is_indexed        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chunk_count       INTEGER,
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'indexed', 'failed', 'scanned_image_no_text')),
  ADD COLUMN IF NOT EXISTS processing_error  TEXT,
  ADD COLUMN IF NOT EXISTS file_hash         TEXT;


-- ---------------------------------------------------------------
-- 3. document_chunks table
--    One row per text chunk extracted from a student's document.
--    The embedding column is a 384-dim float vector (gte-small).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id   UUID        NOT NULL REFERENCES auth.users(id)       ON DELETE CASCADE,
  resource_id  UUID        NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  chunk_index  INTEGER     NOT NULL,          -- 0-based position in document
  page_number  INTEGER,                       -- estimated page (chars / 3000)
  content      TEXT        NOT NULL,          -- raw text of this chunk
  embedding    vector(384),                   -- gte-small output (384 dims)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.document_chunks IS
  'Text chunks and vector embeddings extracted from student-uploaded documents. '
  'Used by the RAG Ask My Notes feature. Populated by the process-document Edge Function.';


-- ---------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------
-- Standard btree indexes for filtered lookups
CREATE INDEX IF NOT EXISTS idx_doc_chunks_student
  ON public.document_chunks(student_id);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_resource
  ON public.document_chunks(resource_id);

-- IVFFlat cosine similarity index
-- lists = 10 is appropriate for < 10 000 vectors.
-- NOTE: IVFFlat requires at least `lists` rows before it is useful;
-- for very small collections Postgres will automatically fall back
-- to a sequential scan, which is still correct — just slower.
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding
  ON public.document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);


-- ---------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

-- Students may SELECT only their own chunks (used for similarity search)
DROP POLICY IF EXISTS "Students can read own document chunks" ON public.document_chunks;
CREATE POLICY "Students can read own document chunks"
  ON public.document_chunks FOR SELECT
  USING (auth.uid() = student_id);

-- Students may DELETE their own chunks (triggered when a resource is deleted)
DROP POLICY IF EXISTS "Students can delete own document chunks" ON public.document_chunks;
CREATE POLICY "Students can delete own document chunks"
  ON public.document_chunks FOR DELETE
  USING (auth.uid() = student_id);

-- No INSERT policy for the anon / authenticated role.
-- Only the service_role key (used inside the Edge Function) can insert.
-- This prevents any client from injecting arbitrary vectors.


-- ---------------------------------------------------------------
-- Helper SQL function for cosine similarity search
-- Called by the backend via RPC
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding   vector(384),
  match_student_id  UUID,
  match_resource_id UUID    DEFAULT NULL,
  match_count       INTEGER DEFAULT 5,
  match_threshold   FLOAT   DEFAULT 0.35
)
RETURNS TABLE (
  id          UUID,
  resource_id UUID,
  chunk_index INTEGER,
  page_number INTEGER,
  content     TEXT,
  similarity  FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER          -- runs as owner, enforces strict student_id check in WHERE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.resource_id,
    dc.chunk_index,
    dc.page_number,
    dc.content,
    (1 - (dc.embedding <=> query_embedding))::FLOAT AS similarity
  FROM public.document_chunks dc
  WHERE
    dc.student_id = match_student_id
    AND (match_resource_id IS NULL OR dc.resource_id = match_resource_id)
    AND (1 - (dc.embedding <=> query_embedding)) >= match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.match_document_chunks IS
  'Cosine similarity search over document_chunks for a specific student + resource. '
  'Called by the ask-document Edge Function.';


-- ---------------------------------------------------------------
-- Verification queries (run after migration to confirm)
-- ---------------------------------------------------------------
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' AND tablename = 'document_chunks';
-- SELECT policyname, cmd FROM pg_policies
--   WHERE tablename = 'document_chunks';
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'resources' AND column_name IN ('is_indexed','chunk_count');
