-- SSAS Feature 3: automated schedule reminders.
-- Run after supabase_schema.sql. Then deploy process-reminders and configure
-- the managed scheduler using reminder_scheduler.sql.

ALTER TABLE public.schedule_items
  ADD COLUMN IF NOT EXISTS due_time TIME;

ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS interval_hours INTEGER,
  ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_error TEXT,
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

ALTER TABLE public.reminders
  DROP CONSTRAINT IF EXISTS reminders_status_check,
  ADD CONSTRAINT reminders_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'dismissed'));
ALTER TABLE public.reminders
  DROP CONSTRAINT IF EXISTS reminders_interval_hours_check,
  ADD CONSTRAINT reminders_interval_hours_check
  CHECK (interval_hours IS NULL OR interval_hours IN (1, 24, 72));
ALTER TABLE public.reminders
  DROP CONSTRAINT IF EXISTS reminders_email_status_check,
  ADD CONSTRAINT reminders_email_status_check
  CHECK (email_status IN ('disabled', 'pending', 'sending', 'sent', 'failed'));
ALTER TABLE public.reminders
  DROP CONSTRAINT IF EXISTS reminders_delivery_attempts_check,
  ADD CONSTRAINT reminders_delivery_attempts_check
  CHECK (delivery_attempts BETWEEN 0 AND 3);

-- Old rows cannot be reliably associated with a lead-time interval.
-- Retain them as history, but prevent them from appearing as new notifications.
UPDATE public.reminders
SET status = 'dismissed',
    dismissed_at = COALESCE(dismissed_at, NOW()),
    email_status = 'disabled'
