'use strict';
/* =====================================================================
   MAQAM v3 — /api/admin.js   (single-file router)

   Endpoints:
     POST   /api/admin                    → delegates to handler(req,res) below
     GET/POST sub-paths are dispatched by req.path + req.method

   Supported actions:
     login          POST   { password } → { token }
     me             GET    → { email, token } (session refresh)
     logout         POST   → { ok }
     members        GET    → [{ id, name, photo, ... }]
     attendance     GET/POST ?dateFrom&dateTo&prayer&member_id → records[]
     attendance/count POST ?dateFrom&dateTo → [{ date, count }]
     standings      GET    → [{ name, count }]
     chart          GET    ?days=30 → [{ date, count }]
     toggle-member  POST   { id } → { ok }
     remove-member  POST   { id } → { ok }
     save-address   POST   { address } → { ok }
     change-password POST  { oldPassword, newPassword } → { ok }
     save-setting   POST   { key, value } → { ok }
     clear-attendance POST → { ok }
     reset          POST   → { ok }
     save-scene     POST   { sceneRefThresh, sceneMargin } → { ok }
   ===================================================================== */

const crypto = require('crypto');
const { ok, fail, handler, readBody, verifyAdminToken } = require('../utils/api-helpers');
const { supabase } = require('../utils/supabaseClient');
const bcrypt = require('bcryptjs');

const Svc = supabase();            // service-role client (already configured in utils)

