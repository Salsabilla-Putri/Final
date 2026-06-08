const API_URL = '/api';
let activeChart = null;
let activeChartLoading = false;
let auxDashboardLoading = false;
const SENSOR_REFRESH_MS = 2000;
const AUX_REFRESH_MS = 15000;
const CHART_REFRESH_MS = 60000;
const LAST_SENSOR_STORAGE_KEY = 'gensys:last-dashboard-sensor';

// --- UTILS ---
const formatTime = (d) => new Date(d).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
const formatDate = (d) => new Date(d).toLocaleDateString('id-ID', {day:'numeric', month:'short'});


function readLastSensorSnapshot() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_SENSOR_STORAGE_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
}

function saveLastSensorSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    try { localStorage.setItem(LAST_SENSOR_STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* ignore quota */ }
}

function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getEngineRunning(data = {}) {
    const statusText = String(data.status || '').toUpperCase();
    const rpmValue = numberOrZero(data.rpm);
    return ['RUNNING', 'ON', 'ACTIVE'].includes(statusText) || rpmValue > 0;
}

function formatLastUpdated(date = new Date()) {
    return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';
}

function setDataStatus({ live = false, timestamp = null } = {}) {
    const statusEl = document.getElementById('dataLiveStatus');
    const lastEl = document.getElementById('lastUpdated');
    const dt = timestamp ? new Date(timestamp) : new Date();
    const safeDate = Number.isFinite(dt.getTime()) ? dt : new Date();

    if (statusEl) {
        statusEl.className = `conn-badge ${live ? 'conn-online' : 'conn-offline'}`;
        statusEl.innerHTML = live
            ? '<i class="fas fa-circle"></i> Live'
            : '<i class="fas fa-circle"></i> Data terakhir';
    }
    if (lastEl) lastEl.innerText = `Diperbarui: ${formatLastUpdated(safeDate)}`;
}

function setLoading(targetId, isLoading, message = 'Loading data...') {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (isLoading) {
        el.dataset.loading = 'true';
        el.innerHTML = `<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i> ${message}</div>`;
    } else {
        delete el.dataset.loading;
    }
}

function formatEstimatedRuntime(fuelPct) {
    const estHours = Math.max(0, (numberOrZero(fuelPct) / 100) * 8);
    return fmtHours(estHours);
}

function renderSensorSnapshot(data = {}, { live = false } = {}) {
    const snapshot = data && typeof data === 'object' ? data : {};
    const isRun = getEngineRunning(snapshot);

    setVal('val-rpm', `${Math.round(numberOrZero(snapshot.rpm)).toLocaleString('id-ID')} RPM`);
    setVal('val-volt', `${numberOrZero(snapshot.volt).toFixed(1)} V`);

    updateSyncStatus('engSync', snapshot);
    updatePowerSourceStatus(snapshot);

    const stateEl = document.getElementById('engStat');
    if (stateEl) {
        if (live && isRun) {
            stateEl.innerText = 'Live';
            stateEl.className = 'st-ok';
        } else if (isRun) {
            stateEl.innerText = 'Terakhir hidup';
            stateEl.className = 'st-warn';
        } else {
            stateEl.innerText = 'Sementara mati';
            stateEl.className = live ? 'st-err' : 'st-warn';
        }
    }

    const fuel = Math.round(numberOrZero(snapshot.fuel));
    const fuelEl = document.getElementById('fuelLevel');
    if (fuelEl) {
        fuelEl.innerText = `${fuel}%`;
        fuelEl.className = fuel < 20 ? 'st-err' : fuel < 30 ? 'st-warn' : 'st-ok';
    }

    const runtimeEl = document.getElementById('estRuntime');
    if (runtimeEl) {
        runtimeEl.innerText = formatEstimatedRuntime(fuel);
        runtimeEl.className = fuel >= 25 ? 'st-ok' : fuel >= 12 ? 'st-warn' : 'st-err';
    }

    checkLimit('st-volt', numberOrZero(snapshot.volt), 200, 240);
    checkLimit('st-amp',  numberOrZero(snapshot.amp),  0,   100);
    checkLimit('st-freq', numberOrZero(snapshot.freq), 48,  52);
    checkLimit('st-fuel', fuel,                        20,  100);
    checkLimit('st-map',  numberOrZero(snapshot.map),  20,  250);
    checkLimit('st-afr',  numberOrZero(snapshot.afr),  10,  18);
}

