'use strict';
/* =====================================================================
   MAQAM v3 — GET /api/public/config
   Vercel Serverless Function (Node.js)

   Returns public-facing config: mosqueName, radius, setupDone,
   membersCount, todayCount, prayer suggestions, hijri date, etc.
   No admin auth required.
   ===================================================================== */

const { supabase } = require('../utils/supabaseClient');
const { ok, fail, handler } = require('../utils/api-helpers');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return fail(res, 405, 'Metode tidak diizinkan.');

  const sb = supabase();

  // ---- mosque settings ----
  const { data: settings, error: sErr } = await sb.from('settings').select('key, value');
  if (sErr) return fail(res, 500, 'Gagal membaca pengaturan: ' + sErr.message);

  const byKey = {};
  (settings || []).forEach(r => { byKey[r.key] = r.value; });

  const setupDone = byKey['setup_done'] === 'true';
  const mosqueName = byKey['mosque_name'] || 'MAQAM';
  const radius = parseInt(byKey['mosque_radius'], 10) || 120;

  // ---- counts ----
  let membersCount = 0, todayCount = 0;
  if (setupDone) {
    const { count: mCount } = await sb.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true);
    membersCount = mCount || 0;

    const today = new Date().toISOString().slice(0, 10);
    const { count: aCount } = await sb.from('attendance').select('id', { count: 'exact', head: true }).eq('date', today);
    todayCount = aCount || 0;
  }

  // ---- prayertimes (simple local approximation, can be replaced with API) ----
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const todayStr = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hijriStr = (() => {
    try { return new Intl.DateTimeFormat('id-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(now) + ' H'; }
    catch (e) { return ''; }
  })();

  return ok(res, {
    setupDone,
    mosqueName,
    radius,
    address: byKey['mosque_address'] || '',
    membersCount,
    todayCount,
    date: todayStr,
    hijri: hijriStr,
    suggestedPrayer: ['Subuh','Zuhur','Ashar','Maghrib','Isya'].find(p => {
      const t = ({ Subuh: 5, Zuhur: 12, Ashar: 15.5, Maghrib: 18, Isya: 19.5 })[p] || 0;
      return hour < t;
    }) || 'Subuh',
    lat: byKey['mosque_lat'] ? parseFloat(byKey['mosque_lat']) : null,
    lng: byKey['mosque_lng'] ? parseFloat(byKey['mosque_lng']) : null,
  });
});
