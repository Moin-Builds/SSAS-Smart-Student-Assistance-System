/* =========================================================
   js/app.js
   Main application logic — SSAS v2.0
   Covers: Dashboard, Schedule, Resources, Performance, Profile
   All data operations use Supabase (db), protected by RLS.
   ========================================================= */

/* ---- App state ---- */
let currentUser          = null;
let currentProfile       = null;
let chartObj             = null;
let currentScheduleItems = [];

/* ---- Utility ---- */
function isoDate(d) { return d.toISOString().slice(0, 10); }
const today = new Date();

/* ---- Simple in-app alert (inside the main app) ---- */
function showAlert(msg, type = 'error', containerId = 'appAlert') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<span>${type === 'error' ? '⚠' : '✓'}</span> ${msg}`;
  el.className = `alert ${type}`;
  el.style.display = 'flex';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

/* =========================================================
   INIT — called on app.html load
   ========================================================= */
async function initApp() {
  showOverlay('Loading your account…');
  currentUser = await requireAuth();
  if (!currentUser) return; // requireAuth already redirected
  window.currentUser = currentUser;

  currentProfile = await loadProfile(currentUser.id);
  window.currentProfile = currentProfile;
  renderUserHeader();
  setupNavigation();

  // Load dashboard first
  await loadDashboard();
  hideOverlay();
}

/* =========================================================
   HEADER USER INFO
   ========================================================= */
function renderUserHeader() {
  const name  = currentProfile?.full_name || currentUser.email;
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  const el = document.getElementById('headerUserInfo');
  if (el) {
    el.innerHTML = `
      <div class="user-avatar">${initials}</div>
      <span style="font-size:13px;opacity:.9;">${name.split(' ')[0]}</span>
    `;
  }
}

/* =========================================================
   NAVIGATION
   ========================================================= */
function setupNavigation() {
  document.querySelectorAll('.navbtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.navbtn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      const view = document.getElementById(btn.dataset.view);
      if (view) view.classList.add('active');

      // Load view data
      switch (btn.dataset.view) {
        case 'dashboard':   await loadDashboard();   break;
        case 'schedule':    await loadSchedule();    break;
        case 'reminders':   await loadReminderView(); break;
        case 'resources':   await loadResources();   break;
        case 'performance': await loadPerformance(); break;
        case 'profile':     renderProfileView();     break;
      }
    });
  });
}

/* ---- Navigate + query from quick chips ---- */
function goToChatWith(text) {
  document.querySelector('.navbtn[data-view="chatbot"]').click();
  document.getElementById('chatInput').value = text;
  sendChat();
}

/* =========================================================
   DASHBOARD
   ========================================================= */
async function loadDashboard() {
  // --- Stat: upcoming in 7 days ---
  const sevenDaysOut = new Date();
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

  const { data: upcoming, error: upErr } = await db
    .from('schedule_items')
    .select('*')
    .eq('student_id', currentUser.id)
    .neq('status', 'done')
    .gte('date', isoDate(today))
    .lte('date', isoDate(sevenDaysOut))
    .order('date', { ascending: true });

  // --- Stat: study hours this week ---
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const { data: weekLogs, error: logErr } = await db
    .from('study_logs')
    .select('hours_studied')
    .eq('student_id', currentUser.id)
    .gte('date', isoDate(weekStart));

  // --- Stat: assignments done/total ---
  const { data: allAssignments } = await db
    .from('schedule_items')
    .select('status')
    .eq('student_id', currentUser.id)
    .eq('type', 'assignment');

  // --- Render stats ---
  const upcomingCount = upcoming ? upcoming.length : 0;
  const totalHours    = weekLogs ? weekLogs.reduce((s, l) => s + (l.hours_studied || 0), 0) : 0;
  const doneCount     = allAssignments ? allAssignments.filter(a => a.status === 'done').length : 0;
  const totalCount    = allAssignments ? allAssignments.length : 0;

  setEl('statUpcoming', upcomingCount);
  setEl('statHours', totalHours.toFixed(1) + 'h');
  setEl('statDone', `${doneCount}/${totalCount}`);

  // --- Upcoming table ---
  const tbody = document.getElementById('dashUpcomingBody');
  if (!upcoming || upcoming.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4">
      <div class="empty-state" style="padding:20px">
        <div class="empty-icon">🎉</div>
        <div class="empty-title">All clear!</div>
        <p>No upcoming deadlines in the next 7 days.</p>
      </div>
    </td></tr>`;
  } else {
    tbody.innerHTML = upcoming.map(s => `
      <tr>
        <td>${escHtml(s.title)}</td>
        <td>${escHtml(s.course)}</td>
        <td><span class="badge ${s.type}">${capitalize(s.type)}</span></td>
        <td>${s.date}</td>
      </tr>
    `).join('');
  }
  await loadReminderNotifications('dashboardReminders', true);
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* =========================================================
   SCHEDULE MANAGEMENT
   ========================================================= */
