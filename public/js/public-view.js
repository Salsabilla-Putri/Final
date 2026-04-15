/**
 * Gen-Track · Public View  v2.0
 * Enhanced JS: power source detection, cost estimator,
 * animated flow, health checks, user-friendly language.
 */

'use strict';

/* ── CONSTANTS ─────────────────────────────────── */
const TARIFF_PER_KWH = 1699;          // Rp/kWh — R-1/TR 1300VA (update sesuai tarif PLN)
const MAX_POWER_KW   = 1.3;           // kapasitas daya rumah tangga (kW)
const VOLT_MIN       = 198;
const VOLT_MAX       = 242;
const FREQ_MIN       = 49.5;
const FREQ_MAX       = 50.5;

let accumulatedKwh   = 0;
let sessionStartMs   = Date.now();
let lastPowerKw      = 0;
let lastUpdateMs     = 0;

/* ── UTILS ─────────────────────────────────────── */
function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric',
                                      hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function fmtCurrency(n) {
  return Math.round(n).toLocaleString('id-ID');
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function initials(name) {
  return (name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
}

/* ── POWER SOURCE LOGIC ─────────────────────────── */
/**
 * Determines active power source.
 * Returns: 'PLN' | 'GENERATOR' | 'HYBRID' | 'OFF'
 */
function detectPowerSource(data, isRunning) {
  const sync = String(data.sync || '').toUpperCase();
  const hasGrid = sync.includes('ON-GRID') || sync.includes('SYNC') || sync.includes('PLN');

  if (!isRunning && !hasGrid) return 'OFF';
  if (isRunning && hasGrid)   return 'HYBRID';
  if (isRunning && !hasGrid)  return 'GENERATOR';
  return 'PLN';   // grid only, generator standby
}

function powerSourceMeta(source) {
  const map = {
    PLN: {
      label:   'Jaringan PLN (Listrik Utama)',
      icon:    'fas fa-plug',
      cls:     'pln',
      flowCls: 'active',
      flowLabel: 'PLN',
      genState: 'Siaga (Standby)',
      plnState: 'Aktif ✓',
      sysHealth: 'Normal',
    },
    GENERATOR: {
      label:   'Generator Cadangan',
      icon:    'fas fa-bolt',
      cls:     'gen',
      flowCls: 'active gen-active',
      flowLabel: 'Generator',
      genState: 'Menyala ✓',
      plnState: 'Tidak Aktif',
      sysHealth: 'Mode Cadangan',
    },
    HYBRID: {
      label:   'Hybrid (PLN + Generator)',
      icon:    'fas fa-rotate',
      cls:     'hyb',
      flowCls: 'active',
      flowLabel: 'PLN + Gen',
      genState: 'Menyala ✓',
      plnState: 'Aktif ✓',
      sysHealth: 'Mode Hybrid',
    },
    OFF: {
      label:   'Tidak Ada Sumber Listrik',
      icon:    'fas fa-power-off',
      cls:     'off',
      flowCls: '',
      flowLabel: '--',
      genState: 'Mati',
      plnState: 'Tidak Aktif',
      sysHealth: 'Offline',
    },
  };
  return map[source] || map.OFF;
}

/* ── COST ACCUMULATOR ───────────────────────────── */
function accumulateCost(powerKw, nowMs) {
  if (lastUpdateMs > 0 && powerKw > 0) {
    const dtHours = (nowMs - lastUpdateMs) / 3_600_000;
    accumulatedKwh += powerKw * dtHours;
  }
  lastUpdateMs = nowMs;
  lastPowerKw  = powerKw;
}

function todayKwh(powerKw) {
  // If session started same day, use accumulated. Otherwise estimate from hours since midnight.
  const msNow      = Date.now();
  const midnight   = new Date(); midnight.setHours(0,0,0,0);
  const hoursToday = (msNow - midnight.getTime()) / 3_600_000;
  return Math.max(accumulatedKwh, powerKw * hoursToday * 0.6); // 0.6 = utilisation factor estimate
}

/* ── METRIC BAR + CARD STATUS ───────────────────── */
function setMetricCard(barId, cardId, value, lo, hi, max, unit) {
  const bar  = document.getElementById(barId);
  const card = document.getElementById(cardId);
  if (!bar || !card) return;

  const pct     = clamp((value - 0) / max * 100, 0, 100);
  const inRange = value >= lo && value <= hi;

  bar.style.width = pct + '%';
  bar.classList.toggle('warn', !inRange && value > 0);
  bar.classList.toggle('err',  value <= 0);
}

/* ── HEALTH STATUS HELPER ───────────────────────── */
function setHealth(dotId, badgeId, descId, itemId, status, label, desc) {
  const dot   = document.getElementById(dotId);
  const badge = document.getElementById(badgeId);
  const descEl = document.getElementById(descId);
  const item   = document.getElementById(itemId);

  if (dot)   { dot.className   = 'hi-dot ' + status; }
  if (badge) { badge.className = 'hi-badge ' + status; badge.textContent = label; }
  if (descEl){ descEl.textContent = desc; }
  if (item)  { item.className  = 'health-item ' + status; }
}

// NEW CODE
// EXTENSION ONLY: render top 3 alerts from API
function renderAlerts(alerts = []) {
  const listEl = document.getElementById('publicAlertsList');
  if (!listEl) return;

  const limitedAlerts = Array.isArray(alerts) ? alerts.slice(0, 3) : [];
  if (!limitedAlerts.length) {
    listEl.innerHTML = `<li class="public-alert public-alert--info"><strong>Aman:</strong> Tidak ada peringatan penting saat ini.</li>`;
    return;
  }

  listEl.innerHTML = limitedAlerts.map((alert) => {
    const type = String(alert?.type || 'info').toLowerCase();
    const message = alert?.message || 'Peringatan sistem';
    const action = alert?.action ? ` — ${alert.action}` : '';
    return `<li class="public-alert public-alert--${type}"><strong>${message}</strong><span>${action}</span></li>`;
  }).join('');
}

// NEW CODE
// EXTENSION ONLY: render maintenance summary text
function renderMaintenance(maintenance = {}) {
  const statusEl = document.getElementById('maintenanceStatusText');
  const recEl = document.getElementById('maintenanceRecommendationText');
  if (!statusEl || !recEl) return;

  statusEl.textContent = maintenance?.status || 'Good condition';
  recEl.textContent = maintenance?.recommendation || 'No immediate maintenance action required.';
}

/* ── MAIN UPDATE FUNCTION ───────────────────────── */
function updatePublicView(data) {
  const nowMs    = Date.now();

  /* --- Raw values --- */
  const volt     = Number(data.volt   || 0);
  const freq     = Number(data.freq   || 0);
  const current  = Number(data.current || data.amp || 0);
  const fuel     = Number(data.fuel   || 0);
  const temp     = Number(data.temp   || data.coolant || 0);
  const oil      = Number(data.oil    || data.oilPressure || 0);
  const isRunning = String(data.status || '').toLowerCase() === 'on' || Number(data.rpm || 0) > 0;
  const syncText  = String(data.sync  || '').toUpperCase();
  const syncLabel = data.sync_label || (syncText === 'ON-GRID' ? 'Terhubung PLN' : 'Generator Aktif');

  /* --- Derived --- */
  const powerKw  = (volt * current) / 1000 || (isRunning ? 0.6 : 0);
  const voltOk   = volt >= VOLT_MIN && volt <= VOLT_MAX;
  const freqOk   = freq >= FREQ_MIN && freq <= FREQ_MAX;
  const electricOk = voltOk && freqOk && volt > 0;
  const syncOk   = syncText.includes('ON-GRID') || syncText.includes('SYNC') || syncText.includes('PLN');
  const engineOk = (temp === 0 || temp <= 95) && (oil === 0 || oil >= 15);

  /* --- Power source --- */
  const source     = detectPowerSource(data, isRunning);
  const sourceMeta = powerSourceMeta(source);

  /* --- Cost --- */
  accumulateCost(powerKw, nowMs);
  const kwhToday = todayKwh(powerKw);
  const costRp   = kwhToday * TARIFF_PER_KWH;

  /* ── DOM Updates ── */

  /* Sidebar user */
  const username = localStorage.getItem('username') || 'Pengguna';
  const sidebarName = document.getElementById('sidebarName');
  const sidebarAvatar = document.getElementById('sidebarAvatar');
  if (sidebarName) sidebarName.textContent = username;
  if (sidebarAvatar) sidebarAvatar.textContent = initials(username);

  /* Power source badge */
  const badge = document.getElementById('powerSourceBadge');
  const psbIcon = document.getElementById('psbIcon');
  const psbValue = document.getElementById('powerSourceName');
  if (badge)  { badge.className = 'power-source-badge ' + sourceMeta.cls; }
  if (psbIcon) psbIcon.innerHTML = `<i class="${sourceMeta.icon}"></i>`;
  if (psbValue) psbValue.textContent = sourceMeta.label;
  const publicSyncLabel = document.getElementById('publicSyncLabel');
  if (publicSyncLabel) publicSyncLabel.textContent = syncLabel;

  /* Hero stats */
  document.getElementById('heroGenState').textContent  = sourceMeta.genState;
  document.getElementById('heroPLNState').textContent  = sourceMeta.plnState;
  document.getElementById('heroSysHealth').textContent = sourceMeta.sysHealth;

  /* Power flow */
  const flowEl = document.getElementById('powerFlow');
  const pfSourceLabel = document.getElementById('pfSourceLabel');
  if (flowEl) {
    flowEl.className = 'power-flow ' + sourceMeta.flowCls;
  }
  if (pfSourceLabel) pfSourceLabel.textContent = sourceMeta.flowLabel;

  /* Source icon on flow */
  const pfSrc = document.querySelector('.pf-source i');
  if (pfSrc) {
    pfSrc.className = source === 'GENERATOR' ? 'fas fa-bolt' : 'fas fa-plug';
    pfSrc.parentElement.style.background = source === 'GENERATOR' ? '#fef3c7' : '#d1fae5';
    pfSrc.style.color = source === 'GENERATOR' ? '#d97706' : '#059669';
  }

  /* Metrics */
  document.getElementById('metricVolt').textContent    = volt > 0    ? volt.toFixed(1)    : '--';
  document.getElementById('metricFreq').textContent    = freq > 0    ? freq.toFixed(2)    : '--';
  document.getElementById('metricCurrent').textContent = current > 0 ? current.toFixed(1) : '--';
  document.getElementById('metricPower').textContent   = powerKw > 0 ? powerKw.toFixed(2) : '--';

  document.getElementById('voltNote').textContent  = voltOk
    ? `Tegangan normal (${VOLT_MIN}–${VOLT_MAX} V)` : volt > 0
    ? `Tegangan di luar normal — sistem auto-menyesuaikan` : 'Tidak terdeteksi tegangan';

  document.getElementById('freqNote').textContent  = freqOk
    ? `Frekuensi stabil (${FREQ_MIN}–${FREQ_MAX} Hz)` : freq > 0
    ? `Frekuensi belum stabil, hindari peralatan sensitif` : 'Tidak terdeteksi frekuensi';

  document.getElementById('powerNote').textContent = powerKw > 0
    ? `${((powerKw / MAX_POWER_KW) * 100).toFixed(0)}% kapasitas daya digunakan`
    : 'Tidak ada konsumsi daya terdeteksi';

  setMetricCard('voltBar',    'voltageCard', volt,    VOLT_MIN, VOLT_MAX, 260, 'V');
  setMetricCard('freqBar',    'freqCard',    freq,    FREQ_MIN, FREQ_MAX,  55, 'Hz');
  setMetricCard('currentBar', 'currentCard', current, 0,        16,        20, 'A');
  setMetricCard('powerBar',   'powerCard',   powerKw, 0,        MAX_POWER_KW, MAX_POWER_KW * 1.2, 'kW');

  /* Cost */
  document.getElementById('costAmount').textContent = fmtCurrency(costRp);
  document.getElementById('costKwh').textContent    = kwhToday.toFixed(2) + ' kWh';
  document.getElementById('costTariff').textContent = 'Rp ' + TARIFF_PER_KWH.toLocaleString('id-ID') + '/kWh';

  const midnight  = new Date(); midnight.setHours(0,0,0,0);
  const hoursUsed = ((Date.now() - midnight.getTime()) / 3_600_000).toFixed(1);
  document.getElementById('costHours').textContent = hoursUsed + ' jam';

  /* Fuel gauge */
  const fuelFill = document.getElementById('fuelFill');
  const fuelPct  = document.getElementById('fuelPct');
  if (fuelFill) fuelFill.style.width = clamp(fuel, 0, 100) + '%';
  if (fuelPct)  fuelPct.textContent  = fuel > 0 ? fuel.toFixed(0) + '%' : '--%';

  /* Fuel stats */
  let runtimeText;
  if (!isRunning)   runtimeText = 'Generator tidak aktif';
  else if (fuel >= 75) runtimeText = 'Lebih dari 8 jam';
  else if (fuel >= 50) runtimeText = '6–8 jam';
  else if (fuel >= 25) runtimeText = '3–6 jam';
  else if (fuel >= 10) runtimeText = 'Kurang dari 3 jam';
  else               runtimeText  = 'Kritis — segera isi BBM';

  document.getElementById('fuelRuntime').textContent  = runtimeText;
  document.getElementById('engineTemp').textContent   = temp > 0 ? temp.toFixed(0) + ' °C' : '-- °C';
  document.getElementById('oilPressure').textContent  = oil > 0  ? oil.toFixed(0)  + ' kPa' : '-- kPa';

  /* Health items */
  // PLN
  if (volt > 0 && electricOk) {
    setHealth('hPLNDot','hPLNBadge','hPLNDesc','hPLN','ok','Normal','Tegangan & frekuensi PLN stabil');
  } else if (volt > 0) {
    setHealth('hPLNDot','hPLNBadge','hPLNDesc','hPLN','warn','Tidak Stabil','Sistem sedang menstabilkan daya');
  } else {
    setHealth('hPLNDot','hPLNBadge','hPLNDesc','hPLN','err','Tidak Aktif','Tidak ada pasokan dari PLN');
  }

  // Generator
  if (!isRunning) {
    setHealth('hGenDot','hGenBadge','hGenDesc','hGen','ok','Siaga','Mesin generator siap diaktifkan otomatis');
  } else if (engineOk) {
    setHealth('hGenDot','hGenBadge','hGenDesc','hGen','ok','Berjalan Normal','Suhu & tekanan oli dalam batas aman');
  } else {
    setHealth('hGenDot','hGenBadge','hGenDesc','hGen','warn','Perlu Diperiksa','Parameter mesin di luar batas normal');
  }

  // Sync
  if (syncOk && isRunning) {
    setHealth('hSyncDot','hSyncBadge','hSyncDesc','hSync','ok','Tersinkron','Generator & PLN tersinkron dengan baik');
  } else if (isRunning) {
    setHealth('hSyncDot','hSyncBadge','hSyncDesc','hSync','warn','Menyinkronkan','Sistem sedang dalam proses sinkronisasi');
  } else {
    setHealth('hSyncDot','hSyncBadge','hSyncDesc','hSync','ok','Siaga','Sinkronisasi akan aktif saat generator menyala');
  }

  // Auto control
  if (electricOk || (!isRunning)) {
    setHealth('hAutoDot','hAutoBadge','hAutoDesc','hAuto','ok','Aktif','Sistem kendali otomatis bekerja normal');
  } else {
    setHealth('hAutoDot','hAutoBadge','hAutoDesc','hAuto','warn','Menyesuaikan','Sistem sedang mengatur ulang parameter');
  }

  /* Public message */
  let msg;
  if (source === 'OFF') {
    msg = 'Sistem tidak mendeteksi sumber listrik aktif. Jika terjadi pemadaman, generator cadangan akan menyala otomatis dalam beberapa detik.';
  } else if (source === 'GENERATOR') {
    msg = fuel < 25
      ? 'Generator cadangan sedang menyuplai listrik rumah Anda. Bahan bakar mulai menipis — tim kami sudah diberitahu untuk pengisian segera.'
      : 'Listrik PLN sedang tidak tersedia. Generator cadangan aktif menyuplai daya untuk rumah Anda secara otomatis. Anda dapat menggunakan listrik seperti biasa.';
  } else if (source === 'HYBRID') {
    msg = 'Sistem berjalan dalam mode hybrid — PLN dan generator bekerja bersama untuk memastikan kualitas listrik terbaik bagi rumah Anda.';
  } else if (!electricOk && volt > 0) {
    msg = 'Listrik PLN aktif namun kualitasnya sedang tidak stabil. Sistem sedang menyesuaikan secara otomatis. Sementara itu, hindari penggunaan alat elektronik sensitif seperti laptop atau TV.';
  } else {
    msg = 'Semua sistem berjalan normal. Listrik PLN tersedia stabil dan generator siaga jika sewaktu-waktu dibutuhkan. Anda dapat menggunakan listrik seperti biasa.';
  }
  document.getElementById('publicMessage').textContent = msg;

  /* Message border color */
  const msgBox = document.getElementById('publicMessageBox');
  if (msgBox) {
    const colors = { PLN: '#3b82f6', GENERATOR: '#f59e0b', HYBRID: '#8b5cf6', OFF: '#ef4444' };
    msgBox.style.borderLeftColor = colors[source] || '#3b82f6';
  }

  /* Tips */
  const tips = buildTips({ source, electricOk, fuel, engineOk, volt, isRunning });
  const tipsList = document.getElementById('publicTips');
  if (tipsList) {
    tipsList.innerHTML = tips.map(t =>
      `<li><i class="${t.icon}"></i><span>${t.text}</span></li>`
    ).join('');
  }

  /* Last update */
  document.getElementById('lastUpdate').innerHTML =
    `<i class="fas fa-clock"></i> Diperbarui: ${fmt(data.timestamp || new Date().toISOString())}`;

  // NEW CODE
  // EXTENSION ONLY
  renderAlerts(data.alerts || []);
  renderMaintenance(data.maintenance || {});
}

/* ── TIPS BUILDER ───────────────────────────────── */
function buildTips({ source, electricOk, fuel, engineOk, volt, isRunning }) {
  const tips = [];

  if (source === 'OFF') {
    tips.push({ icon: 'fas fa-lightbulb', text: 'Jika listrik padam cukup lama, simpan makanan di kulkas dan minimalkan membuka pintunya.' });
    tips.push({ icon: 'fas fa-mobile-screen-button', text: 'Isi daya perangkat penting (HP, laptop, senter darurat) saat masih ada listrik.' });
    return tips;
  }

  if (source === 'GENERATOR') {
    tips.push({ icon: 'fas fa-check-circle', text: 'Generator aktif — listrik tetap tersedia untuk kebutuhan rumah tangga Anda.' });
    if (fuel < 25) tips.push({ icon: 'fas fa-triangle-exclamation', text: 'Bahan bakar generator rendah. Tim operasional sedang mempersiapkan pengisian.' });
  }

  if (!electricOk && volt > 0) {
    tips.push({ icon: 'fas fa-triangle-exclamation', text: 'Hindari menyalakan TV, kulkas baru, atau peralatan sensitif sampai listrik kembali stabil.' });
  }

  if (!engineOk && isRunning) {
    tips.push({ icon: 'fas fa-wrench', text: 'Teknisi sudah dihubungi untuk memeriksa kondisi mesin generator.' });
  }

  if (tips.length === 0) {
    tips.push({ icon: 'fas fa-circle-check', text: 'Listrik berjalan normal — Anda dapat menggunakan semua peralatan rumah seperti biasa.' });
    tips.push({ icon: 'fas fa-leaf', text: 'Matikan peralatan yang tidak terpakai untuk menghemat listrik dan mengurangi tagihan.' });
    tips.push({ icon: 'fas fa-bell', text: 'Jika merasakan gangguan listrik, laporkan melalui aplikasi atau hubungi petugas setempat.' });
  }

  return tips;
}

/* ── LOAD DATA ──────────────────────────────────── */
async function loadPublicData() {
  const refreshBtn  = document.getElementById('refreshPublic');
  const refreshIcon = document.getElementById('refreshIcon');
  const liveInd     = document.getElementById('liveIndicator');

  if (refreshBtn)  refreshBtn.classList.add('spinning');

  try {
    const res  = await fetch('/api/engine-data/latest');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = json?.data || {};

    updatePublicView(data);

    if (liveInd) {
      liveInd.style.background = 'var(--ok-bg)';
      liveInd.style.color      = 'var(--ok)';
    }

  } catch (err) {
    console.error('Gen-Track fetch error:', err);

    document.getElementById('powerSourceName').textContent = 'Data Tidak Tersedia';
    document.getElementById('publicMessage').textContent   =
      'Koneksi ke sistem monitoring sedang bermasalah. Data mungkin tidak terkini. Coba perbarui halaman.';

    const tipsList = document.getElementById('publicTips');
    if (tipsList) {
      tipsList.innerHTML = `
        <li><i class="fas fa-wifi"></i><span>Pastikan koneksi internet Anda aktif.</span></li>
        <li><i class="fas fa-rotate"></i><span>Coba tekan tombol Perbarui di pojok kanan atas.</span></li>
        <li><i class="fas fa-headset"></i><span>Jika masalah berlanjut, hubungi petugas teknis setempat.</span></li>
      `;
    }

    if (liveInd) {
      liveInd.style.background = 'var(--err-bg)';
      liveInd.style.color      = 'var(--err)';
    }
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

/* ── NAV: ACTIVE LINK ON SCROLL ─────────────────── */
function initScrollSpy() {
  const sections = ['heroSection','metricsSection','costSection','healthSection','infoSection'];
  const navLinks  = document.querySelectorAll('.nav-link');

  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        navLinks.forEach(a => {
          a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
        });
      }
    });
  }, { threshold: 0.4 });

  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) obs.observe(el);
  });
}

/* ── SIDEBAR TOGGLE ────────────────────────────── */
function initSidebar() {
  const menuBtn  = document.getElementById('menuBtn');
  const overlay  = document.getElementById('sidebarOverlay');

  function close() { document.body.classList.remove('sidebar-open'); }
  function open()  { document.body.classList.add('sidebar-open'); }

  if (menuBtn)  menuBtn.addEventListener('click', open);
  if (overlay)  overlay.addEventListener('click', close);

  document.querySelectorAll('.nav-link').forEach(a => a.addEventListener('click', close));
}

/* ── LOGOUT ─────────────────────────────────────── */
document.getElementById('logoutPublic')?.addEventListener('click', () => {
  localStorage.removeItem('isLoggedIn');
  localStorage.removeItem('userRole');
  localStorage.removeItem('username');
  window.location.replace('login.html');
});

/* ── REFRESH BUTTON ─────────────────────────────── */
document.getElementById('refreshPublic')?.addEventListener('click', loadPublicData);

/* ── INIT ───────────────────────────────────────── */
initSidebar();
initScrollSpy();
loadPublicData();
setInterval(loadPublicData, 10_000);
