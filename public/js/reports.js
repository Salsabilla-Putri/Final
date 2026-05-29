// public/js/reports.js
// ─────────────────────────────────────────────────────────────────────────────
// PERUBAHAN dari versi sebelumnya:
//   1. Dihapus: variabel cbmTrendChartInst, cbmFftChartInst, currentSuggestionPayload
//   2. Dihapus: fungsi runCbmAnalysis(), renderMaintenanceDecision(),
//               approveAndSchedule(), renderCbmCharts()
//      → Digantikan oleh public/js/cbm_panel.js yang lebih lengkap.
//   3. Ditambah: hook di applyRowsToReports() untuk auto-refresh CBM panel
//               saat data baru selesai dimuat.
// ─────────────────────────────────────────────────────────────────────────────

// === CONFIGURATION ===
const API_URL       = '/api/reports';
const API_STATS_URL = '/api/reports/stats';

// Konfigurasi Parameter
const SENSORS = {
    rpm:     { name: 'RPM',            unit: 'rpm', icon: 'fas fa-tachometer-alt',  color: '#1745a5' },
    volt:    { name: 'Voltage',        unit: 'V',   icon: 'fas fa-bolt',            color: '#f97316' },
    amp:     { name: 'Current',        unit: 'A',   icon: 'fas fa-plug',            color: '#ec4899' },
    freq:    { name: 'Frequency',      unit: 'Hz',  icon: 'fas fa-wave-square',     color: '#8b5cf6' },
    power:   { name: 'Power',          unit: 'kW',  icon: 'fas fa-charging-station',color: '#14b8a6' },
    temp:    { name: 'Engine Temp',    unit: '°C',  icon: 'fas fa-thermometer-half',color: '#ef4444' },
    coolant: { name: 'Coolant',        unit: '°C',  icon: 'fas fa-snowflake',       color: '#06b6d4' },
    fuel:    { name: 'Fuel',           unit: '%',   icon: 'fas fa-gas-pump',        color: '#10b981' },
    iat:     { name: 'Intake Air',     unit: '°C',  icon: 'fas fa-wind',            color: '#f59e0b' },
    batt:    { name: 'Battery Voltage',unit: 'V',   icon: 'fas fa-car-battery',     color: '#6366f1' },
    afr:     { name: 'AFR',            unit: '',    icon: 'fas fa-burn',            color: '#3b82f6' },
    phase:   { name: 'Phase Difference', unit: '°',   icon: 'fas fa-code-compare',    color: '#0ea5e9' }
};

const SENSOR_LIMITS = {
    rpm:     { min: 0,   max: 5000 },
    volt:    { min: 0,   max: 300  },
    amp:     { min: 0,   max: 500  },
    freq:    { min: 0,   max: 80   },
    power:   { min: 0,   max: 2000 },
    temp:    { min: -20, max: 180  },
    coolant: { min: -20, max: 180  },
    fuel:    { min: 0,   max: 100  },
    iat:     { min: -20, max: 120  },
    batt:    { min: 0,   max: 24   },
    afr:     { min: 0,   max: 40   },
    phase:   { min: -180,max: 180  }
};

let myChart               = null;
let fftChart              = null;
let currentData           = [];
let selectedSensors       = ['rpm'];
let activeRange           = { start: null, end: null };
let reportStatsBySensor   = null;
let reportTotalMatched    = 0;
let periodAlertCount      = 0;

function getReportDeviceId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('deviceId')
        || localStorage.getItem('reportDeviceId')
        || 'ESP32_GENERATOR_01';
}

// --- 1. CHART MANAGEMENT ---
function destroyChart() {
    try {
        if (myChart) { myChart.destroy(); myChart = null; }
    } catch (e) { console.warn('Error destroying chart:', e); myChart = null; }
}

// --- 2. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('Reports.js initialized');
    initDatePickers();
    setupEventListeners();
    loadReportData();
});

// --- 3. DATE PICKER ---
function initDatePickers() {
    const now       = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    const fmt = (date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    const dateRangeDiv = document.querySelector('.date-range');
    if (dateRangeDiv) {
        let dateSelector = dateRangeDiv.querySelector('.date-selector');
        if (!dateSelector) {
            dateSelector = document.createElement('div');
            dateSelector.className = 'date-selector';
            const applyBtn = dateRangeDiv.querySelector('.apply-btn');
            dateRangeDiv.insertBefore(dateSelector, applyBtn);
        }
        dateSelector.innerHTML = `
            <div>
                <label style="font-size:12px; color:#666;">Start Date</label>
                <input type="date" id="dateFrom" class="date-input"
                       style="padding:8px; border:1px solid #d0d7e1; border-radius:4px; width:150px;">
            </div>
            <div style="align-self:center; margin:0 10px; color:#666;">to</div>
            <div>
                <label style="font-size:12px; color:#666;">End Date</label>
                <input type="date" id="dateTo" class="date-input"
                       style="padding:8px; border:1px solid #d0d7e1; border-radius:4px; width:150px;">
            </div>`;
    }

    const dateFrom = document.getElementById('dateFrom');
    const dateTo   = document.getElementById('dateTo');
    if (dateFrom) { dateFrom.value = fmt(yesterday); dateFrom.max = fmt(now); }
    if (dateTo)   { dateTo.value   = fmt(now);       dateTo.max   = fmt(now); }
    if (dateFrom && dateTo) dateTo.min = dateFrom.value;
}

// --- 4. SENSOR SELECTOR ---
const FFT_SENSORS = ['rpm', 'volt', 'freq'];

function selectSingleSensor(key) {
    if (!SENSORS[key]) return;
    selectedSensors = [key];

    document.querySelectorAll('.sensor-card').forEach(card => {
        card.classList.toggle('active-sensor', card.dataset.sensor === key);
    });

    if (currentData.length > 0) {
        renderChart(currentData);
        updateChartTitle(
            document.getElementById('dateFrom')?.value,
            document.getElementById('dateTo')?.value
        );
    }

    const analysisPanelEl = document.querySelector('.analysis-panel');
    if (analysisPanelEl) {
        if (FFT_SENSORS.includes(key)) {
            analysisPanelEl.style.display = '';
            if (currentData.length > 0) renderFftAnalysis(currentData);
        } else {
            analysisPanelEl.style.display = 'none';
        }
    }
}

// --- 5. EVENT LISTENERS ---
function setupEventListeners() {
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            updateDateFromHours(this.getAttribute('data-hours'));
            loadReportData();
        });
    });

    document.getElementById('applyDateRange')?.addEventListener('click', loadReportData);

    document.addEventListener('change', function (e) {
        if (e.target.id === 'dateFrom') {
            const dateTo = document.getElementById('dateTo');
            if (dateTo) dateTo.min = e.target.value;
        }
    });

    document.addEventListener('keypress', function (e) {
        if ((e.target.id === 'dateFrom' || e.target.id === 'dateTo') && e.key === 'Enter') {
            loadReportData();
        }
    });

    document.getElementById('toggleExport')?.addEventListener('click', toggleExportOptions);
    document.getElementById('printChart')?.addEventListener('click', printChart);
    document.getElementById('recalculateFft')?.addEventListener('click', () => renderFftAnalysis(currentData));
}

