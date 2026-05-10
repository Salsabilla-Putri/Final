'use strict';

// ── Chart instances ──────────────────────────────────────────────────────────
let activeChart  = null;
let systemChart  = null;

// ── Live clock ───────────────────────────────────────────────────────────────
function updateClock() {
    const el = document.getElementById('liveClock');
    if (!el) return;
    el.innerText = new Date().toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit'
    }) + ' WIB';
}

// ── Username from localStorage ───────────────────────────────────────────────
function updateUserInfo() {
    const username = localStorage.getItem('username') || 'Pengguna';
    const topbarSpan = document.querySelector('#user-btn span');
    const heroSpan   = document.getElementById('welcome-user');
    if (topbarSpan) topbarSpan.innerText = username;
    if (heroSpan)   heroSpan.innerText   = username;
}

// ── Logout ───────────────────────────────────────────────────────────────────
function logout() {
    ['isLoggedIn','userRole','hasLoginSession','username'].forEach(k => localStorage.removeItem(k));
    sessionStorage.removeItem('loginFlowOk');
    window.location.href = 'login.html';
}

// ── Connection status badge ──────────────────────────────────────────────────
function setConnectionStatus(online) {
    const badge = document.getElementById('connStatus');
    if (!badge) return;
    badge.className = 'conn-badge ' + (online ? 'conn-online' : 'conn-offline');
    badge.innerHTML = online
        ? '<i class="fas fa-circle"></i> Live'
        : '<i class="fas fa-circle"></i> Offline';
}

// ── Last updated timestamp ───────────────────────────────────────────────────
function setLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (el) el.innerText = 'Diperbarui: ' + new Date().toLocaleTimeString('id-ID');
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN FETCH ORCHESTRATOR
// ════════════════════════════════════════════════════════════════════════════
async function fetchDashboardData() {
    try {
        // Fetch semua data, limit history ditambah ke 100 agar cukup untuk kalkulasi 7 hari
        const [engineRes, alertsRes, specsRes, historyRes, maintenanceRes, dashRes, cbmRes] = await Promise.allSettled([
            fetch('/api/engine-data/latest'),
            fetch('/api/alerts?limit=10'),
            fetch('/api/generator-specs'),
            fetch('/api/generator-active-time/history?limit=100'), 
            fetch('/api/maintenance'),
            fetch('/api/public/dashboard'),
            fetch('/api/cbm/analysis?hours=24') // Fetch data CBM untuk Health Score
        ]);

        const engineData = engineRes.status === 'fulfilled' ? await engineRes.value.json().catch(() => null) : null;
        const cbmData = cbmRes.status === 'fulfilled' ? await cbmRes.value.json().catch(() => null) : null;

        if (engineData?.success && engineData.data) {
            updateOverviewCards(engineData.data);
            updateOperationsSection(engineData.data, cbmData?.data);
        }

        const alertsData = alertsRes.status === 'fulfilled' ? await alertsRes.value.json().catch(() => null) : null;
        if (alertsData?.success) {
            const active = alertsData.data.filter(a => !a.resolved).length;
            const badge  = document.getElementById('val-alerts');
            if (badge) badge.innerText = active;
            renderAlertList(alertsData.data);
        }

        const specsData = specsRes.status === 'fulfilled' ? await specsRes.value.json().catch(() => null) : null;
        if (specsData?.success) updateSpecificationsSection(specsData.data);

        const historyData = historyRes.status === 'fulfilled' ? await historyRes.value.json().catch(() => null) : null;
        const maintenanceData = maintenanceRes.status === 'fulfilled' ? await maintenanceRes.value.json().catch(() => null) : null;

        if (historyData?.success) {
            // Gabungkan riwayat sesi DB dengan maintenance yang Completed
            renderRecentActivity(historyData.data, maintenanceData?.success ? maintenanceData.data : []);
            // Render chart berdasarkan data history aktual
            updateActiveTimeChart(historyData.data);
        }

        if (maintenanceData?.success) updateMaintenanceSection(maintenanceData.data);

        const dashData = dashRes.status === 'fulfilled' ? await dashRes.value.json().catch(() => null) : null;
        if (dashData?.success && dashData.data) updatePerformanceSection(dashData.data);

        setConnectionStatus(true);
        setLastUpdated();

    } catch (err) {
        console.error('fetchDashboardData error:', err);
        setConnectionStatus(false);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW CARDS
// ════════════════════════════════════════════════════════════════════════════
function updateOverviewCards(data) {
    const rpm  = data.rpm   || 0;
    const temp = data.coolant || data.temp || 0;
    const volt = data.volt  || 0;

    const rpmEl  = document.getElementById('val-rpm');
    const tmpEl  = document.getElementById('val-temp');
    const vltEl  = document.getElementById('val-volt');

    if (rpmEl) rpmEl.innerText  = rpm + ' RPM';
    if (tmpEl) tmpEl.innerText  = temp + ' °C';
    if (vltEl) vltEl.innerText  = volt + ' V';
}

// ════════════════════════════════════════════════════════════════════════════
//  OPERATIONS SECTION (Engine Status + Health)
// ════════════════════════════════════════════════════════════════════════════
function updateOperationsSection(data, cbmData) {
    // Sync
    const syncEl = document.getElementById('engSync');
    if (syncEl) {
        syncEl.innerText  = data.sync || '--';
        syncEl.className  = data.sync === 'ON-GRID' ? 'st-ok' : 'st-warn';
    }

    // Status
    const statEl = document.getElementById('engStat');
    if (statEl) {
        statEl.innerText = data.status || '--';
        const running = ['RUNNING','ON-GRID'].includes((data.status || '').toUpperCase());
        const stopped = (data.status || '').toUpperCase() === 'STOPPED';
        statEl.className = running ? 'st-ok' : stopped ? 'st-err' : 'st-warn';
    }

    // Fuel
    const fuelEl = document.getElementById('fuelLevel');
    if (fuelEl) {
        const f = data.fuel || 0;
        fuelEl.innerText  = f + '%';
        fuelEl.className  = f > 30 ? 'st-ok' : f > 15 ? 'st-warn' : 'st-err';
    }

    const applyHealth = (id, value, min, max) => {
        const el = document.getElementById(id);
        if (!el) return;
        const state = healthStatus(value, min, max);
        el.innerText = state.text;
        el.className = state.cls;
    };
    applyHealth('st-volt', data.volt, 200, 240);
    applyHealth('st-amp',  data.amp, 0,   100);
    applyHealth('st-freq', data.freq,48,  52);
    applyHealth('st-fuel', data.fuel,20,  100);
    applyHealth('st-afr',  data.afr, 10,  18);

    renderHealthScore(data, cbmData);
}

function healthStatus(value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v)) return { text: '--', cls: 'st-err' };
    if (v >= min && v <= max) return { text: 'Normal', cls: 'st-ok' };
    return { text: v < min ? 'Low' : 'High', cls: 'st-err' };
}

