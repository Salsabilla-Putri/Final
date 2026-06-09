// public/js/reports.js
// ─────────────────────────────────────────────────────────────────────────────
// Reports page logic, termasuk panel Condition-Based Maintenance (CBM).
// CBM sengaja disatukan di file ini agar halaman Reports tidak bergantung
// pada file JavaScript terpisah untuk panel rekomendasi maintenance.
// ─────────────────────────────────────────────────────────────────────────────

// === CONFIGURATION ===
const API_URL       = '/api/reports';
const API_STATS_URL = '/api/reports/stats';
const ENABLE_WEB_FFT = false;
const ENABLE_WEB_CBM = false;

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
    map:     { name: 'MAP',            unit: 'kPa', icon: 'fas fa-gauge-high',      color: '#0f766e' },
    batt:    { name: 'Battery Voltage',unit: 'V',   icon: 'fas fa-car-battery',     color: '#6366f1' },
    afr:     { name: 'AFR',            unit: '',    icon: 'fas fa-burn',            color: '#3b82f6' },
    tps:     { name: 'TPS',            unit: '%',   icon: 'fas fa-sliders-h',       color: '#a855f7' },
    phase:   { name: 'Phase Angle',    unit: '°',   icon: 'fas fa-circle-notch',     color: '#64748b' }
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
    map:     { min: 0,   max: 250  },
    batt:    { min: 0,   max: 24   },
    afr:     { min: 0,   max: 40   },
    tps:     { min: 0,   max: 100  },
    phase:   { min: -360,max: 360  }
};

let myChart               = null;
let fftChart              = null;
let currentData           = [];
let selectedSensors       = ['rpm'];
let activeRange           = { start: null, end: null };
let reportStatsBySensor   = null;
let reportTotalMatched    = 0;
let periodAlertCount      = 0;
let reportTableParam      = 'all';