function updateDateFromHours(hours) {
    const now  = new Date();
    const past = new Date(now.getTime() - (hours * 60 * 60 * 1000));

    const fmt = (date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    const dateFrom = document.getElementById('dateFrom');
    const dateTo   = document.getElementById('dateTo');
    if (dateFrom) dateFrom.value = fmt(past);
    if (dateTo)   dateTo.value   = fmt(now);
    if (dateFrom && dateTo) dateTo.min = dateFrom.value;
}

function cleanSensorValue(sensorKey, rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return null;
    const limits = SENSOR_LIMITS[sensorKey];
    if (!limits) return parsed;
    if (parsed < limits.min || parsed > limits.max) return null;
    return parsed;
}

function deduplicateByTimestamp(rows) {
    const byTime = new Map();

    rows.forEach((row) => {
        const ts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(ts)) return;

        if (!byTime.has(ts)) { byTime.set(ts, { ...row, __count: 1 }); return; }

        const prev   = byTime.get(ts);
        const merged = { ...prev, __count: prev.__count + 1 };

        Object.keys(SENSORS).forEach((sensorKey) => {
            const a = Number(prev[sensorKey]);
            const b = Number(row[sensorKey]);
            if      (Number.isFinite(a) && Number.isFinite(b)) merged[sensorKey] = (a + b) / 2;
            else if (!Number.isFinite(a) && Number.isFinite(b)) merged[sensorKey] = b;
        });

        byTime.set(ts, merged);
    });

    return [...byTime.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, row]) => { const n = { ...row }; delete n.__count; return n; });
}

function removeSpikeNoise(rows) {
    if (!Array.isArray(rows) || rows.length < 5) return rows;

    const cleanRows    = rows.map((row) => ({ ...row }));
    const windowRadius = 2;

    Object.keys(SENSORS).forEach((sensorKey) => {
        const series = cleanRows.map((row) => Number(row[sensorKey]));

        for (let i = 0; i < series.length; i++) {
            const curr = series[i];
            if (!Number.isFinite(curr)) continue;

            const start        = Math.max(0, i - windowRadius);
            const end          = Math.min(series.length - 1, i + windowRadius);
            const neighborhood = [];

            for (let j = start; j <= end; j++) {
                if (j === i) continue;
                const value = series[j];
                if (Number.isFinite(value)) neighborhood.push(value);
            }

            if (neighborhood.length < 3) continue;

            const sorted     = [...neighborhood].sort((a, b) => a - b);
            const median     = sorted[Math.floor(sorted.length / 2)];
            const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
            const mad        = deviations[Math.floor(deviations.length / 2)] || 0;

            if (mad === 0) continue;

            const robustZ = Math.abs(curr - median) / (1.4826 * mad);
            if (robustZ > 4.5) cleanRows[i][sensorKey] = null;
        }
    });

    return cleanRows;
}

function normalizeReportRows(rows) {
    if (!Array.isArray(rows)) return [];

    const normalized = rows.map((row) => {
        const tempVal      = row.temp ?? row.temperature;
        const powerKw      = row.power ?? row.kw;
        const timestampRaw = row.timestamp || row.createdAt || row.date || row.waktu || null;
        const ts           = new Date(timestampRaw || '').getTime();
        if (!Number.isFinite(ts)) return null;

        const normalizedRow = {
            ...row,
            timestamp: new Date(ts).toISOString(),
            temp:    cleanSensorValue('temp',    tempVal),
            coolant: cleanSensorValue('coolant', row.coolant ?? tempVal),
            power:   cleanSensorValue('power',   powerKw)
        };

        Object.keys(SENSORS).forEach((sensorKey) => {
            if (sensorKey === 'temp' || sensorKey === 'coolant' || sensorKey === 'power') return;
            const rawValue = sensorKey === 'phase'
                ? (row.phase ?? row.phaseAngle ?? row.phase_angle ?? row.phaseDiff)
                : row[sensorKey];
            normalizedRow[sensorKey] = cleanSensorValue(sensorKey, rawValue);
        });

        return normalizedRow;
    }).filter(Boolean);

    const deduplicated = deduplicateByTimestamp(normalized);
    return removeSpikeNoise(deduplicated);
}

// --- 6. DATA FETCHING ---
function getApiBaseCandidates() {
    const candidates = [''];
    if (typeof window !== 'undefined' && window.location) {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        if (pathSegments.length > 1) {
            const basePath = `/${pathSegments.slice(0, -1).join('/')}`;
            if (basePath && !candidates.includes(basePath)) candidates.push(basePath);
        }
    }
    return candidates;
}

function buildApiCandidates(endpointPath, queryString = '') {
    const suffix = queryString ? `?${queryString}` : '';
    return getApiBaseCandidates().map((basePath) => `${basePath}${endpointPath}${suffix}`);
}

async function fetchFirstAvailable(urls) {
    let lastResponse = null;

    for (const url of urls) {
        let response;
        try { response = await fetch(url); }
        catch (networkErr) { console.warn(`Network error fetching ${url}:`, networkErr.message); continue; }

        const contentType   = (response.headers.get('content-type') || '').toLowerCase();
        const looksLikeJson = contentType.includes('application/json')
            || contentType.includes('text/json')
            || contentType.includes('application/problem+json');
        const looksLikeHtml = contentType.includes('text/html');

        if (response.ok) {
            if (looksLikeJson) return response;
            if (looksLikeHtml) {
                console.warn(`[fetchFirstAvailable] ${url} returned HTML — skipping.`);
                lastResponse = response; continue;
            }
            if (!contentType) return response;
            lastResponse = response; continue;
        }

        if (response.status === 503) { lastResponse = response; continue; }
        if (response.status !== 404) return response;

        lastResponse = response;
    }

    return lastResponse;
}

async function fetchWithFallback(primaryUrls, fallbackUrls = []) {
    const primaryResponse    = await fetchFirstAvailable(primaryUrls);
    const primaryContentType = (primaryResponse?.headers?.get('content-type') || '').toLowerCase();
    const primaryLooksLikeJson = !primaryResponse
        ? false
        : !primaryContentType
            || primaryContentType.includes('application/json')
            || primaryContentType.includes('application/problem+json')
            || primaryContentType.includes('text/json');

    if (
        primaryResponse
        && (primaryResponse.ok || primaryResponse.status !== 404 || !fallbackUrls.length)
        && (primaryResponse.status !== 200 || primaryLooksLikeJson || !fallbackUrls.length)
    ) return primaryResponse;

    console.warn(`Primary reports endpoints unavailable. Falling back to ${fallbackUrls.join(', ')}.`);
    return fetchFirstAvailable(fallbackUrls);
}

