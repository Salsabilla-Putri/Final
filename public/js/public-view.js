'use strict';

// ── Chart instances ──────────────────────────────────────────────────────────
let activeChart  = null;
let systemChart  = null;
let fuelWeeklyChart = null;
let maintenanceCostChart = null;
let dashboardHistoryCache = [];
let dashboardMaintenanceCache = [];
let calendarViewMonth = new Date().getMonth();
let calendarViewYear = new Date().getFullYear();
let selectedMaintenanceDateKey = null;
let selectedCostMonthIndex = null;
let lastFuelCostSignature = '';

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



        const alertsData = alertsRes.status === 'fulfilled' ? await alertsRes.value.json().catch(() => null) : null;
        let activeAlerts = 0;
        if (alertsData?.success) {
            activeAlerts = alertsData.data.filter(a => !a.resolved).length;
            const badge  = document.getElementById('val-alerts');
            if (badge) badge.innerText = activeAlerts;
            renderAlertList(alertsData.data);
        }

        const specsData = specsRes.status === 'fulfilled' ? await specsRes.value.json().catch(() => null) : null;
        if (specsData?.success) updateSpecificationsSection(specsData.data);

        const historyData = historyRes.status === 'fulfilled' ? await historyRes.value.json().catch(() => null) : null;
        const maintenanceData = maintenanceRes.status === 'fulfilled' ? await maintenanceRes.value.json().catch(() => null) : null;

        if (historyData?.success) {
            dashboardHistoryCache = historyData.data || [];
            // Gabungkan riwayat sesi DB dengan maintenance yang Completed
            renderRecentActivity(historyData.data, maintenanceData?.success ? maintenanceData.data : []);
            // Render chart berdasarkan data history aktual
            updateActiveTimeChart(historyData.data);
        }

        if (maintenanceData?.success) {
            dashboardMaintenanceCache = maintenanceData.data || [];
            updateMaintenanceSection(maintenanceData.data);
            const schedCount = maintenanceData.data.filter(m => ['scheduled','pending'].includes(String(m.status || '').toLowerCase())).length;
            const ms = document.getElementById('val-maint-scheduled');
            if (ms) ms.innerText = String(schedCount);
        }
        const historyRows = historyData?.success ? historyData.data : dashboardHistoryCache;
        updateFuelAndCostCharts(historyRows, maintenanceData?.success ? maintenanceData.data : dashboardMaintenanceCache);

        if (engineData?.success && engineData.data) {
            updateOverviewCards(engineData.data, historyRows);
            updateOperationsSection(engineData.data, cbmData?.data);
        }

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
function updateOverviewCards(data, historyRows = []) {
    const power = Number(data.power ?? data.kw ?? 0) || 0;
    const avg7h = calculateAverageRuntime7Days(historyRows);

    const avgEl = document.getElementById('val-avg-runtime');
    const powerEl  = document.getElementById('val-power');

    if (avgEl) avgEl.innerText = formatHourMinute(avg7h);
    if (powerEl) powerEl.innerText  = power.toFixed(1) + ' kW';
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

    const fuelEstimateEl = document.getElementById('fuelRuntimeEstimate');
    if (fuelEstimateEl) {
        const fuelPct = Number(data.fuel || 0);
        const estHours = Math.max(0, (fuelPct / 100) * 8);
        fuelEstimateEl.innerText = formatHourMinute(estHours);
        fuelEstimateEl.className = estHours >= 2 ? 'st-ok' : estHours >= 1 ? 'st-warn' : 'st-err';
    }

    renderHealthScore(data, cbmData);
}

function healthStatus(value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v)) return { text: '--', cls: 'st-err' };
    if (v >= min && v <= max) return { text: 'Normal', cls: 'st-ok' };
    return { text: v < min ? 'Low' : 'High', cls: 'st-err' };
}

