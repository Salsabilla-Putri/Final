/**
 * Gen-Track Public Dashboard — public-view.js
 * Non-technical, consumer-friendly generator monitoring
 * Tries live API first, gracefully falls back to demo data
 */

'use strict';

/* ============================================================
   CONFIGURATION
   ============================================================ */
const API = {
  sensors:     '/api/sensors/latest',
  alerts:      '/api/alerts?limit=20',
  maintenance: '/api/maintenance',
  readings:    '/api/readings?hours=168'
};

const REFRESH_INTERVAL = 10_000;

/* ============================================================
   DEMO DATA FALLBACK
   (used when backend is unreachable)
   ============================================================ */
const DEMO = {
  useDemoMode: false,

  sensor() {
    const usePLN = Math.random() > 0.25;
    return {
      source: usePLN ? 'pln' : 'generator',
      genHealthRaw: 'normal',
      fuelPercent: 68,
      voltageV: 220.4,
      frequencyHz: 50.0,
      loadPercent: 72,
      runtime_today_h: 14.2,
      temp_coolant: 82
    };
  },

  alerts() {
    return [
      { _id: 'a1', type: 'info', message: 'Generator berhasil aktif dan menyuplai listrik', action: 'Tidak perlu tindakan', icon: 'fa-circle-info', timestamp: new Date(Date.now() - 15 * 60_000) },
      { _id: 'a2', type: 'warning', message: 'Bahan bakar mulai berkurang, pertimbangkan pengisian segera', action: 'Hubungi petugas untuk isi BBM', icon: 'fa-triangle-exclamation', timestamp: new Date(Date.now() - 2 * 3600_000) },
      { _id: 'a3', type: 'info', message: 'Perpindahan ke listrik PLN berhasil dilakukan', action: 'Tidak perlu tindakan', icon: 'fa-circle-info', timestamp: new Date(Date.now() - 5 * 3600_000) },
      { _id: 'a4', type: 'info', message: 'Sistem berjalan normal, semua parameter dalam batas aman', action: 'Tidak perlu tindakan', icon: 'fa-circle-check', timestamp: new Date(Date.now() - 24 * 3600_000) }
    ];
  },

  maintenance() {
    return [
      { _id: 'm1', task: 'Ganti oli mesin & filter', type: 'preventive', status: 'completed', completedAt: new Date(Date.now() - 30 * 86400_000), assignedTo: 'Stewart' },
      { _id: 'm2', task: 'Periksa sabuk alternator', type: 'inspection', status: 'completed', completedAt: new Date(Date.now() - 14 * 86400_000), assignedTo: 'Rifananda' },
      { _id: 'm3', task: 'Servis rutin 250 jam', type: 'preventive', status: 'scheduled', dueDate: new Date(Date.now() + 18 * 86400_000), assignedTo: 'Salsabilla' }
    ];
  },

  weeklyKwh() {
    return [14.2, 12.8, 16.1, 11.5, 17.4, 15.0, 14.2];
  }
};

/* ============================================================
   STATE
   ============================================================ */
let state = {
  source: null,
  fuelPercent: null,
  genHealth: null,
  alerts: [],
  maintenance: [],
  showAllAlerts: false,
  weeklyKwh: [],
  todayKwh: 0
};

/* ============================================================
   HELPERS
   ============================================================ */
function fmtTime(date) {
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(date) {
  return date.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateShort(date) {
  return new Date(date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeAgo(date) {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'Baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

function idrFormat(num) {
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function daysFromNow(date) {
  const diff = (new Date(date).getTime() - Date.now()) / 86400_000;
  return Math.ceil(diff);
}

/* ============================================================
   SIDEBAR & MOBILE MENU
   ============================================================ */
function initSidebar() {
  const hamburger = document.getElementById('hamburger');
  const overlay   = document.getElementById('overlay');
  const sidebar   = document.getElementById('sidebar');

  hamburger?.addEventListener('click', () => {
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('active');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('active');
  });

  // Smooth scroll + active highlighting for nav links
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(link.dataset.section);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('active');
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Update active link on scroll
  const sections = ['status', 'usage', 'alerts', 'maintenance'];
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        document.querySelectorAll('.nav-link').forEach(l => {
          l.classList.toggle('active', l.dataset.section === id);
        });
      }
    });
  }, { threshold: 0.35 });

  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
}

/* ============================================================
   LIVE CLOCK
   ============================================================ */
function startClock() {
  function tick() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const clockEl = document.getElementById('heroClock');
    if (clockEl) clockEl.textContent = `${h}:${m}:${s}`;
    const dateEl = document.getElementById('heroDate');
    if (dateEl) dateEl.textContent = fmtDate(now);
  }
  tick();
  setInterval(tick, 1000);
}