function buildReportUrls({ startDate, endDate, requestLimit, deviceId }) {
    const baseParams = { limit: String(requestLimit) };
    if (deviceId) baseParams.deviceId = deviceId;

    if (startDate && endDate) {
        const params = new URLSearchParams({
            ...baseParams,
            startDate: startDate.toISOString(),
            endDate:   endDate.toISOString()
        }).toString();
        return {
            primaryUrls:  buildApiCandidates(API_URL,                   params),
            fallbackUrls: buildApiCandidates('/api/engine-data/history', params)
        };
    }

    const params = new URLSearchParams({ ...baseParams, hours: '24' }).toString();
    return {
        primaryUrls:  buildApiCandidates(API_URL,                   params),
        fallbackUrls: buildApiCandidates('/api/engine-data/history', params)
    };
}

// --- 6b. DEDICATED STATS FETCH ---
async function fetchDbStats(startDate, endDate, deviceId) {
    try {
        const baseParams = {};
        if (deviceId) baseParams.deviceId = deviceId;
        if (startDate && endDate) {
            baseParams.startDate = startDate.toISOString();
            baseParams.endDate   = endDate.toISOString();
        } else {
            baseParams.hours = '24';
        }

        const params   = new URLSearchParams(baseParams).toString();
        const urls     = buildApiCandidates(API_STATS_URL, params);
        const response = await fetchFirstAvailable(urls);

        if (response.status === 404) return null;
        if (!response.ok) { console.warn(`fetchDbStats: HTTP ${response.status}`); return null; }

        const result = await response.json();
        const stats  = result?.stats ?? result ?? null;
        return stats;
    } catch (err) { console.warn('fetchDbStats failed:', err); return null; }
}

function createDemoRows() {
    const now     = Date.now();
    const offsets = [5, 4, 3, 2, 1, 0];
    return offsets.map((hourOffset, index) => ({
        timestamp: new Date(now - hourOffset * 60 * 60 * 1000).toISOString(),
        rpm: 1480 + index * 18, volt: 221 + (index % 2), amp: 28 + index,
        power: 620 + index * 22, freq: 50 + ((index % 2) * 0.08),
        temp: 76 + index, coolant: 76 + index, fuel: 68 - index,
        iat: 31 + (index * 0.4), batt: 12.4 + (Math.random() * 0.8),
        afr: 14.1 + (index * 0.05), tps: 34 + index, status: 'DEMO', sync: 'SIMULATED'
    }));
}

async function fetchLatestSnapshotRows() {
    const deviceId = getReportDeviceId();
    const query    = deviceId ? new URLSearchParams({ deviceId }).toString() : '';
    const response = await fetchFirstAvailable(buildApiCandidates('/api/engine-data/latest', query));
    if (!response.ok) throw new Error(`Latest snapshot error: ${response.status}`);

    const result = await response.json();
    const data   = result?.data ? [result.data] : [];
    return { result, rows: normalizeReportRows(data) };
}

async function fetchLatestEspFft({ startDate, endDate, deviceId, source }) {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate.toISOString());
    if (endDate) params.set('endDate', endDate.toISOString());
    if (deviceId) params.set('deviceId', deviceId);
    if (source) params.set('source', source);

    const response = await fetchFirstAvailable(buildApiCandidates('/api/fft/latest', params.toString()));
    if (!response || !response.ok) return null;
    const result = await response.json();
    return result?.data || null;
}

async function fetchPeriodAlertCount({ startDate, endDate, deviceId }) {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate.toISOString());
    if (endDate)   params.set('endDate',   endDate.toISOString());
    if (deviceId)  params.set('deviceId',  deviceId);

    const response = await fetchFirstAvailable(buildApiCandidates('/api/alerts/count', params.toString()));
    if (!response || !response.ok) return 0;
    const result = await response.json();
    return Number(result?.count) || 0;
}

function renderDataSourceNotice({ source, mode = 'info', message }) {
    const noticeEl = document.getElementById('dataSourceNotice');
    if (!noticeEl) return;

    const presets = {
        success: { icon: 'fa-circle-check',       className: 'notice-success' },
        warning: { icon: 'fa-triangle-exclamation', className: 'notice-warning' },
        info:    { icon: 'fa-circle-info',          className: '' }
    };

    const preset = presets[mode] || presets.info;
    noticeEl.className = `data-source-notice ${preset.className}`.trim();
    noticeEl.innerHTML = `
        <i class="fas ${preset.icon}"></i>
        <div>
            <strong>${message}</strong>
            ${source ? `<div style="margin-top:4px; font-size:13px; opacity:0.9;">Mode tampilan: ${source}</div>` : ''}
        </div>`;
    noticeEl.style.display = 'flex';
}

// ── NEW: Trigger CBM panel refresh after data load ───────────────────────────
function _triggerCbmRefresh() {
    // cbm_panel.js registers window.CBMPanel when it initialises.
    // We call it with a short delay so the main chart rendering finishes first.
    if (typeof window.CBMPanel?.reload === 'function') {
        setTimeout(() => window.CBMPanel.reload(false), 300);
    }
}

function applyRowsToReports(rows, meta = {}) {
    currentData          = normalizeReportRows(rows);
    reportStatsBySensor  = meta?.stats?.bySensor || null;
    reportTotalMatched   = Number(meta?.stats?.totalMatched) || 0;
    const deviceInfo     = meta?.deviceIdUsed ? `device ${meta.deviceIdUsed}` : '';

    if (currentData.length > 0) {
        updateOverview(currentData);
        renderSensorCards(currentData);
        renderChart(currentData);

        const analysisPanelEl = document.querySelector('.analysis-panel');
        const activeSensor    = selectedSensors[0] || 'rpm';
        if (analysisPanelEl) {
            analysisPanelEl.style.display = FFT_SENSORS.includes(activeSensor) ? '' : 'none';
        }
        if (FFT_SENSORS.includes(activeSensor)) renderFftAnalysis(currentData);

        updateChartTitle(document.getElementById('dateFrom')?.value, document.getElementById('dateTo')?.value);

        if (meta.source === 'demo') {
            renderDataSourceNotice({ source: 'preview', mode: 'info',
                message: 'Mode pratinjau aktif. Halaman menampilkan contoh data lokal.' });
        } else if (meta.source === 'memory') {
            renderDataSourceNotice({
                source: ['snapshot', deviceInfo].filter(Boolean).join(' • '),
                mode: 'warning',
                message: 'Data historis belum tersedia. Menampilkan snapshot terakhir.'
            });
        } else {
            renderDataSourceNotice({
                source: [meta.source || 'live data', deviceInfo].filter(Boolean).join(' • '),
                mode: 'success', message: 'Data berhasil dimuat.'
            });
        }

        // ── Trigger CBM panel setelah data baru berhasil dimuat ──
        _triggerCbmRefresh();

        return true;
    }

    return false;
}

