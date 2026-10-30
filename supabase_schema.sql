CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL DEFAULT '',
  email        TEXT,
  program      TEXT NOT NULL DEFAULT '',
  semester     INTEGER NOT NULL DEFAULT 1 CHECK (semester BETWEEN 1 AND 8),
  role         TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profiles IS 'Extended user profiles linked to Supabase Auth users.';


-- ================================================================
-- TABLE: schedule_items
-- Classes, assignments, and exams for each student.
-- ================================================================
CREATE TABLE IF NOT EXISTS public.schedule_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  course       TEXT NOT NULL CHECK (char_length(course) BETWEEN 1 AND 50),
  type         TEXT NOT NULL DEFAULT 'class' CHECK (type IN ('class', 'assignment', 'exam')),
  date         DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ongoing', 'done')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_items_student  ON public.schedule_items(student_id);
CREATE INDEX IF NOT EXISTS idx_schedule_items_date     ON public.schedule_items(date);
CREATE INDEX IF NOT EXISTS idx_schedule_items_status   ON public.schedule_items(status);

COMMENT ON TABLE public.schedule_items IS 'Student schedule: classes, assignments, and exams.';


-- ================================================================
-- TABLE: resources
-- Metadata for files uploaded to Supabase Storage.
-- The actual binary is in the "student-resources" storage bucket.
-- ================================================================
CREATE TABLE IF NOT EXISTS public.resources (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course       TEXT NOT NULL CHECK (char_length(course) BETWEEN 1 AND 50),
  file_name    TEXT NOT NULL,
  storage_path TEXT NOT NULL,       -- path inside the "student-resources" bucket
  file_url     TEXT,                -- public or signed URL (may be NULL if private)
  upload_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_student ON public.resources(student_id);

COMMENT ON TABLE public.resources IS 'Metadata for student-uploaded study resources (files in Supabase Storage).';


-- ================================================================
-- TABLE: study_logs
-- Records each study session logged by the student.
-- Used to generate the weekly chart and course-wise progress.
-- ================================================================
CREATE TABLE IF NOT EXISTS public.study_logs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course         TEXT NOT NULL DEFAULT 'General',
  hours_studied  NUMERIC(4,2) NOT NULL CHECK (hours_studied > 0 AND hours_studied <= 24),
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  task_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_logs_student ON public.study_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_study_logs_date    ON public.study_logs(date);

COMMENT ON TABLE public.study_logs IS 'Study sessions logged by the student (hours, course, date).';


-- ================================================================
-- TABLE: chat_interactions
-- Stores chatbot conversations per student.
-- ================================================================
CREATE TABLE IF NOT EXISTS public.chat_interactions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  intent      TEXT,
  response    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_student ON public.chat_interactions(student_id);

COMMENT ON TABLE public.chat_interactions IS 'Chat history between students and the rule-based AI assistant.';


-- ================================================================
-- TABLE: reminders
-- Linked to schedule_items for deadline reminders.
-- ================================================================
CREATE TABLE IF NOT EXISTS public.reminders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  schedule_item_id UUID REFERENCES public.schedule_items(id) ON DELETE CASCADE,
  remind_at        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_student ON public.reminders(student_id);

COMMENT ON TABLE public.reminders IS 'Scheduled reminders linked to student schedule items.';


-- ================================================================
-- TRIGGER: Auto-create profile when a new user signs up
-- ================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, program, semester)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'program',   ''),
    COALESCE((NEW.raw_user_meta_data->>'semester')::INTEGER, 1)
  )
  ON CONFLICT (id) DO NOTHING;   -- safe to re-run
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMENT ON FUNCTION public.handle_new_user IS 'Automatically inserts a profile row when a new Supabase Auth user is created.';


-- ================================================================
-- ROW LEVEL SECURITY (RLS)
-- ALL student-owned tables must enforce: student sees ONLY their own data.
-- Policies use auth.uid() — this is enforced at the DATABASE level,
-- not just the frontend. Even if a malicious user changes their
-- student_id in the browser, Supabase will reject the query.
-- ================================================================

-- ---- profiles ----
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- The trigger (SECURITY DEFINER) handles INSERT so no separate INSERT policy needed.


-- ---- schedule_items ----
ALTER TABLE public.schedule_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can read own schedule"
  ON public.schedule_items FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "Students can insert own schedule"
  ON public.schedule_items FOR INSERT
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can update own schedule"
  ON public.schedule_items FOR UPDATE
  USING (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can delete own schedule"
  ON public.schedule_items FOR DELETE
  USING (auth.uid() = student_id);


-- ---- resources ----
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can read own resources"
  ON public.resources FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "Students can insert own resources"
  ON public.resources FOR INSERT
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can delete own resources"
  ON public.resources FOR DELETE
  USING (auth.uid() = student_id);


-- ---- study_logs ----
ALTER TABLE public.study_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can read own study logs"
  ON public.study_logs FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "Students can insert own study logs"
  ON public.study_logs FOR INSERT
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can delete own study logs"
  ON public.study_logs FOR DELETE
  USING (auth.uid() = student_id);


-- ---- chat_interactions ----
ALTER TABLE public.chat_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can read own chat history"
  ON public.chat_interactions FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "Students can insert own chat messages"
  ON public.chat_interactions FOR INSERT
  WITH CHECK (auth.uid() = student_id);


-- ---- reminders ----
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Students can read own reminders"
  ON public.reminders FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "Students can insert own reminders"
  ON public.reminders FOR INSERT
  WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can update own reminders"
  ON public.reminders FOR UPDATE
  USING (auth.uid() = student_id);

CREATE POLICY "Students can delete own reminders"
  ON public.reminders FOR DELETE
  USING (auth.uid() = student_id);


-- ================================================================
-- STORAGE BUCKET POLICIES
-- Run these AFTER creating the "student-resources" bucket in the
-- Supabase Storage dashboard.
--
-- These policies restrict access so a student can ONLY access
-- files inside their own folder: student-resources/{their_user_id}/
-- ================================================================

-- Allow authenticated students to upload to their own folder
INSERT INTO storage.buckets (id, name, public)
VALUES ('student-resources', 'student-resources', false)
ON CONFLICT (id) DO NOTHING;

-- SELECT: read own files
CREATE POLICY "Students can view own files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'student-resources'
    AND auth.uid()::TEXT = (storage.foldername(name))[1]
  );

-- INSERT: upload to own folder only
CREATE POLICY "Students can upload own files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'student-resources'
    AND auth.uid()::TEXT = (storage.foldername(name))[1]
  );

-- DELETE: delete own files only
CREATE POLICY "Students can delete own files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'student-resources'
    AND auth.uid()::TEXT = (storage.foldername(name))[1]
  );


-- ================================================================
-- VERIFICATION QUERIES
-- Run these after setup to confirm everything is correct:
-- ================================================================
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
-- SELECT policyname, tablename, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;
-- ================================================================