module.exports = handler(async (req, res) => {
  const path = req.path || req.url || '/';
  const method = req.method;

  // ---- admin session (header X-Admin-Token or Authorization: Bearer) ----
  const token = (req.headers['x-admin-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const admin = await verifyAdminToken(token);
  if (!admin.ok && path !== '/login' && path !== '/') {
    return fail(res, 401, 'Admin belum login.');
  }

  // ---- routing ----
  if (method === 'POST' && (path === '/login' || path.endsWith('/login'))) {
    return doLogin(req, res);
  }
  if (method === 'GET' && (path === '/' || path.endsWith('/me') || path === '/me')) {
    return me(req, res, admin);
  }
  if (method === 'POST' && (path === '/logout' || path.endsWith('/logout'))) {
    return logout(req, res);
  }
  if (method === 'GET' && path.endsWith('/members')) {
    return members(req, res);
  }
  if (method === 'POST' && path.endsWith('/attendance/count')) {
    return attendanceCount(req, res);
  }
  if ((method === 'GET' || method === 'POST') && path.endsWith('/attendance')) {
    return attendance(req, res, admin);
  }
  if (method === 'GET' && path.endsWith('/standings')) {
    return standings(req, res);
  }
  if (method === 'GET' && path.endsWith('/chart')) {
    return chart(req, res);
  }
  if (method === 'POST' && path.endsWith('/toggle-member')) {
    return toggleMember(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/remove-member')) {
    return removeMember(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/save-address')) {
    return saveAddress(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/change-password')) {
    return changePassword(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/save-setting')) {
    return saveSetting(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/clear-attendance')) {
    return clearAttendance(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/reset')) {
    return resetApp(req, res, admin);
  }
  if (method === 'POST' && path.endsWith('/save-scene')) {
    return saveScene(req, res, admin);
  }

  return fail(res, 404, 'Endpoint admin tidak dikenal.');
});

/* =================================================================== */
/* endpoints                                                           */
/* =================================================================== */

async function doLogin(req, res) {
  const body = await readBody(req);
  const { username, password } = body || {};
  if (!password) return fail(res, 400, 'Kata sandi wajib diisi.');

  // look up admin — if username (email) is provided, filter by it;
  // otherwise pick the first active admin (single-admin setup).
  let query = Svc.from('admins').select('id, email, password_hash, role').eq('is_active', true);
  if (username) {
    query = query.eq('email', username.toLowerCase());
  } else {
    query = query.limit(1);
  }
  const { data, error } = await query.single();
  if (error || !data) return fail(res, 401, 'Kata sandi salah.');

  // verify password with bcrypt
  const match = await bcrypt.compare(password, data.password_hash);
  if (!match) return fail(res, 401, 'Kata sandi salah.');

  // issue stateless HMAC token
  const payload = data.email + '.' + Date.now();
  const sig = crypto.createHmac('sha256', data.id.toString()).update(payload).digest('hex').slice(0, 32);
  const token = payload + '.' + sig;

  return ok(res, { token, email: data.email });
}

async function me(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  return ok(res, { email: admin.admin.email, token: req.headers['x-admin-token'] || '' });
}

async function logout(req, res) {
  // stateless token — nothing to revoke server-side
  return ok(res, { ok: true });
}

async function members(req, res) {
  const { data, error } = await Svc.from('users').select('*')
    .order('created_at', { ascending: false });
  if (error) return fail(res, 500, 'Gagal membaca anggota: ' + error.message);
  const list = (data || []).map(r => ({
    id: r.id,
    name: r.name,
    photo: r.photo_url,
    email: r.email || '',
    phone: r.phone || '',
    reminders: r.reminders || '',
    notes: r.notes || '',
    created_at: r.created_at,
    is_active: r.is_active,
  }));
  return ok(res, { members: list, count: list.length });
}

async function attendance(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');

  const qs = req.query || {};
  let body = {};
  if (req.body) {
    try { body = JSON.parse(req.body); } catch (_) {}
  }
  const dateFrom = body.dateFrom || qs.dateFrom || new Date().toISOString().slice(0, 7) + '-01';
  const dateTo   = body.dateTo   || qs.dateTo   || new Date().toISOString().slice(0, 10);
  const prayer   = body.prayer   || qs.prayer;
  const memberId = body.member_id || qs.member_id;
  const limit    = Math.min(200, parseInt(body.limit || qs.limit || 50) || 50);
  const offset   = parseInt(body.offset || qs.offset || 0) || 0;

  let q = Svc.from('attendance').select('*').gte('date', dateFrom).lte('date', dateTo).order('timestamp', { ascending: false });
  if (prayer)     q = q.eq('prayer', prayer);
  if (memberId)   q = q.eq('member_id', memberId);

  const { data, error } = await q.range(offset, offset + limit - 1);
  if (error) return fail(res, 500, 'Gagal membaca kehadiran: ' + error.message);

  return ok(res, {
    records: (data || []).map(r => ({
      id: r.id,
      member_id: r.member_id,
      member_name: r.member_name,
      prayer: r.prayer,
      date: r.date,
      timestamp: r.timestamp,
      face_dist: r.face_dist,
      geo_lat: r.geo_lat,
      geo_lng: r.geo_lng,
      geo_dist: r.geo_dist,
      scene_ref_sim: r.scene_ref_sim,
      scene_black_sim: r.scene_black_sim,
      scene_note: r.scene_note,
      server_ts: r.server_ts,
    })),
    count: (data || []).length,
    dateFrom,
    dateTo,
  });
}

async function attendanceCount(req, res) {
  let body = {};
  if (req.body) {
    try { body = JSON.parse(req.body); } catch (_) {}
  }
  const dateFrom = body.dateFrom || new Date().toISOString().slice(0, 7) + '-01';
  const dateTo   = body.dateTo   || new Date().toISOString().slice(0, 10);

  const { data, error } = await Svc.from('attendance')
    .select('date')
    .gte('date', dateFrom).lte('date', dateTo);
  if (error) return fail(res, 500, 'Gagal menghitung kehadiran: ' + error.message);

  // group by date
  const byDate = {};
  (data || []).forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + 1; });
  const counts = Object.entries(byDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return ok(res, { counts });
}

async function standings(req, res) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await Svc.from('attendance')
    .select('member_id, member_name')
    .gte('date', since);
  if (error) return fail(res, 500, 'Gagal membaca standings: ' + error.message);

  const byMember = {};
  (data || []).forEach(r => {
    const key = r.member_id || r.member_name;
    if (!byMember[key]) byMember[key] = { name: r.member_name, member_id: r.member_id, count: 0 };
    byMember[key].count++;
  });
  const standings = Object.values(byMember).sort((a, b) => b.count - a.count).slice(0, 20);
  return ok(res, { standings });
}

async function chart(req, res) {
  const days = 30;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data, error } = await Svc.from('attendance')
    .select('date')
    .gte('date', since);
  if (error) return fail(res, 500, 'Gagal membaca chart: ' + error.message);

  const byDate = {};
  (data || []).forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + 1; });

  // fill in missing days with 0
  const chart = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    chart.push({ date: d, count: byDate[d] || 0 });
  }
  return ok(res, { chart });
}

async function toggleMember(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { id } = body || {};
  if (!id) return fail(res, 400, 'ID anggota wajib diisi.');

  const { data, error } = await Svc.from('users').select('is_active').eq('id', id).single();
  if (error || !data) return fail(res, 404, 'Anggota tidak ditemukan.');

  const next = !data.is_active;
  const { error: upErr } = await Svc.from('users').update({ is_active: next }).eq('id', id);
  if (upErr) return fail(res, 500, 'Gagal mengubah status anggota: ' + upErr.message);

  return ok(res, { ok: true, id, is_active: next });
}

async function removeMember(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { id } = body || {};
  if (!id) return fail(res, 400, 'ID anggota wajib diisi.');

  const { data, error } = await Svc.from('users').select('photo_url, name').eq('id', id).single();
  if (error || !data) return fail(res, 404, 'Anggota tidak ditemukan.');

  // best-effort: remove photo from storage
  if (data.photo_url) {
    try {
      const p = data.photo_url.split('/').slice(-1)[0] || '';
      if (p) await Svc.storage.from('maqam-faces').remove([p]);
    } catch (_) { /* non-critical */ }
  }

  const { error: delErr } = await Svc.from('users').delete().eq('id', id);
  if (delErr) return fail(res, 500, 'Gagal menghapus anggota: ' + delErr.message);

  return ok(res, { ok: true, id, name: data.name });
}

async function saveAddress(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { address } = body || {};
  if (typeof address !== 'string' || address.trim().length < 2) return fail(res, 400, 'Alamat tidak valid.');

  const { error } = await Svc.from('settings').upsert({ key: 'admin_address', value: address.trim() });
  if (error) return fail(res, 500, 'Gagal menyimpan alamat: ' + error.message);

  return ok(res, { ok: true });
}

async function changePassword(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { oldPassword, newPassword } = body || {};
  if (!oldPassword || !newPassword) return fail(res, 400, 'Sandi lama dan baru wajib diisi.');
  if (newPassword.length < 4) return fail(res, 400, 'Sandi baru minimal 4 karakter.');

  const { data, error } = await Svc.from('admins').select('id, password_hash').eq('id', admin.admin.id).single();
  if (error || !data) return fail(res, 404, 'Admin tidak ditemukan.');

  const match = await bcrypt.compare(oldPassword, data.password_hash);
  if (!match) return fail(res, 401, 'Sandi lama salah.');

  const hash = await bcrypt.hash(newPassword, 12);
  const { error: upErr } = await Svc.from('admins').update({ password_hash: hash }).eq('id', admin.admin.id);
  if (upErr) return fail(res, 500, 'Gagal mengubah sandi: ' + upErr.message);

  return ok(res, { ok: true });
}

async function saveSetting(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { key, value } = body || {};
  if (!key || typeof value !== 'string') return fail(res, 400, 'Key dan value wajib diisi.');

  const { error } = await Svc.from('settings').upsert({ key, value });
  if (error) return fail(res, 500, 'Gagal menyimpan pengaturan: ' + error.message);

  return ok(res, { ok: true });
}

async function clearAttendance(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');

  const { error } = await Svc.from('attendance').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, 500, 'Gagal menghapus absensi: ' + error.message);

  return ok(res, { ok: true });
}

async function resetApp(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');

  // delete everything except admins table
  const tables = ['attendance', 'users', 'scene_refs', 'settings'];
  for (const t of tables) {
    await Svc.from(t).delete().neq(
      t === 'settings' ? 'key' : 'id',
      '00000000-0000-0000-0000-000000000000'
    );
  }
  return ok(res, { ok: true, message: 'Semua data direset. Silakan setup ulang.' });
}

async function saveScene(req, res, admin) {
  if (!admin.ok) return fail(res, 401, 'Admin belum login.');
  const body = await readBody(req);
  const { sceneRefThresh, sceneMargin } = body || {};

  if (sceneRefThresh != null) {
    const { error } = await Svc.from('settings').upsert({ key: 'scene_ref_thresh', value: String(sceneRefThresh) });
    if (error) return fail(res, 500, 'Gagal menyimpan ambang: ' + error.message);
  }
  if (sceneMargin != null) {
    const { error } = await Svc.from('settings').upsert({ key: 'scene_margin', value: String(sceneMargin) });
    if (error) return fail(res, 500, 'Gagal menyimpan margin: ' + error.message);
  }

  return ok(res, { ok: true });
}