async function loadReportData() {
    console.log('Loading report data...');
    reportStatsBySensor = null;
    reportTotalMatched  = 0;
    periodAlertCount    = 0;
    const deviceId      = getReportDeviceId();

    const loadingEl   = document.getElementById('sensorsLoading');
    const containerEl = document.getElementById('sensorsContainer');

    if (loadingEl)   loadingEl.style.display   = 'block';
    if (containerEl) containerEl.style.display = 'none';

    try {
        const dateFrom = document.getElementById('dateFrom');
        const dateTo   = document.getElementById('dateTo');

        let requestLimit = 5000;
        let urls;
        let rangeStart = null;
        let rangeEnd   = null;

        if (dateFrom && dateTo && dateFrom.value && dateTo.value) {
            const startDate = new Date(dateFrom.value);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(dateTo.value);
            endDate.setHours(23, 59, 59, 999);

            if (endDate < startDate) { showError('End date must be after start date'); return; }

            activeRange.start = startDate.getTime();
            activeRange.end   = endDate.getTime();
            rangeStart = startDate;
            rangeEnd   = endDate;

            const rangeDays  = Math.max(1, Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000)));
            requestLimit     = Math.min(100000, Math.max(5000, rangeDays * 2880));
            urls             = buildReportUrls({ startDate, endDate, requestLimit, deviceId });
        } else {
            requestLimit      = 10000;
            urls              = buildReportUrls({ requestLimit, deviceId });
            activeRange.start = null;
            activeRange.end   = null;
            rangeStart        = new Date(Date.now() - 24 * 60 * 60 * 1000);
            rangeEnd          = new Date();
        }

        const [response, separateDbStats] = await Promise.all([
            fetchWithFallback(urls.primaryUrls, urls.fallbackUrls),
            fetchDbStats(rangeStart, rangeEnd, deviceId)
        ]);

        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
            const raw = await response.text();
            console.error('Non-JSON response:', raw.substring(0, 200));
            throw new Error(`Server returned non-JSON response (${contentType || 'unknown'}). Pastikan endpoint /api/reports terdaftar.`);
        }

        const result = await response.json();
        const rows   = Array.isArray(result) ? result : (result.data || []);
        periodAlertCount = await fetchPeriodAlertCount({ startDate: rangeStart, endDate: rangeEnd, deviceId });

        const metaWithStats = {
            ...result,
            stats: separateDbStats || result?.stats || null
        };

        if ((result.success !== false) && rows) {
            if (!applyRowsToReports(rows, metaWithStats)) {
                const snapshot = await fetchLatestSnapshotRows();
                if (!applyRowsToReports(snapshot.rows, { ...snapshot.result, source: 'memory' })) {
                    renderDataSourceNotice({ source: 'empty range', mode: 'warning',
                        message: 'Belum ada data sensor untuk rentang waktu ini.' });
                    showNoDataMessage();
                }
            }
        } else {
            throw new Error(result.error || 'No data received');
        }

    } catch (error) {
        console.error('Error loading data:', error);

        const isDbNotReady  = error.message?.includes('503') || error.message?.includes('not ready');
        const isHtmlResp    = error.message?.includes('non-JSON') || error.message?.includes('text/html');

        if (isHtmlResp) {
            renderDataSourceNotice({ source: null, mode: 'warning',
                message: '⚠️ Server mengembalikan halaman HTML bukan data. Periksa koneksi server.' });
        } else if (isDbNotReady) {
            renderDataSourceNotice({ source: null, mode: 'warning',
                message: '⏳ Database belum siap. Klik "Apply" dalam beberapa detik...' });
        }

        try {
            const snapshot = await fetchLatestSnapshotRows();
            if (!applyRowsToReports(snapshot.rows, { ...snapshot.result, source: 'memory', warning: error.message })) {
                renderDataSourceNotice({ source: 'snapshot', mode: 'warning',
                    message: 'Data histori belum bisa diambil, mencoba snapshot terakhir.' });
                showNoDataMessage();
            }
        } catch (snapshotError) {
            applyRowsToReports(createDemoRows(), { source: 'demo' });
        }
    } finally {
        if (loadingEl)   loadingEl.style.display   = 'none';
        if (containerEl) containerEl.style.display = 'grid';
    }
}

// --- BUCKET / AGGREGATION HELPERS ---
function buildContinuousBuckets(aggregatedData, bucketMs, startMs, endMs) {
    if (!Array.isArray(aggregatedData) || !bucketMs || !Number.isFinite(startMs) || !Number.isFinite(endMs))
        return aggregatedData || [];

    const byTs = new Map();
    aggregatedData.forEach((row) => {
        const t = new Date(row.timestamp).getTime();
        if (Number.isFinite(t)) byTs.set(t, row);
    });

    const alignedStart = Math.floor(startMs / bucketMs) * bucketMs;
    const alignedEnd   = Math.floor(endMs   / bucketMs) * bucketMs;
    const rows = [];

    for (let t = alignedStart; t <= alignedEnd; t += bucketMs) {
        if (byTs.has(t)) { rows.push(byTs.get(t)); continue; }
        const emptyRow = { timestamp: new Date(t).toISOString() };
        Object.keys(SENSORS).forEach((key) => { emptyRow[key] = null; });
        rows.push(emptyRow);
    }

    return rows;
}

function buildTrendInsights(displayData, sensorKey) {
    const values = displayData.map((row) => Number(row[sensorKey])).filter((v) => Number.isFinite(v));
    if (!values.length) return ['Data belum cukup untuk analisis tren sensor pada rentang ini.'];

    const first = values[0];
    const last  = values[values.length - 1];
    const min   = Math.min(...values);
    const max   = Math.max(...values);
    const avg   = values.reduce((a, b) => a + b, 0) / values.length;
    const trend = last > first ? 'naik' : (last < first ? 'turun' : 'stabil');

    const insights = [
        `${(SENSORS[sensorKey]?.name || sensorKey)} cenderung ${trend} (${first.toFixed(1)} → ${last.toFixed(1)}).`,
        `Rentang nilai ${min.toFixed(1)} - ${max.toFixed(1)} dengan rata-rata ${avg.toFixed(1)}.`
    ];

    if (sensorKey === 'volt') {
        insights.push(min >= 200 && max <= 240
            ? 'Tegangan relatif stabil dalam rentang operasional.'
            : 'Tegangan keluar dari rentang ideal, perlu pengecekan regulator/beban.');
    }

    return insights;
}

function computeTimeRange(data) {
    if (!Array.isArray(data) || data.length < 2) return 0;
    const stamps = data.map((d) => new Date(d.timestamp).getTime()).filter((t) => Number.isFinite(t));
    if (stamps.length < 2) return 0;
    return Math.max(...stamps) - Math.min(...stamps);
}

function getBucketMsByRange(timeRange) {
    const hour = 60 * 60 * 1000;
    const day  = 24 * hour;
    if (timeRange > 120 * day) return 3 * day;
    if (timeRange > 45  * day) return 2 * day;
    if (timeRange > 7   * day) return 1 * day;
    if (timeRange > 2   * day) return 6 * hour;
    if (timeRange > day)       return 30 * 60 * 1000;
    return 5 * 60 * 1000;
}

