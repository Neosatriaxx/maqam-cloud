'use strict';
/* =====================================================================
   MAQAM v3 — api-helpers.js
   Shared plumbing for all Vercel serverless functions:
   response envelope, JSON body parsing, validation, geofence, settings.
   ===================================================================== */
const crypto = require('crypto');
const { supabase } = require('./supabaseClient');

const PRAYERS = ['Subuh', 'Zuhur', 'Ashar', 'Maghrib', 'Isya'];

/* ---------- response envelope ---------- */
function ok(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}
function fail(res, status, message, code) {
  ok(res, { error: message, code }, status);
}
/** wraps a handler so thrown errors become clean JSON responses */
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[maqam]', e);
      fail(res, status, e && e.status ? e.message : 'Kesalahan server.', e && e.code);
    }
  };
}

/* ---------- request body ---------- */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body terlalu besar'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Body JSON tidak valid'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ---------- validation ---------- */
function validDescriptor(x) {
  return Array.isArray(x) && x.length === 128 && x.every((v) => typeof v === 'number' && isFinite(v));
}
function validDataURL(s, maxLen = 800000) {
  return typeof s === 'string' && /^data:image\/(jpeg|png);base64,/.test(s) && s.length < maxLen;
}
function validName(n) { return typeof n === 'string' && n.trim().length >= 3 && n.trim().length <= 60; }

/* ---------- settings (cached in the warm lambda) ---------- */
let settingsCache = { at: 0, map: null };
async function getSettings(force = false) {
  if (!force && settingsCache.map && Date.now() - settingsCache.at < 30000) return settingsCache.map;
  const sb = supabase();
  const { data, error } = await sb.from('settings').select('key,value');
  if (error) throw Object.assign(new Error('Gagal membaca pengaturan: ' + error.message), { status: 500 });
  const map = {};
  for (const r of data || []) map[r.key] = r.value;
  settingsCache = { at: Date.now(), map };
  return map;
}
async function setSetting(key, value) {
  const sb = supabase();
  const { error } = await sb.from('settings').upsert({ key, value: String(value) });
  if (error) throw Object.assign(new Error('Gagal menyimpan pengaturan: ' + error.message), { status: 500 });
  settingsCache = { at: 0, map: null };
}
const isSetup = async () => (await getSettings()).setup_done === 'true';

/* ---------- geofence (server-side re-check, mirrors the old logic) ---------- */
function haversine(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function geoCheck(geo) {
  const S = await getSettings();
  if (S.setup_done !== 'true') throw Object.assign(new Error('Masjid belum disetup oleh takmir.'), { status: 503 });
  const lat = +(geo && geo.lat), lng = +(geo && geo.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw Object.assign(new Error('Data lokasi tidak valid.'), { status: 400 });
  const age = Date.now() - ((geo && geo.ts) || 0);
  if (age > 300000 || age < -300000)
    throw Object.assign(new Error('Data GPS tidak segar — ulangi dari dalam area masjid.'), { status: 400 });
  const c = { lat: +S.mosque_lat, lng: +S.mosque_lng }, radius = +S.mosque_radius;
  const d = haversine({ lat, lng }, c);
  const tol = Math.min(Math.max(+(geo.accuracy || 15), 10), 50);
  if (d > radius + tol)
    throw Object.assign(new Error('Akses ditolak — posisi di luar area masjid (' + Math.round(d) + ' m dari pusat).'), { status: 403, code: 'GEO' });
  return { dist: d, lat, lng };
}

/* ---------- misc ---------- */
const dayKey = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 64).toString('hex');

/* ---------- admin token (stateless HMAC — lambdas share no memory) ---------- */
/**
 * Token format: "<email>.<timestamp>.<hmac-hex>"
 * HMAC secret = admin's UUID from the admins table.
 * This allows stateless verification without shared secrets.
 */
async function verifyAdminToken(token) {
  if (!token) return { ok: false };
  const parts = token.split('.');
  if (parts.length < 3) return { ok: false };

  const email = parts[0];
  const payload = parts.slice(0, 2).join('.');   // "<email>.<timestamp>"
  const sig = parts[2];

  // look up the admin
  const sb = supabase();
  const { data, error } = await sb
    .from('admins')
    .select('id, email, role')
    .eq('email', email)
    .eq('is_active', true)
    .single();
  if (error || !data) return { ok: false };

  // recompute HMAC and compare
  const expect = crypto.createHmac('sha256', data.id.toString()).update(payload).digest('hex');
  if (sig.length !== expect.length) return { ok: false };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { ok: false };

  // check expiry (12 hours)
  const ts = Number(parts[1]);
  if (!isFinite(ts) || Date.now() - ts > 12 * 3600e3) return { ok: false, reason: 'Token kedaluwarsa' };

  return { ok: true, admin: data };
}

/** Middleware for serverless functions — throws if no valid admin token */
async function requireAdmin(req) {
  const h = (req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  const admin = await verifyAdminToken(t);
  if (!admin.ok) throw Object.assign(new Error('Sesi takmir tidak valid — masuk ulang.'), { status: 401, code: 'AUTH' });
  return admin;
}

/* legacy helpers (kept for compatibility, not used by new code) */
function adminSecret(S) { return (S && S.pass_hash) || 'maqam-dev-secret'; }
function issueToken(S) {
  const payload = 'takmir.' + Date.now();
  const sig = crypto.createHmac('sha256', adminSecret(S)).update(payload).digest('hex');
  return payload + '.' + sig;
}
function tokenOK(token, S) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx), sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', adminSecret(S)).update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const ts = Number(payload.split('.')[1]);
  return isFinite(ts) && Date.now() - ts < 12 * 3600e3;
}

module.exports = {
  PRAYERS, ok, fail, handler, readBody,
  validDescriptor, validDataURL, validName,
  getSettings, setSetting, isSetup, geoCheck, haversine,
  dayKey, hashPass, issueToken, tokenOK, requireAdmin, verifyAdminToken,
};