async function loadSchedule() {
  const tbody = document.getElementById('scheduleBody');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="7"><span class="spinner"></span> Loading…</td></tr>';

  const { data, error } = await db
    .from('schedule_items')
    .select('*')
    .eq('student_id', currentUser.id)
    .order('date', { ascending: true });

  if (error) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Failed to load schedule. Please refresh.</td></tr>';
    return;
  }
  currentScheduleItems = data || [];
  renderScheduleTable(currentScheduleItems);
}

function renderScheduleTable(items) {
  const tbody = document.getElementById('scheduleBody');
  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <div class="empty-title">No schedule items yet</div>
        <p>Use the form above to add a class, assignment, or exam.</p>
      </div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(s => `
    <tr>
      <td><strong>${escHtml(s.title)}</strong></td>
      <td>${escHtml(s.course)}</td>
      <td><span class="badge ${s.type}">${capitalize(s.type)}</span></td>
      <td>${s.date}</td>
      <td>${s.due_time ? escHtml(s.due_time.slice(0, 5)) : '11:59 p.m.'}</td>
      <td><span class="badge ${s.status}">${capitalize(s.status)}</span></td>
      <td style="white-space:nowrap">
        <button class="btn secondary sm" onclick="openEditScheduleModal('${s.id}')">✏ Edit</button>
        ${s.status !== 'done' ? `<button class="btn secondary sm" style="margin-left:4px" onclick="markDone('${s.id}')">✓ Done</button>` : ''}
        <button class="btn danger sm" style="margin-left:4px" onclick="deleteScheduleItem('${s.id}')">✕</button>
      </td>
    </tr>
  `).join('');
}

function openEditScheduleModal(itemId) {
  const item = currentScheduleItems.find(i => i.id === itemId);
  if (!item) return;

  setInputVal('editSchId', item.id);
  setInputVal('editSchTitle', item.title);
  setInputVal('editSchCourse', item.course);
  setInputVal('editSchType', item.type);
  setInputVal('editSchDate', item.date);
  setInputVal('editSchTime', item.due_time || '');
  setInputVal('editSchStatus', item.status);

  const modal = document.getElementById('editScheduleModal');
  if (modal) modal.style.display = 'flex';
}

function closeEditScheduleModal() {
  const modal = document.getElementById('editScheduleModal');
  if (modal) modal.style.display = 'none';
}

async function handleEditScheduleSubmit(e) {
  e.preventDefault();
  const id     = document.getElementById('editSchId').value;
  const title  = document.getElementById('editSchTitle').value.trim();
  const course = document.getElementById('editSchCourse').value.trim();
  const type   = document.getElementById('editSchType').value;
  const date   = document.getElementById('editSchDate').value;
  const dueTime = document.getElementById('editSchTime').value || null;
  const status = document.getElementById('editSchStatus').value;

  if (!id || !title || !course || !date) return;

  const btn = document.getElementById('saveSchEditBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner white sm"></span> Saving…';
  }

  const { error } = await db
    .from('schedule_items')
    .update({ title, course, type, date, due_time: dueTime, status })
    .eq('id', id)
    .eq('student_id', currentUser.id);

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = 'Save Changes';
  }

  if (error) {
    showAlert('Failed to update task: ' + error.message);
    return;
  }

  closeEditScheduleModal();
  await loadSchedule();
  await loadDashboard();
}

