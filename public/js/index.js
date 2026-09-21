'use strict';
/* =====================================================================
   MAQAM v3 — client (index.html)
   Lightweight: camera, geolocation, UI only. All AI runs on the backend.
   UI states, colors, animations, labels — unchanged from v2.
   ===================================================================== */

/* ---------- shortcuts ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ic  = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayKey = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
const fmtTime = ts => new Date(ts).toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'});
const greet = () => {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 4.5) return 'Selamat malam'; if (h < 6) return 'Selamat subuh';
  if (h < 11) return 'Selamat pagi'; if (h < 15) return 'Selamat siang';
  if (h < 18.5) return 'Selamat sore'; return 'Selamat malam';
};
const hijri = () => {
  try { return new Intl.DateTimeFormat('id-u-ca-islamic-umalqura', {day:'numeric',month:'long',year:'numeric'}).format(new Date()) + ' H'; }
  catch (e) { return ''; }
};
function distM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const h = Math.sin(dLa/2)**2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lng)) * Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- toast & modal ---------- */
function toast(msg, type = 'info') {
  const box = $('#toasts'), t = document.createElement('div');
  t.className = 'toast t-' + type;
  t.innerHTML = ic(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info') + `<span>${esc(msg)}</span>`;
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('bye'); setTimeout(() => t.remove(), 320); }, type === 'err' ? 5200 : 3400);
}
function openModal(o) {
  const root = $('#modal-root');
  const ov = document.createElement('div'); ov.className = 'modal-ov';
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<h3 class="modal-title">${o.title}</h3><div class="modal-body"></div><div class="modal-actions"></div>`;
  const body = m.querySelector('.modal-body');
  if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
  const close = () => { ov.classList.add('out'); setTimeout(() => ov.remove(), 170); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const actions = (o.actions && o.actions.length) ? o.actions : [{ label: 'Tutup', cls: 'btn-line' }];
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || 'btn-line');
    b.innerHTML = (a.icon ? ic(a.icon) : '') + a.label;
    b.type = 'button';
    b.onclick = () => { a.onClick ? a.onClick(close) : close(); };
    m.querySelector('.modal-actions').appendChild(b);
  });
  ov.appendChild(m);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  root.appendChild(ov);
  const inp = m.querySelector('input'); if (inp) setTimeout(() => inp.focus(), 60);
}
function fieldErr(id, msg) {
  const el = $('#' + id);
  if (!el) return;
  el.style.borderColor = 'var(--danger)';
  el.focus();
  toast(msg, 'err');
  setTimeout(() => { el.style.borderColor = ''; }, 2500);
}

/* ---------- state ---------- */
const state = {
  cfg: null, view: null, pendingView: null,
  lastGeo: null, geoAcc: null, geoDenied: false, geoWatch: false,
  prayer: null,
};
const PRAYERS = [['Subuh', 'الفجر'], ['Zuhur', 'الظهر'], ['Ashar', 'العصر'], ['Maghrib', 'المغرب'], ['Isya', 'العشاء']];
const PRAYER_ORDER = ['Subuh', 'Zuhur', 'Ashar', 'Maghrib', 'Isya'];
const PRAYER_TIMES = { Subuh: 4.75, Zuhur: 12, Ashar: 15.25, Maghrib: 18, Isya: 19.25 };
const suggestPrayer = () => {
  const m = new Date().getHours() + new Date().getMinutes() / 60;
  for (const p of PRAYER_ORDER) { if (m < PRAYER_TIMES[p]) return p; }
  return 'Subuh';
};

/* ---------- API ---------- */
function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = opts.headers || {};
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; }
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = new Request(path, { method: opts.method || 'GET', headers, body });
    fetch(req).then(res => res.json().then(d => {
      if (!res.ok) {
        const err = new Error((d && d.error) || ('HTTP ' + res.status));
        err.code = d && d.code; err.status = res.status; err.data = d;
        reject(err);
      } else resolve(d);
    })).catch(reject);
  });
}
async function loadConfig() { state.cfg = await api('/api/public-config'); }
function geoPayload() {
  const g = state.lastGeo;
  return g ? { lat: g.lat, lng: g.lng, accuracy: state.geoAcc || 15, ts: g.ts } : null;
}

/* ---------- geofence (client-side, BEFORE sending requests) ---------- */
function fenceCheck(geo) {
  const c = state.cfg, d = distM(geo, c);
  const tol = Math.min(Math.max(state.geoAcc || 15, 10), 50);
  return { d, tol, inside: d <= c.radius + tol };
}
function pingGeo() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => {
    state.lastGeo = { lat: p.coords.latitude, lng: p.coords.longitude, ts: Date.now() };
    state.geoAcc = p.coords.accuracy; state.geoDenied = false;
    evaluateGate();
  }, err => {
    if (err.code === 1) { state.geoDenied = true; if (state.view === 'v-gate') showGate('denied'); }
    toast('Tidak bisa mendapat posisi — pastikan GPS aktif', 'err');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 });
}
function startGeoWatch() {
  if (state.geoWatch) return; state.geoWatch = true;
  if (!navigator.geolocation) { state.geoDenied = true; showGate('denied'); return; }
  navigator.geolocation.watchPosition(p => {
    state.lastGeo = { lat: p.coords.latitude, lng: p.coords.longitude, ts: Date.now() };
    state.geoAcc = p.coords.accuracy; state.geoDenied = false;
    evaluateGate();
  }, err => {
    if (err.code === 1) {
      state.geoDenied = true;
      if (state.view === 'v-gate') showGate('denied');
      else if (state.cfg && state.cfg.setupDone && state.view !== 'v-setup') { state.pendingView = state.view; go('v-gate'); showGate('denied'); }
    }
  }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 25000 });
}
function renderLocChip() {
  const c = $('#chip-loc');
  if (!state.cfg || !state.cfg.setupDone) { c.hidden = true; return; }
  c.hidden = false; c.classList.remove('ok', 'out');
  const t = $('#chip-loc-t');
  if (state.geoDenied) { t.textContent = 'Lokasi nonaktif'; return; }
  if (!state.lastGeo) { t.textContent = 'Mengunci GPS…'; return; }
  const f = fenceCheck(state.lastGeo);
  if (f.inside) { c.classList.add('ok'); t.textContent = `Di area masjid · ±${Math.round(state.geoAcc)} m`; }
  else { c.classList.add('out'); t.textContent = `${Math.round(f.d)} m dari masjid`; }
}
function evaluateGate() {
  renderLocChip();
  if (!state.cfg || !state.cfg.setupDone || state.view === 'v-setup') return;
  if (state.geoDenied) {
    if (state.view !== 'v-gate') { state.pendingView = state.view; go('v-gate'); showGate('denied'); }
    return;
  }
  if (!state.lastGeo) {
    if (state.view !== 'v-gate') { state.pendingView = state.view; go('v-gate'); showGate('locating'); }
    return;
  }
  const f = fenceCheck(state.lastGeo);
  if (f.inside) {
    state.wasOutside = false;
    if (state.view === 'v-gate') {
      const dest = (state.pendingView && state.pendingView !== 'v-gate') ? state.pendingView : 'v-home';
      state.pendingView = null;
      go(dest);
      toast('Lokasi terverifikasi — selamat menunaikan sholat', 'ok');
    }
  } else {
    if (state.view !== 'v-gate') { state.pendingView = state.view; go('v-gate'); }
    if (state.gateMode !== 'outside' || state.view !== 'v-gate') showGate('outside', f);
    else updateGate(f);
  }
}
function markSVG(s) { return `<svg width="${s}" height="${s}" viewBox="0 0 48 48" aria-hidden="true"><g fill="none" stroke="var(--gold)" stroke-width="1.6"><rect x="15" y="15" width="18" height="18"/><rect x="15" y="15" width="18" height="18" transform="rotate(45 24 24)"/></g><path d="M26.5 19.5a5.8 5.8 0 1 0 0 9.2 4.7 4.7 0 1 1 0-9.2Z" fill="var(--gold)"/></svg>`; }
function showGate(mode, f) {
  const cfg = state.cfg, b = $('#gate-body'); state.gateMode = mode;
  if (mode === 'locating') {
    b.innerHTML = `<div class="mark-lg">${markSVG(84)}</div>
      <h1>Memverifikasi Lokasi</h1>
      <p>MAQAM hanya aktif di dalam area <b>${esc(cfg.mosqueName)}</b>. Menghubungkan ke GPS…</p>
      <p class="hint">Izinkan akses lokasi bila peramban memintanya.</p>`;
  }
  else if (mode === 'outside') {
    state.wasOutside = true;
    b.innerHTML = `<h1>Di Luar Area Masjid</h1>
      <p>Kamu berada <b><span id="g-d">—</span></b> dari <b>${esc(cfg.mosqueName)}</b>, di luar radius akses ${cfg.radius} m.</p>
      <div class="scale">
        <div class="zone"></div><i class="mos"></i>
        <i class="you" id="g-you" style="left:75%"></i>
        <em class="sc-you" id="g-sd" style="left:75%">kamu</em>
        <span class="l">0 m</span><span class="r">${cfg.radius * 2} m</span>
      </div>
      <button class="btn btn-line" id="g-retry" type="button">${ic('refresh')}Cek Ulang Lokasi</button>
      <p class="hint">Akurasi GPS ±<span id="g-acc">—</span> m. Aplikasi akan terbuka otomatis saat kamu kembali ke area masjid.</p>`;
    $('#g-retry').onclick = pingGeo;
    updateGate(f);
  }
  else if (mode === 'denied') {
    b.innerHTML = `<h1>Izin Lokasi Dibutuhkan</h1>
      <p>MAQAM membatasi akses hanya ke area masjid, sehingga izin lokasi wajib aktif.</p>
      <div class="panel" style="text-align:left;margin-top:14px">
        <p class="hint">1. Klik ikon kunci / lokasi di bilah alamat peramban.<br>2. Izinkan <b>Lokasi</b> dan <b>Kamera</b>.<br>3. Muat ulang halaman bila perlu.</p>
      </div>
      <button class="btn btn-line" id="g-retry" type="button">${ic('refresh')}Saya Sudah Mengizinkan — Coba Lagi</button>`;
    $('#g-retry').onclick = pingGeo;
  }
}
function updateGate(f) {
  if (!f) f = state.lastGeo ? fenceCheck(state.lastGeo) : null; if (!f) return;
  const d = $('#g-d'); if (d) d.textContent = Math.round(f.d) + ' m';
  const a = $('#g-acc'); if (a) a.textContent = Math.round(state.geoAcc || 0);
  const you = $('#g-you'), sd = $('#g-sd');
  if (you) {
    const pct = Math.min(96, Math.max(4, (f.d / (state.cfg.radius * 2)) * 100));
    you.style.left = pct + '%'; sd.style.left = pct + '%';
  }
}

/* ---------- camera (preview only — no AI) ---------- */
class Cam {
  constructor(canvas) {
    this.cv = canvas; this.cx = canvas.getContext('2d');
    this.v = document.createElement('video');
    this.v.setAttribute('playsinline', ''); this.v.muted = true;
    this.mirror = false; this.box = null; this.label = null;
    this.flash = 0; this.running = false; this.stream = null;
  }
  async start(facing = 'user') {
    this.stop();
    const tries = facing === 'environment'
      ? [{ facingMode: { ideal: 'environment' } }, { facingMode: 'user' }]
      : [{ facingMode: 'user' }];
    let stream = null, lastErr = null;
    for (const t of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { ...t, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); break; }
      catch (e) { lastErr = e; }
    }
    if (!stream) throw lastErr || new Error('Kamera tidak tersedia');
    this.mirror = (facing === 'user');
    this.stream = stream; this.v.srcObject = stream;
    this.v.play().catch(() => {});
    if (this.v.readyState < 1) {
      await new Promise(r => {
        const on = () => { this.v.removeEventListener('loadedmetadata', on); r(); };
        this.v.addEventListener('loadedmetadata', on);
      });
    }
    let guard = 0;
    while (!this.v.videoWidth && guard++ < 60) await sleep(100);
    this.running = true; this._raf();
    return this;
  }
  stop() {
    this.running = false; this.box = null; this.label = null;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }
  _raf() { if (!this.running) return; this._paint(); requestAnimationFrame(() => this._raf()); }
  _paint() {
    const v = this.v, c = this.cv, ctx = this.cx;
    const cw = c.clientWidth, ch = c.clientHeight; if (!cw || !ch) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#071020'; ctx.fillRect(0, 0, W, H);
    if (!(v.readyState >= 2 && v.videoWidth)) return;
    const s = Math.max(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s, dx = (W - dw) / 2, dy = (H - dh) / 2;
    ctx.save();
    if (this.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, dx, dy, dw, dh);
    ctx.restore();
    let center = null, boxTop = null;
    if (this.box) {
      const b = this.box;
      const x = dx + b.x * s, y = dy + b.y * s, w = b.width * s, h = b.height * s;
      boxTop = y;
      ctx.strokeStyle = 'rgba(228,192,106,.95)'; ctx.lineWidth = Math.max(2, 1.5 * dpr);
      ctx.strokeRect(x, y, w, h);
      const t = Math.max(9, 7 * dpr); ctx.lineWidth = Math.max(3, 2 * dpr);
      ctx.beginPath();
      [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([px, py, m1, m2]) => {
        ctx.moveTo(px + m1 * t, py); ctx.lineTo(px, py); ctx.lineTo(px, py + m2 * t);
      });
      ctx.stroke();
      center = this.mirror ? W - (x + w / 2) : (x + w / 2);
    }
    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * .45; ctx.fillStyle = '#F2EDDC';
      ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      this.flash = Math.max(0, this.flash - .05);
    }
    if (this.box && this.label && center != null) {
      const fs = Math.max(12, 11 * dpr);
      ctx.font = `700 ${fs}px "Plus Jakarta Sans",sans-serif`;
      const txt = String(this.label), tw = ctx.measureText(txt).width;
      let bx = Math.min(Math.max(2, center - tw / 2 - fs * .6), W - tw - fs * 1.2);
      let by = Math.max(2, boxTop - fs * 2.3);
      ctx.fillStyle = 'rgba(7,16,32,.86)'; ctx.strokeStyle = 'rgba(217,169,78,.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(bx, by, tw + fs * 1.2, fs * 1.7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#F2ECDD'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + fs * .6, by + fs * .9);
      ctx.textBaseline = 'alphabetic';
    }
  }
  snapshot(maxW = 480, q = .7) {
    const v = this.v; if (!(v.readyState >= 2 && v.videoWidth)) return null;
    const s = Math.min(1, maxW / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }
  faceCrop(box, size = 210, pad = .42) {
    const v = this.v; if (!(v.readyState >= 2 && v.videoWidth)) return null;
    const side = Math.max(box.width, box.height) * (1 + pad * 2);
    const sx = box.x + box.width / 2 - side / 2, sy = box.y + box.height / 2 - side / 2;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#071020'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(v, sx, sy, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', .85);
  }
}

/* ---------- attendance flow (steps 1, 2, 3) ---------- */
const attend = {
  active: false, cam1: null, cam2: null, t1: null, t2: null,
  tFace: null, tScene: null,
  busy: false, member: null, faceDist: 0, desc: null,
  sceneFrames: [], lastScene: null, lastAgg: null,
  bestSnap: null, bestSnapScore: 0, lastSnapT: 0,
  autoDone: false, finishing: false, busyS: false,
  sceneSnapEvery: 1500,

  async begin() {
    this.active = true; this.member = null; this.desc = null;
    this.autoDone = false; this.finishing = false; this.bursting = false; this.burst = null;
    this.streak = 0; this.busy = false; this.cool = 0; this._lastReason = '';
    this.sceneFrames = []; this.lastScene = null; this.lastAgg = null;
    this.bestSnap = null; this.bestSnapScore = 0; this.lastSnapT = 0;
    go('v-attend');
    $('#at-sub').textContent = `${state.prayer} · ${esc(state.cfg.mosqueName)}`;
    renderPillBox($('#pills-att'));
    this.setStep(1);
    await this.openFace();
  },
  setStep(n) {
    [1, 2, 3].forEach(i => {
      $('#at-p' + i).hidden = (i !== n);
      const st = $('#st' + i);
      st.classList.toggle('on', i === n);
      st.classList.toggle('done', i < n);
    });
  },
  async openFace() {
    const w = $('#at-arch1');
    w.classList.add('scanning'); w.classList.remove('locked');
    this.stat(1, 'Menyalakan kamera…');
    $('#at-toreg').hidden = true; $('#at-retry').hidden = true;
    $('#at-guide1').textContent = 'Hadapkan wajah ke kamera — sistem akan memotret setiap 1,5 detik dan mengirim ke server.';
    try {
      this.cam1 = this.cam1 || new Cam($('#at-cam1'));
      await this.cam1.start('user');
    } catch (e) {
      this.stat(1, 'Kamera tidak dapat diakses');
      $('#at-retry').hidden = false;
      toast('Izinkan akses kamera' + (!window.isSecureContext ? ' — buka lewat alamat https milik server' : ''), 'err');
      return;
    }
    this.stat(1, 'Mengirim foto ke server…');
    clearInterval(this.t1);
    this.t1 = setInterval(() => this.faceTick(), 1500);
  },
  stat(n, txt) { const e = $('#at-status' + n); e.innerHTML = `<i class="dot"></i><span>${txt}</span>`; },
  async faceTick() {
    if (this.busy) return;
    const c = this.cam1;
    if (!c || !c.running) return;
    const img = c.snapshot(480, .7);
    if (!img) return;
    this.busy = true;
    try {
      const out = await api('/api/face-recognize', {
        method: 'POST',
        body: { image: img, geo: geoPayload() },
      });
      if (!this.active) return;
      if (out.matched) {
        this.member = out.member;
        this.desc = out.dist;
        this.cam1.label = `${out.member.name} · ${out.simPct}%`;
        $('#at-arch1').classList.remove('scanning');
        $('#at-arch1').classList.add('locked');
        this.stat(1, `Wajah dikenali — ${esc(out.member.name)} (${out.simPct}%)`);
        this.busy = false;
        setTimeout(() => { if (this.active) this.toScene(); }, 1100);
        return;
      }
    } catch (e) {
      this.busy = false;
      if (e.code === 'GEO') { toast(e.message, 'err'); evaluateGate(); return; }
      toast(e.message || 'Gagal menghubungi server', 'err');
      setTimeout(() => { if (this.active) this.openFace(); }, 2500);
      return;
    }
    this.busy = false;
  },
  toScene() { this.setStep(2); this.openEnv(); },
  async openEnv() {
    const w = $('#at-arch2');
    w.classList.add('scanning'); w.classList.remove('locked');
    this.stat(2, 'Mengalihkan kamera…');
    $('#at-retry2').hidden = true;
    this.sceneFrames = []; this.lastScene = null; this.lastAgg = null;
    this.bestSnap = null; this.bestSnapScore = 0; this.lastSnapT = 0;
    this.autoDone = false;
    $('#at-meter-f').style.width = '0%'; $('#at-meter-v').textContent = '0%';
    $('#at-labels').innerHTML = ''; $('#at-scene-note').textContent = '';
    $('#at-meter').classList.remove('fail');
    const g = $('#at-p2 .guide');
    g.textContent = 'Arahkan kamera ke bagian mushola — sistem akan memotret setiap 1,5 detik dan mengecek dengan server.';
    try {
      if (this.cam1) this.cam1.stop();
      this.cam2 = this.cam2 || new Cam($('#at-cam2'));
      await this.cam2.start('environment');
    } catch (e) {
      this.stat(2, 'Kamera tidak dapat diakses');
      $('#at-retry2').hidden = false;
      return;
    }
    this.stat(2, 'Memindikan lingkungan ke server…');
    clearInterval(this.t2);
    this.t2 = setInterval(() => this.sceneTick(), this.sceneSnapEvery);
  },
  renderScene(agg) {
    $('#at-meter').classList.remove('fail');
    if (agg.meanRef != null) {
      const pct = Math.min(100, Math.round(agg.meanRef * 100));
      $('#at-meter-f').style.width = pct + '%';
      $('#at-meter-v').textContent = pct + '% · ' + agg.n + ' fotokopi';
      $('#at-labels').innerHTML =
        `<span class="chip hit">Mirip mushola ${Math.round(agg.meanRef * 100)}%</span>` +
        (agg.meanBlack != null ? `<span class="chip">Mirip non-mushola ${Math.round(agg.meanBlack * 100)}%</span>` : '');
      return;
    }
    const pct = Math.min(100, Math.round(agg.meanTotal / .42 * 100));
    $('#at-meter-f').style.width = pct + '%';
    $('#at-meter-v').textContent = pct + '% · ' + agg.n + ' fotokopi';
    let chips = agg.hits.slice(0, 3).map(h =>
      `<span class="chip hit">${esc(h.id)} · ${Math.round(h.p * 100)}%</span>`).join('');
    if (!chips && this.lastScene && this.lastScene.res)
      chips = this.lastScene.res.slice(0, 3).map(r => {
        const nm = String(r.className).split(',')[0];
        return `<span class="chip">${esc(nm)} · ${Math.round(r.probability * 100)}%</span>`;
      }).join('');
    $('#at-labels').innerHTML = chips;
  },
  async sceneTick() {
    if (!this.cam2 || !this.cam2.running || this.finishing) return;
    const img = this.cam2.snapshot(380, .6);
    if (!img) return;
    this.busyS = true;
    try {
      // server-side scene check
      const out = await api('/api/scene-recognize', {
        method: 'POST',
        body: { image: img, refSim: this.lastAgg ? this.lastAgg.meanRef : null },
      });
      this.busyS = false;
      if (!this.active) return;
      if (out.pass) {
        const agg = { n: this.sceneFrames.length + 1, meanRef: out.refSim || (out.bestRef || 0), meanBlack: out.blackSim || 0, passes: (this.lastAgg ? this.lastAgg.passes : 0) + 1 };
        this.sceneFrames.push({ sc: agg });
        this.renderScene(agg);
        this.lastAgg = agg;
        // keep a good snapshot
        if (out.refSim > this.bestSnapScore && Date.now() - this.lastSnapT > 400) {
          this.bestSnap = img; this.bestSnapScore = out.refSim; this.lastSnapT = Date.now();
        }
        if (this.sceneFrames.length >= 6 && !this.autoDone) {
          this.autoDone = true;
          this.stat(2, `Tempat terverifikasi — kemiripan ${Math.round(agg.meanRef * 100)}% (${agg.n} fotokopi)`);
          $('#at-arch2').classList.remove('scanning');
          $('#at-arch2').classList.add('locked');
          setTimeout(() => { if (this.active) this.finalize(); }, 700);
        }
        return;
      }
      // not passed — keep scanning
      this.sceneFrames.push({ sc: { n: this.sceneFrames.length + 1, meanRef: out.refSim || 0, meanBlack: out.blackSim || 0, passes: 0 } });
      this.renderScene(this.sceneFrames[this.sceneFrames.length - 1]);
      if (this.sceneFrames.length > 14) this.sceneFrames.shift();
    } catch (e) {
      this.busyS = false;
      toast(e.message || 'Gagal memindai lingkungan', 'err');
    }
  },
  async finalize() {
    if (this.finishing) return;
    this.finishing = true;
    clearInterval(this.t2);
    const snap = this.bestSnap || (this.cam2 ? this.cam2.snapshot(380, .6) : null);
    let scene = null;
    if (this.lastAgg && this.lastAgg.meanRef != null) {
      scene = { labels: [{ id: 'Mushola (server)', p: this.lastAgg.meanRef }], refSim: this.lastAgg.meanRef, blackSim: this.lastAgg.meanBlack };
    }
    if (this.cam2) this.cam2.stop();
    try {
      await api('/api/attendance', { method: 'POST', body: {
        member: this.member,
        prayer: state.prayer,
        scene, sceneImg: snap,
        geo: geoPayload(),
      }});
      renderDone({ name: this.member.name, prayer: state.prayer, ts: Date.now(),
        simPct: Math.round((1 - this.desc) * 100), dist: Math.round(state.lastGeo ? distM(state.lastGeo, state.cfg) : 0), scene });
      this.setStep(3);
      this.finishing = false;
      loadConfig().catch(() => {});
    } catch (e) {
      this.finishing = false;
      if (e.code === 'DUPE' && e.data && e.data.rec) { renderDupe(e.data.rec); this.setStep(3); }
      else if (e.code === 'GEO') { toast(e.message, 'err'); evaluateGate(); }
      else if (e.code === 'NOFACE') { toast(e.message, 'err'); this.cancel(); }
      else toast((e && e.message) || 'Gagal menyimpan absensi', 'err');
    }
  },
  cancel() { this.hardStop(); go('v-home'); },
  hardStop() {
    clearInterval(this.t1); clearInterval(this.t2);
    this.active = false; this.finishing = false; this.autoDone = false;
    this.busy = false; this.busyS = false;
    if (this.cam1) this.cam1.stop();
    if (this.cam2) this.cam2.stop();
  },
};

function renderDone(rec) {
  $('#done-tag').textContent = 'TERCATAT';
  $('#done-salam').hidden = false;
  $('#done-name').textContent = rec.name;
  let place, vInfo;
  if (rec.scene && rec.scene.labels && rec.scene.labels.length) {
    place = `mushola ${Math.round((rec.scene.refSim || 0) * 100)}%` +
      (rec.scene.blackSim != null ? ` · non-mushola ${Math.round(rec.scene.blackSim * 100)}%` : '');
    vInfo = ` (${rec.scene.frames || '—'} fotokopi)`;
  } else {
    place = rec.scene && rec.scene.labels && rec.scene.labels.length
      ? rec.scene.labels.map(h => `${h.id} ${Math.round(h.p * 100)}%`).join(' · ') : '—';
    vInfo = '';
  }
  $('#done-kv').innerHTML = `
    <dt>Sholat</dt><dd>${rec.prayer}</dd>
    <dt>Waktu</dt><dd>${fmtTime(rec.ts)}</dd>
    <dt>Tempat</dt><dd>${esc(place)}${vInfo}</dd>
    <dt>Kemiripan</dt><dd>${rec.simPct}%</dd>
    <dt>Jarak</dt><dd>${rec.dist} m dari pusat</dd>`;
  $('#done-note').textContent = `Kehadiran ${rec.prayer} hari ini telah tercatat. Semoga sholatnya diterima.`;
}
function renderDupe(rec) {
  $('#done-tag').textContent = 'SUDAH TERCATAT';
  $('#done-salam').hidden = true;
  $('#done-name').textContent = rec.name;
  $('#done-kv').innerHTML = `
    <dt>Sholat</dt><dd>${rec.prayer}</dd>
    <dt>Tercatat pukul</dt><dd>${fmtTime(rec.ts)}</dd>`;
  $('#done-note').textContent = `Absensi ${rec.prayer} hari ini sudah tercatat — tidak dicatat ulang.`;
}

/* ---------- pendaftaran ---------- */
const reg = {
  active: false, name: '', samples: [], cam: null, t: null, streak: 0, busy: false, cool: 0, _lastReason: '',
  start() {
    this.active = true; this.samples = []; this.name = ''; this._lastReason = '';
    go('v-register');
    $('#rg-p1').hidden = false; $('#rg-p2').hidden = true; $('#rg-p3').hidden = true;
    $('#rg-sub').textContent = 'Langkah 1 dari 2 · Data';
    $('#rg-name').value = '';
  },
  next() {
    const name = $('#rg-name').value.trim();
    if (name.length < 3) { fieldErr('rg-name', 'Nama minimal 3 huruf.'); return; }
    this.name = name;
    this.toCam();
  },
  async toCam() {
    const btn = $('#rg-next'); btn.disabled = true;
    $('#rg-p1').hidden = true; $('#rg-p2').hidden = false;
    $('#rg-sub').textContent = 'Langkah 2 dari 2 · Sampel wajah';
    $('#rg-name-chip').textContent = this.name;
    $('#rg-fin').hidden = true; $('#rg-manual').hidden = false; $('#rg-cam-retry').hidden = true;
    this.renderSlots();
    this.stat('Menyalakan kamera…');
    try {
      this.cam = this.cam || new Cam($('#rg-cam'));
      await this.cam.start('user');
    } catch (e) {
      this.stat('Kamera tidak dapat diakses');
      $('#rg-cam-retry').hidden = false;
      toast('Izinkan akses kamera' + (!window.isSecureContext ? ' — buka lewat alamat https milik server' : ''), 'err');
      return;
    }
    this.stat('Mengambil sampel…');
    this.streak = 0; this.busy = false; this.cool = 0;
    clearInterval(this.t);
    this.t = setInterval(() => this.tick(), 2200);
  },
  stat(txt) { $('#rg-status').innerHTML = `<i class="dot"></i><span>${txt}</span>`; },
  async tick() {
    // server-only registration: no client-side face detection.
    // The UI just waits for the user to tap the manual capture button.
    if (!this.cam || !this.cam.running || this.busy) return;
    this.streak++;
    if (this.streak >= 2) this.cool = Date.now() + 600;
  },
  async capture(manual) {
    if (this.busy) return;
    const c = this.cam;
    if (!c || !c.running) {
      if (manual) toast('Kamera belum siap', 'err');
      return;
    }
    this.busy = true;
    // send the snapshot to the server for face detection + descriptor;
    // the server re-derives the descriptor (server-side truth).
    try {
      const img = c.snapshot(480, .8);
      if (!img) { toast('Gambar tidak bisa diambil', 'err'); this.busy = false; return; }
      const res = await api('/api/detect-face', { method: 'POST', body: { image: img, geo: geoPayload() } });
      if (!this.active) { this.busy = false; return; }
      if (res && res.descriptor && res.descriptor.length === 128) {
        const thumb = c.faceCrop(res.box || { x: 0, y: 0, width: 100, height: 100 }, 210, .42);
        this.samples.push({ d: new Float32Array(res.descriptor), thumb });
        c.flash = 1;
        this.renderSlots();
        this.stat(`Sampel ${this.samples.length}/3 tersimpan`);
        this.cool = Date.now() + 1600;
        if (this.samples.length >= 3) {
          this.stat('Sampel cukup — periksa lalu simpan');
          $('#rg-fin').hidden = false; $('#rg-manual').hidden = true;
        }
      } else {
        toast('Wajah tidak terdeteksi — hadapkan wajah ke kamera lalu coba lagi', 'err');
        this.cool = Date.now() + 1200;
      }
    } catch (e) {
      toast(e.message || 'Gagal mendeteksi wajah dari sisi server', 'err');
      this.cool = Date.now() + 1200;
    }
    this.busy = false;
  },
  renderSlots() {
    $('#rg-samples').innerHTML = [0, 1, 2].map(i =>
      this.samples[i]
        ? `<div class="slot"><img src="${this.samples[i].thumb}" alt=""></div>`
        : `<div class="slot"><span>${i + 1}</span></div>`).join('');
  },
  reset() {
    this.samples = []; this.renderSlots();
    $('#rg-fin').hidden = true; $('#rg-manual').hidden = false;
    this.stat('Ulangi — 3 sampel akan diambil');
  },
  async save() {
    if (this.samples.length < 1) return;
    const btn = $('#rg-save'); btn.disabled = true; btn.textContent = 'Menyimpan…';
    try {
      const m = await api('/api/register', { method: 'POST', body: {
        name: this.name,
        samples: this.samples.map(s => ({ descriptor: Array.from(s.d), thumb: s.thumb })),
        geo: geoPayload(),
      }});
      this.hardStop();
      $('#rg-p2').hidden = true; $('#rg-p3').hidden = false;
      $('#rg-sub').textContent = 'Selesai';
      $('#rg-done-photo').src = m.photo;
      $('#rg-done-name').textContent = m.name;
      toast(`Pendaftaran berhasil — ahlan wa sahlan, ${m.name}`, 'ok');
      loadConfig().catch(() => {});
    } catch (e) {
      btn.disabled = false; btn.innerHTML = ic('check') + 'Simpan Pendaftaran';
      if (e.code === 'GEO') { toast(e.message, 'err'); evaluateGate(); }
      else if (e.code === 'DUPFACE')
        openModal({ title: 'Wajah Sudah Terdaftar', body: `<p class="mbody">${esc(e.message)}</p>`, actions: [{ label: 'Mengerti', cls: 'btn-pri' }] });
      else toast((e && e.message) || 'Gagal menyimpan pendaftaran', 'err');
    }
  },
  cancel() { this.hardStop(); go('v-home'); },
  hardStop() { clearInterval(this.t); this.active = false; this.busy = false; if (this.cam) this.cam.stop(); },
  // client no longer detects locally; registration uses /api/detect-face.
  detectBox: null,
  detFull: null,
};

/* ---------- navigasi ---------- */
function go(id) {
  $$('.view').forEach(v => v.classList.toggle('on', v.id === id));
  state.view = id;
  try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
  if (id !== 'v-attend' && id !== 'v-register') { attend.hardStop(); reg.hardStop(); }
  if (id === 'v-home') { renderHome(); loadConfig().then(renderHome).catch(() => {}); }
}
function renderHeader() {
  const cfg = state.cfg;
  $('#hdr-name').textContent = cfg && cfg.setupDone ? cfg.mosqueName : 'MAQAM';
  $('#hdr-sub').textContent = cfg && cfg.setupDone ? 'Absensi Sholat · MAQAM' : 'Menyiapkan masjid…';
  $('#btn-admin').hidden = !(cfg && cfg.setupDone);
}
function renderHome() {
  const cfg = state.cfg; if (!cfg || !cfg.setupDone) return;
  if (!state.prayer) state.prayer = suggestPrayer();
  $('#home-sal').textContent = `ASSALAMU'ALAIKUM · ${greet().toUpperCase()}`;
  $('#home-clock').textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#home-date').textContent = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#home-hijri').textContent = hijri();
  $('#home-stat').innerHTML = `${cfg.membersCount} jamaah terdaftar · <b style="color:var(--gold2)">${cfg.todayCount}</b> sudah absen hari ini`;
  renderPillBox($('#pills-home'));
  if (state.lastGeo && fenceCheck(state.lastGeo).inside)
    $('#home-geo-note').innerHTML = `Lokasi terverifikasi: kamu berada dalam area <b>${esc(cfg.mosqueName)}</b> (radius ${cfg.radius} m).`;
}
function renderPillBox(box) {
  box.innerHTML = PRAYERS.map(([n, ar]) =>
    `<button type="button" class="pill ${state.prayer === n ? 'sel' : ''}" data-p="${n}"><b>${n}</b><span class="ar">${ar}</span></button>`).join('');
}
['pills-home', 'pills-att'].forEach(id => {
  $('#' + id).addEventListener('click', e => {
    const p = e.target.closest('.pill'); if (!p) return;
    state.prayer = p.dataset.p;
    renderPillBox($('#pills-home')); renderPillBox($('#pills-att'));
    $('#at-sub').textContent = `${state.prayer} · ${esc(state.cfg.mosqueName)}`;
  });
});
setInterval(() => { const el = $('#home-clock'); if (el && state.view === 'v-home') el.textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
setInterval(() => {
  if (state.cfg && state.cfg.setupDone)
    loadConfig().then(() => { renderLocChip(); evaluateGate(); }).catch(() => {});
}, 60000);

/* ---------- event ---------- */
$('#btn-admin').addEventListener('click', () => window.open('/admin.html', '_blank'));
$('#btn-attend').addEventListener('click', async () => {
  if (!state.lastGeo || !fenceCheck(state.lastGeo).inside) {
    toast('Kamu harus berada di area masjid', 'err'); evaluateGate(); return;
  }
  attend.begin();
});
$('#btn-reg').addEventListener('click', reg.start.bind(reg));
$('#at-cancel').addEventListener('click', () => attend.cancel());
$('#at-toreg').addEventListener('click', () => reg.start());
$('#at-retry').addEventListener('click', () => attend.openFace());
$('#at-retry2').addEventListener('click', () => attend.openEnv());
$('#at-verify').addEventListener('click', async () => {
  $('#at-meter').classList.remove('fail');
  void $('#at-meter').offsetWidth;
  $('#at-meter').classList.add('fail');
  toast('Verifikasi tempat belum lolos', 'err');
});
$('#done-back').addEventListener('click', () => go('v-home'));

$('#rg-cancel').addEventListener('click', () => reg.cancel());
$('#rg-next').addEventListener('click', () => reg.next());
$('#rg-manual').addEventListener('click', () => reg.capture(true));
$('#rg-reset').addEventListener('click', () => reg.reset());
$('#rg-save').addEventListener('click', () => reg.save());
$('#rg-cam-retry').addEventListener('click', () => reg.toCam());
$('#rg-done-attend').addEventListener('click', () => { if (state.lastGeo && fenceCheck(state.lastGeo).inside) attend.begin(); else evaluateGate(); });
$('#rg-done-home').addEventListener('click', () => go('v-home'));

let setupGeo = null;
$('#su-rad').addEventListener('input', e => $('#su-rad-v').textContent = e.target.value + ' m');
$('#su-gps').addEventListener('click', () => {
  const btn = $('#su-gps'); btn.disabled = true;
  toast('Mengambil sinyal GPS…', 'info');
  navigator.geolocation.getCurrentPosition(p => {
    btn.disabled = false;
    setupGeo = { lat: p.coords.latitude, lng: p.coords.longitude };
    const res = $('#su-geores'); res.hidden = false;
    res.innerHTML = `Titik pusat: <b>${setupGeo.lat.toFixed(5)}, ${setupGeo.lng.toFixed(5)}</b><br>akurasi ±${Math.round(p.coords.accuracy)} m`;
    toast('Koordinat masjid tersimpan', 'ok');
  }, () => {
    btn.disabled = false;
    toast('Gagal mengambil GPS — izinkan lokasi atau isi manual', 'err');
  }, { enableHighAccuracy: true, timeout: 15000 });
});
$('#su-save').addEventListener('click', async () => {
  const name = $('#su-name').value.trim();
  const pass = $('#su-pass').value, pass2 = $('#su-pass2').value;
  if (name.length < 3) { fieldErr('su-name', 'Nama masjid minimal 3 huruf.'); return; }
  if (pass.length < 4) { fieldErr('su-pass', 'Kata sandi minimal 4 karakter.'); return; }
  if (pass !== pass2) { fieldErr('su-pass2', 'Konfirmasi sandi tidak sama.'); return; }
  let geo = setupGeo;
  if (!geo) {
    const lat = parseFloat($('#su-lat').value), lng = parseFloat($('#su-lng').value);
    if (isFinite(lat) && isFinite(lng) && lat !== 0) geo = { lat, lng };
  }
  if (!geo) { toast('Ambil lokasi GPS (disarankan) atau isi koordinat manual', 'err'); return; }
  const radius = Math.min(300, Math.max(30, parseInt($('#su-rad').value) || 120));
  const btn = $('#su-save'); btn.disabled = true;
  try {
    await api('/api/setup', { method: 'POST', body: { mosqueName: name, password: pass, lat: geo.lat, lng: geo.lng, radius } });
    await loadConfig();
    renderHeader(); renderHome();
    toast(`${name} terdaftar — aplikasi MAQAM aktif`, 'ok');
    startGeoWatch();
    go('v-gate'); showGate('locating');
  } catch (e) {
    btn.disabled = false;
    toast(e.message || 'Gagal menyimpan setup', 'err');
  }
});/* boot */
init();