// --- UPDATE DASHBOARD ---
async function updateDashboard() {
    await Promise.allSettled([updateSensorData(), updateAuxiliaryData()]);
}

async function updateAuxiliaryData() {
    if (auxDashboardLoading) return;
    auxDashboardLoading = true;
    try {
        await Promise.allSettled([updateMaintenanceLog(), updateAlerts()]);
    } finally {
        auxDashboardLoading = false;
    }
}


function normalizeSyncStatus(data = {}) {
    if (data.synced !== undefined && data.synced !== null && data.synced !== '') {
        const value = typeof data.synced === 'string' ? data.synced.trim().toLowerCase() : data.synced;
        if ([true, 1, 'true', '1', 'on-grid', 'ongrid'].includes(value)) return 'ON-GRID';
        if ([false, 0, 'false', '0', 'off-grid', 'offgrid'].includes(value)) return 'OFF-GRID';
    }

    const rawSync = String(data.sync ?? data.syncStatus ?? data.gridStatus ?? '').trim().toUpperCase().replace(/\s+/g, '-');
    if (['ON-GRID', 'ONGRID', 'SYNC', 'SYNCHRONIZED'].includes(rawSync)) return 'ON-GRID';
    if (['OFF-GRID', 'OFFGRID', 'UNSYNC', 'UNSYNCHRONIZED'].includes(rawSync)) return 'OFF-GRID';
    return rawSync || 'UNKNOWN';
}


function getPowerSourceStatus(data = {}) {
    const syncStatus = normalizeSyncStatus(data);
    if (syncStatus === 'ON-GRID') {
        return { label: 'GRID', detail: 'Grid tersambung', ok: true };
    }
    if (syncStatus === 'OFF-GRID') {
        return { label: 'GENSET', detail: 'Genset tersambung', ok: true };
    }
    return { label: '--', detail: 'Supply source belum terdeteksi', ok: false };
}

function updatePowerSourceStatus(data) {
    const supply = getPowerSourceStatus(data);
    const overviewEl = document.getElementById('val-supply');
    if (overviewEl) overviewEl.innerText = supply.label;

    const detailEl = document.getElementById('engSupply');
    if (detailEl) {
        detailEl.innerText = supply.detail;
        detailEl.className = supply.ok ? 'st-ok' : 'st-err';
    }
}

function updateSyncStatus(id, data) {
    const el = document.getElementById(id);
    if (!el) return;
    const syncStatus = normalizeSyncStatus(data);
    el.innerText = syncStatus;
    el.className = syncStatus === 'ON-GRID' ? 'st-ok' : 'st-err';
}

// ─── 1. SENSOR DATA ──────────────────────────────────────────────────────────
// Lacak timestamp data terakhir yang berhasil diterima dari ESP32
let _lastSensorOkAt = null;
let _lastDisplayData = readLastSensorSnapshot();
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
                _handleDisconnect(data);
                return;
            }

            // Data fresh → catat waktu sukses
            _lastSensorOkAt = Date.now();
            _disconnectReported = false;

            _lastDisplayData = data;
            saveLastSensorSnapshot(data);
            renderSensorSnapshot(data, { live: true });
            setDataStatus({ live: true, timestamp: data.timestamp });
        }
    } catch (e) {
        console.warn('Sensor Error', e);
        _handleDisconnect();
    }
}

