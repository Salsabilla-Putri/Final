const API_URL = '/api';
let activeChart = null;
let activeChartLoading = false;
let auxDashboardLoading = false;
const SENSOR_REFRESH_MS = 500;
const AUX_REFRESH_MS = 15000;
const CHART_REFRESH_MS = 15000;
const LAST_SENSOR_STORAGE_KEY = 'gensys:last-engine-sensor';
const WIB_TIME_ZONE = 'Asia/Jakarta';
let sensorRequestSeq = 0;
let engineStream = null;
let lastStreamMessageAt = 0;

// --- UTILS ---
const formatTime = (d) => new Date(d).toLocaleTimeString('id-ID', { timeZone: WIB_TIME_ZONE, hour:'2-digit', minute:'2-digit' });
const formatDate = (d) => new Date(d).toLocaleDateString('id-ID', { timeZone: WIB_TIME_ZONE, day:'numeric', month:'short' });


function readLastSensorSnapshot() {
    if (typeof localStorage === 'undefined') return null;
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_SENSOR_STORAGE_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
}

function saveLastSensorSnapshot(data) {
    if (typeof localStorage === 'undefined') return;
    if (!data || typeof data !== 'object') return;
    try { localStorage.setItem(LAST_SENSOR_STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* ignore quota */ }
}

function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function getSaneDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith('millis:')) return null;

    const dateObj = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dateObj.getTime())) return null;

    const now = Date.now();
    const year = dateObj.getUTCFullYear();
    const tooOld = year < 2020;
    const tooFuture = dateObj.getTime() - now > 24 * 60 * 60 * 1000;
    const absurdYear = year > 2100;
    return (tooOld || tooFuture || absurdYear) ? null : dateObj;
}


function isGridOnlySnapshot(data = {}) {
    const source = String(data.powerSource || data.power_source || data.syncStatus || data.sync || '').trim().toUpperCase();
    return source === 'GRID' || source === 'PLN' || source === 'UTILITY';
}

function getDisplayVolt(data = {}) {
    if (isGridOnlySnapshot(data)) return numberOrZero(data.voltGrid ?? data.volt_grid ?? data.gridVolt ?? data.grid_voltage ?? data.volt);
    return numberOrZero(data.volt);
}

function getDisplayFreq(data = {}) {
    if (isGridOnlySnapshot(data)) return numberOrZero(data.freqGrid ?? data.freq_grid ?? data.gridFreq ?? data.grid_frequency ?? data.freq);
    return numberOrZero(data.freq);
}

function getLastDataTimestamp(data = {}) {
    const candidates = [
        data.timestamp,
        data.lastDataAt,
        data.deviceTimestamp,
        data.lastUpdated,
        data.serverReceivedAt,
        data.realtimeReceivedAt,
        data.lastMqttUpdate
    ];
    for (const candidate of candidates) {
        const saneDate = getSaneDate(candidate);
        if (saneDate) return saneDate;
    }
    return null;
}

function formatLastUpdated(date = new Date()) {
    return date.toLocaleString('id-ID', {
        timeZone: WIB_TIME_ZONE,
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }) + ' WIB';
}

function setDataStatus({ live = false, timestamp = null } = {}) {
    const statusEl = document.getElementById('dataLiveStatus');
    const lastEl = document.getElementById('lastUpdated');
    const dt = timestamp ? new Date(timestamp) : null;
    const safeDate = dt && Number.isFinite(dt.getTime()) ? dt : null;
    const label = live ? 'Live' : 'Data terakhir';
    const timestampText = safeDate ? ` • ${formatLastUpdated(safeDate)}` : '';

    if (statusEl) {
        statusEl.className = `conn-badge ${live ? 'conn-online' : 'conn-offline'}`;
        statusEl.innerHTML = `<i class="fas fa-circle"></i> ${label}${timestampText}`;
    }
    if (lastEl) {
        if (safeDate) {
            lastEl.style.display = '';
            lastEl.innerText = `Data terakhir: ${formatLastUpdated(safeDate)}`;
        } else {
            lastEl.style.display = 'none';
        }
    }
}


