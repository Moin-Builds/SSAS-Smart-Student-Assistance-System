-- One-time managed scheduler setup after reminder_migration.sql and Edge
-- Function deployment. First add these two secrets in Supabase Vault:
--   ssas_reminder_project_url
--   ssas_reminder_service_role_key
-- Do not put secret values in this file or frontend code.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Replace any prior copy of this job before scheduling the one-minute worker.
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'ssas-process-reminders'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'ssas-process-reminders',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'ssas_reminder_project_url'
        LIMIT 1
      ) || '/functions/v1/process-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'ssas_reminder_service_role_key'
          LIMIT 1
        ),
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'ssas_reminder_service_role_key'
          LIMIT 1
        )
      ),
      body := '{}'::jsonb
    );
  $job$
);

-- Monitor scheduler runs in Supabase SQL Editor:
-- SELECT jobid, status, return_message, start_time
-- FROM cron.job_run_details
-- ORDER BY start_time DESC
-- LIMIT 25;