function calculateHealth(data) {
    let health = 100;
    const temp = data.coolant || data.temp || 0;
    const fuel = data.fuel  || 0;
    const volt = data.volt  || 0;
    if (temp > 95)                          health -= 30;
    else if (temp > 85)                     health -= 15;
    if (fuel < 20)                          health -= 20;
    if (volt > 0 && (volt < 190 || volt > 250)) health -= 15;
    return Math.max(0, Math.min(100, health));
}

function renderHealthScore(engineData, cbmData) {
    const container = document.getElementById('systemHealthContainer');
    if (!container) return;

    let health = 100;
    const warnings = [];

    // Prioritaskan skor dari sistem analitik CBM
    if (cbmData && typeof cbmData.overallHealth !== 'undefined') {
        health = Math.round(cbmData.overallHealth);
        if (cbmData.components) {
            Object.values(cbmData.components).forEach(comp => {
                if (comp.status === 'critical') warnings.push({ label: `Kritis: ${comp.name || 'Sistem'}`, cls: 'danger' });
                else if (comp.status === 'warning') warnings.push({ label: `Perhatian: ${comp.name || 'Sistem'}`, cls: 'warn' });
            });
        }
    } else {
        // Fallback
        health = calculateHealth(engineData);
        const temp = engineData.coolant || engineData.temp || 0;
        if (temp > 95) warnings.push({ label: 'Suhu Kritis', cls: 'danger' });
        else if (temp > 85) warnings.push({ label: 'Suhu Tinggi', cls: 'warn' });
        if ((engineData.fuel || 0) < 20) warnings.push({ label: 'BBM Hampir Habis', cls: 'warn' });
        if (engineData.volt > 0 && (engineData.volt < 190 || engineData.volt > 250)) warnings.push({ label: 'Tegangan Tidak Normal', cls: 'danger' });
    }

    const color  = health > 80 ? '#10b981' : health > 50 ? '#f59e0b' : '#ef4444';
    const pillsHTML = warnings.length
        ? warnings.map(w => `<span class="status-pill ${w.cls}">${w.label}</span>`).join('')
        : `<span class="status-pill ok"><i class="fas fa-check"></i> Kondisi Mesin Ideal</span>`;

    container.innerHTML = `
        <div class="health-ring" style="--hc:${color};">
            <div class="health-ring-value" style="color:${color};">${health}%</div>
            <div class="health-ring-label">Health Score</div>
        </div>
        <div class="health-warning-wrap">${pillsHTML}</div>
    `;
}