/* ============================================================
   API FETCH WITH DEMO FALLBACK
   ============================================================ */
async function apiFetch(url, demoData) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success) return json.data;
    throw new Error('API error');
  } catch {
    DEMO.useDemoMode = true;
    return typeof demoData === 'function' ? demoData() : demoData;
  }
}

/* ============================================================
   SENSOR / POWER SOURCE
   ============================================================ */
async function refreshSensor() {
  const data = await apiFetch(API.sensors, DEMO.sensor);

  const source = data.source || (data.voltageV > 100 ? 'pln' : 'generator');
  state.source = source;
  state.fuelPercent = data.fuelPercent ?? 68;
  state.genHealth = data.genHealthRaw ?? 'normal';

  renderHero(source, data);
  renderPowerCard(source, data);
  renderGenCard(data);
  renderFuelCard(data.fuelPercent ?? 68);
  renderUsage(data);

  const lastUpdateEl = document.getElementById('lastUpdate');
  if (lastUpdateEl) {
    lastUpdateEl.textContent = `Diperbarui: ${fmtTime(new Date())}`;
  }
}

function renderHero(source, data) {
  const banner = document.getElementById('heroBanner');
  const heroVal = document.getElementById('heroValue');
  const heroDesc = document.getElementById('heroDesc');
  const heroIcon = document.getElementById('heroIconInner');

  if (source === 'pln') {
    banner.className = 'hero-banner state-pln';
    heroVal.textContent = 'Menggunakan Listrik PLN';
    heroDesc.textContent = 'Listrik dari PLN aktif dan stabil. Generator dalam mode standby.';
    heroIcon.className = 'fas fa-city';
  } else if (source === 'generator') {
    banner.className = 'hero-banner state-gen';
    heroVal.textContent = 'Menggunakan Generator';
    heroDesc.textContent = 'Generator sedang aktif menyuplai listrik. PLN sedang tidak tersedia.';
    heroIcon.className = 'fas fa-engine';
  } else if (source === 'switching') {
    banner.className = 'hero-banner state-switching';
    heroVal.textContent = 'Sedang Perpindahan Sumber';
    heroDesc.textContent = 'Sistem sedang berpindah sumber listrik, mungkin ada kedip sebentar.';
    heroIcon.className = 'fas fa-shuffle';
  } else {
    banner.className = 'hero-banner state-error';
    heroVal.textContent = 'Cek Sistem';
    heroDesc.textContent = 'Tidak dapat membaca status sumber listrik.';
    heroIcon.className = 'fas fa-triangle-exclamation';
  }
}

function renderPowerCard(source, data) {
  const el = document.getElementById('powerSource');
  const hint = document.getElementById('powerHint');
  const dot = document.getElementById('powerDot');

  const map = {
    pln:        { label: 'Listrik PLN',       hint: 'Sumber utama aktif & stabil', dot: 'dot-green' },
    generator:  { label: 'Generator',          hint: 'Generator aktif menyuplai listrik', dot: 'dot-amber' },
    switching:  { label: 'Berpindah...',       hint: 'Proses perpindahan sumber berlangsung', dot: 'dot-blue' },
    default:    { label: 'Tidak Diketahui',    hint: 'Cek koneksi sistem', dot: '' }
  };
  const s = map[source] || map.default;
  el.textContent = s.label;
  hint.textContent = s.hint;
  dot.className = 'card-status-dot ' + s.dot;
}

