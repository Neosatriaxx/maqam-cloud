'use strict';
/* =====================================================================
   MAQAM v3 — admin client (admin.html)
   Light: login, member list, member photos, attendance table, CSV export,
   scene ref management, settings. No client-side AI.
   Uses the real element IDs from admin.html.
   ===================================================================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTs = ts => ts ? new Date(ts).toLocaleString('id-ID', {hour:'2-digit',minute:'2-digit',day:'numeric',month:'short',year:'numeric',hour12:false}) : '—';
const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('id-ID', {weekday:'long',day:'numeric',month:'long',year:'numeric'}) : '—';

/* ---------- API ---------- */
function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = opts.headers || {};
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; }
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    fetch(path, { method: opts.method || 'GET', headers, body }).then(res => res.json().then(d => {
      if (!res.ok) { const err = new Error((d && d.error) || ('HTTP ' + res.status)); err.code = d?.code; err.status = res.status; err.data = d; reject(err); }
      else resolve(d);
    })).catch(rej => reject(new Error('Jaringan: ' + rej.message)));
  });
}
function adminApi(path, opts = {}) {
  const token = localStorage.loggedIn;
  const headers = opts.headers || {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
  return fetch(path, { method: opts.method || 'GET', headers, body }).then(res => res.json().then(d => {
    if (!res.ok) { const err = new Error((d && d.error) || ('HTTP ' + res.status)); err.code = d?.code; err.status = res.status; err.data = d; reject(err); }
    else resolve(d);
  })).catch(rej => reject(new Error('Jaringan: ' + rej.message)));
}

/* ---------- login ---------- */
let LOGGED_IN = false;
const loginCard = $('#login-card'), panel = $('#panel');
function showLogin() { loginCard.hidden = false; panel.hidden = true; LOGGED_IN = false; }
function showPanel() { loginCard.hidden = true; panel.hidden = false; LOGGED_IN = true; }

$('#adl-btn').addEventListener('click', async () => {
  const pass = $('#adl-pass').value;
  if (!pass) { $('#adl-err').textContent = 'Masukkan kata sandi'; return; }
  $('#adl-err').textContent = '';
  $('#adl-btn').disabled = true;
  try {
    const d = await api('/api/admin/login', { method: 'POST', body: { password: pass } });
    localStorage.loggedIn = d.token;
    LOGGED_IN = true;
    showPanel();
    await loadAll();
    toast('Selamat datang, takmir', 'ok');
  } catch (err) {
    $('#adl-btn').disabled = false;
    $('#adl-err').textContent = err.data && err.data.error || 'Kata sandi salah';
  }
});

$('#adm-logout').addEventListener('click', async () => {
  localStorage.removeItem('loggedIn');
  LOGGED_IN = false;
  showLogin();
  toast('Keluar dari panel', 'info');
});

/* ---------- tabs ---------- */
$$('.tab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    const tab = t.dataset.tab;
    $$('#tab-members, #tab-att, #tab-scene, #tab-set').forEach(el => el.hidden = (el.id !== 'tab-' + tab));
  });
});