async function addScheduleItem(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const title  = document.getElementById('schTitle').value.trim();
  const course = document.getElementById('schCourse').value.trim();
  const type   = document.getElementById('schType').value;
  const date   = document.getElementById('schDate').value;
  const dueTime = document.getElementById('schTime').value || null;

  if (!title || !course || !date) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span>';

  const { data, error } = await db.from('schedule_items').insert({
    student_id: currentUser.id,
    title, course, type, date, due_time: dueTime,
    status: 'pending'
  }).select();

  btn.disabled = false;
  btn.innerHTML = '+ Add';

  if (error) {
    showAlert('Failed to add item: ' + error.message);
    return;
  }
  e.target.reset();
  await loadSchedule();
}

async function markDone(itemId) {
  const { error } = await db
    .from('schedule_items')
    .update({ status: 'done' })
    .eq('id', itemId)
    .eq('student_id', currentUser.id); // RLS also enforces this

  if (error) { showAlert('Could not update status.'); return; }
  await loadSchedule();
  await loadDashboard();
}

async function deleteScheduleItem(itemId) {
  if (!confirm('Delete this schedule item?')) return;
  const { error } = await db
    .from('schedule_items')
    .delete()
    .eq('id', itemId)
    .eq('student_id', currentUser.id);

  if (error) { showAlert('Could not delete item.'); return; }
  await loadSchedule();
  await loadDashboard();
}

/* =========================================================
   RESOURCE MANAGEMENT
   ========================================================= */
const ALLOWED_TYPES = ['application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'];
const MAX_FILE_MB = 20;

async function loadResources() {
  const list = document.getElementById('resourceList');
  list.innerHTML = '<div style="padding:16px;color:var(--muted)"><span class="spinner sm"></span> Loading resources…</div>';

  const { data, error } = await db
    .from('resources')
    .select('*')
    .eq('student_id', currentUser.id)
    .order('upload_date', { ascending: false });

  if (error) {
    list.innerHTML = '<p class="muted">Failed to load resources.</p>';
    return;
  }
  renderResourceList(data || []);
}