function renderGenCard(data) {
  const health = data.genHealthRaw ?? 'normal';
  const tempC = data.temp_coolant;
  const el = document.getElementById('genCondition');
  const hint = document.getElementById('genHint');
  const dot = document.getElementById('genDot');

  let label, hintText, dotClass;

  if (health === 'normal' || health === 'ok') {
    label = state.source === 'generator' ? 'Sedang Berjalan' : 'Siap Digunakan';
    hintText = state.source === 'generator' ? 'Generator aktif, semua sistem normal' : 'Generator standby dalam kondisi baik';
    dotClass = 'dot-green';
  } else if (health === 'warning' || health === 'overheat') {
    label = 'Perlu Perhatian';
    hintText = 'Ada kondisi yang perlu diperiksa teknisi';
    dotClass = 'dot-amber';
  } else if (health === 'critical' || health === 'fault') {
    label = 'Butuh Servis';
    hintText = 'Segera hubungi teknisi';
    dotClass = 'dot-red';
  } else {
    label = 'Standby';
    hintText = 'Status sedang dikonfirmasi';
    dotClass = 'dot-blue';
  }

  if (tempC) {
    hintText += ` · Suhu: ${Math.round(tempC)}°C`;
  }

  el.textContent = label;
  hint.textContent = hintText;
  dot.className = 'card-status-dot ' + dotClass;
}

function renderFuelCard(pct) {
  const el = document.getElementById('fuelStatus');
  const dot = document.getElementById('fuelDot');
  const segs = document.querySelectorAll('.fuel-seg');

  let label, dotClass, fillClass;
  const filled = Math.round((pct / 100) * 5);

  if (pct >= 60) {
    label = 'Cukup';
    dotClass = 'dot-green';
    fillClass = 'filled-full';
  } else if (pct >= 25) {
    label = 'Perlu Diisi Segera';
    dotClass = 'dot-amber';
    fillClass = 'filled-medium';
  } else {
    label = 'Hampir Habis!';
    dotClass = 'dot-red';
    fillClass = 'filled-low';
  }

  // Full = force label to "Penuh"
  if (pct >= 90) label = 'Penuh';

  el.textContent = `${label} (${Math.round(pct)}%)`;
  dot.className = 'card-status-dot ' + dotClass;

  segs.forEach((seg, i) => {
    seg.className = 'fuel-seg ' + (i < filled ? fillClass : '');
  });
}

/* ============================================================
   USAGE & COST
   ============================================================ */
async function refreshUsage() {
  const data = await apiFetch(API.readings, () => ({
    todayKwh: 14.2,
    weeklyKwh: DEMO.weeklyKwh()
  }));

  const todayKwh = data.todayKwh ?? data.today_kwh ?? 14.2;
  const weeklyKwh = data.weeklyKwh ?? DEMO.weeklyKwh();
  state.todayKwh = todayKwh;
  state.weeklyKwh = weeklyKwh;

  renderUsageCard(todayKwh);
  renderCostCard(todayKwh);
  renderWeeklyChart(weeklyKwh);
}

function renderUsage(sensorData) {
  // called from sensor refresh when runtime data is present
  if (sensorData.runtime_today_h) {
    const kwh = sensorData.runtime_today_h * (sensorData.loadPercent / 100) * 8;
    renderUsageCard(kwh);
    renderCostCard(kwh);
  }
}

function renderUsageCard(kwh) {
  const maxKwh = 50;
  const pct = Math.min(100, (kwh / maxKwh) * 100);
  document.getElementById('dailyUsage').textContent = `${kwh.toFixed(1)} kWh`;
  document.getElementById('usageBarFill').style.width = `${pct}%`;
  document.getElementById('usageBarMax').textContent = `${maxKwh} kWh`;

  let note = '';
  if (kwh < 10)  note = 'Penggunaan sangat rendah hari ini, sangat hemat!';
  else if (kwh < 25) note = 'Penggunaan normal, efisiensi bagus.';
  else if (kwh < 40) note = 'Penggunaan agak tinggi hari ini.';
  else note = 'Penggunaan tinggi hari ini. Pertimbangkan hemat energi.';
  document.getElementById('usageNote').textContent = note;
}

function renderCostCard(kwh) {
  // PLN tarif ~Rp 1.444/kWh (nonsubsidi R1/1300VA), generator ~Rp 2.200/kWh (BBM)
  const tariffPLN = 1444;
  const tariffGen = 2200;

  const plnKwh = state.source === 'generator' ? kwh * 0.2 : kwh * 0.85;
  const genKwh = kwh - plnKwh;
  const totalCost = (plnKwh * tariffPLN) + (genKwh * tariffGen);
  const plnCost   = plnKwh * tariffPLN;
  const genCost   = genKwh * tariffGen;

  document.getElementById('estimatedCost').textContent = idrFormat(totalCost);
  document.getElementById('plnCost').textContent = idrFormat(plnCost);
  document.getElementById('genCost').textContent = idrFormat(genCost);
}

/* ============================================================
   WEEKLY CHART
   ============================================================ */
