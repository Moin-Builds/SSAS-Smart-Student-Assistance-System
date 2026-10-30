/* =========================================================
   js/rag.js
   Ask My Notes — RAG Document Assistant — SSAS v3.0
   
   Responsibilities:
     - Populate document selector with student's indexed resources
     - Route requests to FastAPI AI backend (http://127.0.0.1:8000)
       with automatic fallback to Supabase Edge Functions
     - Maintain session chat history for follow-up questions
     - Render answers with exact page citations and excerpts
     - Handle empty/scanned document status notifications
   ========================================================= */

/* ── Service Endpoints ──────────────────────────────────── */
const AI_BACKEND_URL = window.AI_BACKEND_URL || 'http://127.0.0.1:8000';
const EDGE_BASE      = `${SUPABASE_URL}/functions/v1`;

/* ── Conversational State ───────────────────────────────── */
let ragChatHistory = []; // stores [{role: 'user'|'assistant', content: str}]
const activeIndexingRequests = new Map();

/* =========================================================
   DOCUMENT SELECTOR
   Loads the student's resources into the Ask My Notes
   document picker. Shows processing status badge.
   ========================================================= */
async function loadRagDocumentList(retryPending = true) {
  const select = document.getElementById('ragDocSelect');
  const hint   = document.getElementById('ragIndexHint');
  if (!select) return;

  select.innerHTML = '<option value="">Loading documents…</option>';
  select.disabled  = true;

  const client = getActiveDb();
  const user   = getActiveUser();
  if (!client || !user) return;

  const { data, error } = await client
    .from('resources')
    .select('id, file_name, course, is_indexed, chunk_count, processing_status, processing_error, upload_date')
    .eq('student_id', user.id)
    .order('upload_date', { ascending: false });

  if (error || !data || data.length === 0) {
    select.innerHTML = '<option value="">No documents uploaded yet</option>';
    if (hint) hint.textContent = 'Upload a lecture PDF or document in the Resources tab first.';
    return;
  }

  select.innerHTML = '<option value="">— Search across all uploaded notes —</option>';
  data.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;

    let statusText = '⏳ Pending index';
    let isDisabled = false;

    if (r.processing_status === 'indexed' || r.is_indexed) {
      statusText = `✅ Indexed (${r.chunk_count || 0} chunks)`;
    } else if (r.processing_status === 'processing') {
      statusText = '⚙ Processing…';
      isDisabled = true;
    } else if (r.processing_status === 'scanned_image_no_text') {
      statusText = '⚠ Scanned PDF (no selectable text)';
      isDisabled = true;
    } else if (r.processing_status === 'failed') {
      statusText = '❌ Indexing failed';
    }

    opt.textContent = `${r.file_name} (${r.course}) — ${statusText}`;
    opt.disabled    = isDisabled;
    select.appendChild(opt);
  });

  select.disabled = false;
  if (hint) hint.textContent = 'Select a specific document or search across all your indexed lecture notes.';

  const pendingResources = data.filter(r =>
    !r.is_indexed && (!r.processing_status || r.processing_status === 'pending')
  );
  if (retryPending && pendingResources.length > 0 && typeof indexDocument === 'function') {
    (async () => {
      let failedCount = 0;
      for (const resource of pendingResources) {
        if (!await indexDocument(resource.id)) failedCount += 1;
      }
      await loadRagDocumentList(false);
      if (failedCount > 0 && hint) {
        hint.textContent = `Could not index ${failedCount} document${failedCount === 1 ? '' : 's'}. Check the document status and confirm the process-document function is deployed.`;
      }
    })().catch(err => console.error('Could not retry pending document indexing:', err));
  }
}

/* =========================================================
   SUBMIT A QUESTION
   Called when student submits in Ask My Notes mode.
   ========================================================= */
