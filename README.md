# SSAS — Smart Student Assistance System

A real multi-user web application for students to manage their academic schedule, resources, and performance — backed by Supabase (Auth + PostgreSQL + Storage).

---

## Features

| Feature | Description |
|---|---|
| 🔐 Authentication | Secure login and signup via Supabase Auth |
| 👤 Student Profiles | Per-student profile with program and semester |
| 📅 Schedule Management | Add, view, mark done, and delete classes/assignments/exams |
| 📁 Resource Management | Real file upload to Supabase Storage (PDF, DOC, DOCX, PPT, TXT) |
| 📈 Performance Tracking | Study session logging + weekly chart + course progress |
| 🤖 AI Assistant | Rule-based chatbot that reads real student data from Supabase |
| 📚 AI Study Tools | RAG-grounded quizzes, scored attempts, missed-topic practice, and flashcards |
| 🔒 Data Isolation | Row Level Security (RLS) ensures each student sees only their own data |
| 📱 Responsive Design | Works on desktop, tablet, and mobile |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Styling | Custom CSS (no frameworks) |
| Charts | Chart.js 4.4.0 |
| Backend / Auth | Supabase Auth + FastAPI |
| Database | Supabase PostgreSQL |
| File Storage | Supabase Storage |
| AI Assistant | Rule-based intent engine (no paid APIs) |

**Architecture:**
```
Student Browser
      ↓
HTML / CSS / JavaScript
      ↓
Supabase
 ├── Auth (login, signup, sessions)
 ├── PostgreSQL (schedule, resources, logs, chat)
 ├── Storage (uploaded study files)
 └── FastAPI RAG backend + Groq (document Q&A and study tools)
```

---

## File Structure

```
221327-Assig#3/
├── index.html              ← Login page (entry point)
├── signup.html             ← New user registration
├── forgot-password.html    ← Request an account recovery email
├── reset-password.html     ← Set a new password from the email link
├── app.html                ← Main protected application
├── css/
│   └── styles.css          ← All styles (SSAS blue design)
├── js/
│   ├── supabase-client.js  ← Supabase initialization (add your keys here)
│   ├── auth.js             ← Login, signup, logout, session guard
│   ├── app.js              ← Dashboard, schedule, resources, performance
│   ├── assistant.js        ← Schedule assistant
│   ├── rag.js              ← Document Q&A and assistant modes
│   └── study-tools.js      ← Quiz and flashcard UI
├── backend/
│   ├── app/main.py         ← FastAPI endpoints
│   └── app/study_service.py ← RAG-based study set logic
├── supabase_schema.sql     ← Full PostgreSQL schema with RLS
├── rag_migration.sql       ← Existing document index schema
├── rag_study_tools_migration.sql ← Quiz/flashcard schema and policies
├── SUPABASE_SETUP.md       ← Step-by-step Supabase configuration guide
├── README.md               ← This file
├── .env.example            ← Documents required configuration values
└── ssas_prototype.html     ← Original static prototype (reference only)
```

---

## Supabase Setup

**See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for complete step-by-step instructions.**

