'use strict';
/* =====================================================================
   MAQAM v3 — POST /api/setup
   Vercel Serverless Function (Node.js)

   Body : { mosqueName, password, lat?, lng?, radius, address? }
   Does : 1. ensure setup hasn't been done already
          2. create admin user (bcrypt password hash)
          3. write mosque settings (name, lat, lng, radius, address)
          4. mark setup as done
   ===================================================================== */

const { supabase } = require('../utils/supabaseClient');
const { ok, fail, handler, readBody } = require('../utils/api-helpers');
const bcrypt = require('bcryptjs');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Metode tidak diizinkan.');

  const body = await readBody(req);
  const { mosqueName, password, lat, lng, radius, address } = body || {};

  if (!mosqueName || mosqueName.trim().length < 2) return fail(res, 400, 'Nama masjid wajib diisi.');
  if (!password || password.length < 4) return fail(res, 400, 'Kata sandi minimal 4 karakter.');

  const sb = supabase();

  // ---- setup already done? ----
  const { data: doneRow } = await sb.from('settings').select('value').eq('key', 'setup_done').single();
  if (doneRow && doneRow.value === 'true') {
    return fail(res, 409, 'Setup sudah pernah dilakukan. Gunakan /admin.html untuk login.');
  }

  const name = mosqueName.trim();
  const hash = await bcrypt.hash(password, 12);

  // ---- create admin ----
  const adminEmail = 'admin@' + Date.now().toString(36) + '.maqam';
  const { error: adminErr } = await sb.from('admins').insert({
    email: adminEmail,
    password_hash: hash,
    role: 'admin',
    is_active: true,
    created_at: new Date().toISOString(),
  });
  if (adminErr) return fail(res, 500, 'Gagal membuat admin: ' + adminErr.message);

  // ---- write settings ----
  const settings = [
    { key: 'mosque_name', value: name },
    { key: 'mosque_lat', value: lat != null ? String(lat) : null },
    { key: 'mosque_lng', value: lng != null ? String(lng) : null },
    { key: 'mosque_radius', value: String(radius || 120) },
    { key: 'setup_done', value: 'true' },
    ...(address != null && address.trim() ? [{ key: 'mosque_address', value: address.trim() }] : []),
  ];

  for (const s of settings) {
    const { error: sErr } = await sb.from('settings').upsert(s, { onConflict: 'key' });
    if (sErr) return fail(res, 500, 'Gagal menyimpan pengaturan: ' + sErr.message);
  }

  return ok(res, {
    ok: true,
    mosque: name,
    adminEmail,
    setupDone: true,
  });
});
