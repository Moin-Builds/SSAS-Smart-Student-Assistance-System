/* =========================================================
   js/reminders.js
   Student-facing reminder preferences and in-app notifications.
   ========================================================= */

async function loadReminderView() {
  await loadReminderPreferences();
  await loadReminderNotifications('reminderNotifications', false);
}

async function loadReminderPreferences() {
  const { data, error } = await db
    .from('reminder_preferences')
    .select('timezone, intervals_hours, in_app_enabled, email_enabled')
    .eq('student_id', currentUser.id)
    .maybeSingle();

  if (error) {
    showReminderPreferencesError(`Could not load preferences: ${error.message}`);
    return null;
  }

  if (!data) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const { data: created, error: createError } = await db.rpc('save_reminder_preferences', {
      p_timezone: timezone,
      p_intervals_hours: [24, 1],
      p_in_app_enabled: true,
      p_email_enabled: false,
    });
    if (createError) {
      showReminderPreferencesError(`Could not initialize reminder preferences: ${createError.message}`);
      return null;
    }
    const preferences = normalizeReminderPreferences(created);
    applyReminderPreferences(preferences);
    return preferences;
  }

  const preferences = normalizeReminderPreferences(data);
  applyReminderPreferences(preferences);
  return preferences;
}

function normalizeReminderPreferences(value) {
  return Array.isArray(value) ? (value[0] || null) : value;
}

function applyReminderPreferences(preferences) {
  if (!preferences) return;
  document.getElementById('reminderTimezone').value = preferences.timezone || 'UTC';
  document.getElementById('reminder72h').checked = preferences.intervals_hours.includes(72);
  document.getElementById('reminder24h').checked = preferences.intervals_hours.includes(24);
  document.getElementById('reminder1h').checked = preferences.intervals_hours.includes(1);
  document.getElementById('reminderInApp').checked = preferences.in_app_enabled;
  document.getElementById('reminderEmail').checked = preferences.email_enabled;
}

async function saveReminderPreferences(event) {
  event.preventDefault();
  const timezone = document.getElementById('reminderTimezone').value.trim();
  const intervals = [72, 24, 1].filter(hours =>
    document.getElementById(`reminder${hours}h`).checked
  );
  const inAppEnabled = document.getElementById('reminderInApp').checked;
  const emailEnabled = document.getElementById('reminderEmail').checked;

  if (intervals.length === 0) {
    showReminderPreferencesError('Select at least one reminder interval.');
    return;
  }
  if (!inAppEnabled && !emailEnabled) {
    showReminderPreferencesError('Enable at least one delivery method.');
    return;
  }

  const button = document.getElementById('saveReminderPreferencesBtn');
  button.disabled = true;
  button.textContent = 'Saving…';
  const { data, error } = await db.rpc('save_reminder_preferences', {
    p_timezone: timezone,
    p_intervals_hours: intervals,
    p_in_app_enabled: inAppEnabled,
    p_email_enabled: emailEnabled,
  });
  button.disabled = false;
  button.textContent = 'Save Preferences';

  if (error) {
    showReminderPreferencesError(error.message);
    return;
  }
  applyReminderPreferences(normalizeReminderPreferences(data));
  showReminderPreferencesSuccess('Reminder preferences saved.');
  await loadReminderNotifications('reminderNotifications', false);
  await loadReminderNotifications('dashboardReminders', true);
}

async function loadReminderNotifications(containerId, compact) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '<p class="muted">Loading reminders…</p>';

  const preferences = await loadReminderPreferences();
  if (!preferences) {
    container.innerHTML = '<p class="muted">Reminder preferences are unavailable. Apply the reminder database migration and try again.</p>';
    return;
  }
  if (!preferences.in_app_enabled) {
    container.innerHTML = '<p class="muted">In-app notifications are turned off. Change delivery preferences to see reminders here.</p>';
    return;
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('reminders')
    .select('id, status, remind_at, deadline_at, interval_hours, email_status, email_error, schedule_item:schedule_items(title, course, type, date, due_time, status)')
    .eq('student_id', currentUser.id)
    .eq('in_app_enabled', true)
    .in('status', ['pending', 'sent', 'failed'])
    .gte('deadline_at', since)
    .order('remind_at', { ascending: true })
    .limit(compact ? 5 : 50);

  if (error) {
    container.innerHTML = `<p class="muted">Could not load reminders: ${escapeReminderText(error.message)}</p>`;
    return;
  }

  const notifications = (data || []).filter(reminder => {
    const scheduleItem = Array.isArray(reminder.schedule_item)
      ? reminder.schedule_item[0]
      : reminder.schedule_item;
    return scheduleItem && scheduleItem.status !== 'done';
  });
  renderReminderNotifications(container, notifications, preferences, compact);
}

function renderReminderNotifications(container, reminders, preferences, compact) {
  if (reminders.length === 0) {
    container.innerHTML = '<p class="muted">No upcoming reminders. Add an assignment or exam to your schedule to get started.</p>';
    return;
  }

  container.innerHTML = reminders.map(reminder => {
    const scheduleItem = Array.isArray(reminder.schedule_item)
      ? reminder.schedule_item[0]
      : reminder.schedule_item;
    const dueText = formatReminderDate(reminder.deadline_at, preferences.timezone);
    const remindText = reminder.status === 'pending'
      ? `Scheduled for ${formatReminderDate(reminder.remind_at, preferences.timezone)}`
      : 'In-app reminder';
    const emailNote = reminder.email_status === 'failed'
      ? `<p class="reminder-email-error">Email not sent: ${escapeReminderText(reminder.email_error || 'delivery failed')}</p>`
      : '';
    return `
      <article class="reminder-item">
        <div class="reminder-copy">
          <strong>${escapeReminderText(scheduleItem.title)}</strong>
          <span>${escapeReminderText(scheduleItem.course)} · ${escapeReminderText(scheduleItem.type)}</span>
          <span>${remindText} · Due ${dueText}</span>
          ${emailNote}
        </div>
        <button class="btn secondary sm" type="button" onclick="dismissReminder('${reminder.id}')">Dismiss</button>
      </article>`;
  }).join('');

  if (compact && reminders.length >= 5) {
    container.insertAdjacentHTML('beforeend', '<p class="muted reminder-more">Showing the next 5 reminders. Open Reminders to see more.</p>');
  }
}

async function dismissReminder(reminderId) {
  const { error } = await db
    .from('reminders')
    .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
    .eq('id', reminderId)
    .eq('student_id', currentUser.id);

  if (error) {
    showAlert(`Could not dismiss reminder: ${error.message}`);
    return;
  }
  await loadReminderNotifications('reminderNotifications', false);
  await loadReminderNotifications('dashboardReminders', true);
}

function showReminderPreferencesError(message) {
  const alert = document.getElementById('reminderPreferencesAlert');
  if (!alert) return;
  alert.textContent = message;
  alert.className = 'alert error';
  alert.style.display = 'flex';
}

function showReminderPreferencesSuccess(message) {
  const alert = document.getElementById('reminderPreferencesAlert');
  if (!alert) return;
  alert.textContent = message;
  alert.className = 'alert success';
  alert.style.display = 'flex';
  setTimeout(() => { alert.style.display = 'none'; }, 4000);
}

function formatReminderDate(value, timezone) {
  if (!value) return 'date unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function escapeReminderText(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}
