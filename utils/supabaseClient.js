'use strict';
/* =====================================================================
   MAQAM v3 — Supabase client (server-side only, service_role key)
   ===================================================================== */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

function supabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const e = new Error('Supabase belum dikonfigurasi — set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY di environment variables.');
    e.status = 503; e.code = 'NOSUPA';
    throw e;
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

module.exports = { supabase, SUPABASE_URL };
