const API_URL = '/api';
let activeChart = null;

// --- UTILS ---
const formatTime = (d) => new Date(d).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
const formatDate = (d) => new Date(d).toLocaleDateString('id-ID', {day:'numeric', month:'short'});

// --- UPDATE DASHBOARD ---
async function updateDashboard() {
    await updateSensorData();
    await updateMaintenanceLog();
    await updateAlerts();
}

// ─── 1. SENSOR DATA ──────────────────────────────────────────────────────────
// Lacak timestamp data terakhir yang berhasil diterima dari ESP32
let _lastSensorOkAt = null;
// Jika selama DISCONNECT_THRESHOLD_MS tidak ada data masuk → anggap mesin mati
const DISCONNECT_THRESHOLD_MS = 30_000; // 30 detik

async function updateSensorData() {
    try {
        const res = await fetch(`${API_URL}/engine-data/latest`);
        if (!res.ok) {
            _handleDisconnect();
            return;
        }
        const json = await res.json();

        if (json.success && json.data) {
            const data = json.data;

            // Cek apakah data dari ESP32 masih fresh (bukan stale data dari cache server)
            const dataAge = Date.now() - new Date(data.timestamp || 0).getTime();
            if (dataAge > DISCONNECT_THRESHOLD_MS) {
                _handleDisconnect();
                return;
            }

            // Data fresh → catat waktu sukses
            _lastSensorOkAt = Date.now();
            _disconnectReported = false;

            // Overview
            setVal('val-rpm',  (data.rpm || 0) + ' RPM');
            setVal('val-temp', (data.coolant || data.temp || 0).toFixed(1) + '°C');
            setVal('val-volt', (data.volt || 0).toFixed(1) + ' V');

            // Engine Status
            const statusText = String(data.status || '').toUpperCase();
            const syncText = String(data.sync || '').toUpperCase();
            const rpmValue = Number(data.rpm || 0);

            // Beberapa device tidak selalu kirim status persis "RUNNING".
            // Fallback: jika RPM > 0 maka mesin dianggap berjalan.
            const isRun  = ['RUNNING', 'ON', 'ACTIVE'].includes(statusText) || rpmValue > 0;
            const isSync = ['ON-GRID', 'SYNCHRONIZED', 'SYNC'].includes(syncText);

            updateStatus('engSync', isSync, 'Synchronized', 'Not Sync');
            updateStatus('engStat', isRun,  'Running', 'Stopped');

            const fuel   = Math.round(data.fuel || 0);
            const fuelEl = document.getElementById('fuelLevel');
            if (fuelEl) {
                fuelEl.innerText  = fuel + '%';
                fuelEl.className  = fuel < 20 ? 'st-err' : 'st-ok';
            }

            // System Health Check Limits
            checkLimit('st-volt', data.volt,  200, 240);
            checkLimit('st-amp',  data.amp,   0,   100);
            checkLimit('st-freq', data.freq,  48,  52);
            checkLimit('st-fuel', data.fuel,  20,  100);
            checkLimit('st-afr',  data.afr,   10,  18);
        }
    } catch (e) {
        console.warn('Sensor Error', e);
        _handleDisconnect();
    }
}

// Tandai ke server bahwa ESP32 terputus sehingga sesi aktif ditutup
let _disconnectReported = false;
async function _handleDisconnect() {
    if (_disconnectReported) return;
    _disconnectReported = true;
    console.warn('ESP32 disconnect detected — closing active session');
    try {
        await fetch(`${API_URL}/active-session/close`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ reason: 'esp32_disconnect' })
        });
    } catch (e) { /* silent */ }
}