/* ---------- members ---------- */
let MEMBERS = [];
async function loadMembers() {
  try {
    const d = await adminApi('/api/admin/members');
    MEMBERS = d.members || [];
    renderMembers();
  } catch (err) { toast('Gagal memuat jamaah: ' + err.message, 'err'); }
}
function renderMembers(filter) {
  const q = (filter || '').toLowerCase();
  const list = q ? MEMBERS.filter(m => m.name.toLowerCase().includes(q)) : MEMBERS;
  $('#m-cnt').textContent = list.length + ' jamaah';
  $('#m-grid').innerHTML = list.map(m => `
    <div class="m-card">
      <div class="m-av" style="background:${m.photo ? 'transparent' : 'var(--panel)'}">
        ${m.photo ? `<img src="${esc(m.photo)}" alt="" onerror="this.parentElement.innerHTML='<b>?</b>'">` : '<b>?</b>'}
      </div>
      <div class="m-nm">${esc(m.name)}</div>
      <div class="m-act">${m.is_active ? '<i class="ic"><use href="#i-check"/></i> Aktif' : '<i class="ic"><use href="#i-alert"/></i> Nonaktif'}</div>
      <div class="m-act"><button class="btn btn-line btn-sm" data-act="toggle" data-id="${m.id}">${m.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button></div>
    </div>
  `).join('');
  $('#m-grid').querySelectorAll('[data-act="toggle"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        await adminApi('/api/admin/toggle-member', { method: 'POST', body: { id } });
        const m = MEMBERS.find(x => x.id === id);
        if (m) m.is_active = !m.is_active;
        renderMembers($('#m-q').value);
        toast('Status jamaah diperbarui', 'ok');
      } catch (err) { toast(err.message || 'Gagal mengubah status', 'err'); }
    });
  });
}
$('#m-q').addEventListener('input', () => renderMembers($('#m-q').value));

/* ---------- attendance ---------- */
let ATT = [];
async function loadAttendance() {
  const day = $('#a-day').value;
  const prayer = $('#a-prayer').value;
  const q = $('#a-q').value;
  try {
    const d = await adminApi('/api/admin/attendance', {
      method: 'POST',
      body: {
        dateFrom: day ? day + '-01' : new Date().toISOString().slice(0, 7) + '-01',
        dateTo: day || new Date().toISOString().slice(0, 10),
        prayer: prayer || undefined,
        limit: 200,
      },
    });
    ATT = d.records || [];
    renderAttendance(q);
  } catch (err) { toast('Gagal memuat absensi: ' + err.message, 'err'); }
}
function renderAttendance(filter) {
  const q = (filter || '').toLowerCase();
  const list = q ? ATT.filter(r => r.member_name.toLowerCase().includes(q)) : ATT;
  $('#a-cnt').textContent = list.length + ' catatan';
  if (list.length === 0) {
    $('#a-rows').innerHTML = '';
    $('#a-empty').hidden = false;
    $('#a-stats').innerHTML = '';
    return;
  }
  $('#a-empty').hidden = true;
  $('#a-stats').innerHTML = `
    <div class="stat"><b>${list.length}</b> catatan</div>
    <div class="stat"><b>${new Set(list.map(r => r.member_name)).size}</b> jamaah</div>
    <div class="stat"><b>${list.filter(r => r.scene_ref_sim != null).length}</b> dengan verifikasi tempat</div>
  `;
  $('#a-rows').innerHTML = list.map(r => `
    <tr>
      <td>${fmtTs(r.timestamp)}</td>
      <td>${esc(r.member_name)}</td>
      <td>${r.prayer}</td>
      <td>${r.scene_ref_sim != null ? Math.round((r.scene_ref_sim || 0) * 100) + '%' : '—'}</td>
      <td>${r.geo_dist != null ? Math.round(r.geo_dist) + ' m' : '—'}</td>
      <td><button class="btn btn-line btn-sm" data-act="del" data-id="${r.id}"><svg class="ic"><use href="#i-trash"/></svg></button></td>
    </tr>
  `).join('');
  $('#a-rows').querySelectorAll('[data-act="del"]').forEach(btn => {
    // delete attendance record — optional dangerous feature; guarded
    btn.addEventListener('click', () => {
      if (!confirm('Hapus catatan absensi ini?')) return;
      toast('Fitur hapus absensi belum aktif di backend', 'warn');
    });
  });
}
$('#a-day').addEventListener('change', loadAttendance);
$('#a-prayer').addEventListener('change', loadAttendance);
$('#a-q').addEventListener('input', () => renderAttendance($('#a-q').value));
$('#a-export').addEventListener('click', exportCsv);