const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

function renderWeeklyChart(kwhArr) {
  const container = document.getElementById('weeklyBars');
  if (!container) return;

  const days = kwhArr.slice(-7);
  const maxVal = Math.max(...days, 1);
  const today = new Date().getDay();
  const totalKwh = days.reduce((a, b) => a + b, 0);

  document.getElementById('weeklyUsage').textContent = `${totalKwh.toFixed(1)} kWh`;

  container.innerHTML = '';
  days.forEach((val, i) => {
    const dayOffset = (today - (days.length - 1 - i) + 7) % 7;
    const dayName = DAYS_ID[dayOffset] ?? '?';
    const isToday = i === days.length - 1;
    const heightPct = (val / maxVal) * 100;

    const group = document.createElement('div');
    group.className = 'week-bar-group';
    group.innerHTML = `
      <div class="week-bar-track">
        <div class="week-bar-fill ${isToday ? 'today' : ''}" style="height:${heightPct}%" title="${val.toFixed(1)} kWh"></div>
      </div>
      <div class="week-bar-day ${isToday ? 'today' : ''}">${isToday ? 'Hari ini' : dayName}</div>
    `;
    container.appendChild(group);
  });
}

/* ============================================================
   ALERTS
   ============================================================ */
const ALERT_VISIBLE_DEFAULT = 3;

async function refreshAlerts() {
  const raw = await apiFetch(API.alerts, DEMO.alerts);
  // Map technical alarm data to human-friendly messages
  const mapped = raw.map(mapAlertToFriendly);
  state.alerts = mapped;

  // Update sidebar badge
  const active = mapped.filter(a => !a.resolved).length;
  const badge = document.getElementById('alertBadge');
  if (badge) {
    badge.textContent = active;
    badge.style.display = active > 0 ? '' : 'none';
  }

  renderAlerts();
}

function mapAlertToFriendly(alarm) {
  // If it's already a friendly alert (from demo), return as-is
  if (alarm.message && (alarm.type === 'info' || alarm.type === 'warning' || alarm.type === 'critical')) {
    return alarm;
  }

  // Map technical parameters to friendly messages
  const param = (alarm.parameter || '').toLowerCase();
  const severity = alarm.severity || 'low';
  let type, message, action, icon;

  if (severity === 'critical') {
    type = 'critical';
    icon = 'fa-circle-xmark';
    action = 'Hubungi teknisi segera';
  } else if (severity === 'medium' || severity === 'warning') {
    type = 'warning';
    icon = 'fa-triangle-exclamation';
    action = 'Pantau kondisi ini';
  } else {
    type = 'info';
    icon = 'fa-circle-info';
    action = 'Tidak perlu tindakan segera';
  }

  // Friendly message mapping
  if (param.includes('fuel') || param.includes('bbm')) {
    message = severity === 'critical'
      ? 'Bahan bakar hampir habis, segera isi!'
      : 'Bahan bakar mulai berkurang';
    action = 'Hubungi petugas untuk pengisian BBM';
    icon = 'fa-gas-pump';
  } else if (param.includes('temp') || param.includes('suhu')) {
    message = severity === 'critical'
      ? 'Suhu generator terlalu tinggi, perlu pendinginan segera'
      : 'Suhu generator agak tinggi';
    action = severity === 'critical' ? 'Hubungi teknisi segera' : 'Pastikan ventilasi ruang generator baik';
    icon = 'fa-temperature-high';
  } else if (param.includes('voltage') || param.includes('tegangan')) {
    message = 'Tegangan listrik tidak stabil terdeteksi';
    action = 'Kurangi beban peralatan elektronik sensitif';
    icon = 'fa-bolt';
  } else if (param.includes('oil') || param.includes('oli')) {
    message = 'Tekanan oli rendah terdeteksi';
    action = 'Hubungi teknisi untuk pemeriksaan oli';
    icon = 'fa-droplet';
    type = 'critical';
  } else if (param.includes('battery') || param.includes('baterai') || param.includes('aki')) {
    message = 'Daya aki starter lemah';
    action = 'Hubungi teknisi untuk pengecekan aki';
    icon = 'fa-car-battery';
  } else if (param.includes('overload') || param.includes('beban')) {
    message = 'Beban listrik melebihi kapasitas normal';
    action = 'Matikan beberapa peralatan yang tidak digunakan';
    icon = 'fa-plug-circle-exclamation';
  } else {
    message = severity === 'critical'
      ? 'Sistem membutuhkan perhatian segera'
      : type === 'warning'
        ? 'Ada kondisi yang perlu dipantau'
        : 'Generator berhasil aktif';
    icon = type === 'info' ? 'fa-circle-check' : icon;
  }

  return {
    _id: alarm._id,
    type,
    message,
    action,
    icon,
    timestamp: alarm.timestamp || new Date(),
    resolved: alarm.resolved || false
  };
}