function renderResourceList(items) {
  const list = document.getElementById('resourceList');
  if (!items || items.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <div class="empty-title">No study resources uploaded yet</div>
        <p>Upload a PDF, Word, PowerPoint, or text file using the form above.</p>
      </div>`;
    return;
  }
  list.innerHTML = items.map(r => {
    const icon = fileIcon(r.file_name);
    return `
      <div class="resource-item">
        <span class="file-icon">${icon}</span>
        <div class="resource-info">
          <div class="resource-name">${escHtml(r.file_name)}</div>
          <div class="resource-meta">${escHtml(r.course)} · ${r.upload_date}</div>
        </div>
        <div class="resource-actions">
          <button class="btn secondary sm" onclick="viewResource('${r.id}', '${escHtml(r.storage_path)}', '${escHtml(r.file_url || '')}')">⬇ View</button>
          <button class="btn danger sm" onclick="deleteResource('${r.id}', '${escHtml(r.storage_path)}')">✕</button>
        </div>
      </div>`;
  }).join('');
}

async function viewResource(id, storagePath, fallbackUrl) {
  showOverlay('Opening file…');
  try {
    if (storagePath) {
      const { data, error } = await db.storage
        .from('student-resources')
        .createSignedUrl(storagePath, 3600);

      if (data && data.signedUrl) {
        window.open(data.signedUrl, '_blank');
        hideOverlay();
        return;
      }
    }

    if (fallbackUrl) {
      window.open(fallbackUrl, '_blank');
    } else {
      showAlert('Could not view file. Please check that the "student-resources" bucket exists in Supabase Storage.');
    }
  } catch (err) {
    if (fallbackUrl) {
      window.open(fallbackUrl, '_blank');
    } else {
      showAlert('Error opening file: ' + (err.message || 'Storage error'));
    }
  } finally {
    hideOverlay();
  }
}

async function uploadResource(e) {
  e.preventDefault();
  const course   = document.getElementById('resCourse').value.trim();
  const fileInput = document.getElementById('resFile');
  const file     = fileInput.files[0];
  const statusEl = document.getElementById('uploadStatus');

  statusEl.style.display = 'none';

  if (!course)  { showResourceStatus('Please enter a course name.', 'error'); return; }
  if (!file)    { showResourceStatus('Please select a file to upload.', 'error'); return; }

  // Validate type
  if (!ALLOWED_TYPES.includes(file.type)) {
    showResourceStatus('File type not supported. Use PDF, DOC, DOCX, PPT, PPTX, or TXT.', 'error');
    return;
  }
  // Validate size
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    showResourceStatus(`File too large. Maximum size is ${MAX_FILE_MB} MB.`, 'error');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span> Uploading…';

  try {
    const storagePath = `${currentUser.id}/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;

    // 1. Upload to Supabase Storage
    const { error: storErr } = await db.storage
      .from('student-resources')
      .upload(storagePath, file, { upsert: false });
    if (storErr) throw storErr;

    // 2. Get public/signed URL
    const { data: urlData } = db.storage
      .from('student-resources')
      .getPublicUrl(storagePath);
    const fileUrl = urlData?.publicUrl || null;

    // 3. Insert metadata into resources table
    const { error: dbErr } = await db.from('resources').insert({
      student_id:   currentUser.id,
      course,
      file_name:    file.name,
      storage_path: storagePath,
      file_url:     fileUrl,
      upload_date:  isoDate(today)
    });
    if (dbErr) throw dbErr;

    e.target.reset();
    showResourceStatus('File uploaded successfully!', 'success');
    await loadResources();
  } catch (err) {
    const msg = err.message?.includes('duplicate') ? 'A file with this name already exists.' : (err.message || 'Upload failed.');
    showResourceStatus(msg, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⬆ Upload';
  }
}

async function deleteResource(resourceId, storagePath) {
  if (!confirm('Delete this resource?')) return;
  // Delete from storage
  if (storagePath) {
    await db.storage.from('student-resources').remove([storagePath]);
  }
  // Delete metadata
  const { error } = await db.from('resources').delete()
    .eq('id', resourceId).eq('student_id', currentUser.id);
  if (error) { showAlert('Could not delete resource.'); return; }
  await loadResources();
}

function showResourceStatus(msg, type) {
  const el = document.getElementById('uploadStatus');
  if (!el) return;
  el.innerHTML = `<span>${type === 'error' ? '⚠' : '✓'}</span> ${msg}`;
  el.className = `alert ${type}`;
  el.style.display = 'flex';
}

/* =========================================================
   PERFORMANCE TRACKING
   ========================================================= */
async function loadPerformance() {
  await Promise.all([renderWeeklyChart(), renderCourseProgress()]);
}

async function renderWeeklyChart() {
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay()); // Sunday

  const { data: logs } = await db
    .from('study_logs')
    .select('date, hours_studied')
    .eq('student_id', currentUser.id)
    .gte('date', isoDate(weekStart));

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = [0, 0, 0, 0, 0, 0, 0];

  (logs || []).forEach(l => {
    const d = new Date(l.date + 'T00:00:00');
    const idx = d.getDay();
    hours[idx] += l.hours_studied || 0;
  });

  const ctx = document.getElementById('hoursChart');
  if (chartObj) chartObj.destroy();

  chartObj = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Hours studied',
        data: hours,
        backgroundColor: days.map((_, i) => i === today.getDay() ? '#1e447c' : '#2b5fa5'),
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#f0f0f0' } },
        x: { grid: { display: false } }
      },
      animation: { duration: 400 }
    }
  });

  // Show empty state text if all zeros
  const totalEl = document.getElementById('weeklyTotal');
  const total   = hours.reduce((a, b) => a + b, 0);
  if (totalEl) totalEl.textContent = `Total this week: ${total.toFixed(1)}h`;
}