async function exportCsv() {
  toast('Mengekspor CSV…', 'info');
  try {
    const d = await adminApi('/api/admin/attendance', {
      method: 'POST',
      body: {
        dateFrom: $('#a-day').value ? $('#a-day').value + '-01' : new Date().toISOString().slice(0, 7) + '-01',
        dateTo: $('#a-day').value || new Date().toISOString().slice(0, 10),
        limit: 5000,
      },
    });
    const rows = d.records || [];
    if (rows.length === 0) { toast('Tidak ada data untuk di-ekspor', 'warn'); return; }
    let csv = 'Waktu,Nama,Sholat,Tempat,Kedekatan,Jarak\n';
    csv += rows.map(r =>
      `${fmtTs(r.timestamp)},"${esc(r.member_name)}",${r.prayer},${(r.scene_ref_sim != null ? Math.round((r.scene_ref_sim || 0) * 100) + '%' : '—')},"${r.geo_dist != null ? Math.round(r.geo_dist) + ' m' : '—'}"`
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maqam_absensi_${(new Date()).toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV berhasil diunduh', 'ok');
  } catch (err) { toast('Gagal mengekspor: ' + err.message, 'err'); }
}

/* ---------- chart (simple text-based stats, no canvas dependency) ---------- */
async function loadChart() {
  try {
    const d = await adminApi('/api/admin/attendance/count', {
      method: 'POST',
      body: {
        dateFrom: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        dateTo: new Date().toISOString().slice(0, 10),
        days: 30,
      },
    });
    const counts = d.counts || [];
    if (counts.length === 0) { $('#a-stats').innerHTML = '<div class="stat">Belum ada data 30 hari terakhir</div>'; return; }
    const max = Math.max(...counts.map(c => c.count));
    $('#a-stats').innerHTML = `
      <div class="stat"><b>${counts.reduce((a,c)=>a+c.count,0)}</b> total 30 hari</div>
      <div class="stat"><b>${Math.round(counts.reduce((a,c)=>a+c.count,0)/counts.length)}</b> rata-rata/hari</div>
      <div class="stat"><b>${max}</b> tertinggi (hari: ${counts.find(c=>c.count===max)?.date || '—'})</div>
    `;
  } catch (err) { toast('Gagal memuat statistik: ' + err.message, 'err'); }
}

/* ---------- scene references ---------- */
$('#sr-upl').addEventListener('click', () => $('#sr-file').click());
$('#sb-upl').addEventListener('click', () => $('#sb-file').click());
$('#sr-file').addEventListener('change', () => handleSceneUpload('sr'));
$('#sb-file').addEventListener('change', () => handleSceneUpload('sb'));
$('#sr-clear').addEventListener('click', () => clearSceneRefs('sr'));
$('#sb-clear').addEventListener('click', () => clearSceneRefs('sb'));

async function handleSceneUpload(tab) {
  const fileInput = tab === 'sr' ? $('#sr-file') : $('#sb-file');
  const files = fileInput.files;
  if (!files.length) return;
  const isBlack = tab === 'sb';
  const gridId = isBlack ? 'sb-grid' : 'sr-grid';
  const cntId = isBlack ? 'sb-cnt' : 'sr-cnt';
  const grid = $(`#${gridId}`);
  grid.innerHTML = '';
  for (const f of files) {
    const url = URL.createObjectURL(f);
    grid.innerHTML += `<div class="ref-card"><img src="${url}" alt=""><button class="btn btn-line btn-xs" data-url="${url.replace(/"/g, '&quot;')}"><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
  }
  $(`#${cntId}`).textContent = files.length + ' foto';
  // revoke old object URLs after a bit
  setTimeout(() => grid.querySelectorAll('img').forEach(im => { if (im.src.startsWith('blob:')) URL.revokeObjectURL(im.src); }), 60000);
}

async function clearSceneRefs(tab) {
  const gridId = tab === 'sr' ? 'sr-grid' : 'sb-grid';
  const cntId = tab === 'sr' ? 'sr-cnt' : 'sb-cnt';
  $(`#${gridId}`).innerHTML = '';
  $(`#${cntId}`).textContent = '0 foto';
}

$('#tst-start').addEventListener('click', startTestCam);
async function startTestCam() {
  const camDiv = $('#tst-cam');
  camDiv.hidden = false;
  $('#tst-cv').getContext('2d').fillRect(0, 0, 300, 200);
  $('#tst-ref').textContent = 'Mirip mushola: —';
  $('#tst-blk').textContent = 'Mirip non-mushola: —';
  $('#tst-verdict').textContent = 'Menunggu kamera…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } }, audio: false });
    const video = document.createElement('video');
    video.srcObject = stream; video.playsInline = true; video.muted = true;
    video.play();
    camDiv._stream = stream; camDiv._video = video;
    function tick() {
      if (!camDiv._video || camDiv._video.readyState < 2) { requestAnimationFrame(tick); return; }
      const cv = $('#tst-cv');
      cv.getContext('2d').drawImage(camDiv._video, 0, 0, 300, 200);
      // send snapshot to /api/scene-recognize every ~1.5s
      if (!camDiv._lastSnap || Date.now() - camDiv._lastSnap > 1500) {
        const img = cv.toDataURL('image/jpeg', 0.6);
        camDiv._lastSnap = Date.now();
        api('/api/scene-recognize', { method: 'POST', body: { image: img } }).then(d => {
          $('#tst-ref').textContent = `Mirip mushola: ${Math.round((d.refSim || 0) * 100)}%`;
          $('#tst-blk').textContent = `Mirip non-mushola: ${Math.round((d.blackSim || 0) * 100)}%`;
          $('#tst-verdict').textContent = d.pass ? '✓ Lolos' : '✗ Tidak lolos';
        }).catch(() => {});
      }
      requestAnimationFrame(tick);
    }
    tick();
  } catch (err) {
    camDiv.hidden = true;
    toast('Kamera tidak tersedia untuk uji', 'err');
  }
}

/* ---------- settings ---------- */
let SETTINGS = {};
async function loadSettings() {
  try {
    const d = await api('/api/public/config');
    SETTINGS = d;
    $('#s-name').value = d.mosqueName || '';
    $('#s-lat').value = d.lat != null ? d.lat : '';
    $('#s-lng').value = d.lng != null ? d.lng : '';
    $('#s-rad').value = d.radius || 120;
    $('#s-rad-v').textContent = (d.radius || 120) + ' m';
    $('#adm-mosque').textContent = d.mosqueName || 'Masjid';
  } catch (err) { toast('Gagal memuat pengaturan: ' + err.message, 'err'); }
}
$('#s-rad').addEventListener('input', () => { $('#s-rad-v').textContent = $('#s-rad').value + ' m'; });
$('#s-gps').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('GPS tidak tersedia', 'err'); return; }
  $('#s-gps').disabled = true;
  navigator.geolocation.getCurrentPosition(p => {
    $('#s-gps').disabled = false;
    $('#s-lat').value = p.coords.latitude;
    $('#s-lng').value = p.coords.longitude;
    toast('Koordinat GPS diambil', 'ok');
  }, () => {
    $('#s-gps').disabled = false;
    toast('Gagal mengambil GPS', 'err');
  }, { enableHighAccuracy: true, timeout: 15000 });
});
$('#s-save-name').addEventListener('click', () => saveSetting('mosque_name', $('#s-name').value.trim()));
$('#s-save-geo').addEventListener('click', async () => {
  const lat = parseFloat($('#s-lat').value), lng = parseFloat($('#s-lng').value), rad = parseInt($('#s-rad').value);
  if (!isFinite(lat) || !isFinite(lng)) { toast('Latitude dan longitude wajib diisi', 'err'); return; }
  if (!rad || rad < 30) { toast('Radius wajib diisi (minimal 30 m)', 'err'); return; }
  try {
    await saveSetting('mosque_lat', lat.toString());
    await saveSetting('mosque_lng', lng.toString());
    await saveSetting('mosque_radius', rad.toString());
    toast('Area geofence disimpan', 'ok');
    loadSettings();
  } catch (err) { toast(err.message || 'Gagal menyimpan area', 'err'); }
});
$('#s-save-pass').addEventListener('click', async () => {
  const oldPass = $('#s-p0').value, newPass = $('#s-p1').value;
  if (!oldPass || !newPass) { toast('Sandi lama dan baru wajib diisi', 'err'); return; }
  if (newPass.length < 4) { toast('Sandi baru minimal 4 karakter', 'err'); return; }
  try {
    await adminApi('/api/admin/change-password', { method: 'POST', body: { oldPassword: oldPass, newPassword: newPass } });
    toast('Kata sandi diubah', 'ok');
    $('#s-p0').value = ''; $('#s-p1').value = '';
  } catch (err) {
    toast(err.data && err.data.error || 'Gagal mengubah kata sandi — mungkin sandi lama salah', 'err');
  }
});