const REPORT_TABLE_PARAM_ORDER = ['volt', 'freq', 'phase', 'power', 'rpm', 'iat', 'coolant', 'map', 'fuel', 'batt', 'afr', 'tps'];
const REPORT_STATUS_RULES = {
    volt:    { min: 180, warnMin: 200, warnMax: 240, max: 250 },
    freq:    { min: 48,  warnMin: 49,  warnMax: 51,  max: 52 },
    phase:   { warnAbs: 10, maxAbs: 15 },
    power:   { warnMax: 8, max: 12 },
    rpm:     { warnMax: 3500, max: 4000 },
    iat:     { warnMax: 55, max: 70 },
    coolant: { warnMax: 90, max: 105 },
    map:     { warnMax: 95, max: 105 },
    fuel:    { min: 20, warnMin: 30 },
    batt:    { min: 10.5, warnMin: 11.5, warnMax: 14.5, max: 15.5 },
    afr:     { min: 10.5, warnMin: 12, warnMax: 16, max: 18 },
    tps:     { min: 0, max: 100 },
    temp:    { warnMax: 85, max: 95 }
};


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
const FFT_SENSORS = ENABLE_WEB_FFT ? ['rpm', 'volt', 'freq'] : [];

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

    const analysisPanelEl = ENABLE_WEB_FFT ? document.querySelector('.analysis-panel') : null;
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
    document.getElementById('showAllReportParams')?.addEventListener('click', () => {
        reportTableParam = 'all';
        renderReportTable(currentData);
    });

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
    document.querySelectorAll('.export-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            exportTrendChart(btn.dataset.format);
            document.getElementById('trendExportMenu')?.classList.remove('open');
        });
    });
    document.getElementById('printChart')?.addEventListener('click', printChart);
    if (ENABLE_WEB_FFT) {
        document.getElementById('recalculateFft')?.addEventListener('click', () => renderFftAnalysis(currentData));
    }
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
        afr: 14.1 + (index * 0.05), map: 95 + index * 2, tps: 34 + index, status: 'DEMO', sync: 'SIMULATED'
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
    // CBMPanel sekarang ada di reports.js dan diekspos ke window.
    // We call it with a short delay so the main chart rendering finishes first.
    if (ENABLE_WEB_CBM && typeof window.CBMPanel?.reload === 'function') {
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
        renderReportTable(currentData);

        const analysisPanelEl = ENABLE_WEB_FFT ? document.querySelector('.analysis-panel') : null;
        const activeSensor    = selectedSensors[0] || 'rpm';
        if (analysisPanelEl) {
            analysisPanelEl.style.display = FFT_SENSORS.includes(activeSensor) ? '' : 'none';
        }
        if (ENABLE_WEB_FFT && FFT_SENSORS.includes(activeSensor)) renderFftAnalysis(currentData);

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


function getReportTableRows(data) {
    return [...(data || [])]
        .filter((row) => row?.timestamp && !Number.isNaN(new Date(row.timestamp).getTime()))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function formatReportTableTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp || '-');
    return date.toLocaleString('id-ID', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function getReportParamValue(row, param) {
    if (param === 'phase') return row.phase ?? row.phaseAngle ?? row.phase_angle ?? row.phaseDiff;
    if (param === 'volt') return row.volt ?? row.voltage;
    if (param === 'batt') return row.batt ?? row.battery ?? row.battVolt;
    if (param === 'coolant') return row.coolant ?? row.clt ?? row.temp;
    return row[param];
}

function formatReportValue(value, param) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    if (['rpm', 'fuel', 'tps'].includes(param)) return num.toFixed(0);
    if (['freq', 'power', 'afr'].includes(param)) return num.toFixed(2);
    return num.toFixed(1);
}

function getReportParamStatus(param, value) {
    const rule = REPORT_STATUS_RULES[param] || {};
    const num = Number(value);
    if (!Number.isFinite(num)) return 'normal';

    if (rule.maxAbs !== undefined && Math.abs(num) > rule.maxAbs) return 'critical';
    if (rule.warnAbs !== undefined && Math.abs(num) > rule.warnAbs) return 'warning';
    if ((rule.max !== undefined && num > rule.max) || (rule.min !== undefined && num < rule.min)) return 'critical';
    if ((rule.warnMax !== undefined && num > rule.warnMax) || (rule.warnMin !== undefined && num < rule.warnMin)) return 'warning';
    return 'normal';
}

function getReportStatusLabel(status) {
    if (status === 'critical') return 'kritis';
    if (status === 'warning') return 'warning';
    return 'normal';
}

function getReportSyncStatus(row) {
    const syncValue = String(row.sync ?? row.syncStatus ?? row.gridStatus ?? '').trim().toUpperCase().replace(/\s+/g, '-');
    if (['ON-GRID', 'ONGRID', 'SYNC', 'SYNCHRONIZED'].includes(syncValue) || row.synced === true) return 'ON-GRID';
    if (['OFF-GRID', 'OFFGRID', 'UNSYNC', 'UNSYNCHRONIZED'].includes(syncValue) || row.synced === false) return 'OFF-GRID';
    return syncValue || '-';
}

function getReportTableColumns() {
    if (reportTableParam !== 'all' && SENSORS[reportTableParam]) {
        const sensor = SENSORS[reportTableParam];
        return [
            { key: 'timestamp', label: 'Timestamp', getter: (row) => formatReportTableTimestamp(row.timestamp), type: 'text' },
            { key: 'device', label: 'Device', getter: (row) => row.deviceId || 'Gen-01', type: 'text' },
            { key: reportTableParam, label: `${sensor.name} (${sensor.unit || '-'})`, getter: (row) => formatReportValue(getReportParamValue(row, reportTableParam), reportTableParam), type: 'value', param: reportTableParam },
            { key: 'status', label: 'Status', getter: (row) => getReportParamStatus(reportTableParam, getReportParamValue(row, reportTableParam)), type: 'status' }
        ];
    }

    return [
        { key: 'timestamp', label: 'Timestamp', getter: (row) => formatReportTableTimestamp(row.timestamp), type: 'text' },
        { key: 'device', label: 'Device', getter: (row) => row.deviceId || 'Gen-01', type: 'text' },
        ...REPORT_TABLE_PARAM_ORDER.map((param) => ({
            key: param,
            label: `${SENSORS[param]?.name || param} (${SENSORS[param]?.unit || '-'})`,
            getter: (row) => formatReportValue(getReportParamValue(row, param), param),
            type: 'value',
            param
        })),
        { key: 'sync', label: 'Status Sinkron', getter: getReportSyncStatus, type: 'text' }
    ];
}

function renderReportTable(data) {
    const head = document.getElementById('reportTableHead');
    const body = document.getElementById('reportTableBody');
    const info = document.getElementById('reportTableInfo');
    const title = document.getElementById('reportTableTitle');
    const subtitle = document.getElementById('reportTableSubtitle');
    if (!head || !body) return;

    const rows = getReportTableRows(data);
    const columns = getReportTableColumns();
    const isSingleParam = reportTableParam !== 'all' && SENSORS[reportTableParam];

    if (title) title.textContent = isSingleParam ? `Tabel ${SENSORS[reportTableParam].name}` : 'Tabel Semua Parameter';
    if (subtitle) subtitle.textContent = isSingleParam
        ? 'Filter parameter aktif: tabel menampilkan timestamp, device, value parameter, dan status.'
        : 'Mode biasa: tabel menampilkan semua parameter dan Status Sinkron.';
    if (info) info.textContent = `${rows.length.toLocaleString('id-ID')} rows`;

    head.innerHTML = `<tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr>`;

    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${columns.length}" style="padding:18px; color:#64748b; text-align:center;">Tidak ada data pada filter ini.</td></tr>`;
        return;
    }

    body.innerHTML = rows.map((row) => `<tr>${columns.map((column) => {
        if (column.type === 'status') {
            const status = column.getter(row);
            return `<td><span class="report-status-badge report-status-${status}">${getReportStatusLabel(status)}</span></td>`;
        }

        if (column.type === 'value') {
            const rawValue = getReportParamValue(row, column.param);
            const status = getReportParamStatus(column.param, rawValue);
            return `<td class="report-value-${status}">${column.getter(row)}</td>`;
        }

        return `<td>${column.getter(row)}</td>`;
    }).join('')}</tr>`).join('');
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

        const paramStatus = getReportParamStatus(key, current);
        let status = paramStatus;
        let statusClass = `status-${paramStatus}`;

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
    const menu = document.getElementById('trendExportMenu');
    if (menu) menu.classList.toggle('open');
}