function calculateHealthByComponentAge(engineData = {}, cbmData = {}) {
    const hourAge = Number(engineData.engineHours || engineData.runtimeHours || cbmData.engineHours || 0) || 0;
    const ageMonth = Number(engineData.generatorAgeMonth || cbmData.generatorAgeMonth || 0) || 0;
    const comp = cbmData.components || {};

    const scoreFromState = (status) => {
        const s = String(status || '').toLowerCase();
        if (s === 'critical' || s === 'bad') return 35;
        if (s === 'warning' || s === 'degraded') return 65;
        if (s === 'good' || s === 'normal') return 90;
        return 75;
    };

    const healthFactors = [
        scoreFromState(comp.tps?.status),
        scoreFromState(comp.coolant?.status),
        scoreFromState(comp.battery?.status),
        scoreFromState(comp.fuelSystem?.status),
        scoreFromState(comp.oil?.status),
        Math.max(40, 100 - (hourAge / 250) * 8),
        Math.max(45, 100 - ageMonth * 0.8)
    ];

    return Math.round(healthFactors.reduce((a, b) => a + b, 0) / healthFactors.length);
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
        health = calculateHealthByComponentAge(engineData, cbmData);
        warnings.push({ label: 'Skor berdasar usia/kondisi komponen', cls: 'ok' });
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

    const ageEl = document.getElementById('st-age');
    const runtimeEl = document.getElementById('st-runtime');
    const componentEl = document.getElementById('st-component');
    const lastMaintEl = document.getElementById('st-last-maint');
    const runtimeHours = Math.round(engineData.engineHours || engineData.runtimeHours || cbmData?.engineHours || 0);
    const availabilityPct = Math.max(0, Math.min(100, 100 - Math.min(20, runtimeHours / 400)));
    if (ageEl) ageEl.textContent = `${availabilityPct.toFixed(1)}% (target > 95%)`;
    if (runtimeEl) runtimeEl.textContent = `${runtimeHours.toLocaleString('id-ID')} jam`;
    if (componentEl) componentEl.textContent = warnings.length ? warnings.map(w => w.label.replace(/^Kritis: |^Perhatian: /, '')).join(', ') : 'Sensor & pembakaran stabil';
    const lastCompleted = (dashboardMaintenanceCache || [])
        .filter((m) => String(m.status || '').toLowerCase() === 'completed')
        .sort((a, b) => new Date(b.completedAt || b.updatedAt || b.createdAt) - new Date(a.completedAt || a.updatedAt || a.createdAt))[0];
    if (lastMaintEl) lastMaintEl.textContent = lastCompleted
        ? new Date(lastCompleted.completedAt || lastCompleted.updatedAt || lastCompleted.createdAt).toLocaleDateString('id-ID')
        : '-';
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

    const upcoming = Array.isArray(data)
        ? data.filter(m => ['scheduled', 'pending'].includes(String(m.status || '').toLowerCase()))
        : [];

    if (!upcoming.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle" style="color:#10b981; font-size:1.8rem;"></i><p>Tidak ada upcoming maintenance</p></div>`;
        return;
    }

    const monthStart = new Date(calendarViewYear, calendarViewMonth, 1);
    const monthEnd = new Date(calendarViewYear, calendarViewMonth + 1, 0);
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const totalDays = monthEnd.getDate();

    const byDate = {};
    upcoming.forEach(m => {
        const dt = new Date(m.dueDate || m.createdAt);
        const key = dt.toISOString().slice(0,10);
        (byDate[key] ||= []).push(m);
    });

    const cells = [];
    for (let i=0;i<firstWeekday;i++) cells.push('<div class="calendar-day muted"></div>');
    for (let day=1;day<=totalDays;day++) {
        const d = new Date(calendarViewYear, calendarViewMonth, day);
        const key = d.toISOString().slice(0,10);
        const weekend = [0,6].includes(d.getDay());
        cells.push(`<button class="calendar-day ${weekend ? 'red-day' : ''} ${byDate[key] ? 'has-event' : ''}" data-date="${key}">${day}${byDate[key] ? '<span class="dot"></span>' : ''}</button>`);
    }

    const upcoming7 = upcoming.filter((m) => {
        const due = new Date(m.dueDate || m.createdAt);
        const start = new Date();
        const end = new Date();
        end.setDate(end.getDate() + 7);
        return due >= start && due <= end;
    });

    container.innerHTML = `<div class="maintenance-calendar-wrap">
        <div class="calendar-header">
            <button class="cal-nav" data-nav="-1"><i class="fas fa-chevron-left"></i></button>
            <span>${monthStart.toLocaleDateString('id-ID', { month:'long', year:'numeric' })}</span>
            <button class="cal-nav" data-nav="1"><i class="fas fa-chevron-right"></i></button>
        </div>
        <div class="calendar-weekdays"><span>Sen</span><span>Sel</span><span>Rab</span><span>Kam</span><span>Jum</span><span>Sab</span><span>Min</span></div>
        <div class="calendar-grid">${cells.join('')}</div>
        <div id="maintenanceDetailPanel" class="maintenance-detail-panel">${
            upcoming7.length
            ? `<h4>Upcoming 7 Hari</h4>${upcoming7.map(renderMaintenanceDetailCard).join('')}`
            : 'Tidak ada maintenance 7 hari ke depan.'
        }</div>
    </div>`;

    container.querySelectorAll('.cal-nav').forEach((btn) => {
        btn.addEventListener('click', () => {
            const shift = Number(btn.dataset.nav || 0);
            const ref = new Date(calendarViewYear, calendarViewMonth + shift, 1);
            calendarViewYear = ref.getFullYear();
            calendarViewMonth = ref.getMonth();
            selectedMaintenanceDateKey = null;
            updateMaintenanceSection(data);
        });
    });

    container.querySelectorAll('.calendar-day.has-event').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.date;
            const panel = document.getElementById('maintenanceDetailPanel');
            if (selectedMaintenanceDateKey === key) {
                selectedMaintenanceDateKey = null;
                panel.innerHTML = upcoming7.length
                    ? `<h4>Upcoming 7 Hari</h4>${upcoming7.map(renderMaintenanceDetailCard).join('')}`
                    : 'Tidak ada maintenance 7 hari ke depan.';
                return;
            }
            selectedMaintenanceDateKey = key;
            const list = byDate[key] || [];
            panel.innerHTML = `<h4>Detail ${new Date(key).toLocaleDateString('id-ID')}</h4><div class="maint-detail-grid">${list.map(renderMaintenanceDetailCard).join('')}</div>`;
        });
    });
}
function renderMaintenanceDetailCard(m) {
    return `<div class="maint-detail-item"><div class="maint-visual-top"><span class="status-pill ${(m.priority || '').toLowerCase() === 'high' ? 'danger' : 'ok'}">${m.priority || 'Normal'}</span><strong>${m.task || '-'}</strong></div><div><strong>Type:</strong> ${m.type || m.category || '-'}</div><div><strong>Status:</strong> ${(m.status || '-').toUpperCase()}</div><div><strong>PIC:</strong> ${m.assignedTo || '-'}</div><div><strong>Cost:</strong> Rp ${(Number(m.cost || m.estimatedCost || 0) || 0).toLocaleString('id-ID')}</div><div><strong>Catatan:</strong> ${m.notes || m.description || '-'}</div></div>`;
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

    // Akumulasi durasi mesin aktif berdasarkan data aktual dari DB.
    // Tiap sesi dipecah per-hari (WIB), agar sesi lintas tengah malam tidak salah hitung.
    if (historyRows && Array.isArray(historyRows)) {
        historyRows.forEach(r => {
            const start = new Date(r.startedAt);
            const end   = r.endedAt ? new Date(r.endedAt) : now;

            if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;

            splitSessionByDayWIB(start, end, WIB_OFFSET).forEach(({ dateKey, hours }) => {
                if (dayMap.hasOwnProperty(dateKey)) {
                    dayMap[dateKey] += hours;
                }
            });
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
        
        const val = parseFloat(Math.min(24, dayMap[key]).toFixed(2));
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


function splitSessionByDayWIB(start, end, wibOffset) {
    const result = [];
    let cursor = new Date(start);

    while (cursor < end) {
        const cursorWib = new Date(cursor.getTime() + wibOffset);
        const nextMidnightWib = new Date(
            Date.UTC(cursorWib.getUTCFullYear(), cursorWib.getUTCMonth(), cursorWib.getUTCDate() + 1)
        );
        const nextMidnightUtc = new Date(nextMidnightWib.getTime() - wibOffset);
        const sliceEnd = nextMidnightUtc < end ? nextMidnightUtc : end;

        const durHours = Math.max(0, sliceEnd - cursor) / 3600000;
        const dateKey = new Date(cursor.getTime() + wibOffset).toISOString().slice(0, 10);
        result.push({ dateKey, hours: durHours });
        cursor = sliceEnd;
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════
//  PERFORMANCE — System Status Radar + List
// ════════════════════════════════════════════════════════════════════════════
function updatePerformanceSection(data) {
    if (!data.parameters) return;
    const p = data.parameters;

    const pickValue = (...vals) => {
        for (const v of vals) {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        return null;
    };

    const metricText = (val, unit, digits = 1) => {
        if (val == null) return `N/A`;
        return `${Number(val).toFixed(digits)} ${unit}`;
    };

    const statusOf = (val, lo, hi) => {
        if (val == null) return { text: 'Data belum masuk', cls: 'muted' };
        if (val < lo) return { text: 'Di bawah normal', cls: 'warn' };
        if (val > hi) return { text: 'Di atas normal', cls: 'danger' };
        return { text: 'Normal', cls: 'ok' };
    };

    // dukung berbagai bentuk payload agar tidak lagi N/A saat data sebenarnya ada
    const voltVal = pickValue(p.voltage?.value, p.volt?.value, p.voltage, p.volt, data.voltage, data.volt);
    const fuelVal = pickValue(p.fuel?.percent, p.fuel?.value, p.fuel, data.fuel);
    const tempVal = pickValue(p.temperature?.value, p.coolant?.value, p.temp?.value, p.temperature, p.coolant, p.temp, data.temperature, data.coolant, data.temp);

    const powerVal = pickValue(p.power?.kw, p.power?.value, p.kw?.value, p.power, p.kw, data.power, data.kw);

    const toPct = (val, min, max) => {
        if (val == null) return 0;
        const pct = ((val - min) / (max - min)) * 100;
        return Math.max(0, Math.min(100, pct));
    };

    const cards = [
        { name: 'Tegangan', icon: 'fa-bolt', value: metricText(voltVal, 'V'), status: statusOf(voltVal, 200, 240) },
        { name: 'Daya', icon: 'fa-bolt-lightning', value: metricText(powerVal, 'kW'), status: statusOf(powerVal, 0, 250) },
        { name: 'Temperatur', icon: 'fa-thermometer-half', value: metricText(tempVal, '°C'), status: statusOf(tempVal, 40, 90) },
        { name: 'Bahan Bakar', icon: 'fa-gas-pump', value: metricText(fuelVal, '%', 0), status: statusOf(fuelVal, 20, 100) },
        { name: 'Aki', icon: 'fa-car-battery', value: metricText(voltVal != null ? voltVal / 20 : null, 'V'), status: statusOf(voltVal != null ? voltVal / 20 : null, 11.8, 14.4) }
    ];

    const wrap = document.getElementById('perfSimpleCards');
    if (wrap) {
        wrap.innerHTML = cards.map((c) => `
            <div class="perf-item-card">
                <div class="perf-item-head">
                    <i class="fas ${c.icon}"></i>
                    <span>${c.name}</span>
                </div>
                <div class="perf-item-value">${c.value}</div>
                <div class="perf-bar"><span style="width:${toPct(
                    c.name === 'Tegangan' ? voltVal :
                    c.name === 'Daya' ? powerVal :
                    c.name === 'Temperatur' ? tempVal :
                    c.name === 'Bahan Bakar' ? fuelVal :
                    c.name === 'Aki' ? (voltVal != null ? voltVal / 20 : null) : null,
                    c.name === 'Tegangan' ? 180 : c.name === 'Daya' ? 0 : c.name === 'Temperatur' ? 0 : c.name === 'Bahan Bakar' ? 0 : 10,
                    c.name === 'Tegangan' ? 250 : c.name === 'Daya' ? 250 : c.name === 'Temperatur' ? 120 : c.name === 'Bahan Bakar' ? 100 : 15
                )}%"></span></div>
                <div class="perf-item-status status-pill ${c.status.cls}">${c.status.text}</div>
            </div>
        `).join('');
    }
}

function updateFuelAndCostCharts(historyRows = [], maintenanceRows = []) {
    const fuelCtx = document.getElementById('chartFuelWeekly')?.getContext('2d');
    const costCtx = document.getElementById('chartMaintCostMonthly')?.getContext('2d');
    if (!fuelCtx || !costCtx) return;
    const signature = `${historyRows.length}|${maintenanceRows.length}|${JSON.stringify(historyRows[0] || {})}|${JSON.stringify(maintenanceRows[0] || {})}`;
    if (signature === lastFuelCostSignature) return;
    lastFuelCostSignature = signature;

    const weeklyLabels = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const weeklyFuel = [0, 0, 0, 0, 0, 0, 0];
    (historyRows || []).forEach((r) => {
        const day = new Date(r.startedAt || r.createdAt).getDay();
        const start = new Date(r.startedAt || r.createdAt);
        const end = r.endedAt ? new Date(r.endedAt) : new Date();
        const runtimeHours = Math.max(0, end - start) / 3600000;
        const used = runtimeHours * 1.25;
        weeklyFuel[day] += used;
    });
    for (let i = 0; i < weeklyFuel.length; i++) weeklyFuel[i] = Number(weeklyFuel[i].toFixed(2));

    if (fuelWeeklyChart) fuelWeeklyChart.destroy();
    fuelWeeklyChart = new Chart(fuelCtx, {
        type: 'line',
        data: { labels: weeklyLabels, datasets: [{ label: 'BBM (L)', data: weeklyFuel, borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.2)', tension: 0.35, fill: true }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y.toFixed(2)} L (1,25 L/jam)` } } } }
    });

    const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    const monthlyCost = new Array(12).fill(0);
    (maintenanceRows || []).forEach((m) => {
        const dt = new Date(m.completedAt || m.updatedAt || m.createdAt);
        const idx = dt.getMonth();
        monthlyCost[idx] += Number(m.cost || m.estimatedCost || 0) || 0;
    });

    if (maintenanceCostChart) maintenanceCostChart.destroy();
    const monthlyDetails = new Array(12).fill(0).map(() => []);
    (maintenanceRows || []).forEach((m) => {
        const dt = new Date(m.completedAt || m.updatedAt || m.createdAt);
        const idx = dt.getMonth();
        monthlyDetails[idx].push(m);
    });

    maintenanceCostChart = new Chart(costCtx, {
        type: 'bar',
        data: { labels: monthNames, datasets: [{ label: 'Biaya (Rp)', data: monthlyCost, backgroundColor: 'rgba(23,69,165,0.82)', borderRadius: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, onClick: (_, elements) => {
            const target = document.getElementById('maintenanceCostDetail');
            if (!target || !elements.length) return;
            const idx = elements[0].index;
            if (selectedCostMonthIndex === idx) {
                selectedCostMonthIndex = null;
                target.innerHTML = 'Klik batang bulan untuk lihat detail biaya.';
                return;
            }
            selectedCostMonthIndex = idx;
            const details = monthlyDetails[idx];
            if (!details.length) { target.innerHTML = `<div class="cost-detail-title">${monthNames[idx]}</div><div class="cost-empty">Tidak ada biaya maintenance.</div>`; return; }
            const total = details.reduce((s, d) => s + (Number(d.cost || d.estimatedCost || 0) || 0), 0);
            target.innerHTML = `<div class="cost-detail-title">${monthNames[idx]} • Total Rp ${total.toLocaleString('id-ID')}</div><div class="cost-detail-scroll">${details.map(d => `<div class="cost-row"><span>${d.task || d.type || 'Maintenance'}</span><strong>Rp ${(Number(d.cost || d.estimatedCost || 0) || 0).toLocaleString('id-ID')}</strong></div>`).join('')}</div>`;
        } }
    });
}

function renderSystemRadar({ volt, freq, fuel, temp, power }) {
    // Performance chart disederhanakan ke kartu indikator untuk pengguna awam.
    return;
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
            ['Pengatur Tegangan Otomatis', specs.avrType || 'AVR digital'],
            ['Pelindung Arus Listrik', specs.mcbType || 'MCB 3P 63A'],
            ['Penyearah Arus', specs.rectifierType || 'Bridge rectifier'],
            ['Bantalan Poros', specs.bearingType || 'Bearing standar industri'],
            ['Sistem Starter', specs.sistemStart || 'Starter elektrik'],
            ['Pompa Bahan Bakar', specs.fuelPumpType || 'Pompa elektrik 12V']
        ]);
    }

    const engEl = document.getElementById('engineSpecContainer');
    if (engEl && specs) {
        engEl.innerHTML = buildSpecList([
            ['Sistem Injeksi Bahan Bakar', specs.injectorType || 'Common rail'],
            ['Saringan Oli Mesin', specs.oilFilterType || 'Filter tipe spin-on'],
            ['Saringan Udara', specs.airFilterType || 'Filter kering'],
            ['Aki Starter', specs.batteryType || '12V 70Ah'],
            ['Sistem Pendingin', specs.coolantType || 'Coolant long life'],
            ['Sensor Posisi Gas', specs.tpsType || 'Sensor TPS 0-5V']
        ]);
    }
}

function buildSpecList(rows) {
    return `<ul class="spec-list">${rows.map(([label, val]) =>
        `<li><span class="spec-label">${label}</span><span class="spec-val">${val}</span></li>`
    ).join('')}</ul>`;
}


function calculateAverageRuntime7Days(historyRows = []) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    let total = 0;
    historyRows.forEach((r) => {
        const s = new Date(r.startedAt);
        const e = r.endedAt ? new Date(r.endedAt) : now;
        if (e > start && e > s) total += Math.max(0, e - s) / 3600000;
    });
    return total / 7;
}

function formatHourMinute(hours = 0) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}j ${m}m`;
}

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    updateUserInfo();
    updateClock();
    setInterval(updateClock, 1000);

    // [MODIFIKASI] Navigasi klik profil user ke Halaman public-user.html
    const userBtn = document.getElementById('user-btn');
    if (userBtn) {
        userBtn.addEventListener('click', () => {
            window.location.href = 'public-user.html';
        });
    }

    await fetchDashboardData();
    setInterval(fetchDashboardData, 1000);  // refresh realtime every 1s
});