// ════════════════════════════════════════════════════════════════════════════
//  RECENT ALERTS
// ════════════════════════════════════════════════════════════════════════════
function renderAlertList(alerts) {
    const container = document.getElementById('alertContainer');
    if (!container) return;

    if (!alerts || alerts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-check-circle" style="color:#10b981; font-size:2rem;"></i>
                <p>Tidak ada alert aktif</p>
            </div>`;
        return;
    }

    container.innerHTML = alerts.slice(0, 5).map(alert => {
        const sev = alert.severity || 'info';
        let cls = 'ac-info', icon = 'fa-info-circle';
        if (['critical','high'].includes(sev)) { cls = 'ac-critical'; icon = 'fa-exclamation-circle'; }
        else if (sev === 'medium')             { cls = 'ac-warning';  icon = 'fa-exclamation-triangle'; }

        const dateStr = new Date(alert.timestamp).toLocaleString('id-ID', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });
        const resolvedBadge = alert.resolved
            ? `<span class="badge-resolved">Resolved</span>` : '';

        return `
        <div class="alert-card ${cls}">
            <div class="ac-icon"><i class="fas ${icon}"></i></div>
            <div class="ac-content">
                <div class="ac-title">${(alert.parameter || 'ALERT').toUpperCase()} ${resolvedBadge}</div>
                <div class="ac-desc">${alert.message || '--'}</div>
            </div>
            <div class="ac-date">${dateStr}</div>
        </div>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  RECENT ACTIVITY (Sesi Aktif + Maintenance Selesai)
// ════════════════════════════════════════════════════════════════════════════
function renderRecentActivity(activities, maintenanceList) {
    const container = document.getElementById('recentActivityContainer');
    if (!container) return;

    let combined = [];

    if (activities && Array.isArray(activities)) {
        combined = activities.map(act => ({
            type: 'session',
            date: new Date(act.startedAt),
            title: 'Sesi Generator',
            desc: act.endedAt ? 'Selesai beroperasi' : 'Sedang beroperasi'
        }));
    }

    if (maintenanceList && Array.isArray(maintenanceList)) {
        const completed = maintenanceList.filter(m => (m.status || '').toLowerCase() === 'completed');
        combined = combined.concat(completed.map(m => ({
            type: 'maintenance',
            date: new Date(m.completedAt || m.updatedAt || m.createdAt),
            title: m.task || 'Tugas Maintenance',
            desc: 'Telah diselesaikan oleh teknisi'
        })));
    }

    combined.sort((a, b) => b.date - a.date);

    if (!combined.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-history" style="font-size:1.8rem; color:#94a3b8;"></i>
                <p>Belum ada riwayat aktivitas</p>
            </div>`;
        return;
    }

    container.innerHTML = combined.slice(0, 6).map(item => {
        const dateStr = item.date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = item.date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const isMaint = item.type === 'maintenance';
        
        return `
        <div class="list-row">
            <div style="display:flex; gap:8px; align-items:center;">
                <i class="${isMaint ? 'fas fa-tools' : 'fas fa-calendar-day'}" style="color:${isMaint ? '#10b981' : '#1745a5'}; width:16px; text-align:center;"></i>
                <div style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-weight:600;color:#1e293b;font-size:13px;">${item.title}</span>
                    <span style="font-size:11px;color:#64748b;">${item.desc}</span>
                </div>
            </div>
            <div style="text-align:right;">
                <span style="font-size:11px; font-weight:600; color:#475569; display:block;">${dateStr}</span>
                <span style="font-size:11px; color:#64748b; display:block;">${timeStr} WIB</span>
            </div>
        </div>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  MAINTENANCE (Hanya Scheduled/Pending)
// ════════════════════════════════════════════════════════════════════════════
function updateMaintenanceSection(data) {
    const container = document.getElementById('maintenanceContainer');
    if (!container) return;

    if (!Array.isArray(data) || !data.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-tools" style="font-size:1.8rem; color:#94a3b8;"></i>
                <p>Tidak ada jadwal maintenance</p>
            </div>`;
        return;
    }

    const upcoming = data
        .filter(m => (m.status || '').toLowerCase() === 'scheduled' || (m.status || '').toLowerCase() === 'pending')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 4);

    if (!upcoming.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-check-circle" style="color:#10b981; font-size:1.8rem;"></i>
                <p>Semua maintenance telah selesai</p>
            </div>`;
        return;
    }

    const priorityMap = { High: '#ef4444', Medium: '#f97316', Low: '#10b981' };

    container.innerHTML = upcoming.map(m => {
        const due = new Date(m.dueDate || m.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        const prioColor = priorityMap[m.priority] || '#64748b';

        return `
        <div class="maintenance-item">
            <div class="maint-header">
                <span class="maint-task">${m.task || 'Tugas Maintenance'}</span>
                ${m.priority ? `<span class="maint-badge" style="background:${prioColor}20;color:${prioColor}">${m.priority}</span>` : ''}
            </div>
            <div class="maint-meta">
                <span><i class="fas fa-calendar-alt"></i> Dijadwalkan: ${due}</span>
            </div>
        </div>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  ANALYTICS — Active Time Bar Chart (Real Data from History)
// ════════════════════════════════════════════════════════════════════════════
function updateActiveTimeChart(historyRows) {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const dayMap = {}; 
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    const now = new Date();

    // Inisialisasi map untuk 7 hari terakhir
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() + WIB_OFFSET - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        dayMap[key] = 0;
    }

    // Akumulasi durasi mesin aktif berdasarkan data aktual dari DB
    if (historyRows && Array.isArray(historyRows)) {
        historyRows.forEach(r => {
            const start = new Date(r.startedAt);
            const end   = r.endedAt ? new Date(r.endedAt) : now;
            
            // Konversi waktu mulai ke WIB untuk kunci (key) hari
            const key = new Date(start.getTime() + WIB_OFFSET).toISOString().slice(0, 10);

            if (dayMap.hasOwnProperty(key)) {
                // Hitung durasi jam
                const durHours = Math.max(0, end - start) / 3600000;
                dayMap[key] += durHours;
            }
        });
    }

    const labels = [];
    const dataPoints = [];
    const todayKey = new Date(now.getTime() + WIB_OFFSET).toISOString().slice(0, 10);
    let todayHours = 0;

    // Masukkan data ke array untuk Chart.js
    Object.keys(dayMap).sort().forEach(key => {
        // Tentukan hari menggunakan string dengan zona waktu tetap
        const d = new Date(key + 'T12:00:00+07:00'); 
        labels.push(days[d.getDay()]);
        
        const val = parseFloat(dayMap[key].toFixed(2));
        dataPoints.push(val);
        
        if (key === todayKey) todayHours = val;
    });

    if (activeChart) activeChart.destroy();

    activeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Jam Aktif',
                data: dataPoints,
                backgroundColor: dataPoints.map((_, i) => i === 6 ? '#f97316' : 'rgba(23,69,165,0.8)'),
                borderRadius: 8,
                barPercentage: 0.55
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} jam aktif` } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: 8,
                    ticks: { callback: v => `${v}h` },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Update Text "Hari Ini" agar akurat berdasarkan hitungan kalkulasi di atas
    const tEl = document.getElementById('engToday');
    if (tEl) {
        const h = Math.floor(todayHours);
        const m = Math.round((todayHours - h) * 60);
        tEl.innerText = m > 0 ? `${h}j ${m}m` : `${h}j 0m`;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  PERFORMANCE — System Status Radar + List
// ════════════════════════════════════════════════════════════════════════════
function updatePerformanceSection(data) {
    if (!data.parameters) return;
    const p = data.parameters;

    const statusOf = (val, lo, hi) => {
        if (val == null) return { text: 'N/A',    cls: 'muted'  };
        if (val < lo)   return { text: 'Rendah',  cls: 'warn'   };
        if (val > hi)   return { text: 'Tinggi',  cls: 'danger' };
        return               { text: 'Normal',   cls: 'ok'     };
    };

    const list = document.getElementById('perfStatusList');
    if (list) {
        const rows = [
            ['Voltage',     statusOf(p.voltage?.value,     200, 240)],
            ['Current',     statusOf(p.current?.value,     0,   100)],
            ['Frequency',   statusOf(p.frequency?.value,   48,  52) ],
            ['Fuel Level',  statusOf(p.fuel?.percent,      20,  100)],
            ['Temperature', statusOf(p.temperature?.value, 40,  90) ],
        ];
        list.innerHTML = rows.map(([name, st]) =>
            `<div class="list-row"><span>${name}:</span>
             <span class="status-pill ${st.cls}">${st.text}</span></div>`
        ).join('');
    }

    renderSystemRadar({
        volt:  p.voltage?.value     || 0,
        freq:  p.frequency?.value   || 0,
        fuel:  p.fuel?.percent      || 0,
        temp:  p.temperature?.value || 0,
        power: parseFloat(p.power?.kw) || 0
    });
}

function renderSystemRadar({ volt, freq, fuel, temp, power }) {
    const ctx = document.getElementById('chartSystem')?.getContext('2d');
    if (!ctx) return;
    if (systemChart) systemChart.destroy();

    const normVolt  = Math.min(100, Math.max(0, volt  > 0 ? ((volt - 180) / (250 - 180)) * 100  : 0));
    const normFreq  = Math.min(100, Math.max(0, freq  > 0 ? (1 - Math.abs(freq - 50) / 10) * 100 : 0));
    const normFuel  = Math.min(100, Math.max(0, fuel));
    const normTemp  = Math.min(100, Math.max(0, temp  > 0 ? (1 - (temp / 95)) * 100               : 100));
    const normPower = Math.min(100, Math.max(0, power * 5));

    systemChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['Tegangan', 'Frekuensi', 'Bahan Bakar', 'Suhu', 'Daya'],
            datasets: [{
                label: 'Status Sistem',
                data: [normVolt, normFreq, normFuel, normTemp, normPower],
                backgroundColor: 'rgba(23,69,165,0.12)',
                borderColor: '#1745a5',
                pointBackgroundColor: '#1745a5',
                pointRadius: 4,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                r: {
                    beginAtZero: true, max: 100,
                    ticks: { display: false, stepSize: 25 },
                    grid:  { color: 'rgba(0,0,0,0.07)' },
                    pointLabels: { font: { size: 11 } }
                }
            }
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  SPECIFICATIONS
// ════════════════════════════════════════════════════════════════════════════
function updateSpecificationsSection(specs) {
    const genEl = document.getElementById('generatorSpecContainer');
    if (genEl && specs) {
        genEl.innerHTML = buildSpecList([
            ['Merk',             specs.merk         || '--'],
            ['Tipe',             specs.tipe         || '--'],
            ['Daya Maksimum',    (specs.dayaMaks    || '--') + ' kW'],
            ['Tegangan Output',  (specs.tegangan    || '--') + ' V'],
            ['Frekuensi',        (specs.frekuensi   || '--') + ' Hz'],
            ['Kapasitas Tangki', (specs.kapasitasTangki || '--') + ' L'],
            ['Konsumsi BBM',     (specs.konsumsiBbm || '--') + ' L/jam'],
            ['Sistem Start',     specs.sistemStart  || '--'],
        ]);
    }

    const engEl = document.getElementById('engineSpecContainer');
    if (engEl && specs) {
        engEl.innerHTML = buildSpecList([
            ['Jenis Mesin',   specs.tipeMesin     || 'Diesel 4-tak, OHV'],
            ['Kapasitas',     specs.kapasitasMesin || '389 cc'],
            ['Max RPM',       '3000 RPM'],
            ['Bahan Bakar',   'Solar'],
            ['Oli Mesin',     specs.oliMesin      || 'SAE 10W-30'],
            ['Pendingin',     'Udara (Air-Cooled)'],
        ]);
    }
}

function buildSpecList(rows) {
    return `<ul class="spec-list">${rows.map(([label, val]) =>
        `<li><span class="spec-label">${label}</span><span class="spec-val">${val}</span></li>`
    ).join('')}</ul>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    updateUserInfo();
    updateClock();
    setInterval(updateClock, 1000);

    await fetchDashboardData();
    setInterval(fetchDashboardData, 10_000);  // refresh every 10s
});