WHERE interval_hours IS NULL
  AND status <> 'dismissed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_item_interval_deadline
  ON public.reminders(schedule_item_id, interval_hours, deadline_at)
  WHERE interval_hours IS NOT NULL AND deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_due_status
  ON public.reminders(status, remind_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_reminders_email_retry
  ON public.reminders(email_status, next_retry_at)
  WHERE email_status IN ('pending', 'failed', 'sending');

CREATE TABLE IF NOT EXISTS public.reminder_preferences (
  student_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  intervals_hours INTEGER[] NOT NULL DEFAULT ARRAY[24, 1],
  in_app_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reminder_preferences_intervals_check
    CHECK (
      cardinality(intervals_hours) BETWEEN 1 AND 3
      AND intervals_hours <@ ARRAY[1, 24, 72]::INTEGER[]
    )
);

ALTER TABLE public.reminder_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Students can read own reminder preferences" ON public.reminder_preferences;
CREATE POLICY "Students can read own reminder preferences"
  ON public.reminder_preferences FOR SELECT USING (auth.uid() = student_id);

REVOKE ALL ON public.reminder_preferences FROM anon, authenticated;
GRANT SELECT ON public.reminder_preferences TO authenticated;
GRANT ALL ON public.reminder_preferences TO service_role;

CREATE OR REPLACE FUNCTION public.save_reminder_preferences(
  p_timezone TEXT,
  p_intervals_hours INTEGER[],
  p_in_app_enabled BOOLEAN,
  p_email_enabled BOOLEAN
)
RETURNS public.reminder_preferences
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student_id UUID := auth.uid();
  v_preferences public.reminder_preferences;
BEGIN
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown time zone';
  END IF;
  IF p_intervals_hours IS NULL
     OR cardinality(p_intervals_hours) NOT BETWEEN 1 AND 3
     OR NOT (p_intervals_hours <@ ARRAY[1, 24, 72]::INTEGER[]) THEN
    RAISE EXCEPTION 'Choose one or more valid reminder intervals';
  END IF;

  INSERT INTO public.reminder_preferences (
    student_id, timezone, intervals_hours, in_app_enabled, email_enabled, updated_at
  )
  VALUES (
    v_student_id,
    p_timezone,
    ARRAY(
      SELECT DISTINCT interval_config.value
      FROM unnest(p_intervals_hours) AS interval_config(value)
      ORDER BY interval_config.value DESC
    ),
    p_in_app_enabled,
    p_email_enabled,
    NOW()
  )
  ON CONFLICT (student_id) DO UPDATE SET
    timezone = EXCLUDED.timezone,
    intervals_hours = EXCLUDED.intervals_hours,
    in_app_enabled = EXCLUDED.in_app_enabled,
    email_enabled = EXCLUDED.email_enabled,
    updated_at = NOW()
  RETURNING * INTO v_preferences;

  RETURN v_preferences;
END;
$$;

REVOKE ALL ON FUNCTION public.save_reminder_preferences(TEXT, INTEGER[], BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_reminder_preferences(TEXT, INTEGER[], BOOLEAN, BOOLEAN)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prepare_schedule_reminders()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  -- Obsolete pending notifications are invalidated when a deadline, item type,
  -- or completion state changes. A trigger also handles immediate item updates.
  UPDATE public.reminders AS reminder
  SET status = 'dismissed',
      dismissed_at = NOW(),
      email_status = 'disabled',
      email_error = 'Schedule item is no longer active.'
  FROM public.schedule_items AS item
  LEFT JOIN public.reminder_preferences AS pref ON pref.student_id = item.student_id
  WHERE reminder.status = 'pending'
    AND reminder.schedule_item_id = item.id
    AND (
      item.status = 'done'
      OR item.type NOT IN ('assignment', 'exam')
      OR reminder.deadline_at IS DISTINCT FROM (
        (item.date + COALESCE(item.due_time, TIME '23:59'))
        AT TIME ZONE COALESCE(pref.timezone, 'UTC')
      )
    );

  WITH student_settings AS (
    SELECT
      item.student_id,
      COALESCE(pref.timezone, 'UTC') AS timezone,
      COALESCE(pref.intervals_hours, ARRAY[24, 1]::INTEGER[]) AS intervals_hours,
      COALESCE(pref.in_app_enabled, TRUE) AS in_app_enabled,
      COALESCE(pref.email_enabled, FALSE) AS email_enabled
    FROM public.schedule_items AS item
    LEFT JOIN public.reminder_preferences AS pref ON pref.student_id = item.student_id
    GROUP BY item.student_id, pref.timezone, pref.intervals_hours,
             pref.in_app_enabled, pref.email_enabled
  ),
  reminder_candidates AS (
    SELECT
      item.student_id,
      item.id AS schedule_item_id,
      intervals.interval_hours,
      deadline.deadline_at,
      deadline.deadline_at - make_interval(hours => intervals.interval_hours) AS remind_at,
      settings.in_app_enabled,
      settings.email_enabled
    FROM public.schedule_items AS item
    JOIN student_settings AS settings ON settings.student_id = item.student_id
    CROSS JOIN LATERAL unnest(settings.intervals_hours) AS intervals(interval_hours)
    CROSS JOIN LATERAL (
      SELECT (item.date + COALESCE(item.due_time, TIME '23:59'))
        AT TIME ZONE settings.timezone AS deadline_at
    ) AS deadline
    WHERE item.status IN ('pending', 'ongoing')
      AND item.type IN ('assignment', 'exam')
      AND deadline.deadline_at > NOW()
      AND deadline.deadline_at - make_interval(hours => intervals.interval_hours)
            BETWEEN NOW() - INTERVAL '15 minutes' AND NOW() + INTERVAL '72 hours'
      AND (settings.in_app_enabled OR settings.email_enabled)
  ),
  inserted AS (
    INSERT INTO public.reminders (
      student_id, schedule_item_id, remind_at, status, interval_hours, deadline_at,
      in_app_enabled, email_status
    )
    SELECT
      student_id, schedule_item_id, remind_at, 'pending', interval_hours, deadline_at,
      in_app_enabled,
      CASE WHEN email_enabled THEN 'pending' ELSE 'disabled' END
    FROM reminder_candidates
    ON CONFLICT (schedule_item_id, interval_hours, deadline_at)
      WHERE interval_hours IS NOT NULL AND deadline_at IS NOT NULL
      DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_due_reminders()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_published INTEGER;
BEGIN
  UPDATE public.reminders
  SET status = 'sent'
  WHERE status = 'pending'
    AND remind_at <= NOW()
    AND (in_app_enabled OR email_status = 'pending');
  GET DIAGNOSTICS v_published = ROW_COUNT;
  RETURN v_published;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_reminder_email_deliveries(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (
  reminder_id UUID,
  student_id UUID,
  email TEXT,
  schedule_item_id UUID,
  interval_hours INTEGER,
  delivery_attempts INTEGER,
  item_title TEXT,
  item_course TEXT,
  item_type TEXT,
  deadline_at TIMESTAMPTZ,
  timezone TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT reminder.id
    FROM public.reminders AS reminder
    WHERE reminder.status IN ('sent', 'failed')
      AND (
        (reminder.email_status = 'pending' AND reminder.next_retry_at IS NULL)
        OR (
          reminder.email_status IN ('sending', 'failed')
          AND reminder.next_retry_at <= NOW()
        )
      )
      AND reminder.delivery_attempts < 3
      AND EXISTS (
        SELECT 1
        FROM public.reminder_preferences AS pref
        WHERE pref.student_id = reminder.student_id
          AND pref.email_enabled
      )
    ORDER BY reminder.remind_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  ),
  claimed AS (
    UPDATE public.reminders AS reminder
    SET email_status = 'sending',
        delivery_attempts = reminder.delivery_attempts + 1,
        next_retry_at = NOW() + INTERVAL '10 minutes'
    FROM claimable
    WHERE reminder.id = claimable.id
    RETURNING reminder.id, reminder.student_id, reminder.schedule_item_id,
              reminder.interval_hours, reminder.delivery_attempts
  )
  SELECT claimed.id, claimed.student_id, user_account.email,
         claimed.schedule_item_id, claimed.interval_hours, claimed.delivery_attempts,
         item.title, item.course, item.type, reminder.deadline_at,
         COALESCE(pref.timezone, 'UTC')
  FROM claimed
  JOIN auth.users AS user_account ON user_account.id = claimed.student_id
  JOIN public.schedule_items AS item ON item.id = claimed.schedule_item_id
  JOIN public.reminders AS reminder ON reminder.id = claimed.id
  LEFT JOIN public.reminder_preferences AS pref ON pref.student_id = claimed.student_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_reminder_email_delivery(
  p_reminder_id UUID,
  p_success BOOLEAN,
  p_retryable BOOLEAN DEFAULT FALSE,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts INTEGER;
BEGIN
  SELECT delivery_attempts INTO v_attempts
  FROM public.reminders
  WHERE id = p_reminder_id AND email_status = 'sending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.reminders
  SET status = CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
      email_status = CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
      email_error = CASE WHEN p_success THEN NULL ELSE LEFT(COALESCE(p_error, 'Email delivery failed.'), 1000) END,
      next_retry_at = CASE
        WHEN p_success OR NOT p_retryable OR v_attempts >= 3 THEN NULL
        WHEN v_attempts = 1 THEN NOW() + INTERVAL '2 minutes'
        WHEN v_attempts = 2 THEN NOW() + INTERVAL '10 minutes'
        ELSE NOW() + INTERVAL '30 minutes'
      END
  WHERE id = p_reminder_id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_unconfigured_reminder_emails(p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.reminders
  SET status = 'failed',
      email_status = 'failed',
      email_error = LEFT(p_reason, 1000),
  next_retry_at = NOW() + INTERVAL '5 minutes'
  WHERE status = 'sent'
    AND email_status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.reminder_preferences AS pref
      WHERE pref.student_id = reminders.student_id AND pref.email_enabled
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_schedule_reminder_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.date IS DISTINCT FROM NEW.date
     OR OLD.due_time IS DISTINCT FROM NEW.due_time
     OR OLD.type IS DISTINCT FROM NEW.type
     OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'done') THEN
    UPDATE public.reminders
    SET status = 'dismissed',
        dismissed_at = NOW(),
        email_status = 'disabled',
        email_error = 'Schedule item changed or completed.'
    WHERE schedule_item_id = NEW.id
      AND status IN ('pending', 'sent', 'failed');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schedule_items_reminder_changes ON public.schedule_items;
CREATE TRIGGER schedule_items_reminder_changes
  AFTER UPDATE ON public.schedule_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_schedule_reminder_changes();

CREATE OR REPLACE FUNCTION public.handle_reminder_preference_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.timezone IS DISTINCT FROM NEW.timezone
     OR OLD.intervals_hours IS DISTINCT FROM NEW.intervals_hours
     OR OLD.in_app_enabled IS DISTINCT FROM NEW.in_app_enabled
     OR OLD.email_enabled IS DISTINCT FROM NEW.email_enabled THEN
    DELETE FROM public.reminders
    WHERE student_id = NEW.student_id
      AND status = 'pending';
    UPDATE public.reminders
    SET status = CASE WHEN status = 'failed' THEN 'sent' ELSE status END,
        email_status = 'disabled',
        next_retry_at = NULL,
        email_error = 'Reminder preferences changed.'
    WHERE student_id = NEW.student_id
      AND status IN ('sent', 'failed')
      AND email_status IN ('pending', 'failed', 'sending');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminder_preferences_changed ON public.reminder_preferences;
CREATE TRIGGER reminder_preferences_changed
  AFTER UPDATE ON public.reminder_preferences
  FOR EACH ROW EXECUTE FUNCTION public.handle_reminder_preference_changes();

CREATE OR REPLACE FUNCTION public.handle_reminder_dismissal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'dismissed' AND OLD.status <> 'dismissed' THEN
    NEW.dismissed_at := COALESCE(NEW.dismissed_at, NOW());
    NEW.email_status := 'disabled';
    NEW.next_retry_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reminders_on_dismiss ON public.reminders;
CREATE TRIGGER reminders_on_dismiss
  BEFORE UPDATE OF status ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.handle_reminder_dismissal();

DROP POLICY IF EXISTS "Students can insert own reminders" ON public.reminders;
DROP POLICY IF EXISTS "Students can update own reminders" ON public.reminders;
DROP POLICY IF EXISTS "Students can delete own reminders" ON public.reminders;
DROP POLICY IF EXISTS "Students can dismiss own reminders" ON public.reminders;
CREATE POLICY "Students can dismiss own reminders"
  ON public.reminders FOR UPDATE
  USING (auth.uid() = student_id AND status IN ('pending', 'sent', 'failed'))
  WITH CHECK (auth.uid() = student_id AND status = 'dismissed');

REVOKE INSERT, UPDATE, DELETE ON public.reminders FROM anon, authenticated;
GRANT SELECT ON public.reminders TO authenticated;
GRANT UPDATE (status, dismissed_at) ON public.reminders TO authenticated;
GRANT ALL ON public.reminders TO service_role;

REVOKE ALL ON FUNCTION public.prepare_schedule_reminders() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_due_reminders() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_reminder_email_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_reminder_email_delivery(UUID, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_unconfigured_reminder_emails(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_schedule_reminders() TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_due_reminders() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_reminder_email_deliveries(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_reminder_email_delivery(UUID, BOOLEAN, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_unconfigured_reminder_emails(TEXT) TO service_role;