// Tandai ke server bahwa ESP32 terputus sehingga sesi aktif ditutup
let _disconnectReported = false;
async function _handleDisconnect(fallbackData = null) {
    const snapshot = fallbackData || _lastDisplayData || readLastSensorSnapshot();
    if (snapshot) {
        renderSensorSnapshot(snapshot, { live: false });
        setDataStatus({ live: false, timestamp: snapshot.timestamp });
    } else {
        setDataStatus({ live: false });
    }
    if (_disconnectReported) return;
    _disconnectReported = true;
    console.warn('ESP32 disconnect detected — closing active session');
    updatePowerSourceStatus({ sync: '' });
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
    const container = document.getElementById('maintenanceContainer');
    if (container && !container.children.length) setLoading('maintenanceContainer', true);
    try {
        const res = await fetch(`${API_URL}/maintenance`);
        if (!res.ok) return;

        const json      = await res.json();

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
    const container = document.getElementById('alertContainer');
    if (container && !container.children.length) setLoading('alertContainer', true, 'Loading alerts...');
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
    if (v == null || !Number.isFinite(Number(v))) { e.innerText = 'No data'; e.className = 'st-warn'; return; }
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
 * Sesi tanpa endedAt memakai effectiveEndedAt dari server agar waktu tidak terus
 * bertambah saat ECU sudah tidak terkoneksi. Sesi yang melintas tengah malam
 * dipecah per-hari secara proporsional.
 */
async function initChart() {
    if (activeChartLoading) return;
    activeChartLoading = true;
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) { activeChartLoading = false; return; }

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    const now = new Date();
    const dayMap = {};

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() + WIB_OFFSET - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        dayMap[key] = 0;
    }

    try {
        const res = await fetch(`${API_URL}/generator-active-time/daily?days=7`);
        const json = await res.json();

        if (json.success && Array.isArray(json.data)) {
            json.data.forEach((row) => {
                if (Object.prototype.hasOwnProperty.call(dayMap, row.date)) {
                    dayMap[row.date] = Number(row.hours) || 0;
                }
            });
        } else {
            throw new Error(json.error || 'Daily active time unavailable');
        }
    } catch (e) {
        console.warn('Daily active time fetch error, fallback to session history', e);
        try {
            const startDate = new Date(now.getTime() - 7 * 86400000).toISOString();
            const res = await fetch(`${API_URL}/generator-active-time/history?limit=500&startDate=${encodeURIComponent(startDate)}`);
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) {
                json.data.forEach(r => {
                    const start = new Date(r.startedAt);
                    const end = r.effectiveEndedAt ? new Date(r.effectiveEndedAt) : (r.endedAt ? new Date(r.endedAt) : now);
                    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;
                    _splitSessionByDay(start, end, WIB_OFFSET).forEach(({ dateKey, hours }) => {
                        if (Object.prototype.hasOwnProperty.call(dayMap, dateKey)) dayMap[dateKey] += hours;
                    });
                });
            }
        } catch (fallbackError) {
            console.warn('Active time history fallback error', fallbackError);
        }
    }

    const todayKey = new Date(now.getTime() + WIB_OFFSET).toISOString().slice(0, 10);
    const labels = [];
    const dataPoints = [];
    let todayHours = 0;

    Object.keys(dayMap).sort().forEach(key => {
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
            labels,
            datasets: [{
                label          : 'ECU Connected',
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
                tooltip: { callbacks: { label: ctx => ` ECU connected ${ctx.parsed.y} jam` } }
            },
            scales: {
                y: {
                    beginAtZero : true,
                    suggestedMax: 8,
                    title       : { display: true, text: 'Jam ECU Connected' },
                    ticks       : { callback: v => v + 'h' },
                    grid        : { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    const tEl = document.getElementById('engToday');
    if (tEl) tEl.innerText = fmtHours(todayHours);
    activeChartLoading = false;
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

    if (_lastDisplayData) renderSensorSnapshot(_lastDisplayData, { live: false });
    updateSensorData();
    updateAuxiliaryData();
    initChart();
    setInterval(updateSensorData, SENSOR_REFRESH_MS);
    setInterval(updateAuxiliaryData, AUX_REFRESH_MS);

    // Refresh active time secukupnya agar tidak membebani browser/server.
    setInterval(initChart, CHART_REFRESH_MS);

    // Trigger recalculate sesi hari ini di server setiap 10 menit
    async function triggerTodayRecalculate() {
        try {
            await fetch(`${API_URL}/daily-active-time/recalculate`, { method: 'POST' });
        } catch (e) { /* silent */ }
    }
    triggerTodayRecalculate();
    setInterval(triggerTodayRecalculate, 10 * 60 * 1000);
});
