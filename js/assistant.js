/* =========================================================
   js/assistant.js
   AI Assistant — SSAS v3.0
   Smart NLU assistant using student data from Supabase.
   Reads real student data from Supabase PostgreSQL.
   ========================================================= */

function addMsg(text, who) {
  const chatWindow = document.getElementById('chatWindow');
  if (!chatWindow) return;
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  if (who === 'bot') {
    div.innerHTML = text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  } else {
    div.textContent = text;
  }
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTypingIndicator() {
  const chatWindow = document.getElementById('chatWindow');
  if (!chatWindow) return;
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.id = 'typingIndicator';
  div.innerHTML = '<span class="spinner sm"></span>&nbsp; Thinking…';
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function getActiveUser() {
  return window.currentUser || (typeof currentUser !== 'undefined' ? currentUser : null);
}

function getActiveProfile() {
  return window.currentProfile || (typeof currentProfile !== 'undefined' ? currentProfile : null);
}

function getActiveDb() {
  return window.db || (typeof db !== 'undefined' ? db : null);
}

async function getStudentContext() {
  const todayStr = new Date().toISOString().slice(0, 10);
  let schedule = [];
  let logs = [];

  const user = getActiveUser();
  const client = getActiveDb();

  try {
    if (client && user && user.id) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [schRes, logRes] = await Promise.all([
        client.from('schedule_items')
          .select('title, course, type, date, status')
          .eq('student_id', user.id)
          .order('date', { ascending: true }),
        client.from('study_logs')
          .select('course, hours_studied, date')
          .eq('student_id', user.id)
          .gte('date', sevenDaysAgo)
      ]);
      if (schRes && schRes.data) schedule = schRes.data;
      if (logRes && logRes.data) logs = logRes.data;
    }
  } catch (err) {
    console.warn('Supabase context fetch notice:', err);
  }

  return { schedule, logs, today: todayStr };
}

async function smartFallbackReply(userMessage, ctx) {
  const msg = userMessage.toLowerCase().trim();
  const profile = getActiveProfile();
  const name = profile?.full_name?.split(' ')[0] || 'Student';
  const user = getActiveUser();
  const client = getActiveDb();

  // 1. Log study hours intent
  const logMatch = msg.match(/log\s+([\d.]+)\s*hours?(?:\s*(?:of\s*)?study)?(?:\s*for\s*([a-z0-9\s]+))?/i);
  if (logMatch) {
    const hrs = parseFloat(logMatch[1]);
    const course = (logMatch[2] || 'General').trim().toUpperCase();
    if (hrs > 0 && user && client) {
      await client.from('study_logs').insert({
        student_id: user.id,
        course: course,
        hours_studied: hrs,
        date: ctx.today,
        task_completed: false
      });
      if (typeof loadDashboard === 'function') loadDashboard();
      if (typeof renderWeeklyChart === 'function') renderWeeklyChart();
      if (typeof renderCourseProgress === 'function') renderCourseProgress();
    }
    return `Logged **${hrs}h** of study for **${course}**. Keep up the great work, ${name}! 💪`;
  }

  // 2. Next exam intent
  if (msg.includes('exam') || msg.includes('quiz') || msg.includes('test') || msg.includes('midterm') || msg.includes('final')) {
    const exams = ctx.schedule.filter(s => s.type === 'exam' && s.status !== 'done')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (exams.length === 0) {
      return `You have no upcoming exams in your schedule right now, ${name}. You're all caught up! 🎉`;
    }
    const nextEx = exams[0];
    return `Your next exam is **${nextEx.title}** (${nextEx.course}) on **${nextEx.date}**.`;
  }

  // 3. Due assignments / deadlines intent
  if (msg.includes('due') || msg.includes('assignment') || msg.includes('deadline') || msg.includes('pending') || msg.includes('homework')) {
    const due = ctx.schedule.filter(s => s.type === 'assignment' && s.status !== 'done')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (due.length === 0) {
      return `You have no pending assignments due, ${name}! High five! 🙌`;
    }
    const list = due.map(d => `• **${d.title}** (${d.course}) — Due: ${d.date}`).join('\n');
    return `Here are your pending assignments:\n${list}`;
  }

  // 4. Study plan / Free hours intent
  const hourMatch = msg.match(/([\d.]+)\s*(?:free\s*)?hours?/);
  if (msg.includes('plan') || msg.includes('suggest') || msg.includes('free') || hourMatch) {
    const freeHours = hourMatch ? parseFloat(hourMatch[1]) : 2;
    const pending = ctx.schedule.filter(s => s.status !== 'done')
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);

    if (pending.length === 0) {
      return `You have ${freeHours} free hours! Since you have no pending schedule items, I recommend reviewing recent lecture notes or getting ahead on reading.`;
    }
    const portion = (freeHours / pending.length).toFixed(1);
    const planItems = pending.map((p, idx) => `${idx + 1}. **${portion}h** on ${p.course}: ${p.title} (due ${p.date})`);
    return `Here is a customized ${freeHours}-hour study plan:\n${planItems.join('\n')}\n\nFocus on the items with the nearest deadlines first!`;
  }

  // 5. Study hours / Progress intent
  if (msg.includes('hour') || msg.includes('progress') || msg.includes('total') || msg.includes('studied') || msg.includes('performance')) {
    const total = ctx.logs.reduce((sum, l) => sum + (parseFloat(l.hours_studied) || 0), 0);
    return `You have logged **${total.toFixed(1)} hours** of study this week, ${name}.`;
  }

  // 6. Greetings & conversational inputs
  if (msg.match(/^(hi|hello|hey|heyyy|yo|greetings|good morning|good afternoon|good evening|can you respond|are you there|respond)\b/i) || msg.length < 4 || msg.includes('respond')) {
    return `Hello ${name}! 👋 Yes, I'm here and ready to help! I am your SSAS AI Assistant. I can check your upcoming exams, pending assignments, suggest study plans, or log your study hours. How can I help you today?`;
  }

  // 7. General fallback
  return `I'm here to assist you, ${name}! You can ask me:\n• "When is my next exam?"\n• "What assignments are due this week?"\n• "I have 3 free hours, suggest a study plan"\n• "Log 2 hours of study for DBMS"`;
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  addMsg(text, 'user');
  input.value = '';
  addTypingIndicator();

  const ctx = await getStudentContext();
  // `let` required — botReplyText may be mutated below if a [LOG:...] tag is stripped
  let botReplyText = await smartFallbackReply(text, ctx);

  // Execute inline log action tags if present
  // BUG FIX S2: was declared `const` but reassigned below — changed to `let`
  let inlineLogMatch = botReplyText.match(/\[LOG:([\d.]+):([A-Z0-9\s]+)\]/i);
  if (inlineLogMatch) {
    const hrs = parseFloat(inlineLogMatch[1]);
    const course = inlineLogMatch[2].trim().toUpperCase();
    const user = getActiveUser();
    const client = getActiveDb();
    if (hrs > 0 && user && client) {
      client.from('study_logs').insert({
        student_id: user.id,
        course: course,
        hours_studied: hrs,
        date: ctx.today,
        task_completed: false
      }).then(() => {
        if (typeof loadDashboard === 'function') loadDashboard();
        if (typeof renderWeeklyChart === 'function') renderWeeklyChart();
        if (typeof renderCourseProgress === 'function') renderCourseProgress();
      });
    }
    botReplyText = botReplyText.replace(/\[LOG:[\d.]+:[A-Z0-9\s]+\]/gi, '').trim();
  }

  removeTypingIndicator();
  addMsg(botReplyText, 'bot');

  // Save to chat_interactions table in Supabase
  const user = getActiveUser();
  const client = getActiveDb();
  if (user && client) {
    client.from('chat_interactions').insert({
      student_id: user.id,
      message: text,
      intent: 'chat',
      response: botReplyText
    }).catch(e => console.warn('Chat interaction save warning:', e));
  }
}

document.getElementById('chatSendBtn')?.addEventListener('click', sendChat);
document.getElementById('chatInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function initChatbot() {
  const profile = getActiveProfile();
  const name = profile?.full_name?.split(' ')[0] || 'there';
  addMsg(
    `Hi **${name}**! 👋 I'm your SSAS AI assistant.\n\nI can see your real schedule and study data. Ask me:\n• "When is my next exam?"\n• "What's due this week?"\n• "I have 3 free hours, suggest a study plan"\n• "Log 2 hours of study for DBMS"`,
    'bot'
  );
}
