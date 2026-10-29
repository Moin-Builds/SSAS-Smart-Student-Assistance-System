/* =========================================================
   js/auth.js
   Authentication helpers — SSAS v2.0
   Handles: login, signup, logout, session guard, profile
   ========================================================= */

/* ---- Shared helper: show/hide loading overlay ---- */
function showOverlay(msg = 'Loading…') {
  const o = document.getElementById('loadingOverlay');
  if (o) { o.style.display = 'flex'; o.querySelector('p').textContent = msg; }
}
function hideOverlay() {
  const o = document.getElementById('loadingOverlay');
  if (o) o.style.display = 'none';
}

/* ---- Alert helper (auth pages) ---- */
function showAuthAlert(elId, msg, type = 'error') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<span>${type === 'error' ? '⚠' : '✓'}</span> ${msg}`;
  el.className = `alert ${type}`;
  el.style.display = 'flex';
}
function clearAuthAlert(elId) {
  const el = document.getElementById(elId);
  if (el) { el.style.display = 'none'; el.textContent = ''; }
}

/* =========================================================
   SIGNUP
   ========================================================= */
async function handleSignup(e) {
  e.preventDefault();
  clearAuthAlert('signupAlert');

  const fullName = document.getElementById('signupName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirm  = document.getElementById('signupConfirm').value;
  const program  = document.getElementById('signupProgram').value.trim();
  const semester = parseInt(document.getElementById('signupSemester').value, 10);

  // --- Validation ---
  if (!fullName || !email || !password || !confirm || !program || !semester) {
    return showAuthAlert('signupAlert', 'Please fill in all fields.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showAuthAlert('signupAlert', 'Please enter a valid email address.');
  }
  if (password.length < 8) {
    return showAuthAlert('signupAlert', 'Password must be at least 8 characters long.');
  }
  if (password !== confirm) {
    return showAuthAlert('signupAlert', 'Passwords do not match.');
  }
  if (semester < 1 || semester > 8) {
    return showAuthAlert('signupAlert', 'Semester must be between 1 and 8.');
  }

  const btn = document.getElementById('signupBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span> Creating account…';

  try {
    // 1. Create auth user
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, program, semester }  // stored in auth.users.raw_user_meta_data
      }
    });

    if (error) throw error;

    // 2. Upsert profile row (trigger also does this, but belt-and-suspenders)
    if (data.user) {
      const { error: profErr } = await db.from('profiles').upsert({
        id:        data.user.id,
        full_name: fullName,
        email,
        program,
        semester
      }, { onConflict: 'id' });
      if (profErr) console.warn('Profile upsert warning:', profErr.message);
    }

    // 3. Redirect
    showAuthAlert('signupAlert', 'Account created! Redirecting…', 'success');
    setTimeout(() => { window.location.href = 'app.html'; }, 1200);

  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Create Account';
    const friendly = friendlyAuthError(err.message);
    showAuthAlert('signupAlert', friendly);
  }
}

/* =========================================================
   LOGIN
   ========================================================= */
async function handleLogin(e) {
  e.preventDefault();
  clearAuthAlert('loginAlert');

  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    return showAuthAlert('loginAlert', 'Please enter your email and password.');
  }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner white sm"></span> Logging in…';

  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    window.location.href = 'app.html';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Login';
    showAuthAlert('loginAlert', friendlyAuthError(err.message));
  }
}

/* =========================================================
   LOGOUT
   ========================================================= */
async function handleLogout() {
  try {
    await db.auth.signOut();
  } catch (_) { /* ignore */ }
  window.location.href = 'index.html';
}

/* =========================================================
   SESSION GUARD
   Call on every protected page (app.html, profile.html)
   Returns the session user, or redirects to login.
   ========================================================= */
async function requireAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  return session.user;
}

/* =========================================================
   PROFILE LOAD / UPDATE
   ========================================================= */
async function loadProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) console.warn('Profile load error:', error.message);
  return data;
}

async function updateProfile(userId, updates) {
  const { error } = await db
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId);
  return error;
}

/* =========================================================
   HELPER: Map raw Supabase/GoTrue errors to friendly text
   ========================================================= */
function friendlyAuthError(msg) {
  if (!msg) return 'An unexpected error occurred. Please try again.';
  const m = msg.toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials'))
    return 'Incorrect email or password. Please try again.';
  if (m.includes('email already') || m.includes('already registered') || m.includes('already been registered'))
    return 'An account with this email already exists. Try logging in instead.';
  if (m.includes('email not confirmed'))
    return 'Please verify your email before logging in. Check your inbox.';
  if (m.includes('rate limit') || m.includes('too many'))
    return 'Too many attempts. Please wait a moment and try again.';
  if (m.includes('network') || m.includes('fetch'))
    return 'Network error. Please check your connection and try again.';
  if (m.includes('weak password') || m.includes('password should'))
    return 'Password is too weak. Use at least 8 characters with mixed types.';
  return msg; // fallback: show the original message
}

/* =========================================================
   REDIRECT-IF-ALREADY-LOGGED-IN  (call on login/signup pages)
   ========================================================= */
async function redirectIfLoggedIn() {
  const { data: { session } } = await db.auth.getSession();
  if (session) window.location.href = 'app.html';
}
