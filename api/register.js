'use strict';
/* =====================================================================
   MAQAM v3 — POST /api/register
   Vercel Serverless Function (Node.js)

   Body : { name, samples: [{ descriptor: number[], thumb: dataUri }], geo: { lat, lng, accuracy, ts } }
   Does :
     1. validate body + admin session + geofence (must register from inside the mosque)
     2. run face-api detection on each submitted base64 thumb via faceAiLoader
        (server-side truth — the client descriptor is ignored)
     3. for each sample that yields a descriptor, check anti-duplicate:
        euclidean distance to all existing user descriptors must be > 0.47
     4. average the surviving descriptors into one 128-d vector
     5. upload the first sharp sample's photo to Supabase Storage bucket `maqam-faces`
     6. INSERT { name, photo_url, descriptors, is_active } into the `users` table
     7. return { id, name, photo } on success
   ===================================================================== */

const crypto = require('crypto');
const crypto = require('crypto');
const crypto = require('crypto');
const { handler, readBody, fail } = require('../utils/api-helpers');
const { faceDescriptorFromDataUrl, detectOnlyFromDataUrl } = require('../utils/faceAiLoader');
const { supabase } = require('../utils/supabaseClient');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Metode tidak diizinkan.');

  let body;
  try { body = JSON.parse(req.body); } catch (e) { return fail(res, 400, 'Bad request — body harus JSON'); }

  const { name, samples = [], geo } = body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2)
    return fail(res, 400, 'Nama wajib diisi, minimal 2 huruf.');
  if (!Array.isArray(samples) || samples.length < 1)
    return fail(res, 400, 'Minimal 1 sampel wajah harus dikirim.');

  const sb = supabase();

  // admin auth
  const S = await sb.from('settings').select('value').eq('key', 'admin_password_hash').single();
  const adminFromReq = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenOK(adminFromReq, { pass_hash: S.value })) return fail(res, 401, 'Login admin diperlukan.');

  // geofence
  if (geo) {
    try {
      await geoCheck(geo);
    } catch (e) {
      if (e.code === 'GEO' || e.status === 403 || e.status === 451)
        return fail(res, 451, 'Registrasi hanya bisa dilakukan dari dalam area masjid', { code: 'GEO' });
    }
  }

  const nameTrim = name.trim().replace(/\s+/g, ' ');

  // decode thumbs server-side
  const decoded = [];
  for (const s of samples) {
    try {
      const det = await detectOnlyFromDataUrl(s.thumb);
      if (det) decoded.push({ thumb: s.thumb, box: det.box, score: det.score });
    } catch (e) { continue; }
  }
  if (decoded.length < 1) return fail(res, 400, 'Wajah tidak terbaca dari sampel yang dikirim.');

  // re-derive descriptors
  const candidates = [];
  for (const d of decoded) {
    try {
      const full = await faceDescriptorFromDataUrl(d.thumb);
      if (full && full.descriptor && full.descriptor.length === 128)
        candidates.push({ arr: Float32Array.from(full.descriptor), score: full.score || d.score });
    } catch (e) { continue; }
  }
  if (candidates.length < 1) return fail(res, 400, 'Gagal membaca deskriptor wajah dari sampel.');

  // sharpness
  const valid = candidates.filter(c => c.score >= 0.4);
  if (valid.length < 1) return fail(res, 400, 'Wajah tidak cukup jelas — coba lagi dengan pencahayaan lebih baik.');

  // anti-duplicate
  const { data: rows } = await sb.from('users').select('id, descriptors').eq('is_active', true);
  const existing = (rows || []).filter(r => r.descriptors && Array.isArray(r.descriptors) && r.descriptors.length === 128);
  const DUP_THRESH = 0.47;
  const nonDup = [];
  for (const v of valid) {
    let dup = false;
    for (const u of existing) {
      if (euclidean(v.arr, u.descriptors) < DUP_THRESH) { dup = true; break; }
    }
    if (!dup) nonDup.push(v);
  }
  if (nonDup.length < 1) return fail(res, 409, 'Wajah ini sudah terdaftar — coba wajah lain.', { code: 'DUPFACE' });

  // average
  const finalDesc = nonDup.length === 1
    ? Array.from(nonDup[0].arr)
    : Array.from({ length: 128 }, (_, i) => nonDup.reduce((s, v) => s + v.arr[i], 0) / nonDup.length);

  // upload photo
  const bucket = 'maqam-faces';
  const uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const safeName = nameTrim.replace(/\s+/g, '_').toLowerCase();
  const pathName = `users/${safeName}_${uid}.jpg`;
  const buf = Buffer.from(nonDup[0].thumb.split(',')[1], 'base64');
  const { data: up, error: upErr } = await sb.storage.from(bucket).upload(pathName, buf, {
    cacheControl: '3600', upsert: false, contentType: 'image/jpeg',
  });
  if (upErr || !up) return fail(res, 500, 'Gagal menyimpan foto ke penyimpanan.');
  const { data: pub } = sb.storage.from(bucket).getPublicUrl(pathName);
  const photoUrl = (pub && pub.publicUrl) ? pub.publicUrl : '';

  // insert user
  const { data: ins, error: insErr } = await sb.from('users').insert({
    name: nameTrim,
    photo_url: photoUrl,
    descriptors: finalDesc,
    is_active: true,
    created_at: new Date().toISOString(),
  }).select('id, name, photo_url, descriptors');
  if (insErr || !ins || !ins.length) {
    try { await sb.storage.from(bucket).remove([pathName]); } catch (_) {}
    return fail(res, 500, 'Gagal menyimpan data anggota ke database.');
  }

  res.statusCode = 201;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    id: ins[0].id,
    name: ins[0].name,
    photo: photoUrl,
    descriptors: ins[0].descriptors ? Array.from(ins[0].descriptors).slice(0, 128) : null,
  }));
});

function euclidean(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function tokenOK(token, S) {
  if (!token || !S || !S.value) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', S.value || '').update(payload).digest('hex');
  if (sig.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}