function aggregateDataByTimeBuckets(data, bucketMs) {
    if (!Array.isArray(data) || !data.length || !bucketMs) return data || [];

    const sorted  = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const buckets = new Map();

    sorted.forEach((row) => {
        const ts          = new Date(row.timestamp).getTime();
        if (!Number.isFinite(ts)) return;
        const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
        const key         = String(bucketStart);

        if (!buckets.has(key)) buckets.set(key, { timestamp: new Date(bucketStart).toISOString(), count: 0, sums: {} });

        const b = buckets.get(key);
        b.count += 1;

        Object.keys(SENSORS).forEach((sensorKey) => {
            const v = Number(row[sensorKey]);
            if (Number.isFinite(v)) b.sums[sensorKey] = (b.sums[sensorKey] || 0) + v;
        });
    });

    const aggregated = [];
    buckets.forEach((b) => {
        const row = { timestamp: b.timestamp };
        Object.keys(SENSORS).forEach((sensorKey) => {
            if (b.sums[sensorKey] != null) row[sensorKey] = b.sums[sensorKey] / b.count;
        });
        aggregated.push(row);
    });

    return aggregated.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function buildAnalysisRows(data, sensorKey) {
    const timeRange  = computeTimeRange(data);
    const bucketMs   = getBucketMsByRange(timeRange);
    let aggregated   = aggregateDataByTimeBuckets(data, bucketMs);
    if (Number.isFinite(activeRange.start) && Number.isFinite(activeRange.end)) {
        aggregated = buildContinuousBuckets(aggregated, bucketMs, activeRange.start, activeRange.end);
    }
    aggregated = aggregated.filter((row) => Number.isFinite(Number(row[sensorKey])));

    const maxRows = 1200;
    const reduced = aggregated.length > maxRows
        ? aggregated.filter((_, i) => i % Math.ceil(aggregated.length / maxRows) === 0)
        : aggregated;

    return reduced.map((row) => ({ timestamp: row.timestamp, [sensorKey]: row[sensorKey] }));
}

// --- 7. CHART FUNCTIONS ---
function renderChart(data) {
    destroyChart();

    const canvas = document.getElementById('mainChart');
    if (!canvas) return;

    if (!data || data.length === 0) { return; }

    try {
        const { labels, datasets, timeRange, bucketMs, yScale, displayData } = prepareChartData(data);

        myChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: getChartOptions(timeRange, yScale)
        });

        const insightLines = buildTrendInsights(displayData, selectedSensors[0] || 'rpm');
        updateChartDescription(bucketMs, labels.length, insightLines);
    } catch (error) {
        console.error('Error creating chart:', error);
    }
}

function destroyFftChart() {
    try { if (fftChart) { fftChart.destroy(); fftChart = null; } }
    catch (e) { console.warn('Error destroying FFT chart:', e); fftChart = null; }
}

function calculateMedian(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid    = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function estimateSampleRate(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return 1;
    const sorted = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const deltas = [];
    for (let i = 1; i < sorted.length; i++) {
        const prev   = new Date(sorted[i - 1].timestamp).getTime();
        const curr   = new Date(sorted[i].timestamp).getTime();
        const dtSec  = (curr - prev) / 1000;
        if (Number.isFinite(dtSec) && dtSec > 0) deltas.push(dtSec);
    }
    const medianDt = calculateMedian(deltas);
    return medianDt > 0 ? 1 / medianDt : 1;
}

function detectFftPeaks(spectrum, maxPeaks = 3) {
    if (!Array.isArray(spectrum) || spectrum.length < 3) return [];
    const candidates = [];
    for (let i = 1; i < spectrum.length - 1; i++) {
        const left  = spectrum[i - 1].amp;
        const mid   = spectrum[i].amp;
        const right = spectrum[i + 1].amp;
        if (mid >= left && mid >= right) candidates.push(spectrum[i]);
    }
    return candidates.sort((a, b) => b.amp - a.amp).slice(0, maxPeaks);
}

function calculateFftLocally(rows, sensorKey) {
    const prepared = buildAnalysisRows(rows || [], sensorKey);
    const values   = prepared.map((row) => Number(row[sensorKey])).filter((v) => Number.isFinite(v));

    if (values.length < 16) {
        return {
            summary:  'Data belum cukup untuk FFT (minimal 16 sampel valid).',
            stats:    { count: values.length, mean: 0, trend: 'n/a' },
            spectrum: [],
            peaks:    []
        };
    }

    const sampleRate = estimateSampleRate(prepared);
    const n          = Math.min(values.length, 512);
    const signal     = values.slice(-n);
    const mean       = signal.reduce((a, b) => a + b, 0) / signal.length;
    const centered   = signal.map((v, i) => {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
        return (v - mean) * hann;
    });

    const half     = Math.floor(centered.length / 2);
    const spectrum = [];
    for (let k = 0; k <= half; k++) {
        let real = 0, imag = 0;
        for (let t = 0; t < centered.length; t++) {
            const angle = (2 * Math.PI * k * t) / centered.length;
            real += centered[t] * Math.cos(angle);
            imag -= centered[t] * Math.sin(angle);
        }
        const amp  = Math.sqrt(real * real + imag * imag) / centered.length;
        const freq = (k * sampleRate) / centered.length;
        spectrum.push({ freq, amp });
    }

    const significantSpectrum = spectrum.slice(1).filter((p) => p.freq > 0);
    const peaks               = detectFftPeaks(significantSpectrum, 3);
    const trend               = signal[signal.length - 1] > signal[0]
        ? 'increasing' : signal[signal.length - 1] < signal[0] ? 'decreasing' : 'stable';
    const peakText            = peaks.length
        ? peaks.map((p) => `${p.freq.toFixed(3)} Hz`).join(', ')
        : 'tidak ada frekuensi dominan';

    return {
        summary:  `FFT lokal dari ${signal.length} sampel (fs ${sampleRate.toFixed(3)} Hz). Dominan: ${peakText}.`,
        stats:    { count: signal.length, mean, trend },
        spectrum: significantSpectrum,
        peaks
    };
}


function extractEspFftFromRows(rows, sensorKey) {
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const latestRow = rows[rows.length - 1] || {};
    let fft = latestRow.fft;

    if (!fft && typeof latestRow.fft_json === 'string') {
        try { fft = JSON.parse(latestRow.fft_json); } catch (_) { fft = null; }
    }
    if (!fft) return null;
    const freqBinsCandidate = Array.isArray(fft.freqBins) ? fft.freqBins : [];
    const magBinsCandidate = Array.isArray(fft.magBins) ? fft.magBins : [];
    if (fft.valid === false && (!freqBinsCandidate.length || !magBinsCandidate.length)) return null;

    const source = String(fft.source || '').toLowerCase();
    const normalizedSensor = String(sensorKey || '').toLowerCase();

    const sensorAliases = {
        rpm: ['rpm', 'rpm_fft', 'speed', 'rotation'],
        freq: ['freq', 'freq_fft', 'frequency', 'hz'],
        volt: ['volt', 'volt_fft', 'voltage', 'v']
    };
    const aliases = sensorAliases[normalizedSensor] || [normalizedSensor];
    const sourceMatchesSensor = !normalizedSensor || !source || aliases.includes(source);

    const freqBins = freqBinsCandidate;
    const magBins = magBinsCandidate;
    const len = Math.min(freqBins.length, magBins.length);
    if (!len) return null;

    const spectrum = [];
    for (let j = 0; j < len; j++) {
        const freq = Number(freqBins[j]);
        const amp = Number(magBins[j]);
        if (!Number.isFinite(freq) || !Number.isFinite(amp)) continue;
        if (freq <= 0) continue;
        spectrum.push({ freq, amp });
    }
    if (!spectrum.length) return null;

    const peaks = detectFftPeaks(spectrum, 3);
    const peakText = peaks.length
        ? peaks.map((p) => `${p.freq.toFixed(3)} Hz`).join(', ')
        : 'tidak ada frekuensi dominan';

    return {
        summary: `FFT ESP32 (${fft.source || sensorKey}) | Samples: ${Number(fft.samples) || spectrum.length} | Fs: ${Number(fft.sampleRateHz || 0).toFixed(3)} Hz | Dominan: ${peakText}`,
        stats: {
            count: Number(fft.samples) || spectrum.length,
            mean: Number(fft.rms) || 0,
            trend: sourceMatchesSensor ? 'edge-computed' : `edge-computed (source: ${fft.source || 'unknown'})`
        },
        spectrum,
        peaks,
        meta: {
            resolutionHz: Number(fft.resolutionHz) || 0,
            peakHz: Number(fft.peakHz) || 0,
            peakMagnitude: Number(fft.peakMagnitude) || 0,
            source: fft.source || null,
            sourceMatchesSensor
        }
    };
}

function drawFftResult(result, sensorKey) {
    const summaryEl = document.getElementById('fftSummary');
    const insightsEl = document.getElementById('fftInsights');
    const canvas     = document.getElementById('fftChart');
    if (!canvas || !summaryEl || !insightsEl) return;

    const payload  = result?.data || result || {};
    const stats    = payload.stats || {};
    const peaks    = payload.peaks || [];
    const spectrum = payload.spectrum || [];

    summaryEl.textContent = payload.summary || 'FFT summary unavailable.';
    insightsEl.innerHTML  = '';

    if (stats.count != null) {
        const statsEl = document.createElement('div');
        statsEl.className = 'fft-pill';
        statsEl.innerHTML = `<strong>Stats</strong><br>Count: ${stats.count}<br>Mean: ${(stats.mean ?? 0).toFixed(2)}<br>Trend: ${stats.trend || 'n/a'}`;
        insightsEl.appendChild(statsEl);
    }

    peaks.forEach((peak, idx) => {
        const cycPerMin = (peak.freq || 0) * 60;
        const el = document.createElement('div');
        el.className = 'fft-pill';
        el.innerHTML = `<strong>Peak ${idx + 1}</strong><br>${(peak.freq || 0).toFixed(3)} Hz (${cycPerMin.toFixed(1)} cyc/min)<br>Amp: ${(peak.amp || 0).toFixed(3)}`;
        insightsEl.appendChild(el);
    });

    if (!spectrum.length) return;

    const sensor = SENSORS[sensorKey] || { name: sensorKey, color: '#1745a5' };
    fftChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels:   spectrum.map((p) => (p.freq || 0).toFixed(3)),
            datasets: [{
                label:           `${sensor.name} FFT Amplitude`,
                data:            spectrum.map((p) => p.amp || 0),
                borderColor:     sensor.color || '#1745a5',
                backgroundColor: hexToRgba(sensor.color || '#1745a5', 0.12),
                fill:            true,
                pointRadius:     1.5,
                tension:         0.2,
                borderWidth:     2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: true } },
            scales: {
                x: { title: { display: true, text: 'Frequency (Hz)' } },
                y: { title: { display: true, text: 'Amplitude'       } }
            }
        }
    });
}

