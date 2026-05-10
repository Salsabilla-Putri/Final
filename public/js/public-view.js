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
        // 1. Latest engine sensor data (realtime from MQTT memory)
        const [engineRes, alertsRes, specsRes, historyRes, maintenanceRes, dashRes] = await Promise.allSettled([
            fetch('/api/engine-data/latest'),
            fetch('/api/alerts?limit=10'),
            fetch('/api/generator-specs'),
            fetch('/api/generator-active-time/history?limit=30'),
            fetch('/api/maintenance'),
            fetch('/api/public/dashboard')
        ]);

        const engineData = engineRes.status === 'fulfilled'
            ? await engineRes.value.json().catch(() => null) : null;

        if (engineData?.success && engineData.data) {
            updateOverviewCards(engineData.data);
            updateOperationsSection(engineData.data);
        }

        const alertsData = alertsRes.status === 'fulfilled'
            ? await alertsRes.value.json().catch(() => null) : null;

        if (alertsData?.success) {
            const active = alertsData.data.filter(a => !a.resolved).length;
            const badge  = document.getElementById('val-alerts');
            if (badge) badge.innerText = active;
            renderAlertList(alertsData.data);
        }

        const specsData = specsRes.status === 'fulfilled'
            ? await specsRes.value.json().catch(() => null) : null;

        if (specsData?.success) updateSpecificationsSection(specsData.data);

        const historyData = historyRes.status === 'fulfilled'
            ? await historyRes.value.json().catch(() => null) : null;

        if (historyData?.success) {
            renderRecentActivity(historyData.data);
            updateActiveTimeChart(historyData.data);
        }

        const maintenanceData = maintenanceRes.status === 'fulfilled'
            ? await maintenanceRes.value.json().catch(() => null) : null;

        if (maintenanceData?.success) updateMaintenanceSection(maintenanceData.data);

        const dashData = dashRes.status === 'fulfilled'
            ? await dashRes.value.json().catch(() => null) : null;

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
function updateOperationsSection(data) {
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

    // Analytics: System Health rows (samakan logika dengan dashboard/index)
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

    // Today's active time (async, non-blocking)
    fetch('/api/generator-active-time/stats?hours=24')
        .then(r => r.json())
        .then(sd => {
            if (!sd?.success) return;
            const el = document.getElementById('engToday');
            if (el) el.innerText = formatActiveHours(sd.data.totalDurationHours || 0);
        })
        .catch(() => {});

    // Health score
    renderHealthScore(data);
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

function renderHealthScore(data) {
    const container = document.getElementById('systemHealthContainer');
    if (!container) return;

    const health = calculateHealth(data);
    const color  = health > 80 ? '#10b981' : health > 50 ? '#f59e0b' : '#ef4444';

    const warnings = [];
    const temp = data.coolant || data.temp || 0;
    if (temp > 95)                                    warnings.push({ label: 'Suhu Kritis',           cls: 'danger' });
    else if (temp > 85)                               warnings.push({ label: 'Suhu Tinggi',            cls: 'warn'   });
    if ((data.fuel || 0) < 20)                        warnings.push({ label: 'BBM Hampir Habis',       cls: 'warn'   });
    if (data.volt > 0 && (data.volt < 190 || data.volt > 250))
                                                      warnings.push({ label: 'Tegangan Tidak Normal',  cls: 'danger' });

    const pillsHTML = warnings.length
        ? warnings.map(w => `<span class="status-pill ${w.cls}">${w.label}</span>`).join('')
        : `<span class="status-pill ok"><i class="fas fa-check"></i> Semua Komponen Aman</span>`;

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
//  RECENT ACTIVITY (active-time sessions)
// ════════════════════════════════════════════════════════════════════════════
function renderRecentActivity(activities) {
    const container = document.getElementById('recentActivityContainer');
    if (!container) return;

    if (!activities || activities.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-history" style="font-size:1.8rem; color:#94a3b8;"></i>
                <p>Belum ada riwayat aktivitas</p>
            </div>`;
        return;
    }

    container.innerHTML = activities.slice(0, 6).map(act => {
        const start     = new Date(act.startedAt);
        const end       = act.endedAt ? new Date(act.endedAt) : new Date();
        const durMs     = Math.max(0, end - start);
        const h         = Math.floor(durMs / 3600000);
        const m         = Math.floor((durMs % 3600000) / 60000);
        const dateStr   = start.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr   = start.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const isActive  = !act.endedAt;

        return `
        <div class="list-row">
            <div style="display:flex;flex-direction:column;gap:2px;">
                <span style="font-weight:600;color:#1e293b;font-size:13px;">
                    <i class="fas fa-calendar-day" style="color:#1745a5;margin-right:5px;font-size:11px;"></i>${dateStr}
                </span>
                <span style="font-size:11px;color:#64748b;">${timeStr} WIB</span>
            </div>
            <div style="text-align:right;">
                ${isActive
                    ? `<span class="badge-active"><i class="fas fa-circle"></i> Aktif</span>`
                    : `<span style="font-size:12px;font-weight:600;color:#475569;">${h}j ${m}m</span>`}
            </div>
        </div>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  ANALYTICS — Active Time Bar Chart
// ════════════════════════════════════════════════════════════════════════════

function formatActiveHours(hours) {
    const safe = Number(hours || 0);
    const h = Math.floor(safe);
    const m = Math.round((safe - h) * 60);
    if (h === 0) return `${m}m`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}


function dayLabelWib(dateStr) {
    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const d = new Date(dateStr + 'T12:00:00+07:00');
    return days[d.getDay()];
}

function healthStatus(value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v)) return { text: '--', cls: 'st-err' };
    if (v >= min && v <= max) return { text: 'Normal', cls: 'st-ok' };
    return { text: v < min ? 'Low' : 'High', cls: 'st-err' };
}
function getWibDayKey(offsetDay = 0) {
    const WIB_OFFSET_MS = 7 * 3600 * 1000;
    const d = new Date(Date.now() + WIB_OFFSET_MS + offsetDay * 86400000);
    return d.toISOString().slice(0, 10);
}

function updateActiveTimeChart(rows) {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const renderChart = (labels, dataPoints, highlightIdx = -1) => {
        if (activeChart) activeChart.destroy();
        activeChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Jam Aktif',
                    data: dataPoints,
                    backgroundColor: dataPoints.map((_, i) =>
                        i === highlightIdx ? '#f97316' : 'rgba(23,69,165,0.8)'),
                    borderRadius: 8,
                    barPercentage: 0.55
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.parsed.y.toFixed(1)} jam aktif`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true, max: 24,
                        ticks: { callback: v => `${v}h` },
                        grid: { color: 'rgba(0,0,0,0.05)' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    };

    // Build 7-day map WIB (selaras dengan index.html/dashboard.js)
    const dayMap = {};
    for (let i = 6; i >= 0; i--) {
        dayMap[getWibDayKey(-i)] = 0;
    }

    // Try dedicated endpoint first, fallback to history rows
    Promise.allSettled([
        fetch('/api/daily-active-time?days=7').then(r => r.ok ? r.json() : null),
        fetch('/api/daily-active-time/today').then(r => r.ok ? r.json() : null)
    ]).then(([histResult, todayResult]) => {
        const histJson  = histResult.status  === 'fulfilled' ? histResult.value  : null;
        const todayJson = todayResult.status === 'fulfilled' ? todayResult.value : null;

        if (histJson?.success && Array.isArray(histJson.data)) {
            histJson.data.forEach(r => {
                if (Object.prototype.hasOwnProperty.call(dayMap, r.date)) {
                    dayMap[r.date] = r.activeHours || 0;
                }
            });
        } else {
            // Fallback: accumulate from session history
            (rows || []).forEach(r => {
                const start = new Date(r.startedAt);
                const end   = r.endedAt ? new Date(r.endedAt) : new Date();
                const key   = new Date(start.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
                if (Object.prototype.hasOwnProperty.call(dayMap, key)) {
                    dayMap[key] += Math.max(0, (end - start) / 3600000);
                }
            });
        }

        const todayKey = getWibDayKey(0);
        if (todayJson?.success && todayJson.activeHours != null) {
            dayMap[todayKey] = todayJson.activeHours;
        }

        const keys = Object.keys(dayMap);
        renderChart(
            keys.map(dayLabelWib),
            keys.map(k => +((dayMap[k] || 0).toFixed(2))),
            keys.findIndex(k => k === todayKey)
        );
    });
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

    // Radar chart
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

    // Normalize each param to 0-100 (higher = better)
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
//  MAINTENANCE
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
        .filter(m => (m.status || '').toLowerCase() !== 'completed')
        .sort((a, b) => new Date(a.dueDate || a.createdAt) - new Date(b.dueDate || b.createdAt))
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
        const due      = new Date(m.dueDate || m.createdAt)
            .toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        const estCost  = m.cost > 0
            ? `Rp ${Number(m.cost).toLocaleString('id-ID')}` : 'Belum tersedia';
        const prioColor = priorityMap[m.priority] || '#64748b';
        const status   = (m.status || 'scheduled');

        return `
        <div class="maintenance-item">
            <div class="maint-header">
                <span class="maint-task">${m.task || 'Maintenance Task'}</span>
                ${m.priority
                    ? `<span class="maint-badge" style="background:${prioColor}20;color:${prioColor}">${m.priority}</span>`
                    : ''}
            </div>
            <div class="maint-meta">
                <span><i class="fas fa-calendar-alt"></i> ${due}</span>
                <span class="maint-status status-${status.toLowerCase()}">${status}</span>
            </div>
            ${m.assignedTo ? `<div class="maint-assign"><i class="fas fa-user-cog"></i> ${m.assignedTo}</div>` : ''}
            <div class="maint-cost"><i class="fas fa-tag"></i> Estimasi: <strong>${estCost}</strong></div>
        </div>`;
    }).join('');
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