function getTrendExportContext() {
    if (!currentData || currentData.length === 0) return null;
    const sensorKey = selectedSensors.find((key) => SENSORS[key]) || 'rpm';
    const config = SENSORS[sensorKey] || SENSORS.rpm;
    const prepared = prepareChartData(currentData);
    return { sensorKey, config, rows: prepared.displayData || [], labels: prepared.labels || [] };
}

function getTrendExportFilename(extension) {
    const dateFrom = document.getElementById('dateFrom')?.value || 'all';
    const dateTo = document.getElementById('dateTo')?.value || dateFrom;
    const sensor = selectedSensors.find((key) => SENSORS[key]) || 'sensor';
    return `sensor_trend_${sensor}_${dateFrom}_to_${dateTo}.${extension}`;
}

function escapeExportCell(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function downloadBlob(content, type, filename) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
}

function formatExportNumber(value, digits = 2) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(digits) : '';
}

function calculateStatsFromRows(rows, sensorKey) {
    const values = (Array.isArray(rows) ? rows : [])
        .map((row) => Number(row?.[sensorKey]))
        .filter((value) => Number.isFinite(value));
    if (!values.length) return { count: 0, avg: null, min: null, max: null };
    const sum = values.reduce((total, value) => total + value, 0);
    return {
        count: values.length,
        avg: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values)
    };
}

function getExportSensorStats(sensorKey, rows) {
    const dbStats = reportStatsBySensor?.[sensorKey];
    const rowStats = calculateStatsFromRows(rows, sensorKey);
    return {
        count: Number(dbStats?.count) || rowStats.count,
        avg: Number.isFinite(Number(dbStats?.avg)) ? Number(dbStats.avg) : rowStats.avg,
        min: Number.isFinite(Number(dbStats?.min)) ? Number(dbStats.min) : rowStats.min,
        max: Number.isFinite(Number(dbStats?.max)) ? Number(dbStats.max) : rowStats.max
    };
}

function buildExportStatsRows(rows) {
    return Object.keys(SENSORS).map((sensorKey) => {
        const stats = getExportSensorStats(sensorKey, rows);
        return `
            <tr>
                <td>${escapeExportCell(SENSORS[sensorKey].name)}</td>
                <td>${escapeExportCell(sensorKey)}</td>
                <td>${escapeExportCell(SENSORS[sensorKey].unit)}</td>
                <td>${stats.count}</td>
                <td>${formatExportNumber(stats.avg)}</td>
                <td>${formatExportNumber(stats.min)}</td>
                <td>${formatExportNumber(stats.max)}</td>
                <td>${periodAlertCount}</td>
            </tr>`;
    }).join('');
}

function exportTrendExcel() {
    const context = getTrendExportContext();
    if (!context || context.rows.length === 0) { alert('No chart data available to export'); return; }

    const { sensorKey, config, rows } = context;
    const selectedStats = getExportSensorStats(sensorKey, rows);
    const dateFrom = document.getElementById('dateFrom')?.value || 'all';
    const dateTo = document.getElementById('dateTo')?.value || dateFrom;
    const tableRows = rows.map((row) => {
        const date = new Date(row.timestamp);
        const value = Number(row[sensorKey]);
        return `
            <tr>
                <td>${escapeExportCell(Number.isNaN(date.getTime()) ? row.timestamp : date.toLocaleString('id-ID'))}</td>
                <td>${Number.isFinite(value) ? value : ''}</td>
                <td>${escapeExportCell(config.unit)}</td>
            </tr>`;
    }).join('');

    const htmlTable = `
        <table border="1">
            <thead><tr><th colspan="2">Applied Filters</th></tr></thead>
            <tbody>
                <tr><td>Device ID</td><td>${escapeExportCell(getReportDeviceId())}</td></tr>
                <tr><td>Date From</td><td>${escapeExportCell(dateFrom)}</td></tr>
                <tr><td>Date To</td><td>${escapeExportCell(dateTo)}</td></tr>
                <tr><td>Selected Parameter</td><td>${escapeExportCell(config.name)} (${escapeExportCell(sensorKey)})</td></tr>
            </tbody>
        </table>
        <br>
        <table border="1">
            <thead>
                <tr><th colspan="6">Selected Parameter Statistics</th></tr>
                <tr><th>Parameter</th><th>Readings</th><th>AVG</th><th>MIN</th><th>MAX</th><th>Alerts</th></tr>
            </thead>
            <tbody>
                <tr>
                    <td>${escapeExportCell(config.name)}</td>
                    <td>${selectedStats.count}</td>
                    <td>${formatExportNumber(selectedStats.avg)}</td>
                    <td>${formatExportNumber(selectedStats.min)}</td>
                    <td>${formatExportNumber(selectedStats.max)}</td>
                    <td>${periodAlertCount}</td>
                </tr>
            </tbody>
        </table>
        <br>
        <table border="1">
            <thead>
                <tr><th colspan="8">Sensor Card Statistics</th></tr>
                <tr><th>Sensor</th><th>Key</th><th>Unit</th><th>Readings</th><th>AVG</th><th>MIN</th><th>MAX</th><th>Alerts</th></tr>
            </thead>
            <tbody>${buildExportStatsRows(rows)}</tbody>
        </table>
        <br>
        <table border="1">
            <thead>
                <tr><th>Timestamp</th><th>${escapeExportCell(config.name)}</th><th>Unit</th></tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>`;

    downloadBlob(
        `\ufeff${htmlTable}`,
        'application/vnd.ms-excel;charset=utf-8;',
        getTrendExportFilename('xls')
    );
}