async function renderCourseProgress() {
  const el = document.getElementById('courseProgress');

  // Calculate: (done assignments / total assignments) per course
  const { data: items } = await db
    .from('schedule_items')
    .select('course, status, type')
    .eq('student_id', currentUser.id)
    .eq('type', 'assignment');

  if (!items || items.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <div class="empty-title">No assignment data yet</div>
        <p>Add assignments in Schedule Management to see course progress.</p>
      </div>`;
    return;
  }

  // Group by course
  const courses = {};
  items.forEach(i => {
    if (!courses[i.course]) courses[i.course] = { done: 0, total: 0 };
    courses[i.course].total++;
    if (i.status === 'done') courses[i.course].done++;
  });

  el.innerHTML = Object.entries(courses).map(([course, { done, total }]) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return `
      <div class="progress-wrap">
        <div class="flexrow">
          <span class="progress-label">${escHtml(course)}</span>
          <span class="progress-value">${done}/${total} assignments · ${pct}%</span>
        </div>
        <div class="progress"><div style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

/* Formula: course progress = completed assignments / total assignments × 100 */

async function logStudySession(e) {
  e.preventDefault();
  const course    = document.getElementById('logCourse').value.trim() || 'General';
  const hours     = parseFloat(document.getElementById('logHours').value) || 0;
  const completed = document.getElementById('logCompleted').checked;

  if (hours <= 0) { showAlert('Please enter a valid number of hours.'); return; }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span>';

  const { error } = await db.from('study_logs').insert({
    student_id:    currentUser.id,
    course,
    hours_studied: hours,
    date:          isoDate(today),
    task_completed: completed
  });

  btn.disabled = false;
  btn.innerHTML = '+ Log';

  if (error) { showAlert('Failed to log session: ' + error.message); return; }

  e.target.reset();
  showAlert('Study session logged!', 'success');
  await loadPerformance();
  await loadDashboard();
}

/* =========================================================
   PROFILE VIEW
   ========================================================= */
function renderProfileView() {
  if (!currentProfile) return;
  const el = document.getElementById('profileDisplay');
  if (!el) return;

  const initials = (currentProfile.full_name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  el.innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar">${initials}</div>
      <div>
        <div class="profile-name">${escHtml(currentProfile.full_name || '—')}</div>
        <div class="profile-email">${escHtml(currentProfile.email || currentUser.email)}</div>
      </div>
    </div>`;

  // Pre-fill edit form
  setInputVal('profileName',     currentProfile.full_name);
  setInputVal('profileProgram',  currentProfile.program);
  setInputVal('profileSemester', currentProfile.semester);
}

async function handleProfileUpdate(e) {
  e.preventDefault();
  const fullName = document.getElementById('profileName').value.trim();
  const program  = document.getElementById('profileProgram').value.trim();
  const semester = parseInt(document.getElementById('profileSemester').value, 10);

  if (!fullName || !program || !semester) {
    showAlert('Please fill in all profile fields.', 'error', 'profileAlert');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span> Saving…';

  const error = await updateProfile(currentUser.id, { full_name: fullName, program, semester });

  btn.disabled = false;
  btn.innerHTML = 'Save Changes';

  if (error) {
    showAlert('Update failed: ' + error.message, 'error', 'profileAlert');
    return;
  }

  currentProfile = { ...currentProfile, full_name: fullName, program, semester };
  renderUserHeader();
  renderProfileView();
  showAlert('Profile updated successfully!', 'success', 'profileAlert');
}

/* =========================================================
   SMALL UTILITIES
   ========================================================= */
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function setInputVal(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }

function fileIcon(name) {
  if (!name) return '📄';
  const ext = name.split('.').pop().toLowerCase();
  const map = { pdf:'📕', doc:'📘', docx:'📘', ppt:'📙', pptx:'📙', txt:'📄' };
  return map[ext] || '📄';
}
