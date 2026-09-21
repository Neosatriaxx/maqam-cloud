'use strict';
/* =====================================================================
   MAQAM v3 — POST /api/face-recognize
   Vercel Serverless Function (Node.js)

   Body : { image: dataUrl, geo: { lat, lng, accuracy, ts } }
   Does : 1. server-side geofence re-check
          2. face detection + 128-d descriptor via @vladmandic/face-api
          3. fetches every user's descriptors from Supabase
          4. euclidean distance match -> { matched, member, dist }
   ===================================================================== */
const { supabase } = require('../utils/supabaseClient');
const { ok, fail, handler, readBody, validDataURL, geoCheck } = require('../utils/api-helpers');
const { faceDescriptorFromDataUrl, euclid } = require('../utils/faceAiLoader');

const THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.5);

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Metode tidak diizinkan.');

  const body = await readBody(req);
  if (!validDataURL(body.image)) return fail(res, 400, 'Foto wajah tidak valid.');
  const geo = await geoCheck(body.geo);

  // 1. generate descriptor server-side
  const det = await faceDescriptorFromDataUrl(body.image);
  if (!det) return ok(res, { matched: false, reason: 'noface', message: 'Wajah tidak terdeteksi — hadapkan wajah ke kamera.' });
  if (det.score < 0.45) return ok(res, { matched: false, reason: 'lowconf', message: 'Wajah kurang jelas — hadap kamera & pastikan pencahayaan cukup.' });

  // 2. load all descriptors from Supabase
  const sb = supabase();
  const { data, error } = await sb.from('users').select('id,name,descriptors');
  if (error) return fail(res, 500, 'Gagal membaca data jamaah: ' + error.message);

  // 3. best euclidean match across every stored sample of every user
  // Support both formats: flat 128-array (single avg) or array of 128-arrays (multiple samples)
  let best = null;
  for (const u of data || []) {
    const descs = Array.isArray(u.descriptors) ? u.descriptors : [];
    if (descs.length === 128 && typeof descs[0] === 'number') {
      // Single averaged descriptor (flat array)
      const dist = euclid(det.descriptor, descs);
      if (!best || dist < best.dist) best = { dist, id: u.id, name: u.name };
    } else {
      // Array of descriptors
      for (const d of descs) {
        if (!Array.isArray(d) || d.length !== 128) continue;
        const dist = euclid(det.descriptor, d);
        if (!best || dist < best.dist) best = { dist, id: u.id, name: u.name };
      }
    }
  }

  if (best && best.dist <= THRESHOLD) {
    return ok(res, {
      matched: true,
      dist: +best.dist.toFixed(3),
      simPct: Math.round((1 - best.dist) * 100),
      member: { id: best.id, name: best.name },
      geo: { lat: geo.lat, lng: geo.lng, dist: Math.round(geo.dist) },
    });
  }
  return ok(res, { matched: false, reason: 'unknown', message: 'Wajah belum terdaftar di masjid ini.' });
});
