/* =========================================================
   js/supabase-client.js
   Supabase client initialisation — SSAS v2.0
   
   IMPORTANT: Replace the two constants below with your
   actual Supabase project URL and anon (public) key.
   These are SAFE to expose in the browser — they are
   publishable / anonymous credentials.
   NEVER put your service-role (secret) key here.
   ========================================================= */

const SUPABASE_URL = 'https://mnvvyxszhvhorltmerqi.supabase.co';   // e.g. https://abcx    yz.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_kPaH233LARrUZm_T83qO1g_Nuk0HpPK';      // starts with "eyJ..."

// Supabase JS v2 is loaded via CDN — window.supabase is available
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,   // keep user logged in across page refreshes
    autoRefreshToken: true,   // auto-refresh JWT
    detectSessionInUrl: true   // handle OAuth/magic-link redirects
  }
});
