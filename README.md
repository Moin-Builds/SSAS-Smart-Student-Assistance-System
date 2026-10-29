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
| 🔒 Data Isolation | Row Level Security (RLS) ensures each student sees only their own data |
| 📱 Responsive Design | Works on desktop, tablet, and mobile |

---

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Styling | Custom CSS (no frameworks) |
| Charts | Chart.js 4.4.0 |
| Backend / Auth | Supabase (Free Tier) |
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
 └── Storage (uploaded study files)
```

---

## File Structure

```
221327-Assig#3/
├── index.html              ← Login page (entry point)
├── signup.html             ← New user registration
├── app.html                ← Main protected application
├── css/
│   └── styles.css          ← All styles (SSAS blue design)
├── js/
│   ├── supabase-client.js  ← Supabase initialization (add your keys here)
│   ├── auth.js             ← Login, signup, logout, session guard
│   ├── app.js              ← Dashboard, schedule, resources, performance
│   └── assistant.js        ← AI chatbot logic
├── supabase_schema.sql     ← Full PostgreSQL schema with RLS
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