function getChartCanvas() {
    const canvas = document.getElementById('mainChart');
    if (!myChart || !canvas) { alert('No chart data available to export'); return null; }
    return canvas;
}

function exportTrendImage() {
    const canvas = getChartCanvas();
    if (!canvas) return;
    downloadDataUrl(canvas.toDataURL('image/png'), getTrendExportFilename('png'));
}

function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function concatUint8Arrays(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => { out.set(part, offset); offset += part.length; });
    return out;
}

function createChartPdfBlob(canvas) {
    const encoder = new TextEncoder();
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const imageBytes = base64ToUint8Array(jpegDataUrl.split(',')[1]);
    const pageWidth = 842;
    const pageHeight = 595;
    const margin = 36;
    const maxWidth = pageWidth - (margin * 2);
    const maxHeight = pageHeight - (margin * 2);
    const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
    const drawWidth = canvas.width * ratio;
    const drawHeight = canvas.height * ratio;
    const x = (pageWidth - drawWidth) / 2;
    const y = (pageHeight - drawHeight) / 2;
    const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;

    const objects = [
        encoder.encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
        encoder.encode('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
        encoder.encode('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'),
        concatUint8Arrays([
            encoder.encode(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`),
            imageBytes,
            encoder.encode('\nendstream\nendobj\n')
        ]),
        encoder.encode(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)
    ];

    const header = encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets = [];
    let currentOffset = header.length;
    objects.forEach((obj) => { offsets.push(currentOffset); currentOffset += obj.length; });

    const xrefOffset = currentOffset;
    const xrefRows = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
        .concat(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `))
        .join('\n');
    const trailer = `\n${xrefRows}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return new Blob([header, ...objects, encoder.encode(trailer)], { type: 'application/pdf' });
}

function exportTrendPdf() {
    const canvas = getChartCanvas();
    if (!canvas) return;
    downloadBlob(createChartPdfBlob(canvas), 'application/pdf', getTrendExportFilename('pdf'));
}

function exportTrendChart(format) {
    if (format === 'excel') exportTrendExcel();
    else if (format === 'png') exportTrendImage();
    else if (format === 'pdf') exportTrendPdf();
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

/**
 * CBM Panel - integrated in public/js/reports.js
 * ============================================================
 * Condition-Based Maintenance (CBM) Panel
 *
 * Cara penggunaan:
 * Panel dirender langsung oleh reports.js ke #cbmPanelContainer.
 *
 * Panel otomatis di-render dan di-refresh setiap kali:
 *  - Halaman selesai load
 *  - reports.js memanggil _triggerCbmRefresh() setelah data dimuat
 *  - Tombol "Analisis Sekarang" diklik
 *  - Tombol "+ FFT Peaks" diklik (kirim peaks ke server)
 * ============================================================
 */

/* global selectedSensors, currentData, getReportDeviceId, fftChart */

(function CBMPanel() {
    'use strict';

    if (!ENABLE_WEB_CBM) {
        window.CBMPanel = { reload: () => Promise.resolve(null), getLastResult: () => null };
        return;
    }

    const CBM_API     = '/api/cbm/analysis';
    const SUGGEST_API = '/api/cbm/suggestion';

    const LEVEL = {
        critical: { label: 'KRITIS',  color: '#dc2626', bg: '#fef2f2', border: '#fca5a5', icon: '🔴' },
        warn:     { label: 'WASPADA', color: '#ea580c', bg: '#fff7ed', border: '#fdba74', icon: '🟠' },
        watch:    { label: 'PANTAU',  color: '#ca8a04', bg: '#fefce8', border: '#fde68a', icon: '🟡' },
        ok:       { label: 'NORMAL',  color: '#16a34a', bg: '#f0fdf4', border: '#86efac', icon: '🟢' },
    };

    const URGENCY = {
        overdue:    { label: 'TERLAMBAT', color: '#dc2626' },
        'due-now':  { label: 'SEGERA',    color: '#ea580c' },
        'due-soon': { label: 'MENDEKATI', color: '#ca8a04' },
        scheduled:  { label: 'TERJADWAL', color: '#6b7280' },
    };

    let _loading    = false;
    let _lastResult = null;

    // ── HTML TEMPLATE ─────────────────────────────────────────────────────────
    function buildHTML() {
        return `
<section id="cbmPanel" class="cbm-panel">
  <div class="cbm-panel-header">
    <div class="cbm-title-wrap">
      <div class="cbm-title-icon"><i class="fas fa-stethoscope"></i></div>
      <div>
        <p class="cbm-eyebrow">Predictive insight</p>
        <h2 class="cbm-title">Condition-Based Maintenance</h2>
        <p class="cbm-subtitle">Analisis kesehatan engine dari tren sensor, FFT, dan jadwal preventive.</p>
        <div id="cbmAnalyzedAt" class="cbm-analyzed-at">Menunggu analisis...</div>
      </div>
    </div>
    <div class="cbm-actions">
      <button class="cbm-action-btn cbm-action-secondary" id="cbmSendFftBtn" type="button">
        <i class="fas fa-wave-square"></i> Pakai FFT Peaks
      </button>
      <button class="cbm-action-btn cbm-action-primary" id="cbmRefreshBtn" type="button">
        <i class="fas fa-sync-alt" id="cbmRefreshIcon"></i> Analisis Sekarang
      </button>
    </div>
  </div>

  <div id="cbmLoading" class="cbm-loading" style="display:none;">
    <i class="fas fa-spinner fa-spin"></i>
    <span>Menganalisis data sensor...</span>
  </div>

  <div id="cbmContent" style="display:none;">
    <div id="cbmMainGrid" class="cbm-main-grid">
      <div id="cbmLeftPanel" class="cbm-left-panel">
        <div id="cbmHealthCard" class="cbm-card cbm-health-card">
          <div class="cbm-card-label">Health Score</div>
          <div class="cbm-health-ring">
            <canvas id="cbmHealthCanvas" width="148" height="148"></canvas>
            <div class="cbm-health-center">
              <div id="cbmScoreNum" class="cbm-score-num">--</div>
              <div class="cbm-score-total">/100</div>
            </div>
          </div>
          <span id="cbmStatusBadge" class="cbm-status-badge">---</span>
        </div>

        <div id="cbmComponentCard" class="cbm-card cbm-component-card">
          <div class="cbm-card-label">Status Komponen</div>
          <div id="cbmComponentGrid" class="cbm-component-grid"></div>
        </div>
      </div>

      <div class="cbm-card cbm-findings-card">
        <div class="cbm-findings-head">
          <div>
            <div class="cbm-card-label">Rekomendasi CBM</div>
            <p class="cbm-card-help">Prioritas tindakan berdasarkan pola anomali dan risiko operasional.</p>
          </div>
          <span id="cbmFindingCount" class="cbm-count-pill"></span>
        </div>
        <div id="cbmFindingsEmpty" class="cbm-empty" style="display:none;">
          <div class="cbm-empty-icon">✅</div>
          <strong>Kondisi stabil</strong>
          <span>Tidak ada anomali terdeteksi pada rentang waktu ini.</span>
        </div>
        <div id="cbmFindingsList" class="cbm-findings-list"></div>
      </div>
    </div>
  </div>
</section>`;
    }

    // ── HEALTH RING ───────────────────────────────────────────────────────────
    function renderHealthRing(score) {
        const canvas = document.getElementById('cbmHealthCanvas');
        if (!canvas) return;
        const ctx   = canvas.getContext('2d');
        const size  = canvas.width || 148;
        const cx = size / 2, cy = size / 2, r = (size / 2) - 18, lw = 12;
        const start = -Math.PI / 2;
        const end   = start + (score / 100) * 2 * Math.PI;
        const color = score >= 80 ? '#16a34a' : score >= 55 ? '#ea580c' : '#dc2626';
        const trackColor = score >= 80 ? '#dcfce7' : score >= 55 ? '#fff7ed' : '#fef2f2';

        ctx.clearRect(0, 0, size, size);
        // Track
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = trackColor; ctx.lineWidth = lw; ctx.stroke();
        // Arc
        ctx.beginPath(); ctx.arc(cx, cy, r, start, end);
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

        const numEl = document.getElementById('cbmScoreNum');
        if (numEl) { numEl.textContent = score; numEl.style.color = color; }
    }

    function renderStatusBadge(status) {
        const badge  = document.getElementById('cbmStatusBadge');
        if (!badge) return;
        const colors = {
            AMAN:    { bg: '#dcfce7', color: '#15803d' },
            WASPADA: { bg: '#fef9c3', color: '#a16207' },
            BAHAYA:  { bg: '#fee2e2', color: '#b91c1c' }
        };
        const c = colors[status] || { bg: '#e2e8f0', color: '#475569' };
        badge.textContent = status;
        badge.style.background = c.bg;
        badge.style.color = c.color;
    }

    // ── COMPONENT HEALTH ──────────────────────────────────────────────────────
    function renderComponentHealth(componentHealth) {
        const grid = document.getElementById('cbmComponentGrid');
        if (!grid) return;
        grid.innerHTML = Object.entries(componentHealth).map(([comp, level]) => {
            const m = LEVEL[level] || LEVEL.ok;
            return `
            <div style="display:flex;align-items:center;gap:9px;padding:8px 11px;
                        background:${m.bg};border-radius:9px;border:1px solid ${m.border};">
                <span style="font-size:15px;flex-shrink:0;">${m.icon}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;font-weight:600;color:#1e293b;
                                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${comp}</div>
                </div>
                <span style="font-size:10px;font-weight:700;color:${m.color};
                             background:${m.color}18;padding:2px 7px;border-radius:99px;
                             flex-shrink:0;">${m.label}</span>
            </div>`;
        }).join('');
    }

    // ── FINDINGS ──────────────────────────────────────────────────────────────
    function renderFindings(findings) {
        const list  = document.getElementById('cbmFindingsList');
        const empty = document.getElementById('cbmFindingsEmpty');
        if (!list || !empty) return;

        if (!findings.length) {
            list.innerHTML = ''; empty.style.display = 'block'; return;
        }
        empty.style.display = 'none';

        list.innerHTML = findings.map((f, idx) => {
            const m        = LEVEL[f.level] || LEVEL.ok;
            const isRising = (f.trend?.slopePerHour ?? 0) >= 0;
            const slopeAbs = Math.abs(f.trend?.slopePerHour ?? 0).toFixed(3);
            const priorityColors = {
                high:   { bg: '#fef2f2', color: '#dc2626', label: 'HIGH' },
                medium: { bg: '#fffbeb', color: '#d97706', label: 'MED' },
                low:    { bg: '#f0fdf4', color: '#16a34a', label: 'LOW' },
            };
            const pc = priorityColors[(f.priority || 'medium').toLowerCase()] || priorityColors.medium;

            return `
            <div class="cbm-finding-card" data-idx="${idx}"
                 style="border:1px solid ${m.border};border-left:4px solid ${m.color};
                        border-radius:10px;padding:14px 15px;background:#fff;
                        box-shadow:0 1px 4px rgba(15,23,42,.06);">

              <!-- Top row: title + badges + actions -->
              <div style="display:flex;align-items:flex-start;gap:10px;justify-content:space-between;
                          flex-wrap:wrap;margin-bottom:9px;">
                <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex:1;min-width:0;">
                  <span style="font-size:15px;">${m.icon}</span>
                  <span style="font-weight:700;font-size:13px;color:#0f172a;">${f.component}</span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:${m.color}18;color:${m.color};">${m.label}</span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:#e0e7ff;color:#3730a3;">
                      ${f.type || 'Corrective'}
                  </span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:${pc.bg};color:${pc.color};">
                      ${pc.label}
                  </span>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0;">
                    <button class="cbm-approve-btn" data-idx="${idx}"
                            style="padding:6px 12px;background:#16a34a;color:#fff;border:none;
                                   border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">✅ Setujui</button>
                    <button class="cbm-reject-btn" data-idx="${idx}"
                            style="padding:6px 12px;background:#f1f5f9;color:#ef4444;border:1px solid #fca5a5;
                                   border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">✕ Tolak</button>
                </div>
              </div>

              <!-- Action text -->
              <div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px;">
                ${f.action}
              </div>
              <div style="font-size:12px;color:#64748b;margin-bottom:10px;line-height:1.5;">
                ${f.details}
              </div>

              <!-- Metrics row -->
              ${f.sensor !== 'rpm_fft' ? `
              <div style="display:flex;gap:0;flex-wrap:wrap;background:#f8fafc;
                          border-radius:8px;overflow:hidden;border:1px solid #f1f5f9;">
                ${[
                  ['Sensor', `<b>${(f.sensor||'').toUpperCase()}</b>`],
                  ['Terkini', `<b>${f.trend?.latest ?? '--'}</b>`],
                  ['Tren', `<span style="color:${isRising?'#dc2626':'#16a34a'};font-weight:700;">${isRising?'▲':'▼'} ${slopeAbs}/jam</span>`],
                  ['R²', `<b>${f.trend?.r2 ?? '--'}</b>`],
                  ['CV', `<b>${f.trend?.cv ?? '--'}%</b>`],
                  ['Keyakinan', `<b>${f.confidence ?? '--'}%</b>`],
                ].map(([k,v]) => `
                  <div style="padding:6px 12px;border-right:1px solid #f1f5f9;white-space:nowrap;">
                    <div style="font-size:10px;color:#94a3b8;margin-bottom:1px;">${k}</div>
                    <div style="font-size:12px;color:#374151;">${v}</div>
                  </div>`).join('')}
              </div>` : `
              <div style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;
                          background:#f0f9ff;border-radius:6px;border:1px solid #bae6fd;">
                <i class="fas fa-wave-square" style="color:#0ea5e9;font-size:11px;"></i>
                <span style="font-size:11px;color:#0369a1;font-weight:500;">Sumber: FFT Spectrum Analysis</span>
              </div>`}
            </div>`;
        }).join('');

        // Update count badge
        const countEl = document.getElementById('cbmFindingCount');
        if (countEl) countEl.textContent = findings.length ? `${findings.length} temuan` : '';

        list.querySelectorAll('.cbm-approve-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                const finding = findings[parseInt(this.dataset.idx, 10)];
                await handleApproveFinding(finding, this);
            });
        });
        list.querySelectorAll('.cbm-reject-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const card = this.closest('.cbm-finding-card');
                if (card) card.remove();
                // Jika semua kartu hilang, tampilkan pesan kosong
                if (!list.querySelector('.cbm-finding-card')) {
                    const empty = document.getElementById('cbmFindingsEmpty');
                    if (empty) empty.style.display = 'block';
                }
                const remaining = list.querySelectorAll('.cbm-finding-card').length;
                const countEl = document.getElementById('cbmFindingCount');
                if (countEl) countEl.textContent = remaining ? `${remaining} temuan` : '';
            });
        });
    }

    // ── PREVENTIVE SCHEDULE ───────────────────────────────────────────────────
    function renderPreventive(schedule, totalHours) {
        const list  = document.getElementById('cbmPreventiveList');
        const empty = document.getElementById('cbmPreventiveEmpty');
        const tag   = document.getElementById('cbmTotalHoursTag');
        if (!list || !empty) return;

        if (tag) tag.textContent = `${(totalHours ?? 0).toFixed(1)} jam operasi`;

        if (!schedule.length) {
            list.innerHTML = ''; empty.style.display = 'block'; return;
        }
        empty.style.display = 'none';

        list.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid #e8edf3;">
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:left;letter-spacing:.06em;text-transform:uppercase;">Komponen</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:left;letter-spacing:.06em;text-transform:uppercase;">Tugas</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Interval</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Sisa Jam</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Status</th>
            <th style="padding:9px 12px;"></th>
          </tr></thead>
          <tbody>
            ${schedule.map((s, idx) => {
                const um       = URGENCY[s.urgency] || URGENCY.scheduled;
                const barColor = s.urgency === 'overdue'   ? '#dc2626'
                               : s.urgency === 'due-now'   ? '#ea580c'
                               : s.urgency === 'due-soon'  ? '#ca8a04' : '#16a34a';
                const pct      = Math.min(100, s.percentDue ?? 0);
                return `
                <tr style="border-bottom:1px solid #f1f5f9;transition:background .15s;"
                    onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                  <td style="padding:10px 12px;font-weight:600;color:#0f172a;">${s.component}</td>
                  <td style="padding:10px 12px;color:#475569;">${s.task}</td>
                  <td style="padding:10px 12px;text-align:center;color:#64748b;">${s.intervalHours} jam</td>
                  <td style="padding:10px 12px;text-align:center;">
                    <div style="font-size:12px;font-weight:600;${s.hoursRemaining <= 0 ? 'color:#dc2626;' : 'color:#374151;'}">
                        ${s.hoursRemaining <= 0 ? '⚠ OVERDUE' : s.hoursRemaining + ' jam'}
                    </div>
                    <div style="background:#e2e8f0;border-radius:4px;height:5px;
                                margin-top:4px;width:72px;margin-left:auto;margin-right:auto;overflow:hidden;">
                        <div style="background:${barColor};height:5px;border-radius:4px;width:${pct}%;transition:width .4s;"></div>
                    </div>
                  </td>
                  <td style="padding:10px 12px;text-align:center;">
                    <span style="padding:3px 10px;border-radius:99px;font-size:10.5px;font-weight:700;
                                 background:${um.color}18;color:${um.color};">
                        ${um.label}
                    </span>
                  </td>
                  <td style="padding:10px 12px;">
                    <button class="cbm-prev-approve-btn" data-prev-idx="${idx}"
                            style="padding:5px 10px;background:#1d4ed8;color:#fff;
                                   border:none;border-radius:6px;
                                   cursor:pointer;font-size:11px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">
                        ✅ Setujui
                    </button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

        list.querySelectorAll('.cbm-prev-approve-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                const s = schedule[parseInt(this.dataset.prevIdx, 10)];
                // Buat finding tiruan dari preventive schedule
                const finding = {
                    action:   s.task,
                    details:  `Preventive berkala. Interval ${s.intervalHours} jam. Sisa ${s.hoursRemaining} jam.`,
                    priority: s.urgency === 'overdue' ? 'high' : s.urgency === 'due-soon' ? 'medium' : 'low',
                    type:     'Preventive',
                    component: s.component,
                    estimatedCost: 0
                };
                await handleApproveFinding(finding, this);
            });
        });
    }

    // ── RENDER ALL ────────────────────────────────────────────────────────────
    function renderAll(data) {
        if (!data) return;
        renderHealthRing(data.healthScore ?? 0);
        renderStatusBadge(data.overallStatus ?? '---');
        renderComponentHealth(data.componentHealth ?? {});
        renderFindings(data.findings ?? []);
        renderPreventive(data.preventiveSchedule ?? [], data.totalOperatingHours ?? 0);

        // const summary = document.getElementById('cbmSummaryBox');
        // if (summary) summary.textContent = data.summary ?? '';

        const analyzedAt = document.getElementById('cbmAnalyzedAt');
        if (analyzedAt && data.analyzedAt) {
            const d = new Date(data.analyzedAt);
            analyzedAt.textContent =
                `${d.toLocaleString('id-ID')} · ${(data.dataPoints ?? 0).toLocaleString()} data pts`;
        }
    }

    // ── APPROVE FINDING (Redirect Flow) ──────────────────────────────────────
    async function handleApproveFinding(finding, btn) {
        const original = btn.innerHTML;
        btn.disabled   = true;
        btn.textContent = '⏳';

        try {
            const res = await fetch(SUGGEST_API, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ finding })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error);

            btn.textContent = '✅ Tersimpan';
            // Simpan saran lengkap ke sessionStorage
            sessionStorage.setItem('pendingCbmSuggestion', JSON.stringify(json.data));
            // Redirect ke halaman maintenance
            window.location.href = 'maintenance.html';
        } catch (err) {
            console.error('Approve finding error:', err);
            btn.textContent = '❌ Gagal';
            setTimeout(() => {
                btn.innerHTML = original;
                btn.disabled = false;
            }, 2000);
        }
    }

    // ── FFT PEAKS EXTRACTION ──────────────────────────────────────────────────
    function extractFftPeaks() {
        try {
            const chart = typeof fftChart !== 'undefined' ? fftChart : window.fftChart;
            if (!chart?.data?.datasets?.[0]?.data?.length) return [];
            const labels = chart.data.labels;
            const data   = chart.data.datasets[0].data;
            if (!labels?.length || !data?.length) return [];

            const peaks = [];
            for (let i = 1; i < data.length - 1; i++) {
                if (data[i] >= data[i - 1] && data[i] >= data[i + 1] && data[i] > 0.001) {
                    peaks.push({ freq: parseFloat(labels[i]) || 0, amp: data[i] });
                }
            }
            return peaks.sort((a, b) => b.amp - a.amp).slice(0, 5);
        } catch (err) { console.warn('extractFftPeaks error:', err); return []; }
    }

    // ── MAIN LOAD ─────────────────────────────────────────────────────────────
    async function loadCBM(useFftPeaks = false) {
        if (_loading) return;
        _loading = true;

        const loadingEl   = document.getElementById('cbmLoading');
        const contentEl   = document.getElementById('cbmContent');
        const refreshBtn  = document.getElementById('cbmRefreshBtn');
        const refreshIcon = document.getElementById('cbmRefreshIcon');

        if (loadingEl)   loadingEl.style.display  = 'block';
        if (contentEl)   contentEl.style.display  = 'none';
        if (refreshIcon) refreshIcon.classList.add('fa-spin');
        if (refreshBtn)  refreshBtn.disabled = true;

        try {
            const dateFromEl = document.getElementById('dateFrom');
            const dateToEl   = document.getElementById('dateTo');
            const deviceId   = typeof getReportDeviceId === 'function'
                ? getReportDeviceId() : null;

            const body = { hours: 168, deviceId };

            if (dateFromEl?.value && dateToEl?.value) {
                body.startDate = dateFromEl.value;
                body.endDate   = dateToEl.value;
                delete body.hours;
            }

            if (useFftPeaks) {
                const peaks = extractFftPeaks();
                if (peaks.length) {
                    body.fftPeaks = peaks;
                    if (typeof currentData !== 'undefined' && currentData.length) {
                        const rpmVals = currentData
                            .map(d => Number(d.rpm))
                            .filter(v => Number.isFinite(v) && v > 0);
                        if (rpmVals.length) {
                            body.rpmMean = rpmVals.reduce((a, b) => a + b, 0) / rpmVals.length;
                        }
                    }
                }
            }

            const res = await fetch(CBM_API, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });

            if (!res.ok) throw new Error(`CBM API ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error || 'Unknown error');

            _lastResult = json.data;
            renderAll(json.data);

        } catch (err) {
            console.error('[CBMPanel] load error:', err);

            // Fallback: GET
            try {
                const deviceId = typeof getReportDeviceId === 'function'
                    ? getReportDeviceId() : '';
                const url  = `${CBM_API}?hours=168${deviceId ? '&deviceId=' + deviceId : ''}`;
                const res  = await fetch(url);
                const json = await res.json();
                if (!json.success) throw new Error(json.error);
                _lastResult = json.data;
                renderAll(json.data);
            } catch (fbErr) {
                if (contentEl) {
                    contentEl.style.display = 'block';
                    contentEl.innerHTML = `
                      <div style="padding:14px;background:#fef2f2;border-radius:10px;
                                  color:#b91c1c;font-size:13px;border:1px solid #fca5a5;">
                        ⚠️ Gagal memuat CBM: ${err.message}<br>
                        <small style="color:#94a3b8;">
                          Pastikan <code>/api/cbm/analysis</code> sudah ditambahkan ke server.js
                          dan file <code>lib_cbm_analysis.js</code> sudah ada di root project.
                        </small>
                      </div>`;
                }
            }
        } finally {
            if (loadingEl)   loadingEl.style.display  = 'none';
            if (contentEl && contentEl.innerHTML !== '')
                             contentEl.style.display  = 'block';
            if (refreshIcon) refreshIcon.classList.remove('fa-spin');
            if (refreshBtn)  refreshBtn.disabled = false;
            _loading = false;
        }
    }

    // ── INIT ──────────────────────────────────────────────────────────────────
    function init() {
        const container = document.getElementById('cbmPanelContainer');
        if (!container) {
            console.warn('[CBMPanel] #cbmPanelContainer tidak ditemukan di HTML.');
            return;
        }

        container.innerHTML = buildHTML();

        document.getElementById('cbmRefreshBtn')
            ?.addEventListener('click', () => loadCBM(false));
        document.getElementById('cbmSendFftBtn')
            ?.addEventListener('click', () => loadCBM(true));

        // Hook tombol Apply & time-btn (delay agar data selesai dimuat lebih dulu)
        document.getElementById('applyDateRange')
            ?.addEventListener('click', () => setTimeout(() => loadCBM(false), 700));
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => setTimeout(() => loadCBM(false), 700));
        });

        // Auto-load pertama kali
        loadCBM(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose ke global untuk di-trigger dari reports.js
    window.CBMPanel = {
        reload:        loadCBM,
        getLastResult: () => _lastResult
    };

})();
