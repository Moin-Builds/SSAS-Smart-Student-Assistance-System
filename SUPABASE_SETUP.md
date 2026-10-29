# SSAS — Supabase Setup Guide
## Step-by-step instructions for a beginner

---

## Overview

SSAS uses **Supabase** as its backend. Supabase is a free, open-source Firebase alternative that provides:
- **Authentication** (user signup/login)
- **PostgreSQL database** (store student data)
- **Storage** (file uploads)

Everything used here is on the **Supabase Free Tier** — no credit card required.

---

## Step 1 — Create a Supabase Account

1. Go to [https://supabase.com](https://supabase.com)
2. Click **"Start your project"**
3. Sign up with GitHub or email
4. Verify your email if asked

---

## Step 2 — Create a New Project

1. After logging in, click **"New project"**
2. Fill in:
   - **Project name**: `SSAS` (or any name you like)
   - **Database password**: Choose a strong password and **save it somewhere safe**
   - **Region**: Choose the closest region to you (e.g., `ap-south-1` for Pakistan)
3. Click **"Create new project"**
4. Wait 1–2 minutes while the project is provisioned

---

## Step 3 — Find Your Project URL and Anon Key

1. In your Supabase project dashboard, click the **Settings** icon (gear icon) in the left sidebar
2. Click **API** (under Configuration)
3. You will see:

   | Field | Example Value |
   |---|---|
   | **Project URL** | `https://abcxyz123.supabase.co` |
   | **anon (public) key** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |

4. Copy both values — you will need them in Step 9

> ⚠️ **IMPORTANT**: You will see a **service_role** key listed below the anon key.  
> **DO NOT copy or use the service_role key.** It has full admin access to your database.  
> Only the **anon key** is needed and safe for browser use.

---

## Step 4 — Run the SQL Schema

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open the file `supabase_schema.sql` from the SSAS project folder
4. **Copy all its contents** and paste into the SQL Editor
5. Click **Run** (or press Ctrl + Enter)
6. You should see: `Success. No rows returned`

This creates all 6 tables with proper security (RLS) and the auto-profile trigger.

---

## Step 5 — Verify the Tables Were Created

1. Click **Table Editor** in the left sidebar
2. You should see these tables:
   - `profiles`
   - `schedule_items`
   - `resources`
   - `study_logs`
   - `chat_interactions`
   - `reminders`

If any table is missing, re-run the relevant `CREATE TABLE` block from `supabase_schema.sql`.

---

## Step 6 — Create the Storage Bucket

> **Note**: The SQL schema already tries to create the bucket via SQL. However, if it didn't work, follow these steps manually:

1. In your Supabase dashboard, click **Storage** in the left sidebar
2. Click **New bucket**
3. Enter the bucket name exactly: `student-resources`
4. Make sure **"Public bucket"** is **unchecked** (leave it private)
5. Click **Create bucket**

---

## Step 7 — Configure Storage Policies

The SQL schema already inserts the storage policies. To verify:

1. Click **Storage** → select `student-resources` bucket
2. Click the **Policies** tab
3. You should see 3 policies:
   - `Students can view own files` (SELECT)
   - `Students can upload own files` (INSERT)
   - `Students can delete own files` (DELETE)

If they are missing, run just the Storage Policy section from `supabase_schema.sql` in the SQL Editor.

---

## Step 8 — Configure Supabase Auth Settings

1. Click **Authentication** in the left sidebar
2. Click **Providers** → make sure **Email** is enabled (it should be on by default)
3. Click **Email Templates** — no changes needed for the prototype
4. (Optional) Under **Authentication** → **Settings**, you can disable "Confirm email" during testing so users don't need to verify their email before logging in:
   - Toggle **"Enable email confirmations"** to OFF
   - This makes testing easier. Re-enable before going live.

---

## Step 9 — Add Your Supabase Keys to the Project

1. Open `js/supabase-client.js` in a text editor (e.g., Notepad, VS Code)
2. Find these two lines near the top:

   ```javascript
   const SUPABASE_URL      = 'YOUR_SUPABASE_PROJECT_URL';
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
   ```

3. Replace `YOUR_SUPABASE_PROJECT_URL` with your **Project URL** from Step 3
4. Replace `YOUR_SUPABASE_ANON_KEY` with your **anon key** from Step 3

   Example:
   ```javascript
   const SUPABASE_URL      = 'https://abcxyz123.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
   ```

5. Save the file

---

## Step 10 — Run the Website

Since SSAS is a static HTML project, you just need to open it in a browser.

### Option A — Simple (double-click)
Double-click `index.html` to open it in your browser.

> ⚠️ **Note**: File upload (Supabase Storage) requires HTTP, not `file://`. Use Option B below for full functionality including file uploads.

### Option B — Recommended (local server)

If you have Python installed:
```bash
# Navigate to the project folder
cd "C:\Users\sheik\OneDrive\Desktop\221327-Assig#3"

# Python 3
python -m http.server 5500
```
Then open: [http://localhost:5500](http://localhost:5500)

If you have VS Code with the **Live Server** extension:
1. Right-click `index.html`
2. Click **"Open with Live Server"**

### Option C — Using npm (if Node.js is installed)
```bash
npx serve .
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Invalid API key" error | Double-check you copied the **anon** key, not the service_role key |
| Login fails | Check your Supabase Auth settings — ensure Email provider is enabled |
| Tables not found | Re-run `supabase_schema.sql` in the SQL Editor |
| File upload fails | Make sure the `student-resources` bucket exists and storage policies are set |
| CORS error | You are probably opening the file directly — use a local HTTP server (Step 10B) |
| "Email already registered" | That email is taken — use a different one or log in instead |
| Data not showing after reload | RLS may be blocking — verify the user is logged in and RLS policies are correct |

---

## Security Summary

| What | How |
|---|---|
| User passwords | Managed by Supabase Auth (hashed, never stored in your tables) |
| Data isolation | Row Level Security (RLS) ensures each student sees only their own data |
| File isolation | Storage policies restrict each student to their own folder |
| Key exposure | Only the anon/public key is in the code — this is safe and intentional |
| Service-role key | NEVER in the frontend code |

---

*SSAS Supabase Setup Guide — v2.0*