async function saveSetting(key, value) {
  if (!value && value !== 0) return;
  try {
    await adminApi('/api/admin/save-setting', { method: 'POST', body: { key, value: String(value) } });
    toast(`Pengaturan ${key} disimpan`, 'ok');
    loadSettings();
  } catch (err) { throw err; }
}

/* ---------- dangerous zone ---------- */
$('#d-clear-att').addEventListener('click', () => {
  if (!confirm('Hapus SEMUA catatan absensi? Tindakan ini tidak bisa dibatalkan.')) return;
  adminApi('/api/admin/clear-attendance', { method: 'POST' }).then(() => {
    toast('Semua catatan absensi dihapus', 'ok');
    loadAttendance();
  }).catch(err => toast('Gagal menghapus: ' + err.message, 'err'));
});
$('#d-reset').addEventListener('click', () => {
  if (!confirm('Reset aplikasi total: hapus semua jamaah, absensi, foto, dan pengaturan. Masjid harus disetup lagi dari nol. Lanjutkan?')) return;
  adminApi('/api/admin/reset', { method: 'POST' }).then(() => {
    toast('Aplikasi berhasil direset. Silakan setup ulang dari /admin.html.', 'ok');
    localStorage.removeItem('loggedIn');
    showLogin();
  }).catch(err => toast('Gagal mereset: ' + err.message, 'err'));
});