Quick summary:
1. Create a free Supabase account at [supabase.com](https://supabase.com)
2. Create a new project
3. Copy your **Project URL** and **anon key** from Settings → API
4. Run `supabase_schema.sql` in the SQL Editor
5. Create the `student-resources` Storage bucket (private)
6. Add your credentials to `js/supabase-client.js`

---

## Environment Configuration

Since SSAS is a pure static HTML project (no Node.js build step), Supabase credentials are placed directly in `js/supabase-client.js`:

```javascript
const SUPABASE_URL      = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGci...';
```

> ✅ The **anon key** is safe to include in browser code — it is a publishable key.  
> ❌ Never include the **service_role key** anywhere in your frontend code.

See `.env.example` for the list of required values.

---

## Database Setup

Run `supabase_schema.sql` in Supabase → SQL Editor. This creates:

| Table | Purpose |
|---|---|
| `profiles` | Extended user info (name, program, semester) |
| `schedule_items` | Classes, assignments, exams per student |
| `resources` | File upload metadata |
| `study_logs` | Study session records (hours, course, date) |
| `chat_interactions` | Chatbot conversation history |
| `reminders` | Deadline reminders |

All tables have **Row Level Security (RLS)** enabled. Students can only access their own data.

**Course Progress Formula:**
```
Progress (%) = Completed assignments ÷ Total assignments × 100
```

---

## Storage Setup

Create a private bucket named `student-resources`.

Files are stored at the path: `student-resources/{user_id}/{filename}`

Storage policies ensure each student can only access their own folder.

---

## Authentication Setup

Supabase Auth is used for all authentication.

- Passwords are hashed by Supabase — never stored in the `profiles` table
- Password recovery sends a one-time Supabase email link to `reset-password.html`
- Sessions are persistent (survive page refreshes)
- Session guard on `app.html` redirects unauthenticated users to `index.html`

---

## Local Execution

### Option 1 — Python HTTP Server (Recommended)
```bash
cd "C:\Users\sheik\OneDrive\Desktop\221327-Assig#3"
python -m http.server 5500
```
Open: http://localhost:5500

### Option 2 — VS Code Live Server
Right-click `index.html` → "Open with Live Server"

### Option 3 — npx serve
```bash
npx serve .
```

> ⚠️ Do NOT open HTML files directly with `file://` — Supabase Storage requires HTTP.

## AI Quiz and Flashcard Generator

The **Quizzes & Flashcards** tab in the AI Assistant generates MCQs, short-answer quizzes, and flashcards from indexed documents or all indexed documents for a selected course. Questions are generated from the existing RAG/pgvector retrieval results and include source references. Quiz answers and explanations are kept server-side until each answer is submitted.

### Setup

1. Apply `supabase_schema.sql`, then `rag_migration.sql`, then `rag_study_tools_migration.sql` in the Supabase SQL Editor.
2. Configure `backend/.env` using `backend/.env.example`. The backend needs the Supabase URL, anon key, service-role key, and a valid Groq API key. Keep this file private and never put the service-role or Groq key in frontend code.
3. Ensure the selected document(s) show as indexed in Ask My Notes.
4. Start the frontend using the local server instructions above.
5. From the project root, start the API with:

   ```powershell
   .\backend\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
   ```

6. Sign in, open **AI Assistant → Quizzes & Flashcards**, select a course or document, choose a format/difficulty/count, and generate a set.

The backend exposes `/api/study/generate`, `/api/study/sets`, `/api/study/attempts`, and per-attempt answer/practice and per-flashcard reveal/review endpoints. API requests require the student's Supabase bearer token.

### Feature tests

Run the backend tests with:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q
```

## Automated Assignment and Exam Reminders

The Reminders area stores each student's IANA time zone, selected lead times (1, 24, and/or 72 hours), and delivery preferences. Assignment/exam reminders are generated by a Supabase PostgreSQL function and processed by a managed `pg_cron` job every minute; no browser tab must remain open. Database uniqueness prevents duplicate rows for the same schedule item, lead time, and deadline. Updating/completing a schedule item invalidates its outstanding notifications, while deletion cascades them.

Date-only schedule entries use **11:59 p.m. in the student's saved time zone**. Students can optionally enter a due time; the database converts that local date/time using PostgreSQL time-zone rules. In-app notifications are enabled by default. Email is opt-in and uses Resend only after the configured sender domain is verified. Resend credentials stay in Supabase Edge Function secrets; the scheduler's project URL and service-role key are stored in Supabase Vault.

### Setup

1. Apply the existing database scripts in order: `supabase_schema.sql`, `rag_migration.sql`, and `rag_study_tools_migration.sql`.
2. Apply `reminder_migration.sql` in the Supabase SQL Editor. It adds `schedule_items.due_time`, student reminder preferences, per-interval delivery/retry state, owner-scoped RLS, reminder generation/claim functions, and schedule-change handling.
3. Link the Supabase CLI to the project and deploy the worker:

   ```powershell
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy process-reminders --project-ref YOUR_PROJECT_REF
   ```

4. In Supabase **Database → Vault**, create `ssas_reminder_project_url` with the project URL and `ssas_reminder_service_role_key` with the service-role key. Then run `reminder_scheduler.sql` once in SQL Editor to schedule `process-reminders` every minute through `pg_cron`/`pg_net`. The SQL file contains no secret values. Never put the service-role key in browser code.
5. In the Supabase Dashboard, set the Edge Function secrets below only if email is desired. Leave them unset to use in-app reminders only:

   ```powershell
   supabase secrets set --project-ref YOUR_PROJECT_REF RESEND_API_KEY=YOUR_RESEND_API_KEY REMINDER_FROM_EMAIL=reminders@your-verified-domain.example
   ```

   The worker checks Resend's verified domains before calling its send API. An unverified or unavailable provider is recorded as a delivery failure and **no email is sent**.
6. Sign in, open **Reminders**, choose the time zone, intervals and channels, then add an assignment/exam in **Schedule**. The project is not considered operational until the migration, Edge Function, Vault secrets, and scheduled job have been verified in the target Supabase project.

For local Edge Function development, copy `supabase/functions/process-reminders/.env.example` to a private `.env.local`, fill in local Supabase credentials, and use:

```powershell
supabase functions serve process-reminders --env-file supabase/functions/process-reminders/.env.local
```

The optional email variables are `RESEND_API_KEY` and `REMINDER_FROM_EMAIL`. Hosted Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function. Do not store provider or service-role credentials in frontend files.

### Reminder observability and checks

- In-app status is stored in `reminders.status`; email state, attempt count, retry time, and the last error are stored in `email_status`, `delivery_attempts`, `next_retry_at`, and `email_error`.
- Transient Resend network/429/5xx failures retry after 2 and 10 minutes (maximum three sends); provider idempotency keys and database claims prevent duplicate sends during overlapping scheduler runs.
- Function logs are available in Supabase **Edge Functions → process-reminders → Logs**. Cron invocations are visible in SQL Editor:

  ```sql
  SELECT jobid, status, return_message, start_time
  FROM cron.job_run_details
  ORDER BY start_time DESC
  LIMIT 25;
  ```

- After setting up a non-production Supabase project, verify the flow with two test students: create an exam with a due time in each student's different time zone; confirm reminders appear at the selected intervals; run the worker repeatedly and confirm one row per item/interval/deadline; mark one item done or change its deadline and confirm old reminders are invalidated; dismiss a notification; trigger a temporary provider failure and confirm retry metadata; then sign in as the other student and confirm no reminders or preferences cross accounts.
- `supabase/tests/reminders.test.sql` is a pgTAP integration test for reminder generation/idempotency, two time zones, RLS isolation, retry metadata, and completion invalidation. Run it only against a non-production database after applying the schema and migration; its transaction rolls back its fixture records.
- No migration, scheduled job, live email, or cross-account integration test has been run against the linked Supabase project from this workspace.

---

## Testing

### Two-Student Test (Mandatory)

**Student A:**
1. Create account: `student-a@test.com`, BS Computer Science, Semester 1
2. Add a DBMS assignment and an OS exam
3. Upload a PDF resource
4. Log 2 study hours
5. Ask the chatbot: "When is my next exam?"
6. Refresh → data persists
7. Logout

**Student B:**
1. Create account: `student-b@test.com`
2. Confirm: **0 schedule items, 0 study hours, 0 resources**
3. Student B must NOT see Student A's data (RLS enforces this)

### RLS Security Test
- Log in as Student B
- Try to access Student A's records by changing `student_id` in browser DevTools
- The database will reject the query (RLS uses `auth.uid()`, not the supplied value)

---

## Deployment

For free hosting, use:

| Option | Notes |
|---|---|
| **Vercel** | Drag-and-drop static deploy. Free tier. |
| **Netlify** | Drag-and-drop or Git deploy. Free tier. |
| **GitHub Pages** | Free static hosting from a GitHub repo. |

No server-side build is required — just upload all files.

---

## Limitations

- The AI Assistant is rule-based (no NLP/ML). It understands a fixed set of intents.
- Real-time updates (Supabase Realtime) are not enabled — refresh to see changes.
- Email verification is optional. Disable it in Supabase Auth settings during development.
- File uploads require HTTP (not `file://` protocol).
- Maximum file size: 20 MB (Supabase Storage free tier supports up to 50 MB per file).
- Supabase Free Tier: 500 MB database, 1 GB storage, 50 MB file upload.

---

## Report Alignment

| Report Concept | Implementation |
|---|---|
| Student | `auth.users` + `profiles` table |
| Course | `course` field in `schedule_items`, `resources`, `study_logs` |
| Schedule_Item | `schedule_items` table |
| Resource | `resources` table + Supabase Storage |
| Study_Log | `study_logs` table |
| Chat_Interaction | `chat_interactions` table |
| Reminder | `reminders` table |
| Presentation Layer | HTML / CSS / JS |
| Application Layer | `js/app.js`, `js/assistant.js`, `js/auth.js` |
| Data Layer | Supabase PostgreSQL (via `js/supabase-client.js`) |
| External Services | Supabase Auth + Storage |

---

*SSAS — Smart Student Assistance System · v2.0 · Real Multi-User Build*