// ─── 2. MAINTENANCE LOG ──────────────────────────────────────────────────────
async function updateMaintenanceLog() {
    try {
        const res = await fetch(`${API_URL}/maintenance`);
        if (!res.ok) return;

        const json      = await res.json();
        const container = document.getElementById('maintenanceContainer');

        if (json.success && json.data.length > 0 && container) {
            container.innerHTML = '';
            const logs = json.data.slice(0, 4);

            logs.forEach(log => {
                const dateStr  = new Date(log.dueDate || log.createdAt)
                    .toLocaleDateString('id-ID', {day:'numeric', month:'short'});
                let color = '#64748b';
                if (log.status === 'completed') color = '#10b981';
                if (log.status === 'overdue')   color = '#ef4444';

                container.innerHTML += `
                <div class="list-row">
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-weight:600; color:#1e293b; font-size:14px;">${log.task}</span>
                        <span style="font-size:11px; color:${color}; text-transform:capitalize;">
                            ${log.status} • ${log.assignedTo || '-'}
                        </span>
                    </div>
                    <div style="text-align:right;">
                        <span style="font-size:12px; color:#64748b; font-weight:600;">${dateStr}</span>
                    </div>
                </div>`;
            });
        } else if (container) {
            container.innerHTML = '<div style="text-align:center; padding:15px; color:#aaa">No recent activity</div>';
        }
    } catch (e) { console.warn('Maintenance Fetch Error', e); }
}

// ─── 3. ALERTS ───────────────────────────────────────────────────────────────
async function updateAlerts() {
    try {
        const res  = await fetch(`${API_URL}/alerts?limit=10`);
        const json = await res.json();
        if (json.success) {
            const active = json.data.filter(a => !a.resolved);
            const badge  = document.getElementById('val-alerts');
            if (badge) badge.innerText = active.length;
            renderAlertList(json.data.slice(0, 3));
        }
    } catch (e) { console.warn('Alert Error', e); }
}

// --- HELPERS ---
function setVal(id, v)          { const e=document.getElementById(id); if(e) e.innerText=v; }
function updateStatus(id,ok,t1,t2) { const e=document.getElementById(id); if(e){e.innerText=ok?t1:t2; e.className=ok?'st-ok':'st-err';} }
function checkLimit(id, v, min, max) {
    const e = document.getElementById(id); if (!e) return;
    if (v == null) { e.innerText = '--'; return; }
    if (v >= min && v <= max) { e.innerText = 'Normal'; e.className = 'st-ok'; }
    else                      { e.innerText = v < min ? 'Low' : 'High'; e.className = 'st-err'; }
}

// ─── ALERT RENDER ────────────────────────────────────────────────────────────
function renderAlertList(arr) {
    const c = document.getElementById('alertContainer');
    if (!c) return;
    c.innerHTML = '';

    if (!arr.length) {
        c.innerHTML = '<div style="text-align:center;color:#aaa;padding:25px; font-style:italic;">No recent alerts</div>';
        return;
    }

    arr.forEach(a => {
        let styleClass = 'ac-info', iconClass = 'fa-info';
        if (a.severity === 'critical')                            { styleClass = 'ac-critical'; iconClass = 'fa-exclamation'; }
        else if (a.severity === 'medium' || a.severity === 'warning') { styleClass = 'ac-warning';  iconClass = 'fa-exclamation-triangle'; }

        const title   = a.parameter ? a.parameter : 'System Alert';
        const desc    = a.message;
        const dateStr = new Date(a.timestamp).toLocaleDateString('id-ID');

        c.innerHTML += `
        <div class="alert-card ${styleClass}">
            <div class="ac-icon"><i class="fas ${iconClass}"></i></div>
            <div class="ac-content">
                <div class="ac-title">${title}</div>
                <div class="ac-desc">${desc}</div>
            </div>
            <div class="ac-date">${dateStr}</div>
        </div>`;
    });
}

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────────
function fmtHours(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    if (hh === 0) return `${mm}m`;
    return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}

// ─── CHART — DATA DARI DATABASE (BUKAN FAKE DATA) ────────────────────────────
/**
 * Fetch riwayat sesi aktif dari DB lalu render ke Chart.js.
 *
 * Endpoint  : GET /api/generator-active-time/history?limit=200
 * Response  : { success: true, data: [{ startedAt, endedAt }, ...] }
 *
 * Setiap sesi tanpa endedAt dianggap masih berjalan (endedAt = sekarang).
 * Sesi yang melintas tengah malam dipecah per-hari secara proporsional.
 */