async function renderFftAnalysis(data) {
    const summaryEl  = document.getElementById('fftSummary');
    const insightsEl = document.getElementById('fftInsights');
    const canvas     = document.getElementById('fftChart');
    if (!canvas || !summaryEl || !insightsEl) return;

    destroyFftChart();
    insightsEl.innerHTML = '';

    const sensorKey    = selectedSensors[0] || 'rpm';
    let espFftResult = null;
    try {
        const dateFrom = document.getElementById('dateFrom')?.value;
        const dateTo = document.getElementById('dateTo')?.value;
        const startDate = dateFrom ? new Date(`${dateFrom}T00:00:00`) : null;
        const endDate = dateTo ? new Date(`${dateTo}T23:59:59.999`) : null;
        const deviceId = getReportDeviceId();
        const fftDoc = await fetchLatestEspFft({ startDate, endDate, deviceId, source: sensorKey });
        if (fftDoc) espFftResult = extractEspFftFromRows([{ fft: fftDoc }], sensorKey);
    } catch (e) {
        console.warn('Failed to fetch FFT from API:', e.message);
    }
    if (!espFftResult) espFftResult = extractEspFftFromRows(data || [], sensorKey);
    if (espFftResult) {
        drawFftResult(espFftResult, sensorKey);
        return;
    }

    drawFftResult({
        summary: 'FFT ESP32 belum tersedia untuk rentang waktu ini. Tidak memakai FFT lokal agar konsisten dengan hasil LCD ESP32.',
        stats: { count: 0, mean: 0, trend: 'waiting-edge-data' },
        spectrum: [],
        peaks: []
    }, sensorKey);
}

function formatTimestampLabel(timestamp, timeRange) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp || '');
    if (timeRange >= 2 * 24 * 60 * 60 * 1000)
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function prepareChartData(data) {
    const sortedData = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const timeRange  = computeTimeRange(sortedData);
    const bucketMs   = getBucketMsByRange(timeRange);
    let displayData  = aggregateDataByTimeBuckets(sortedData, bucketMs);

    if (Number.isFinite(activeRange.start) && Number.isFinite(activeRange.end)) {
        displayData = buildContinuousBuckets(displayData, bucketMs, activeRange.start, activeRange.end);
    }

    const maxPoints = 900;
    if (displayData.length > maxPoints) {
        const step = Math.ceil(displayData.length / maxPoints);
        displayData = displayData.filter((_, index) => index % step === 0);
    }

    const datasets = selectedSensors.filter(k => SENSORS[k]).map((sensorKey, index) => {
        const config = SENSORS[sensorKey];
        const values = displayData.map(d => { const v = Number(d[sensorKey]); return Number.isFinite(v) ? v : null; });
        return {
            label:           config.name,
            data:            values,
            borderColor:     config.color,
            backgroundColor: hexToRgba(config.color, 0.1),
            borderWidth:     2,
            pointRadius:     1.5,
            fill:            index === 0,
            tension:         0.2,
            yAxisID:         `y${index === 0 ? '' : index + 1}`
        };
    });

    if (datasets.length === 0) {
        const config = SENSORS.rpm;
        datasets.push({
            label:           config.name,
            data:            displayData.map(d => { const v = Number(d.rpm); return Number.isFinite(v) ? v : null; }),
            borderColor:     config.color,
            backgroundColor: hexToRgba(config.color, 0.1),
            borderWidth:     2,
            pointRadius:     0,
            fill:            true,
            tension:         0.2,
            yAxisID:         'y'
        });
    }

    const allValues = datasets.flatMap((ds) => ds.data).filter((v) => Number.isFinite(Number(v)));
    const minVal    = allValues.length ? Math.min(...allValues) : 0;
    const maxVal    = allValues.length ? Math.max(...allValues) : 1;
    const range     = Math.max(1, maxVal - minVal);
    const pad       = range * 0.15;

    return {
        labels:  displayData.map((d) => formatTimestampLabel(d.timestamp, timeRange)),
        datasets,
        timeRange,
        bucketMs,
        yScale:  { min: minVal - pad, max: maxVal + pad, range },
        displayData
    };
}