async function sendRagQuestion() {
  const input  = document.getElementById('ragQuestionInput');
  const select = document.getElementById('ragDocSelect');
  if (!input || !select) return;

  const question    = input.value.trim();
  const resource_id = select.value || null;

  if (!question) {
    input.focus();
    return;
  }

  // Show user's question in the chat window
  addMsg(question, 'user');
  input.value = '';
  addTypingIndicator();

  // Append to conversational history for follow-up awareness
  ragChatHistory.push({ role: 'user', content: question });

  const user   = getActiveUser();
  const client = getActiveDb();
  if (!user || !client) {
    removeTypingIndicator();
    addMsg('Authentication session expired. Please log in again.', 'bot');
    return;
  }

  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('No active session');

    let answerData = null;
    let pyRes = null;
    let backendUsed = 'Python FastAPI';

    // 1. Try FastAPI AI Backend first
    try {
      pyRes = await fetch(`${AI_BACKEND_URL}/api/ask`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          question: question,
          resource_id: resource_id,
          chat_history: ragChatHistory.slice(-4)
        })
      });
    } catch (e) {
      // Local FastAPI server offline -> fallback to Supabase Edge Function
      console.info('FastAPI backend offline, switching to Supabase Edge Function fallback...');
    }

    if (pyRes) {
      if (!pyRes.ok) {
        const pyError = await pyRes.json().catch(() => null);
        throw new Error(pyError?.detail || `AI backend request failed (${pyRes.status}).`);
      }
      answerData = await pyRes.json();
    }

    // 2. Fallback to Supabase Edge Function if FastAPI is not running
    if (!answerData) {
      backendUsed = 'Supabase Edge Function';
      const edgeRes = await fetch(`${EDGE_BASE}/ask-document`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey':        SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          resource_id: resource_id,
          question: question
        })
      });

      const edgeJson = await edgeRes.json();
      if (!edgeRes.ok || !edgeJson.success) {
        throw new Error(edgeJson.error || 'Unable to generate answer from Edge Function.');
      }

      answerData = {
        answer: edgeJson.answer,
        has_sufficient_evidence: (edgeJson.sources && edgeJson.sources.length > 0),
        citations: (edgeJson.sources || []).map(s => ({
          file_name: edgeJson.file_name || 'Document',
          page_number: s.page_number || 1,
          chunk_index: s.chunk_index || 0,
          similarity: s.similarity || 0,
          excerpt: s.excerpt || ''
        })),
        document_name: edgeJson.file_name || 'Document'
      };
    }

    removeTypingIndicator();

    // Append assistant answer to history
    ragChatHistory.push({ role: 'assistant', content: answerData.answer });

    // Render formatted response + citations
    renderRagAnswer(
      answerData.answer,
      answerData.citations,
      answerData.document_name,
      answerData.has_sufficient_evidence,
      backendUsed
    );

    // Persist interaction to database
    try {
      const { error: saveError } = await client.from('chat_interactions').insert({
        student_id: user.id,
        message:    question,
        intent:     'rag_document_qa',
        response:   answerData.answer
      });
      if (saveError) console.warn('Could not save AI chat interaction:', saveError.message);
    } catch (saveError) {
      console.warn('Could not save AI chat interaction:', saveError);
    }

  } catch (err) {
    removeTypingIndicator();
    addMsg(`⚠ Could not answer question: ${err.message}`, 'bot');
  }
}

/* =========================================================
   RENDER ANSWER + STRUCTURED CITATIONS
   ========================================================= */
