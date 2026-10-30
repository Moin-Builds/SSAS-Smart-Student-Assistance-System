-- Run only against a non-production Supabase database after applying
-- supabase_schema.sql and reminder_migration.sql.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT extensions.plan(12);

CREATE TEMP TABLE reminder_test_ids (label TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO reminder_test_ids VALUES
  ('student_a', gen_random_uuid()),
  ('student_b', gen_random_uuid()),
  ('schedule_a', gen_random_uuid()),
  ('schedule_b', gen_random_uuid());
GRANT SELECT ON reminder_test_ids TO authenticated, service_role;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT id, 'authenticated', 'authenticated',
       id::TEXT || '@reminder-test.example', '', NOW(), '{}'::JSONB, '{}'::JSONB, NOW(), NOW()
FROM reminder_test_ids
WHERE label IN ('student_a', 'student_b');

INSERT INTO public.reminder_preferences (
  student_id, timezone, intervals_hours, in_app_enabled, email_enabled
)
SELECT id,
       CASE label WHEN 'student_a' THEN 'America/Los_Angeles' ELSE 'Asia/Karachi' END,
       ARRAY[24, 1], TRUE, label = 'student_a'
FROM reminder_test_ids
WHERE label IN ('student_a', 'student_b');

INSERT INTO public.schedule_items (id, student_id, title, course, type, date, due_time, status)
SELECT
  item.id,
  student.id,
  'Reminder integration test',
  'Test course',
  'exam',
  CURRENT_DATE + 2,
  TIME '09:00',
  'pending'
FROM reminder_test_ids AS item
CROSS JOIN reminder_test_ids AS student
WHERE item.label = CASE student.label
  WHEN 'student_a' THEN 'schedule_a'
  ELSE 'schedule_b'
END
AND student.label IN ('student_a', 'student_b');

SET LOCAL ROLE service_role;
SELECT public.prepare_schedule_reminders();
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminders
   WHERE schedule_item_id IN (SELECT id FROM reminder_test_ids WHERE label IN ('schedule_a', 'schedule_b'))),
  4::BIGINT,
  'generates one reminder per item and lead interval'
);
SELECT public.prepare_schedule_reminders();
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminders
   WHERE schedule_item_id IN (SELECT id FROM reminder_test_ids WHERE label IN ('schedule_a', 'schedule_b'))),
  4::BIGINT,
  'repeated generation is idempotent'
);
SELECT extensions.is(
  (SELECT deadline_at FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a') LIMIT 1),
  ((CURRENT_DATE + 2 + TIME '09:00') AT TIME ZONE 'America/Los_Angeles'),
  'deadline uses the first student time zone'
);
SELECT extensions.is(
  (SELECT deadline_at FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_b') LIMIT 1),
  ((CURRENT_DATE + 2 + TIME '09:00') AT TIME ZONE 'Asia/Karachi'),
  'deadline uses the second student time zone'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT id::TEXT FROM reminder_test_ids WHERE label = 'student_a'),
  TRUE
);
SET LOCAL ROLE authenticated;
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminders WHERE student_id = (SELECT id FROM reminder_test_ids WHERE label = 'student_a')),
  2::BIGINT,
  'student can read own reminders'
);
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminders WHERE student_id = (SELECT id FROM reminder_test_ids WHERE label = 'student_b')),
  0::BIGINT,
  'student cannot read another student reminders'
);
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminder_preferences WHERE student_id = (SELECT id FROM reminder_test_ids WHERE label = 'student_b')),
  0::BIGINT,
  'student cannot read another student preferences'
);
SELECT extensions.is(
  (
    WITH changed AS (
      UPDATE public.reminders
      SET status = 'dismissed'
      WHERE student_id = (SELECT id FROM reminder_test_ids WHERE label = 'student_b')
      RETURNING id
    )
    SELECT COUNT(*) FROM changed
  ),
  0::BIGINT,
  'student cannot dismiss another student reminders'
);

RESET ROLE;
SET LOCAL ROLE service_role;
UPDATE public.reminders
SET status = 'sent', email_status = 'sending', delivery_attempts = 1
WHERE id = (
  SELECT id FROM public.reminders
  WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a')
  LIMIT 1
);
SELECT extensions.ok(
  public.finish_reminder_email_delivery(
    (SELECT id FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a') AND email_status = 'sending' LIMIT 1),
    FALSE,
    TRUE,
    'test transient failure'
  ),
  'records a retryable email failure'
);
SELECT extensions.is(
  (SELECT email_status FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a') AND email_status = 'failed' LIMIT 1),
  'failed',
  'failed email delivery is observable'
);
SELECT extensions.ok(
  (SELECT next_retry_at > NOW() FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a') AND email_status = 'failed' LIMIT 1),
  'transient failure receives a retry time'
);

RESET ROLE;
UPDATE public.schedule_items
SET status = 'done'
WHERE id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a');
SELECT extensions.is(
  (SELECT COUNT(*) FROM public.reminders WHERE schedule_item_id = (SELECT id FROM reminder_test_ids WHERE label = 'schedule_a') AND status = 'dismissed'),
  2::BIGINT,
  'completing an item invalidates its reminders'
);

SELECT * FROM extensions.finish();
ROLLBACK;