function formatBucketLabel(bucketMs) {
    const minute = 60 * 1000;
    const hour   = 60 * minute;
    if (!bucketMs || bucketMs <= 0)    return '-';
    if (bucketMs % (24 * hour) === 0)  return `${bucketMs / (24 * hour)} day`;
    if (bucketMs % hour === 0)         return `${bucketMs / hour} hour`;
    return `${Math.round(bucketMs / minute)} min`;
}

function updateChartDescription(bucketMs, sampleCount, insights = []) {
    const desc = document.getElementById('chartDescription');
    if (!desc) return;
    const suffix      = Number.isFinite(sampleCount) ? ` (samples: ${sampleCount})` : '';
    const insightText = Array.isArray(insights) && insights.length ? ` | ${insights.join(' ')}` : '';
    desc.textContent  = `Tren menampilkan nilai rata-rata per ${formatBucketLabel(bucketMs)}${suffix}.${insightText}`;
}

function getChartOptions(timeRange, yScale) {
    return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { position: 'top', labels: { usePointStyle: true, padding: 20, font: { size: 12 } } },
            tooltip: {
                mode: 'index', intersect: false,
                callbacks: {
                    title:  (items) => items.length > 0 ? items[0].label : '',
                    label:  (context) => {
                        let label = context.dataset.label || '';
                        if (label) label += ': ';
                        const sensorKey = selectedSensors[context.datasetIndex] || 'rpm';
                        const unit      = SENSORS[sensorKey]?.unit || '';
                        label += context.parsed.y.toFixed(1) + ' ' + unit;
                        return label;
                    }
                }
            }
        },
        scales: {
            x: {
                type: 'category', grid: { display: false },
                ticks: { maxRotation: 45, minRotation: 45, autoSkip: true, maxTicksLimit: 12 },
                title: { display: true, text: 'Time', font: { size: 12, weight: 'bold' } }
            },
            y: {
                type: 'linear', display: true, position: 'left',
                title: { display: true, text: getYAxisTitle(0), font: { size: 12, weight: 'bold' } },
                beginAtZero: false,
                grid:        { color: 'rgba(0, 0, 0, 0.05)' },
                suggestedMin: yScale?.min, suggestedMax: yScale?.max,
                ticks: {
                    callback: function (value) {
                        const absValue = Math.abs(value);
                        if (absValue >= 1000) {
                            const dec = (yScale?.range || 0) < 200 ? 1 : 0;
                            return (value / 1000).toFixed(dec) + 'k';
                        }
                        const dec = (yScale?.range || 0) < 20 ? 2 : ((yScale?.range || 0) < 200 ? 1 : 0);
                        return Number(value).toFixed(dec);
                    }
                }
            }
        },
        animation: { duration: 750, easing: 'easeInOutQuart' }
    };
}

function getYAxisTitle(datasetIndex) {
    if (selectedSensors[datasetIndex]) {
        const sensor = SENSORS[selectedSensors[datasetIndex]];
        return `${sensor.name} (${sensor.unit})`;
    }
    return 'Value';
}

function updateChartTitle(startDate, endDate) {
    const chartTitle    = document.getElementById('chartTitle') || document.querySelector('.chart-title');
    const activeSensor  = SENSORS[selectedSensors[0]]?.name || 'Sensor';
    if (chartTitle) {
        if (startDate && endDate) {
            const start = new Date(startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const end   = new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            chartTitle.textContent = `${activeSensor} Trend (${start} - ${end})`;
        } else {
            chartTitle.textContent = `${activeSensor} Trend (Last 24 Hours)`;
        }
    }
}

// --- 8. HELPERS ---
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function showError(message) {
    const containerEl = document.getElementById('sensorsContainer');
    if (containerEl) {
        containerEl.innerHTML = `
            <div style="grid-column:1/-1; text-align:center; padding:40px 20px; background:#fff; border-radius:15px;">
                <div style="color:#ef4444; font-size:48px; margin-bottom:20px;"><i class="fas fa-exclamation-triangle"></i></div>
                <h3 style="margin-bottom:10px; color:#dc2626;">Error Loading Data</h3>
                <p style="margin-bottom:20px; color:#6b7280;">${message}</p>
                <button onclick="loadReportData()"
                        style="padding:10px 24px; background:#1745a5; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">
                    <i class="fas fa-redo"></i> Try Again
                </button>
            </div>`;
        containerEl.style.display = 'block';
    }
}

function showNoDataMessage() {
    const containerEl = document.getElementById('sensorsContainer');
    if (containerEl) {
        containerEl.innerHTML = `
            <div style="grid-column:1/-1; text-align:center; padding:60px 20px; background:#fff; border-radius:15px;">
                <div style="color:#9ca3af; font-size:48px; margin-bottom:20px;"><i class="fas fa-database"></i></div>
                <h3 style="margin-bottom:10px; color:#4b5563;">No Data Available</h3>
                <p style="margin-bottom:30px; color:#6b7280;">No sensor data found for the selected time period.</p>
                <div style="display:flex; justify-content:center; gap:10px; flex-wrap:wrap;">
                    <button onclick="updateDateFromHours('24'); loadReportData();" class="time-btn active">Last 24 Hours</button>
                    <button onclick="updateDateFromHours('168'); loadReportData();" class="time-btn">Last 7 Days</button>
                </div>
            </div>`;
        containerEl.style.display = 'block';
    }
    setText('dailyAverage', '-- hrs');
    setText('totalHours',   '-- hrs');
    setText('daysActive',   '-- days');
    setText('longestSession','-- hrs');
    setText('phaseDiffSummary', '--°');
    setText('syncStatusSummary', '--');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// --- 9. OVERVIEW ---
function updateOverview(data) {
    if (!data || data.length === 0) {
        setText('dailyAverage', '-- hrs'); setText('totalHours', '-- hrs');
        setText('daysActive',   '-- days'); setText('longestSession', '-- hrs');
        return;
    }

    try {
        const activeRecords = data.filter(d => d.rpm > 100);
        const totalHours    = (activeRecords.length * 2) / 3600;

        const daysSet = new Set();
        activeRecords.forEach(d => { daysSet.add(new Date(d.timestamp).toDateString()); });

        const avgDaily = daysSet.size > 0 ? (totalHours / daysSet.size) : 0;

        let maxSession = 0, currSession = 0;
        const sorted = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].rpm > 100) {
                const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;
                if (diff < 300) { currSession += diff; }
                else { maxSession = Math.max(maxSession, currSession); currSession = 0; }
            }
        }
        maxSession = Math.max(maxSession, currSession);

        setText('dailyAverage',  `${avgDaily.toFixed(1)} hrs`);
        setText('totalHours',    `${totalHours.toFixed(1)} hrs`);
        setText('daysActive',    `${daysSet.size} days`);
        setText('longestSession',`${(maxSession / 3600).toFixed(1)} hrs`);

        const latest = data[data.length - 1] || {};
        const vGen = Number(latest.volt);
        const vGrid = Number(latest.volt_grid ?? latest.voltGrid);
        const fGen = Number(latest.freq);
        const fGrid = Number(latest.freq_grid ?? latest.freqGrid);
        const phase = Number(latest.phase ?? latest.phaseAngle ?? latest.phase_angle ?? latest.phaseDiff);
        const voltOk = Number.isFinite(vGen) && Number.isFinite(vGrid) && Math.abs(vGen - vGrid) <= 10;
        const freqOk = Number.isFinite(fGen) && Number.isFinite(fGrid) && Math.abs(fGen - fGrid) <= 0.5;
        const phaseOk = Number.isFinite(phase) && Math.abs(phase) <= 15;
        setText('phaseDiffSummary', Number.isFinite(phase) ? `${phase.toFixed(1)}°` : '--°');
        setText('syncStatusSummary', (voltOk && freqOk && phaseOk) ? 'SYNC' : 'UNSYNC');
    } catch (e) { console.error('Error in updateOverview:', e); }
}