function renderAlerts() {
  const list = document.getElementById('alertsList');
  const noAlerts = document.getElementById('noAlerts');
  if (!list) return;

  list.innerHTML = '';

  if (state.alerts.length === 0) {
    list.classList.add('hidden');
    noAlerts.classList.remove('hidden');
    return;
  }

  noAlerts.classList.add('hidden');
  list.classList.remove('hidden');

  state.alerts.forEach((alert, i) => {
    const isHidden = !state.showAllAlerts && i >= ALERT_VISIBLE_DEFAULT;
    const card = document.createElement('div');
    card.className = `alert-card type-${alert.type}${isHidden ? ' hidden' : ''}`;
    card.dataset.id = alert._id;

    card.innerHTML = `
      <div class="alert-icon type-${alert.type}">
        <i class="fas ${alert.icon || 'fa-bell'}"></i>
      </div>
      <div class="alert-body">
        <div class="alert-message">${alert.message}</div>
        <span class="alert-action type-${alert.type}">
          <i class="fas fa-arrow-right"></i> ${alert.action}
        </span>
        <div class="alert-meta">${timeAgo(alert.timestamp)}</div>
      </div>
      <div class="alert-card-right">
        <span class="alert-type-label">${alert.type === 'info' ? 'Info' : alert.type === 'warning' ? 'Perhatian' : 'Kritis'}</span>
      </div>
    `;
    list.appendChild(card);
  });

  // Show/hide "see all" button
  const seeAllBtn = document.getElementById('seeAllBtn');
  if (seeAllBtn) {
    seeAllBtn.style.display = state.alerts.length > ALERT_VISIBLE_DEFAULT ? '' : 'none';
    seeAllBtn.querySelector('i').className = state.showAllAlerts ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
    seeAllBtn.innerHTML = `${state.showAllAlerts ? 'Sembunyikan' : 'Tampilkan semua ('+state.alerts.length+')'} <i class="fas ${state.showAllAlerts ? 'fa-chevron-up' : 'fa-chevron-down'}" id="seeAllIcon"></i>`;
    seeAllBtn.onclick = toggleAllAlerts;
  }
}

window.toggleAllAlerts = function() {
  state.showAllAlerts = !state.showAllAlerts;
  renderAlerts();
};

/* ============================================================
   MAINTENANCE
   ============================================================ */
async function refreshMaintenance() {
  const data = await apiFetch(API.maintenance, DEMO.maintenance);
  state.maintenance = data;
  renderMaintenance(data);
}