function setCanvasLoading(canvasId, isLoading, message = 'Loading data...') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const box = canvas.parentElement;
    if (!box) return;
    let loader = box.querySelector('.chart-loading-state');
    if (isLoading) {
        if (!loader) {
            loader = document.createElement('div');
            loader.className = 'chart-loading-state loading-state';
            box.appendChild(loader);
        }
        loader.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${message}`;
        canvas.style.display = 'none';
    } else {
        if (loader) loader.remove();
        canvas.style.display = '';
    }
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
    const disconnected = snapshot.ecuConnected === false;

    // Saat ECU disconnect, nilai sensor yang valid dari snapshot (data live terakhir)
    // tetap ditampilkan — hanya render ulang jika nilainya benar-benar ada (> 0 atau finite).
    // Ini mencegah glitch ke 0 ketika server mengirim payload disconnected dengan nilai kosong.
    const rawRpm  = numberOrZero(snapshot.rpm);
    const rawFuel = Math.round(numberOrZero(snapshot.fuel));

    const displayVolt = getDisplayVolt(snapshot);
    const displayFreq = getDisplayFreq(snapshot);

    // RPM
    const rpmEl = document.getElementById('val-rpm');
    if (rpmEl) rpmEl.innerText = `${Math.round(rawRpm)} RPM`;

    // Voltage overview
    const voltEl = document.getElementById('val-volt');
    if (voltEl) voltEl.innerText = `${Math.round(displayVolt)} V`;

    updatePowerSourceIndicator('engSync', snapshot);
    updatePowerSourceStatus(snapshot);

    // Engine state badge
    const stateEl = document.getElementById('engStat');
    if (stateEl) {
        if (disconnected) {
            stateEl.innerText = 'ECU Disconnected';
            stateEl.className = 'st-err';
        } else {
            stateEl.innerText = 'ECU Connected';
            stateEl.className = 'st-ok';
        }
    }

    // Fuel Level
    const fuelEl = document.getElementById('fuelLevel');
    if (fuelEl) {
        fuelEl.innerText = `${rawFuel}%`;
        fuelEl.className = rawFuel < 20 ? 'st-err' : rawFuel < 30 ? 'st-warn' : 'st-ok';
    }

    // Estimated Runtime
    const runtimeEl = document.getElementById('estRuntime');
    if (runtimeEl) {
        runtimeEl.innerText = formatEstimatedRuntime(rawFuel);
        runtimeEl.className = rawFuel >= 25 ? 'st-ok' : rawFuel >= 12 ? 'st-warn' : 'st-err';
    }

    // System Health — tampilkan nilai terakhir meski disconnect, tidak reset ke "No data"
    checkLimit('st-volt', displayVolt,                200, 240);
    checkLimit('st-amp',  numberOrZero(snapshot.amp),  0,   100);
    checkLimit('st-freq', displayFreq,                48,  52);
    checkLimit('st-fuel', rawFuel,                     20,  100);
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


function normalizeFourStatePowerSourceValue(value) {
    const key = String(value ?? '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
    if (['OFF', 'ECU-OFF', 'ECU-DISCONNECTED', 'DISCONNECTED', 'OFFLINE', 'NO-DATA'].includes(key)) return 'OFF';
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(key)) return 'SYNC';
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(key)) return 'GRID';
    if (['GENSET', 'GENERATOR', 'GEN', 'OFF-GRID', 'OFFGRID'].includes(key)) return 'GENSET';
    return null;
}

function normalizeSyncStatus(data = {}) {
    const fromSync = normalizeFourStatePowerSourceValue(data.sync ?? data.syncStatus ?? data.gridStatus);
    if (fromSync) return fromSync;

    if (data.synced !== undefined && data.synced !== null && data.synced !== '') {
        const value = typeof data.synced === 'string' ? data.synced.trim().toLowerCase() : data.synced;
        if ([true, 1, 'true', '1', 'on-grid', 'ongrid', 'sync'].includes(value)) return 'SYNC';
        if ([false, 0, 'false', '0'].includes(value)) return 'GENSET';
    }

    return 'UNKNOWN';
}

function isEcuDisconnected(data = {}) {
    if (data.ecuConnected === false) return true;
    const ts = data.realtimeReceivedAt || data.lastMqttUpdate;
    const time = ts ? new Date(ts).getTime() : NaN;
    return Number.isFinite(time) && Date.now() - time > DISCONNECT_THRESHOLD_MS;
}

function getPowerSourceStatus(data = {}) {
    if (isEcuDisconnected(data)) {
        return { label: 'OFF', detail: 'ECU disconnected', cls: 'st-err', ok: false };
    }

    const sourceState = normalizeFourStatePowerSourceValue(data.powerSource ?? data.power_source);
    const state = sourceState || normalizeSyncStatus(data);

    if (state === 'OFF') return { label: 'OFF', detail: 'ECU disconnected', cls: 'st-err', ok: false };
    if (state === 'SYNC') return { label: 'SYNC', detail: 'Sinkron dari ESP32', cls: 'st-ok', ok: true };
    if (state === 'GRID') return { label: 'GRID', detail: 'Grid dari ESP32', cls: 'st-ok', ok: true };
    if (state === 'GENSET') return { label: 'GENSET', detail: 'Genset dari payload ESP32', cls: 'st-warn', ok: true };
    return { label: '--', detail: 'Power source belum terdeteksi', cls: 'st-err', ok: false };
}

function updatePowerSourceStatus(data) {
    const supply = getPowerSourceStatus(data);
    const overviewEl = document.getElementById('val-supply');
    if (overviewEl) overviewEl.innerText = supply.label;
}

function updatePowerSourceIndicator(id, data) {
    const el = document.getElementById(id);
    if (!el) return;
    const supply = getPowerSourceStatus(data);
    el.innerText = supply.label;
    el.className = supply.cls;
}


// ─── 1. SENSOR DATA ──────────────────────────────────────────────────────────
// Lacak timestamp data terakhir yang berhasil diterima dari ESP32
let _lastSensorOkAt = null;
let _lastDisplayData = readLastSensorSnapshot();
// Jika selama DISCONNECT_THRESHOLD_MS tidak ada data masuk → anggap mesin mati
const DISCONNECT_THRESHOLD_MS = 10_000; // 10 detik tanpa MQTT = ECU disconnected

async function updateSensorData() {
    const requestSeq = ++sensorRequestSeq;
    try {
        const res = await fetch(`${API_URL}/engine-data/latest?_=${Date.now()}`, { cache: 'no-store' });
        if (requestSeq !== sensorRequestSeq) return;
        if (!res.ok) {
            _handleDisconnect();
            return;
        }
        const json = await res.json();

        if (json.success && json.data) {
            const data = json.data;

            // Cek apakah data dari ESP32 masih fresh (bukan stale data dari cache server)
            const lastTs = data.realtimeReceivedAt || data.lastMqttUpdate;
            const dataAge = Date.now() - new Date(lastTs || 0).getTime();
            if (data.ecuConnected === false || dataAge > DISCONNECT_THRESHOLD_MS) {
                _handleDisconnect(data);
                return;
            }

            applyLiveSensorData(data);
        }
    } catch (e) {
        console.warn('Sensor Error', e);
        _handleDisconnect();
    }
}

// Tandai ke server bahwa ESP32 terputus sehingga sesi aktif ditutup
let _disconnectReported = false;
async function _handleDisconnect(fallbackData = null) {
    // Selalu gunakan data live terakhir yang valid untuk nilai sensor (rpm, volt, fuel, dll.)
    // agar tidak glitch ke 0 saat ECU disconnect. fallbackData dari server bisa mengandung
    // nilai nol karena ECU sudah tidak mengirim data — jadi dipakai hanya sebagai last resort.
    const sensorSnapshot = _lastDisplayData || readLastSensorSnapshot() || fallbackData;
    if (sensorSnapshot) {
        renderSensorSnapshot({ ...sensorSnapshot, ecuConnected: false, powerSource: 'OFF' }, { live: false });
        setDataStatus({ live: false, timestamp: getLastDataTimestamp(sensorSnapshot) });
    } else {
        setDataStatus({ live: false });
    }
    if (_disconnectReported) return;
    _disconnectReported = true;
    console.warn('ESP32 disconnect detected — closing active session');
    updatePowerSourceStatus({ ecuConnected: false, powerSource: 'OFF' });
    updatePowerSourceIndicator('engSync', { ecuConnected: false, powerSource: 'OFF' });
    try {
        await fetch(`${API_URL}/active-session/close`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ reason: 'esp32_disconnect' })
        });
    } catch (e) { /* silent */ }
}


function applyLiveSensorData(data) {
    if (!data || typeof data !== 'object') return;

    _lastSensorOkAt = Date.now();
    _disconnectReported = false;
    _lastDisplayData = data;
    saveLastSensorSnapshot(data);
    renderSensorSnapshot(data, { live: true });
    setDataStatus({ live: true, timestamp: getLastDataTimestamp(data) });
}

function startEngineRealtimeStream() {
    if (!window.EventSource || engineStream) return;

    engineStream = new EventSource(`${API_URL}/engine-data/stream`);

    engineStream.onmessage = (event) => {
        try {
            const json = JSON.parse(event.data);
            if (!json.success || !json.data) return;

            const data = json.data;
            lastStreamMessageAt = Date.now();
            const lastTs = data.realtimeReceivedAt || data.lastMqttUpdate;
            const dataAge = Date.now() - new Date(lastTs || 0).getTime();

            if (data.ecuConnected === false || dataAge > DISCONNECT_THRESHOLD_MS) {
                _handleDisconnect(data);
                return;
            }

            applyLiveSensorData(data);
        } catch (error) {
            console.warn('Realtime stream parse error', error);
        }
    };

    engineStream.onerror = () => {
        // EventSource auto-reconnect. Polling 0,5 detik tetap berjalan sebagai fallback.
        if (Date.now() - lastStreamMessageAt > DISCONNECT_THRESHOLD_MS) _handleDisconnect();
    };
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
    if (!activeChart) setCanvasLoading('chartActive', true);

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    const now = new Date();
    const dayMap = {};

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = new Date(d.getTime() + WIB_OFFSET).toISOString().slice(0, 10);
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

    if (activeChart) {
        activeChart.data.labels = labels;
        activeChart.data.datasets[0].data = dataPoints;
        activeChart.data.datasets[0].backgroundColor = dataPoints.map((_, i) => i === dataPoints.length - 1 ? '#f97316' : 'rgba(23,69,165,0.8)');
        activeChart.update('none');
    } else {
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
                    title       : { display: true, text: 'Hours' },
                    ticks       : { callback: v => v + 'h' },
                    grid        : { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
        });
    }

    const tEl = document.getElementById('engToday');
    if (tEl) tEl.innerText = fmtHours(todayHours);
    setCanvasLoading('chartActive', false);
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
// Guard: file ini hanya berjalan di browser. Jika di-require() oleh Node.js
// (misal karena bundler atau server side), semua DOM/browser API dilewati
// agar tidak melempar ReferenceError: document is not defined.
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const renderClock = () => {
        const el = document.getElementById('clock');
        if (el) el.innerText = new Date().toLocaleTimeString('id-ID', { timeZone: WIB_TIME_ZONE, hour:'2-digit', minute:'2-digit' }) + ' WIB';
    };

    renderClock();
    setInterval(renderClock, 1000);

    if (_lastDisplayData) {
        renderSensorSnapshot(_lastDisplayData, { live: false });
        setDataStatus({ live: false, timestamp: getLastDataTimestamp(_lastDisplayData) });
    }
    startEngineRealtimeStream();
    updateSensorData();
    updateAuxiliaryData();
    initChart();
    setInterval(updateSensorData, SENSOR_REFRESH_MS);
    setInterval(updateAuxiliaryData, AUX_REFRESH_MS);

    // Refresh active time secukupnya agar chart tidak terus dibuat ulang dan membebani browser/server.
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
