/**
 * Scheduled reminder processor.
 *
 * Deploy with verify_jwt enabled and invoke using the Supabase service-role
 * JWT from Supabase Vault/pg_cron. Email is opt-in and only sent after the
 * configured Resend sender domain is verified.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};
const RESEND_API = 'https://api.resend.com';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Reminder worker missing Supabase service configuration.');
    return jsonResponse(500, { error: 'Reminder worker is not configured.' });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const { error: generationError } = await client.rpc('prepare_schedule_reminders');
    if (generationError) throw new Error(`Reminder generation failed: ${generationError.message}`);

    const { data: published, error: publishError } = await client.rpc('publish_due_reminders');
    if (publishError) throw new Error(`Reminder publishing failed: ${publishError.message}`);

    const apiKey = Deno.env.get('RESEND_API_KEY')?.trim();
    const from = Deno.env.get('REMINDER_FROM_EMAIL')?.trim();
    let verified = false;
    let providerReason = 'Email delivery is disabled: configure RESEND_API_KEY and REMINDER_FROM_EMAIL.';
    if (apiKey && from) {
      const verification = await verifySender(apiKey, from);
      verified = verification.verified;
      providerReason = verification.reason;
    }

    if (!verified) {
      const { data: failedEmailRows, error: configError } = await client.rpc(
        'fail_unconfigured_reminder_emails',
        { p_reason: providerReason },
      );
      if (configError) throw new Error(`Could not record email configuration status: ${configError.message}`);
      console.info(JSON.stringify({
        event: 'reminder_run',
        published_in_app: published ?? 0,
        email_provider_verified: false,
        email_configuration_failures: failedEmailRows ?? 0,
      }));
      return jsonResponse(200, {
        success: true,
        published_in_app: published ?? 0,
        email_provider_verified: false,
      });
    }

    const { data: claims, error: claimError } = await client.rpc(
      'claim_reminder_email_deliveries',
      { p_limit: 50 },
    );
    if (claimError) throw new Error(`Could not claim email reminders: ${claimError.message}`);

    let delivered = 0;
    let failed = 0;
    for (const claim of claims ?? []) {
      const delivery = await sendReminderEmail(apiKey!, from!, claim);
      const { error: finishError } = await client.rpc('finish_reminder_email_delivery', {
        p_reminder_id: claim.reminder_id,
        p_success: delivery.success,
        p_retryable: delivery.retryable,
        p_error: delivery.error ?? null,
      });
      if (finishError) {
        console.error(JSON.stringify({
          event: 'reminder_email_result_record_failed',
          reminder_id: claim.reminder_id,
          error: finishError.message,
        }));
        throw new Error('Could not record reminder email delivery result.');
      }
      if (delivery.success) delivered += 1;
      else failed += 1;
    }

    console.info(JSON.stringify({
      event: 'reminder_run',
      published_in_app: published ?? 0,
      emails_claimed: (claims ?? []).length,
      emails_sent: delivered,
      emails_failed: failed,
      email_provider_verified: true,
    }));
    return jsonResponse(200, {
      success: true,
      published_in_app: published ?? 0,
      emails_claimed: (claims ?? []).length,
      emails_sent: delivered,
      emails_failed: failed,
      email_provider_verified: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'reminder_run_failed', error: message }));
    return jsonResponse(500, { error: 'Reminder processing failed.' });
  }
});

interface ReminderClaim {
  reminder_id: string;
  student_id: string;
  email: string | null;
  schedule_item_id: string;
  interval_hours: number;
  delivery_attempts: number;
  item_title: string;
  item_course: string;
  item_type: string;
  deadline_at: string;
  timezone: string;
}

interface DeliveryResult {
  success: boolean;
  retryable: boolean;
  error?: string;
}

async function verifySender(apiKey: string, from: string): Promise<{ verified: boolean; reason: string }> {
  const match = from.match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
  if (!match) return { verified: false, reason: 'REMINDER_FROM_EMAIL is not a valid email address.' };
  try {
    const response = await fetch(`${RESEND_API}/domains`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return { verified: false, reason: `Email provider domain verification failed (${response.status}).` };
    }
    const result = await response.json() as { data?: Array<{ name?: string; status?: string }> };
    const senderDomain = match[1].toLowerCase();
    const isVerified = (result.data ?? []).some(domain =>
      domain.status === 'verified'
      && typeof domain.name === 'string'
      && (senderDomain === domain.name.toLowerCase()
        || senderDomain.endsWith(`.${domain.name.toLowerCase()}`))
    );
    return isVerified
      ? { verified: true, reason: '' }
      : { verified: false, reason: 'REMINDER_FROM_EMAIL must use a verified Resend sender domain.' };
  } catch {
    return { verified: false, reason: 'Could not verify the email sender domain. No email was sent.' };
  }
}

async function sendReminderEmail(
  apiKey: string,
  from: string,
  claim: ReminderClaim,
): Promise<DeliveryResult> {
  if (!claim.email) return { success: false, retryable: false, error: 'Student account has no email address.' };
  try {
    const response = await fetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': claim.reminder_id,
      },
      body: JSON.stringify({
        from,
        to: [claim.email],
        subject: `SSAS reminder: ${claim.item_title}`,
        text: [
          `${claim.item_type} for ${claim.item_course}: ${claim.item_title}`,
          `Deadline: ${new Intl.DateTimeFormat('en', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: claim.timezone,
          }).format(new Date(claim.deadline_at))}.`,
          'Open SSAS to view your schedule.',
        ].join('\n'),
      }),
    });
    if (response.ok) return { success: true, retryable: false };
    const retryable = response.status === 429 || response.status >= 500;
    console.error(JSON.stringify({
      event: 'reminder_email_delivery_failed',
      reminder_id: claim.reminder_id,
      status: response.status,
      retryable,
    }));
    return {
      success: false,
      retryable,
      error: `Email provider returned HTTP ${response.status}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: 'reminder_email_delivery_failed',
      reminder_id: claim.reminder_id,
      retryable: true,
      error: message,
    }));
    return { success: false, retryable: true, error: `Email provider request failed: ${message}` };
  }
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
