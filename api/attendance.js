'use strict';
/* =====================================================================
   MAQAM v3 — POST /api/attendance
   Vercel Serverless Function (Node.js)

   Body : { member: { id, name, dist? }, prayer, scene?: {...}, sceneImg?: dataUrl, geo }
   Does : 1. geofence re-check
          2. dedup: same user + same prayer + same day MUST NOT be recorded twice
          3. store attendance + optional scene summary + optional scene snapshot in Supabase
          4. return { ok, id } or { duplicate, existing }
   ===================================================================== */

const { supabase } = require('../utils/supabaseClient');
const { ok, fail, handler, readBody, geoCheck } = require('../utils/api-helpers');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Metode tidak diizinkan.');

  const body = await readBody(req);
  const { member, prayer, scene, sceneImg, geo } = body || {};

  if (!member || !member.id || !prayer) return fail(res, 400, 'Data kehadiran tidak lengkap.');
  if (!['Subuh','Zuhur','Ashar','Maghrib','Isya'].includes(prayer)) return fail(res, 400, 'Sholat tidak dikenal.');

  let g;
  try {
    g = await geoCheck(geo);
  } catch (e) {
    return fail(res, e.status || 403, e.message || 'Akses ditolak — posisi di luar area masjid.', e.code);
  }

  const sb = supabase();
  const today = new Date().toISOString().slice(0, 10);

  // ---- dedup: one attendance per user per prayer per day ----
  const { data: existing, error: qErr } = await sb
    .from('attendance')
    .select('id')
    .eq('member_id', member.id)
    .eq('prayer', prayer)
    .eq('date', today)
    .single();

  if (qErr && qErr.code !== 'PGRES_TOO_MANY_ROWS' && qErr.code !== 'PGRES_NO_ROWS') {
    // single() returns an error when no rows found — that's fine
    if (qErr.code !== 'PGRES_NO_ROWS') return fail(res, 500, 'Gagal memeriksa kehadiran sebelumnya: ' + qErr.message);
  }

  if (existing) {
    return ok(res, {
      duplicate: true,
      existing: { id: existing.id, prayer, date: today, member: { id: member.id, name: member.name } },
    });
  }

  // ---- insert ----
  const payload = {
    member_id: member.id,
    member_name: member.name,
    prayer,
    date: today,
    timestamp: new Date().toISOString(),
    face_dist: member.dist != null ? member.dist : null,
    geo_lat: g.lat,
    geo_lng: g.lng,
    geo_dist: g.dist,
    scene_ref_sim: scene && scene.refSim != null ? scene.refSim : null,
    scene_black_sim: scene && scene.blackSim != null ? scene.blackSim : null,
    scene_note: scene && scene.labels ? scene.labels.map(l => `${l.id}:${l.p}`).join(';') : null,
    server_ts: Date.now(),
  };

  const { data: ins, error: iErr } = await sb.from('attendance').insert(payload).select('id');
  if (iErr || !ins) return fail(res, 500, 'Gagal menyimpan kehadiran: ' + (iErr && iErr.message));

  // optional: store scene snapshot in Supabase Storage and update record
  if (sceneImg && sceneImg.startsWith('data:')) {
    try {
      const buf = Buffer.from(sceneImg.split(',')[1], 'base64');
      if (buf.length > 5000) {
        const { data: up } = await sb.storage.from('maqam-scenes').upload(
          `attendance/${ins[0].id}_${Date.now()}.jpg`, buf, { contentType: 'image/jpeg' }
        );
        if (up) {
          const { data: pub } = sb.storage.from('maqam-scenes').getPublicUrl(up.path);
          const sceneImgUrl = (pub && pub.publicUrl) ? pub.publicUrl : '';
          if (sceneImgUrl) {
            await sb.from('attendance').update({ scene_img_url: sceneImgUrl }).eq('id', ins[0].id);
          }
        }
      }
    } catch (_) { /* non-critical */ }
  }

  return ok(res, { ok: true, id: ins[0].id, prayer, date: today });
});
