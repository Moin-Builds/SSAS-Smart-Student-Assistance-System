/* =========================================================
   AI Quiz and Flashcard Generator
   Uses the authenticated FastAPI RAG backend.
   ========================================================= */

const STUDY_API_BASE = window.AI_BACKEND_URL || 'http://127.0.0.1:8000';
let activeStudyQuiz = null;
let activeStudyFlashcards = null;

async function studyApi(path, options = {}) {
  const client = getActiveDb();
  if (!client) throw new Error('Authentication session expired. Please log in again.');
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Authentication session expired. Please log in again.');

  const response = await fetch(`${STUDY_API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      ...(options.headers || {})
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.detail || result.error || `Study service request failed (${response.status}).`);
  }
  return result;
}

async function loadStudyTools() {
  await Promise.all([loadStudySources(), refreshStudyHistory()]);
}

async function loadStudySources() {
  const select = document.getElementById('studySourceSelect');
  if (!select) return;
  select.replaceChildren(new Option('Loading indexed sources…', ''));

  const client = getActiveDb();
  const user = getActiveUser();
  if (!client || !user) return;

  const { data, error } = await client
    .from('resources')
    .select('id, file_name, course, is_indexed, processing_status')
    .eq('student_id', user.id)
    .eq('is_indexed', true)
    .order('course', { ascending: true });

  if (error) {
    select.replaceChildren(new Option('Could not load indexed sources', ''));
    showStudyStatus(`Could not load documents: ${error.message}`, 'error');
    return;
  }
  if (!data || data.length === 0) {
    select.replaceChildren(new Option('No indexed documents available', ''));
    return;
  }

  select.replaceChildren(new Option('Choose a course or document…', ''));
  const courses = new Map();
  data.forEach(resource => {
    const course = resource.course || 'Uncategorized';
    if (!courses.has(course)) courses.set(course, []);
    courses.get(course).push(resource);
  });

  const courseGroup = document.createElement('optgroup');
  courseGroup.label = 'Courses';
  [...courses.keys()].sort().forEach(course => {
    courseGroup.appendChild(new Option(course, `course|${course}`));
  });
  select.appendChild(courseGroup);

  const documentGroup = document.createElement('optgroup');
  documentGroup.label = 'Documents';
  data.forEach(resource => {
    documentGroup.appendChild(new Option(
      `${resource.file_name} (${resource.course || 'Uncategorized'})`,
      `document|${resource.id}`
    ));
  });
  select.appendChild(documentGroup);
}

async function generateStudySet() {
  const sourceValue = document.getElementById('studySourceSelect')?.value || '';
  const kind = document.getElementById('studyKindSelect')?.value;
  const difficulty = document.getElementById('studyDifficultySelect')?.value;
  const count = Number(document.getElementById('studyCountInput')?.value);
  const focus = document.getElementById('studyFocusInput')?.value.trim();
  const button = document.getElementById('studyGenerateBtn');

  if (!sourceValue.includes('|')) {
    showStudyStatus('Choose a course or indexed document first.', 'error');
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    showStudyStatus('Choose between 1 and 20 questions or flashcards.', 'error');
    return;
  }

  const [source_type, source_id] = sourceValue.split('|', 2);
  button.disabled = true;
  button.textContent = 'Generating…';
  hideStudyPanels();
  showStudyStatus('Retrieving passages and generating your study set…', 'info');

  try {
    const result = await studyApi('/api/study/generate', {
      method: 'POST',
      body: JSON.stringify({ source_type, source_id, kind, difficulty, count, focus: focus || null })
    });
    hideStudyStatus();
    if (kind === 'flashcard') {
      await openStudyFlashcards(result.study_set.id);
    } else {
      activeStudyQuiz = {
        studySet: result.study_set,
        attempt: result.attempt,
        questions: result.questions,
        index: 0,
        submitted: null
      };
      renderStudyQuestion();
    }
    await refreshStudyHistory();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
}

function hideStudyPanels() {
  const quizPanel = document.getElementById('studyQuizPanel');
  const flashPanel = document.getElementById('studyFlashcardPanel');
  if (quizPanel) quizPanel.hidden = true;
  if (flashPanel) flashPanel.hidden = true;
}

function renderStudyQuestion() {
  const quiz = activeStudyQuiz;
  const panel = document.getElementById('studyQuizPanel');
  const content = document.getElementById('studyQuizContent');
  if (!quiz || !panel || !content) return;
  panel.hidden = false;
  content.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = quiz.studySet.title;
  content.appendChild(heading);

  if (quiz.index >= quiz.questions.length) {
    const score = quiz.submitted?.score ?? 0;
    const summary = document.createElement('p');
    summary.className = 'study-result';
    summary.textContent = `Quiz complete — ${quiz.submitted?.correct_count ?? 0} / ${quiz.questions.length} correct (${score}%).`;
    content.appendChild(summary);
    if (quiz.submitted?.correct_count < quiz.questions.length) {
      const practice = document.createElement('button');
      practice.className = 'btn';
      practice.type = 'button';
      practice.textContent = 'Practise missed topics';
      practice.addEventListener('click', generateMissedPractice);
      content.appendChild(practice);
    }
    refreshStudyHistory();
    return;
  }

  const question = quiz.questions[quiz.index];
  const progress = document.createElement('p');
  progress.className = 'muted';
  progress.textContent = `Question ${quiz.index + 1} of ${quiz.questions.length} · ${quiz.studySet.difficulty}`;
  content.appendChild(progress);

  const prompt = document.createElement('p');
  prompt.className = 'study-question';
  prompt.textContent = question.prompt;
  content.appendChild(prompt);

  const form = document.createElement('form');
  form.id = 'studyAnswerForm';
  if (Array.isArray(question.options) && question.options.length > 0) {
    question.options.forEach((option, index) => {
      const label = document.createElement('label');
      label.className = 'study-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'study-answer';
      radio.value = option;
      radio.required = index === 0;
      label.append(radio, document.createTextNode(` ${option}`));
      form.appendChild(label);
    });
  } else {
    const answer = document.createElement('textarea');
    answer.id = 'studyAnswerInput';
    answer.rows = 3;
    answer.maxLength = 2000;
    answer.required = true;
    answer.placeholder = 'Type your answer…';
    form.appendChild(answer);
  }
  const submit = document.createElement('button');
  submit.className = 'btn';
  submit.type = 'submit';
  submit.textContent = 'Submit answer';
  form.appendChild(submit);
  form.addEventListener('submit', submitStudyAnswer);
  content.appendChild(form);
  appendStudySources(content, question.source_refs);
}

async function submitStudyAnswer(event) {
  event.preventDefault();
  const quiz = activeStudyQuiz;
  const question = quiz?.questions[quiz.index];
  if (!quiz || !question) return;
  const form = event.currentTarget;
  const formData = new FormData(form);
  const answer = String(formData.get('study-answer') || document.getElementById('studyAnswerInput')?.value || '').trim();
  if (!answer) {
    showStudyStatus('Choose or enter an answer before submitting.', 'error');
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const result = await studyApi(`/api/study/attempts/${encodeURIComponent(quiz.attempt.id)}/answers`, {
      method: 'POST',
      body: JSON.stringify({ question_id: question.id, answer })
    });
    quiz.submitted = result;
    renderStudyFeedback(result);
    await refreshStudyHistory();
  } catch (error) {
    showStudyStatus(error.message, 'error');
    submit.disabled = false;
    submit.textContent = 'Submit answer';
  }
}

function renderStudyFeedback(result) {
  const content = document.getElementById('studyQuizContent');
  if (!content) return;
  const feedback = document.createElement('div');
  feedback.className = result.is_correct ? 'study-feedback correct' : 'study-feedback review';
  const verdict = document.createElement('strong');
  verdict.textContent = result.is_correct ? 'Correct' : 'Not quite';
  const answer = document.createElement('p');
  answer.textContent = `Answer: ${result.correct_answer}`;
  const explanation = document.createElement('p');
  explanation.textContent = result.explanation;
  const note = document.createElement('p');
  note.textContent = result.feedback;
  feedback.append(verdict, answer, explanation, note);
  appendStudySources(feedback, result.source_refs);
  content.appendChild(feedback);

  const form = document.getElementById('studyAnswerForm');
  if (form) form.remove();
  const next = document.createElement('button');
  next.className = 'btn';
  next.type = 'button';
  next.textContent = result.complete ? 'View score' : 'Next question';
  next.addEventListener('click', () => {
    activeStudyQuiz.index += 1;
    renderStudyQuestion();
  });
  content.appendChild(next);
  const currentScore = document.createElement('p');
  currentScore.className = 'muted';
  currentScore.textContent = `Score so far: ${result.correct_count} / ${result.answered_count}`;
  content.appendChild(currentScore);
}

async function generateMissedPractice() {
  const quiz = activeStudyQuiz;
  if (!quiz) return;
  try {
    showStudyStatus('Generating practice from missed topics…', 'info');
    const result = await studyApi(`/api/study/attempts/${encodeURIComponent(quiz.attempt.id)}/practice`, {
      method: 'POST',
      body: JSON.stringify({
        difficulty: document.getElementById('studyDifficultySelect')?.value || 'medium',
        count: Number(document.getElementById('studyCountInput')?.value) || 5
      })
    });
    hideStudyStatus();
    activeStudyQuiz = {
      studySet: result.study_set,
      attempt: result.attempt,
      questions: result.questions,
      index: 0,
      submitted: null
    };
    renderStudyQuestion();
    await refreshStudyHistory();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  }
}

async function openStudyFlashcards(studySetId) {
  const result = await studyApi(`/api/study/sets/${encodeURIComponent(studySetId)}/flashcards`);
  activeStudyFlashcards = { studySetId, cards: result.flashcards, index: 0, back: null };
  renderStudyFlashcard();
}

function renderStudyFlashcard() {
  const state = activeStudyFlashcards;
  const panel = document.getElementById('studyFlashcardPanel');
  const content = document.getElementById('studyFlashcardContent');
  if (!state || !panel || !content) return;
  panel.hidden = false;
  content.replaceChildren();

  if (state.index >= state.cards.length) {
    const done = document.createElement('p');
    done.className = 'study-result';
    done.textContent = 'Flashcard review complete.';
    content.appendChild(done);
    refreshStudyHistory();
    return;
  }
  const card = state.cards[state.index];
  const progress = document.createElement('p');
  progress.className = 'muted';
  progress.textContent = `Card ${state.index + 1} of ${state.cards.length} · ${card.review_status === 'new' ? 'Not reviewed' : card.review_status}`;
  const front = document.createElement('p');
  front.className = 'study-question';
  front.textContent = card.prompt;
  content.append(progress, front);
  appendStudySources(content, card.source_refs);

  if (state.back === null) {
    const reveal = document.createElement('button');
    reveal.className = 'btn';
    reveal.type = 'button';
    reveal.textContent = 'Reveal answer';
    reveal.addEventListener('click', revealStudyFlashcard);
    content.appendChild(reveal);
    return;
  }

  const back = document.createElement('div');
  back.className = 'study-feedback';
  const answer = document.createElement('p');
  answer.textContent = state.back.correct_answer;
  const explanation = document.createElement('p');
  explanation.textContent = state.back.explanation;
  back.append(answer, explanation);
  content.appendChild(back);

  [['known', 'I know this'], ['revise', 'Needs revision']].forEach(([reviewStatus, label]) => {
    const button = document.createElement('button');
    button.className = reviewStatus === 'known' ? 'btn' : 'btn secondary';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => markStudyFlashcard(reviewStatus));
    content.appendChild(button);
  });
}

async function revealStudyFlashcard() {
  const state = activeStudyFlashcards;
  const card = state?.cards[state.index];
  if (!state || !card) return;
  try {
    state.back = await studyApi(
      `/api/study/sets/${encodeURIComponent(state.studySetId)}/flashcards/${encodeURIComponent(card.id)}/reveal`,
      { method: 'POST', body: '{}' }
    );
    renderStudyFlashcard();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  }
}

async function markStudyFlashcard(reviewStatus) {
  const state = activeStudyFlashcards;
  const card = state?.cards[state.index];
  if (!state || !card) return;
  try {
    await studyApi(
      `/api/study/sets/${encodeURIComponent(state.studySetId)}/flashcards/${encodeURIComponent(card.id)}/review`,
      { method: 'POST', body: JSON.stringify({ status: reviewStatus }) }
    );
    state.index += 1;
    state.back = null;
    renderStudyFlashcard();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  }
}

function appendStudySources(parent, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const list = document.createElement('ul');
  list.className = 'study-sources';
  sources.forEach(source => {
    const item = document.createElement('li');
    const page = source.page_number ? `, page ${source.page_number}` : '';
    item.textContent = `${source.file_name || 'Course notes'}${page}: ${source.excerpt || ''}`;
    list.appendChild(item);
  });
  parent.appendChild(list);
}

async function refreshStudyHistory() {
  const container = document.getElementById('studyHistory');
  if (!container) return;
  try {
    const [setResult, attemptResult] = await Promise.all([
      studyApi('/api/study/sets'),
      studyApi('/api/study/attempts')
    ]);
    renderStudyHistory(container, setResult.study_sets || [], attemptResult.attempts || []);
  } catch (error) {
    container.textContent = `Could not load study history: ${error.message}`;
  }
}

function renderStudyHistory(container, sets, attempts) {
  container.replaceChildren();
  if (!sets.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No saved study sets yet. Generate a quiz or flashcard set to begin.';
    container.appendChild(empty);
    return;
  }
  const attemptBySet = new Map();
  attempts.forEach(attempt => {
    if (!attemptBySet.has(attempt.study_set_id)) attemptBySet.set(attempt.study_set_id, []);
    attemptBySet.get(attempt.study_set_id).push(attempt);
  });
  sets.forEach(studySet => {
    const row = document.createElement('div');
    row.className = 'study-history-item';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = studySet.title;
    const detail = document.createElement('p');
    detail.className = 'muted';
    const flashProgress = studySet.content_type === 'flashcard'
    ? ` · ${studySet.known_count || 0} known · ${studySet.revise_count || 0} to revise`
    : '';
    detail.textContent = `${studySet.content_type.replace('_', ' ')} · ${studySet.course || 'Selected document'} · ${studySet.difficulty}${flashProgress}`;
    info.append(title, detail);

    const actions = document.createElement('div');
    actions.className = 'study-history-actions';
    if (studySet.content_type === 'flashcard') {
      const open = document.createElement('button');
      open.className = 'btn secondary sm';
      open.type = 'button';
      open.textContent = 'Review cards';
      open.addEventListener('click', () => openStudyFlashcards(studySet.id).catch(error => showStudyStatus(error.message, 'error')));
      actions.appendChild(open);
    } else {
      const past = attemptBySet.get(studySet.id) || [];
      const completed = past.filter(attempt => attempt.completed_at);
      const inProgress = past.find(attempt => !attempt.completed_at);
      const summary = document.createElement('span');
      summary.className = 'study-score';
      const scoreHistory = completed.length
        ? `Past scores: ${completed.map(attempt => `${Number(attempt.score || 0)}%`).join(', ')}`
        : 'No completed attempts yet';
      const progress = inProgress
        ? ` · In progress: ${inProgress.answered_count}/${inProgress.total_questions}`
        : '';
      summary.textContent = `${scoreHistory}${progress}`;
      const action = document.createElement('button');
      action.className = 'btn secondary sm';
      action.type = 'button';
      action.textContent = inProgress ? 'Resume quiz' : 'Take quiz';
      action.addEventListener('click', () => inProgress
        ? continueStudyAttempt(inProgress.id)
        : startSavedQuiz(studySet));
      actions.append(summary, action);
    }
    row.append(info, actions);
    container.appendChild(row);
  });
}

async function startSavedQuiz(studySet) {
  try {
    const result = await studyApi(`/api/study/sets/${encodeURIComponent(studySet.id)}/attempts`, {
      method: 'POST',
      body: '{}'
    });
    activeStudyQuiz = {
      studySet,
      attempt: result.attempt,
      questions: result.questions,
      index: 0,
      submitted: null
    };
    hideStudyPanels();
    renderStudyQuestion();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  }
}

async function continueStudyAttempt(attemptId) {
  try {
    const result = await studyApi(`/api/study/attempts/${encodeURIComponent(attemptId)}`);
    activeStudyQuiz = {
      studySet: result.study_set,
      attempt: result.attempt,
      questions: result.questions,
      index: result.answered_count,
      submitted: null
    };
    hideStudyPanels();
    renderStudyQuestion();
  } catch (error) {
    showStudyStatus(error.message, 'error');
  }
}

function showStudyStatus(message, type = 'info') {
  const status = document.getElementById('studyStatus');
  if (!status) return;
  status.textContent = message;
  status.className = `alert ${type}`;
  status.style.display = 'flex';
}

function hideStudyStatus() {
  const status = document.getElementById('studyStatus');
  if (status) status.style.display = 'none';
}