// --- 10. SENSOR CARDS ---
function renderSensorCards(data) {
    const container = document.getElementById('sensorsContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!data || data.length === 0) { showNoDataMessage(); return; }

    const latest = data[data.length - 1] || {};

    Object.entries(SENSORS).forEach(([key, config]) => {
        const values      = data.map(d => d[key]).filter(v => v != null && !isNaN(v));
        if (values.length === 0) return;

        const computedMin = Math.min(...values);
        const computedMax = Math.max(...values);
        const computedAvg = values.reduce((a, b) => a + b, 0) / values.length;
        const dbMin  = reportStatsBySensor?.[key]?.min;
        const dbMax  = reportStatsBySensor?.[key]?.max;
        const dbAvg  = reportStatsBySensor?.[key]?.avg;
        const dbCount = reportStatsBySensor?.[key]?.count;
        const min    = Number.isFinite(Number(dbMin)) ? Number(dbMin) : computedMin;
        const max    = Number.isFinite(Number(dbMax)) ? Number(dbMax) : computedMax;
        const avg    = Number.isFinite(Number(dbAvg)) ? Number(dbAvg) : computedAvg;
        const readingCount = Number.isFinite(Number(dbCount)) && Number(dbCount) > 0
            ? Number(dbCount)
            : (reportTotalMatched > 0 ? reportTotalMatched : values.length);
        const current = latest[key] != null ? latest[key] : avg;

        let status = 'normal', statusClass = 'status-normal';
        if (key === 'temp'   && current > 90)                   { status = 'critical'; statusClass = 'status-critical'; }
        else if (key === 'volt' && (current < 11 || current > 15)) { status = 'warning';  statusClass = 'status-warning'; }
        else if (key === 'fuel' && current < 20)                   { status = 'warning';  statusClass = 'status-warning'; }

        const accentColor = '#1745a5';
        const hasDbStats  = !!(reportStatsBySensor && reportStatsBySensor[key]);

        const card = document.createElement('div');
        card.className = 'sensor-card';
        card.dataset.sensor = key;
        card.style.setProperty('--sensor-accent', accentColor);
        card.classList.toggle('active-sensor', selectedSensors.includes(key));

        card.innerHTML = `
            <div class="sensor-header">
                <div class="sensor-name">
                    <div class="sensor-icon" style="background:${accentColor}20; color:${accentColor}">
                        <i class="${config.icon}"></i>
                    </div>
                    <span class="sensor-title-text">${config.name}</span>
                </div>
                <div class="sensor-status ${statusClass}">${status.toUpperCase()}</div>
            </div>
            <div class="sensor-stats">
                <div class="stat-item">
                    <div class="stat-label">CURRENT</div>
                    <div class="stat-value current-value">${current.toFixed(1)}<small style="font-size:12px;"> ${config.unit}</small></div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">AVERAGE</div>
                    <div class="stat-value">${avg.toFixed(1)} ${config.unit}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">MIN</div>
                    <div class="stat-value">${min.toFixed(1)} ${config.unit}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">MAX</div>
                    <div class="stat-value">${max.toFixed(1)} ${config.unit}</div>
                </div>
            </div>
            <div class="sensor-footer">
                <div class="warning-indicator warning-zero">
                    <i class="fas ${hasDbStats ? 'fa-check-circle' : 'fa-exclamation-triangle'}"
                       style="${hasDbStats ? 'color:#22c55e' : 'color:#f97316'}"></i>
                    ${readingCount.toLocaleString('en-US')} readings${hasDbStats ? '' : ' <span style="font-size:11px;opacity:.8">(est.)</span>'}
                </div>
                <div class="alert-indicator">
                    <i class="fas fa-bell"></i>
                    ${periodAlertCount.toLocaleString('en-US')} alerts
                </div>
            </div>`;

        card.addEventListener('click', () => selectSingleSensor(key));
        container.appendChild(card);
    });

    container.style.display = 'grid';
}

// --- 11. EXPORT ---
function toggleExportOptions() {
    const exportOptions = document.getElementById('exportOptions');
    if (exportOptions) {
        exportOptions.style.display = exportOptions.style.display === 'block' ? 'none' : 'block';
    }
}

function printChart() {
    if (!myChart) { alert('No chart data available to print'); return; }

    const printWindow = window.open('', '_blank');
    const chartImage  = document.getElementById('mainChart').toDataURL('image/png');
    const dateFrom    = document.getElementById('dateFrom')?.value || 'N/A';
    const dateTo      = document.getElementById('dateTo')?.value   || 'N/A';

    printWindow.document.write(`
        <html><head><title>GENSYS - Engine Report</title>
        <style>body{font-family:Arial,sans-serif;padding:40px;} img{max-width:100%;}</style></head>
        <body>
            <h1 style="text-align:center;">Engine Data Report</h1>
            <p style="text-align:center;">Period: ${dateFrom} to ${dateTo}</p>
            <p style="text-align:center;">Generated: ${new Date().toLocaleString()}</p>
            <img src="${chartImage}" alt="Chart">
            <script>setTimeout(()=>{window.print();window.close();},500);<\/script>
        </body></html>`);
    printWindow.document.close();
}

// --- 12. GLOBAL EXPORTS ---
window.loadReportData      = loadReportData;
window.updateDateFromHours = updateDateFromHours;