function renderRagAnswer(answer, citations, docName, hasEvidence, backend) {
  const chatWindow = document.getElementById('chatWindow');
  if (!chatWindow) return;

  const answerDiv = document.createElement('div');
  answerDiv.className = 'msg bot';

  const formattedAnswer = answer
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  answerDiv.innerHTML = formattedAnswer;
  chatWindow.appendChild(answerDiv);

  // Render clickable source citations if evidence was found
  if (hasEvidence && citations && citations.length > 0) {
    const citDiv = document.createElement('div');
    citDiv.className = 'rag-citations';

    const toggle = document.createElement('button');
    toggle.className = 'rag-cite-toggle';
    toggle.innerHTML = `📚 <strong>${citations.length} verified citation${citations.length > 1 ? 's' : ''}</strong> from "${escHtml(docName)}"`;
    toggle.setAttribute('aria-expanded', 'false');

    const citeList = document.createElement('div');
    citeList.className = 'rag-cite-list';
    citeList.hidden = true;

    citations.forEach(c => {
      const item = document.createElement('div');
      item.className = 'rag-cite-item';
      const scoreBadge = c.similarity ? `<span style="float:right;font-size:10.5px;color:var(--primary);opacity:0.85">Match: ${Math.round(c.similarity * 100)}%</span>` : '';
      item.innerHTML = `
        ${scoreBadge}
        <span class="rag-cite-label">📄 Page ${c.page_number} &middot; Section ${c.chunk_index + 1}</span>
        <span class="rag-cite-excerpt">"${escHtml(c.excerpt)}"</span>
      `;
      citeList.appendChild(item);
    });

    toggle.addEventListener('click', () => {
      const isOpen = !citeList.hidden;
      citeList.hidden = isOpen;
      toggle.setAttribute('aria-expanded', String(!isOpen));
    });

    citDiv.appendChild(toggle);
    citDiv.appendChild(citeList);
    chatWindow.appendChild(citDiv);
  }

  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* =========================================================
   DOCUMENT INDEXING TRIGGER
   ========================================================= */
function indexDocument(resource_id) {
  const activeRequest = activeIndexingRequests.get(resource_id);
  if (activeRequest) return activeRequest;

  const request = runDocumentIndexing(resource_id)
    .finally(() => activeIndexingRequests.delete(resource_id));
  activeIndexingRequests.set(resource_id, request);
  return request;
}

async function runDocumentIndexing(resource_id) {
  const user   = getActiveUser();
  const client = getActiveDb();
  if (!user || !client || !resource_id) return false;

  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session) return false;

    // 1. Try FastAPI AI Backend
    let pyRes = null;
    try {
      pyRes = await fetch(`${AI_BACKEND_URL}/api/process-document`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ resource_id })
      });
    } catch (e) {
      console.info('FastAPI indexing unavailable, falling back to Edge Function...');
    }

    if (pyRes) {
      const pyJson = await pyRes.json().catch(() => null);
      if (!pyRes.ok || !pyJson?.success) {
        throw new Error(pyJson?.detail || pyJson?.message || `AI backend indexing failed (${pyRes.status}).`);
      }
      console.log(`[FastAPI] Indexed ${pyJson.chunk_count} chunks.`);
      return true;
    }

    // 2. Fallback to Supabase Edge Function
    const edgeRes = await fetch(`${EDGE_BASE}/process-document`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey':        SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ resource_id })
    });

    const edgeJson = await edgeRes.json();
    if (!edgeRes.ok || !edgeJson.success) {
      throw new Error(edgeJson.error || 'The document indexing service returned an error.');
    }
    return true;

  } catch (err) {
    console.warn('Document indexing failed:', err.message);
    return false;
  }
}

/* =========================================================
   MODE SWITCHING
   ========================================================= */
function switchAssistantMode(mode) {
  const modes = {
    schedule: { panel: 'assistantScheduleMode', button: 'modeScheduleBtn', label: '💬 Schedule Assistant' },
    rag: { panel: 'assistantRagMode', button: 'modeRagBtn', label: '⚡ AI Research & Study Assistant' },
    study: { panel: 'assistantStudyMode', button: 'modeStudyBtn', label: '🧠 Quizzes & Flashcards' }
  };
  if (!modes[mode]) return;

  Object.entries(modes).forEach(([name, config]) => {
    const panel = document.getElementById(config.panel);
    const button = document.getElementById(config.button);
    if (panel) panel.hidden = name !== mode;
    if (button) {
      button.classList.toggle('active', name === mode);
      button.setAttribute('aria-selected', String(name === mode));
    }
  });

  const chatWindow = document.getElementById('chatWindow');
  if (chatWindow) chatWindow.hidden = mode === 'study';
  const badge = document.getElementById('assistantModeBadge');
  if (badge) badge.textContent = modes[mode].label;
  if (mode === 'rag') loadRagDocumentList();
  if (mode === 'study' && typeof loadStudyTools === 'function') loadStudyTools();
}

function ragShowStatus(msg, type = 'info') {
  const el = document.getElementById('ragStatus');
  if (!el) return;
  el.textContent   = msg;
  el.className     = `rag-status ${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4500);
}
