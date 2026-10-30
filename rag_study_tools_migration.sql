-- SSAS Feature 2: RAG-grounded quizzes and flashcards.
-- Run after supabase_schema.sql and rag_migration.sql.
-- All writes are performed by the authenticated FastAPI service-role client.

CREATE TABLE IF NOT EXISTS public.study_sets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id     UUID REFERENCES public.resources(id) ON DELETE SET NULL,
  course          TEXT,
  parent_set_id   UUID REFERENCES public.study_sets(id) ON DELETE SET NULL,
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  content_type    TEXT NOT NULL CHECK (content_type IN ('mcq', 'short_answer', 'flashcard')),
  difficulty      TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question_count  INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, student_id)
);

CREATE TABLE IF NOT EXISTS public.study_questions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  study_set_id  UUID NOT NULL,
  student_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL CHECK (position > 0),
  prompt        TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 4 AND 1200),
  options       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_refs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (study_set_id, position),
  UNIQUE (id, student_id),
  FOREIGN KEY (study_set_id, student_id)
    REFERENCES public.study_sets(id, student_id) ON DELETE CASCADE
);

-- This table has no authenticated/anon RLS policy and no client grants.
-- Answer keys are only returned by the backend after an answer is submitted.
CREATE TABLE IF NOT EXISTS public.study_answer_keys (
  question_id     UUID PRIMARY KEY,
  student_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  correct_answer  TEXT NOT NULL,
  explanation     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (question_id, student_id)
    REFERENCES public.study_questions(id, student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.study_attempts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  study_set_id     UUID NOT NULL,
  student_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_questions  INTEGER NOT NULL CHECK (total_questions BETWEEN 1 AND 20),
  correct_count    INTEGER NOT NULL DEFAULT 0 CHECK (correct_count BETWEEN 0 AND total_questions),
  score            NUMERIC(5, 1) CHECK (score BETWEEN 0 AND 100),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  FOREIGN KEY (study_set_id, student_id)
    REFERENCES public.study_sets(id, student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.study_responses (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attempt_id   UUID NOT NULL,
  question_id  UUID NOT NULL,
  student_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  answer       TEXT NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 2000),
  is_correct   BOOLEAN NOT NULL,
  points       NUMERIC(4, 2) NOT NULL DEFAULT 0 CHECK (points >= 0 AND points <= 1),
  feedback     TEXT NOT NULL,
  answered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, question_id),
  FOREIGN KEY (attempt_id, student_id)
    REFERENCES public.study_attempts(id, student_id) ON DELETE CASCADE,
  FOREIGN KEY (question_id, student_id)
    REFERENCES public.study_questions(id, student_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.flashcard_reviews (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id  UUID NOT NULL,
  student_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('known', 'revise')),
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, question_id),
  FOREIGN KEY (question_id, student_id)
    REFERENCES public.study_questions(id, student_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_study_sets_student_created
  ON public.study_sets(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_questions_set_position
  ON public.study_questions(study_set_id, position);
CREATE INDEX IF NOT EXISTS idx_study_attempts_student_started
  ON public.study_attempts(student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_responses_attempt
  ON public.study_responses(attempt_id, student_id);

ALTER TABLE public.study_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_answer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flashcard_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can read own study sets" ON public.study_sets;
CREATE POLICY "Students can read own study sets"
  ON public.study_sets FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students can read own study questions" ON public.study_questions;
CREATE POLICY "Students can read own study questions"
  ON public.study_questions FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students can read own study attempts" ON public.study_attempts;
CREATE POLICY "Students can read own study attempts"
  ON public.study_attempts FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students can read own study responses" ON public.study_responses;
CREATE POLICY "Students can read own study responses"
  ON public.study_responses FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Students can read own flashcard reviews" ON public.flashcard_reviews;
CREATE POLICY "Students can read own flashcard reviews"
  ON public.flashcard_reviews FOR SELECT USING (auth.uid() = student_id);

REVOKE ALL ON public.study_answer_keys FROM anon, authenticated;
GRANT ALL ON
  public.study_sets,
  public.study_questions,
  public.study_answer_keys,
  public.study_attempts,
  public.study_responses,
  public.flashcard_reviews
TO service_role;

-- Serialize a quiz response, enforce one-at-a-time order, and update progress
-- atomically so concurrent/retried requests cannot corrupt an attempt score.
CREATE OR REPLACE FUNCTION public.record_study_response(
  p_attempt_id UUID,
  p_question_id UUID,
  p_student_id UUID,
  p_answer TEXT,
  p_is_correct BOOLEAN,
  p_feedback TEXT
)
RETURNS TABLE (
  question_id UUID,
  answered_count INTEGER,
  total_questions INTEGER,
  correct_count INTEGER,
  score NUMERIC,
  complete BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt public.study_attempts%ROWTYPE;
  v_question_position INTEGER;
  v_answered_count INTEGER;
  v_correct_count INTEGER;
BEGIN
  SELECT * INTO v_attempt
  FROM public.study_attempts
  WHERE id = p_attempt_id AND student_id = p_student_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quiz attempt not found';
  END IF;
  IF v_attempt.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Quiz attempt is already complete';
  END IF;

  SELECT position INTO v_question_position
  FROM public.study_questions
  WHERE id = p_question_id
    AND study_set_id = v_attempt.study_set_id
    AND student_id = p_student_id;

  IF v_question_position IS NULL THEN
    RAISE EXCEPTION 'Question not found in this quiz';
  END IF;

  SELECT COUNT(*) INTO v_answered_count
  FROM public.study_responses
  WHERE attempt_id = p_attempt_id AND student_id = p_student_id;

  IF v_question_position <> v_answered_count + 1 THEN
    RAISE EXCEPTION 'Answer the quiz questions in order';
  END IF;

  INSERT INTO public.study_responses (
    attempt_id, question_id, student_id, answer, is_correct, points, feedback
  ) VALUES (
    p_attempt_id, p_question_id, p_student_id, p_answer, p_is_correct,
    CASE WHEN p_is_correct THEN 1 ELSE 0 END, p_feedback
  );

  SELECT COUNT(*), COUNT(*) FILTER (WHERE is_correct)
  INTO v_answered_count, v_correct_count
  FROM public.study_responses
  WHERE attempt_id = p_attempt_id AND student_id = p_student_id;

  UPDATE public.study_attempts
  SET correct_count = v_correct_count,
      score = ROUND(v_correct_count * 100.0 / v_attempt.total_questions, 1),
      completed_at = CASE
        WHEN v_answered_count = v_attempt.total_questions THEN NOW()
        ELSE NULL
      END
  WHERE id = p_attempt_id AND student_id = p_student_id;

  RETURN QUERY
  SELECT p_question_id, v_answered_count, v_attempt.total_questions,
         v_correct_count,
         ROUND(v_correct_count * 100.0 / v_attempt.total_questions, 1),
         v_answered_count = v_attempt.total_questions;
END;
$$;

REVOKE ALL ON FUNCTION public.record_study_response(UUID, UUID, UUID, TEXT, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_study_response(UUID, UUID, UUID, TEXT, BOOLEAN, TEXT)
  TO service_role;