function renderMaintenance(tasks) {
  const completed = tasks.filter(t => t.status === 'completed').sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const upcoming  = tasks.filter(t => t.status !== 'completed').sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const overdue   = upcoming.filter(t => new Date(t.dueDate) < new Date());

  // Status card
  const statusCard = document.getElementById('maintStatusCard');
  const statusIcon = document.getElementById('maintStatusIcon');
  const statusVal  = document.getElementById('maintStatusValue');
  const statusDesc = document.getElementById('maintStatusDesc');

  if (overdue.length > 0) {
    statusCard.classList.add('status-critical');
    statusIcon.innerHTML = '<i class="fas fa-circle-exclamation"></i>';
    statusVal.textContent  = 'Servis Direkomendasikan';
    statusDesc.textContent = `${overdue.length} jadwal perawatan telah lewat`;
  } else if (upcoming.length > 0) {
    const next = upcoming[0];
    const days = daysFromNow(next.dueDate);
    if (days <= 7) {
      statusCard.classList.add('status-warn');
      statusIcon.innerHTML = '<i class="fas fa-clock"></i>';
      statusVal.textContent  = 'Perawatan Segera';
      statusDesc.textContent = `Jadwal servis dalam ${days} hari`;
    } else {
      statusIcon.innerHTML = '<i class="fas fa-circle-check"></i>';
      statusVal.textContent  = 'Kondisi Baik';
      statusDesc.textContent = 'Generator terawat dengan baik';
    }
  } else {
    statusIcon.innerHTML = '<i class="fas fa-circle-check"></i>';
    statusVal.textContent  = 'Kondisi Baik';
    statusDesc.textContent = 'Semua perawatan terjadwal dengan baik';
  }

  // Last maintenance
  const lastEl = document.getElementById('lastMaint');
  if (lastEl) {
    lastEl.textContent = completed.length > 0
      ? fmtDateShort(completed[0].completedAt) + ` · ${completed[0].task}`
      : 'Belum ada data';
  }

  // Next maintenance
  const nextEl = document.getElementById('nextMaint');
  const nextCd = document.getElementById('nextMaintCountdown');
  if (nextEl) {
    if (upcoming.length > 0) {
      const next = upcoming[0];
      const days = daysFromNow(next.dueDate);
      nextEl.textContent = fmtDateShort(next.dueDate) + ` · ${next.task}`;
      if (nextCd) {
        if (days < 0) {
          nextCd.textContent = `Sudah lewat ${Math.abs(days)} hari`;
          nextCd.className = 'maint-date-countdown countdown-soon';
        } else if (days <= 7) {
          nextCd.textContent = `${days} hari lagi`;
          nextCd.className = 'maint-date-countdown countdown-soon';
        } else {
          nextCd.textContent = `${days} hari lagi`;
          nextCd.className = 'maint-date-countdown countdown-ok';
        }
      }
    } else {
      nextEl.textContent = 'Belum terjadwal';
    }
  }

  // History list
  const histList = document.getElementById('maintHistory');
  if (histList) {
    histList.innerHTML = '';
    const histItems = completed.slice(0, 4);
    if (histItems.length === 0) {
      histList.innerHTML = '<p style="font-size:13px;color:var(--muted)">Belum ada riwayat perawatan</p>';
    } else {
      histItems.forEach(t => {
        histList.innerHTML += `
          <div class="maint-history-item">
            <div class="maint-hist-dot"></div>
            <div class="maint-hist-text">${t.task}</div>
            <div class="maint-hist-date">${fmtDateShort(t.completedAt)}</div>
          </div>
        `;
      });
    }
  }
}

/* ============================================================
   SERVICE REQUEST MODAL
   ============================================================ */
window.requestService = function() {
  document.getElementById('serviceModal').classList.remove('hidden');
};

window.closeServiceModal = function() {
  document.getElementById('serviceModal').classList.add('hidden');
};

window.submitServiceRequest = async function() {
  const name  = document.getElementById('svcName').value.trim();
  const phone = document.getElementById('svcPhone').value.trim();
  const note  = document.getElementById('svcNote').value.trim();

  if (!name || !phone) {
    showToast('Mohon isi nama dan nomor telepon Anda');
    return;
  }

  // In production this would POST to an API endpoint
  const payload = { name, phone, note, timestamp: new Date(), type: 'service_request' };
  console.log('Service request:', payload);

  closeServiceModal();
  showToast('✓ Permintaan servis berhasil dikirim. Tim kami akan menghubungi Anda segera.');

  document.getElementById('svcName').value = '';
  document.getElementById('svcPhone').value = '';
  document.getElementById('svcNote').value = '';
};

/* ============================================================
   TOAST
   ============================================================ */
function showToast(msg, duration = 4000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

/* ============================================================
   CLOSE MODAL ON OUTSIDE CLICK
   ============================================================ */
function initModalClose() {
  document.getElementById('serviceModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeServiceModal();
  });
}

/* ============================================================
   MAIN INIT & REFRESH LOOP
   ============================================================ */
async function refreshAll() {
  await Promise.allSettled([
    refreshSensor(),
    refreshAlerts(),
    refreshMaintenance(),
    refreshUsage()
  ]);
}

document.addEventListener('DOMContentLoaded', () => {
  initSidebar();
  startClock();
  initModalClose();

  // Check auth (public users still need to be logged in as 'Masyarakat')
  const role = localStorage.getItem('userRole');
  if (role && role !== 'Masyarakat' && role !== 'Administrator' && role !== 'Operator') {
    // Redirect to login if not authenticated at all
    if (!localStorage.getItem('isLoggedIn')) {
      window.location.href = 'login.html';
      return;
    }
  }

  // Initial load
  refreshAll();

  // Auto-refresh every 10 seconds
  setInterval(refreshAll, REFRESH_INTERVAL);
});