/* ---------- scene calibration save ---------- */
$('#s-save-scene').addEventListener('click', async () => {
  const thresh = parseInt($('#s-thr').value) / 100;
  const margin = parseInt($('#s-mar').value) / 100;
  try {
    await adminApi('/api/admin/save-scene', { method: 'POST', body: { sceneRefThresh: thresh, sceneMargin: margin } });
    toast(`Kalibrasi disimpan: ambang ${Math.round(thresh*100)}%, margin ${Math.round(margin*100)}%`, 'ok');
  } catch (err) { toast('Gagal menyimpan kalibrasi: ' + err.message, 'err'); }
});

/* ---------- toast ---------- */
function toast(msg, type = 'info') {
  const box = $('#toasts'), t = document.createElement('div');
  t.className = 'toast t-' + type;
  t.innerHTML = `<svg class="ic"><use href="#i-${type === 'ok' ? 'check' : type === 'err' ? 'alert' : type === 'warn' ? 'alert' : 'info'}"/></svg><span>${esc(msg)}</span>`;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { t.classList.add('bye'); setTimeout(() => t.remove(), 300); }, type === 'err' ? 5000 : 3000);
}

/* ---------- init ---------- */
(async function init() {
  if (localStorage.loggedIn) {
    LOGGED_IN = true;
    showPanel();
    await loadAll();
  } else {
    showLogin();
  }
})();
async function loadAll() {
  await loadSettings();
  await loadMembers();
  await loadAttendance();
  await loadChart();
}