async function initChart() {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const days       = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const WIB_OFFSET = 7 * 60 * 60 * 1000; // UTC+7 dalam ms
    const now        = new Date();

    // Bangun map { 'YYYY-MM-DD': jamAktif } untuk 7 hari terakhir (WIB)
    const dayMap = {};
    for (let i = 6; i >= 0; i--) {
        const d   = new Date(now.getTime() + WIB_OFFSET - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        dayMap[key] = 0;
    }

    try {
        const res  = await fetch(`${API_URL}/generator-active-time/history?limit=200`);
        const json = await res.json();

        if (json.success && Array.isArray(json.data)) {
            json.data.forEach(r => {
                const start = new Date(r.startedAt);
                // Sesi masih berjalan (belum ada endedAt) → gunakan waktu sekarang
                const end   = r.endedAt ? new Date(r.endedAt) : now;

                // Pecah sesi yang melintas batas hari
                _splitSessionByDay(start, end, WIB_OFFSET).forEach(({ dateKey, hours }) => {
                    if (dayMap.hasOwnProperty(dateKey)) {
                        dayMap[dateKey] += hours;
                    }
                });
            });
        }
    } catch (e) {
        console.warn('Active time fetch error', e);
        // Render chart tetap muncul, hanya semua nilai 0
    }

    const todayKey   = new Date(now.getTime() + WIB_OFFSET).toISOString().slice(0, 10);
    const labels     = [];
    const dataPoints = [];
    let   todayHours = 0;

    Object.keys(dayMap).sort().forEach(key => {
        const d   = new Date(key + 'T12:00:00+07:00');
        labels.push(days[d.getDay()]);
        const val = parseFloat(dayMap[key].toFixed(2));
        dataPoints.push(val);
        if (key === todayKey) todayHours = val;
    });

    if (activeChart) activeChart.destroy();

    activeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label          : 'Jam Aktif',
                data           : dataPoints,
                backgroundColor: dataPoints.map((_, i) => i === 6 ? '#f97316' : 'rgba(23,69,165,0.8)'),
                borderRadius   : 8,
                barPercentage  : 0.55
            }]
        },
        options: {
            responsive           : true,
            maintainAspectRatio  : false,
            plugins: {
                legend : { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} menit aktif` } }
            },
            scales: {
                y: {
                    beginAtZero : true,
                    suggestedMax: 8,
                    title       : { display: true, text: 'Menit' },
                    ticks       : { callback: v => v + 'm' },
                    grid        : { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Update teks "Aktif Hari Ini"
    const tEl = document.getElementById('engToday');
    if (tEl) tEl.innerText = fmtHours(todayHours);
}

/**
 * Pecah satu sesi menjadi potongan per-hari (WIB).
 * Berguna untuk sesi yang melewati tengah malam.
 *
 * @param {Date}   start
 * @param {Date}   end
 * @param {number} wibOffset  - UTC offset dalam ms (7 * 3600000)
 * @returns {{ dateKey: string, hours: number }[]}
 */
function _splitSessionByDay(start, end, wibOffset) {
    const result   = [];
    let   cursor   = new Date(start);

    while (cursor < end) {
        // Tentukan akhir hari ini (WIB) = tengah malam berikutnya
        const cursorWib = new Date(cursor.getTime() + wibOffset);
        const nextMidnightWib = new Date(
            Date.UTC(cursorWib.getUTCFullYear(), cursorWib.getUTCMonth(), cursorWib.getUTCDate() + 1)
        );
        const nextMidnightUtc = new Date(nextMidnightWib.getTime() - wibOffset);

        const sliceEnd   = nextMidnightUtc < end ? nextMidnightUtc : end;
        const durMs      = sliceEnd - cursor;
        const durHours   = durMs / 3600000;

        const dateKey = new Date(cursor.getTime() + wibOffset).toISOString().slice(0, 10);
        result.push({ dateKey, hours: durHours });

        cursor = sliceEnd;
    }

    return result;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const renderClock = () => {
        const el = document.getElementById('clock');
        if (el) el.innerText = new Date().toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) + ' WIB';
    };

    renderClock();
    setInterval(renderClock, 1000);

    updateDashboard();
    initChart();
    setInterval(updateDashboard, 1000);

    // Refresh chart setiap 5 menit
    setInterval(initChart, 5 * 60 * 1000);

    // Trigger recalculate sesi hari ini di server setiap 10 menit
    async function triggerTodayRecalculate() {
        try {
            await fetch(`${API_URL}/daily-active-time/recalculate`, { method: 'POST' });
        } catch (e) { /* silent */ }
    }
    triggerTodayRecalculate();
    setInterval(triggerTodayRecalculate, 10 * 60 * 1000);
});
