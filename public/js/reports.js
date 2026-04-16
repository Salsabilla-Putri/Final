// public/js/reports.js

// === CONFIGURATION ===
const API_URL = '/api/reports';
const API_STATS_URL = '/api/reports/stats'; // dedicated MongoDB aggregation stats endpoint

// Konfigurasi Parameter
const SENSORS = {
    rpm: { name: 'RPM', unit: 'rpm', icon: 'fas fa-tachometer-alt', color: '#1745a5' },
    volt: { name: 'Voltage', unit: 'V', icon: 'fas fa-bolt', color: '#f97316' },
    amp: { name: 'Current', unit: 'A', icon: 'fas fa-plug', color: '#ec4899' },
    freq: { name: 'Frequency', unit: 'Hz', icon: 'fas fa-wave-square', color: '#8b5cf6' },
    power: { name: 'Power', unit: 'kW', icon: 'fas fa-charging-station', color: '#14b8a6' },
    temp: { name: 'Engine Temp', unit: '°C', icon: 'fas fa-thermometer-half', color: '#ef4444' },
    coolant: { name: 'Coolant', unit: '°C', icon: 'fas fa-snowflake', color: '#06b6d4' },
    fuel: { name: 'Fuel', unit: '%', icon: 'fas fa-gas-pump', color: '#10b981' },
    iat: { name: 'Intake Air', unit: '°C', icon: 'fas fa-wind', color: '#f59e0b' },
    batt: { name: 'Battery Voltage', unit: 'V', icon: 'fas fa-car-battery', color: '#6366f1' },
    afr: { name: 'AFR', unit: '', icon: 'fas fa-burn', color: '#3b82f6' }
};

const SENSOR_LIMITS = {
    rpm: { min: 0, max: 5000 },
    volt: { min: 0, max: 300 },
    amp: { min: 0, max: 500 },
    freq: { min: 0, max: 80 },
    power: { min: 0, max: 2000 },
    temp: { min: -20, max: 180 },
    coolant: { min: -20, max: 180 },
    fuel: { min: 0, max: 100 },
    iat: { min: -20, max: 120 },
    batt: { min: 0, max: 24 },
    afr: { min: 0, max: 40 }
};

let myChart = null;
let fftChart = null;
let currentData = [];
let selectedSensors = ['rpm']; // Default sensor to show
let activeRange = { start: null, end: null };
let reportStatsBySensor = null;
let reportTotalMatched = 0;
let periodAlertCount = 0;

function getReportDeviceId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('deviceId')
        || localStorage.getItem('reportDeviceId')
        || 'ESP32_GENERATOR_01';
}

// --- 1. CHART MANAGEMENT ---
function destroyChart() {
    try {
        if (myChart) {
            myChart.destroy();
            myChart = null;
        }
    } catch (error) {
        console.warn('Error destroying chart:', error);
        myChart = null;
    }
}

// --- 2. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('Reports.js initialized');
    
    initDatePickers();
    setupEventListeners();
    loadReportData();
});

// --- 3. DATE PICKER FUNCTIONS ---
function initDatePickers() {
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    
    // Format untuk input type="date"
    const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    // Cari atau buat date picker
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
            <div style="align-self: center; margin: 0 10px; color:#666;">to</div>
            <div>
                <label style="font-size:12px; color:#666;">End Date</label>
                <input type="date" id="dateTo" class="date-input" 
                       style="padding:8px; border:1px solid #d0d7e1; border-radius:4px; width:150px;">
            </div>
        `;
    }
    
    // Set nilai default
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    
    if (dateFrom) {
        dateFrom.value = formatDate(yesterday);
        dateFrom.max = formatDate(now);
    }
    
    if (dateTo) {
        dateTo.value = formatDate(now);
        dateTo.max = formatDate(now);
        if (dateFrom) {
            dateTo.min = dateFrom.value;
        }
    }
}

// --- 4. SENSOR SELECTOR ---
// Sensors that support FFT analysis (periodic / electrical signals only)
const FFT_SENSORS = ['rpm', 'volt', 'freq'];

function selectSingleSensor(key) {
    if (!SENSORS[key]) return;
    selectedSensors = [key];

    // Update active highlight on all sensor cards
    document.querySelectorAll('.sensor-card').forEach(card => {
        card.classList.toggle('active-sensor', card.dataset.sensor === key);
    });

    // Re-render trend chart for the selected sensor
    if (currentData.length > 0) {
        renderChart(currentData);
        updateChartTitle(
            document.getElementById('dateFrom')?.value,
            document.getElementById('dateTo')?.value
        );
    }

    // Show/hide & re-render FFT panel depending on sensor type
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

function initSensorSelector() {
    // Parameter buttons on chart header intentionally removed by request.
}



// --- 5. EVENT LISTENERS ---
function setupEventListeners() {
    // Tombol preset waktu
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            
            // Update active button
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            // Update dates
            const hours = this.getAttribute('data-hours');
            updateDateFromHours(hours);
            
            // Load data
            loadReportData();
        });
    });
    
    // Tombol Apply
    document.getElementById('applyDateRange')?.addEventListener('click', loadReportData);
    
    // Date picker change events
    document.addEventListener('change', function(e) {
        if (e.target.id === 'dateFrom') {
            const dateTo = document.getElementById('dateTo');
            if (dateTo) {
                dateTo.min = e.target.value;
            }
        }
    });
    
    // Enter key pada date picker
    document.addEventListener('keypress', function(e) {
        if ((e.target.id === 'dateFrom' || e.target.id === 'dateTo') && e.key === 'Enter') {
            loadReportData();
        }
    });
    
    // Export buttons
    document.getElementById('toggleExport')?.addEventListener('click', toggleExportOptions);
    document.getElementById('printChart')?.addEventListener('click', printChart);
    document.getElementById('recalculateFft')?.addEventListener('click', () => renderFftAnalysis(currentData));
}

function updateDateFromHours(hours) {
    const now = new Date();
    const past = new Date(now.getTime() - (hours * 60 * 60 * 1000));
    
    const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    const dateFrom = document.getElementById('dateFrom');
    const dateTo = document.getElementById('dateTo');
    
    if (dateFrom) dateFrom.value = formatDate(past);
    if (dateTo) dateTo.value = formatDate(now);
    
    // Update constraints
    if (dateFrom && dateTo) {
        dateTo.min = dateFrom.value;
    }
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

        if (!byTime.has(ts)) {
            byTime.set(ts, { ...row, __count: 1 });
            return;
        }

        const prev = byTime.get(ts);
        const merged = { ...prev, __count: prev.__count + 1 };

        Object.keys(SENSORS).forEach((sensorKey) => {
            const a = Number(prev[sensorKey]);
            const b = Number(row[sensorKey]);

            if (Number.isFinite(a) && Number.isFinite(b)) merged[sensorKey] = (a + b) / 2;
            else if (!Number.isFinite(a) && Number.isFinite(b)) merged[sensorKey] = b;
        });

        byTime.set(ts, merged);
    });

    return [...byTime.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, row]) => {
            const normalized = { ...row };
            delete normalized.__count;
            return normalized;
        });
}

function removeSpikeNoise(rows) {
    if (!Array.isArray(rows) || rows.length < 5) return rows;

    const cleanRows = rows.map((row) => ({ ...row }));
    const windowRadius = 2;

    Object.keys(SENSORS).forEach((sensorKey) => {
        const series = cleanRows.map((row) => Number(row[sensorKey]));

        for (let i = 0; i < series.length; i++) {
            const curr = series[i];
            if (!Number.isFinite(curr)) continue;

            const start = Math.max(0, i - windowRadius);
            const end = Math.min(series.length - 1, i + windowRadius);
            const neighborhood = [];

            for (let j = start; j <= end; j++) {
                if (j === i) continue;
                const value = series[j];
                if (Number.isFinite(value)) neighborhood.push(value);
            }

            if (neighborhood.length < 3) continue;

            const sorted = [...neighborhood].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
            const mad = deviations[Math.floor(deviations.length / 2)] || 0;

            if (mad === 0) continue;

            const robustZ = Math.abs(curr - median) / (1.4826 * mad);
            if (robustZ > 4.5) {
                cleanRows[i][sensorKey] = null;
            }
        }
    });

    return cleanRows;
}

function normalizeReportRows(rows) {
    if (!Array.isArray(rows)) return [];

    const normalized = rows.map((row) => {
        const tempVal = row.temp ?? row.temperature;
        const powerKw = row.power ?? row.kw;
        const timestampRaw = row.timestamp || row.createdAt || row.date || row.waktu || null;
        const ts = new Date(timestampRaw || '').getTime();
        if (!Number.isFinite(ts)) return null;

        const normalizedRow = {
            ...row,
            timestamp: new Date(ts).toISOString(),
            temp: cleanSensorValue('temp', tempVal),
            coolant: cleanSensorValue('coolant', row.coolant ?? tempVal),
            power: cleanSensorValue('power', powerKw)
        };

        Object.keys(SENSORS).forEach((sensorKey) => {
            if (sensorKey === 'temp' || sensorKey === 'coolant' || sensorKey === 'power') return;
            normalizedRow[sensorKey] = cleanSensorValue(sensorKey, row[sensorKey]);
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
            if (basePath && !candidates.includes(basePath)) {
                candidates.push(basePath);
            }
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
        const response = await fetch(url);
        if (response.ok || response.status !== 404) {
            return response;
        }

        lastResponse = response;
        console.warn(`Reports endpoint not found (${url}). Trying next candidate...`);
    }

    return lastResponse;
}

async function fetchWithFallback(primaryUrls, fallbackUrls = []) {
    const primaryResponse = await fetchFirstAvailable(primaryUrls);
    if (primaryResponse && (primaryResponse.ok || primaryResponse.status !== 404 || !fallbackUrls.length)) {
        return primaryResponse;
    }

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
            endDate: endDate.toISOString()
        }).toString();

        return {
            primaryUrls: buildApiCandidates(API_URL, params),
            fallbackUrls: buildApiCandidates('/api/engine-data/history', params)
        };
    }

    const params = new URLSearchParams({ ...baseParams, hours: '24' }).toString();
    return {
        primaryUrls: buildApiCandidates(API_URL, params),
        fallbackUrls: buildApiCandidates('/api/engine-data/history', params)
    };
}



// --- 6b. DEDICATED STATS FETCH FROM MONGODB AGGREGATION ---
/**
 * Fetch per-sensor stats (min, max, avg, count) from a dedicated MongoDB aggregation endpoint.
 * Expected API response shape:
 * {
 *   stats: {
 *     totalMatched: 34641,
 *     bySensor: {
 *       rpm:  { min: 0, max: 3099, avg: 2898.7, count: 34641 },
 *       volt: { min: 0, max: 229.9, avg: 219.9, count: 34641 },
 *       ...
 *     }
 *   }
 * }
 *
 * If the endpoint doesn't exist (404), the function returns null gracefully
 * so the caller can fall back to stats bundled in the main data response.
 */
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

        const params = new URLSearchParams(baseParams).toString();
        const urls   = buildApiCandidates(API_STATS_URL, params);
        const response = await fetchFirstAvailable(urls);

        if (response.status === 404) {
            console.info('fetchDbStats: /api/reports/stats not found – will use stats from main response.');
            return null;
        }

        if (!response.ok) {
            console.warn(`fetchDbStats: HTTP ${response.status}`);
            return null;
        }

        const result = await response.json();
        // Accept { stats: { bySensor, totalMatched } } OR { bySensor, totalMatched } directly
        const stats = result?.stats ?? result ?? null;
        if (stats?.bySensor) {
            console.info('fetchDbStats: received MongoDB aggregation stats', stats);
        }
        return stats;
    } catch (err) {
        console.warn('fetchDbStats failed:', err);
        return null;
    }
}

function createDemoRows() {
    const now = Date.now();
    const offsets = [5, 4, 3, 2, 1, 0];
    return offsets.map((hourOffset, index) => ({
        timestamp: new Date(now - hourOffset * 60 * 60 * 1000).toISOString(),
        rpm: 1480 + index * 18,
        volt: 221 + (index % 2),
        amp: 28 + index,
        power: 620 + index * 22,
        freq: 50 + ((index % 2) * 0.08),
        temp: 76 + index,
        coolant: 76 + index,
        fuel: 68 - index,
        iat: 31 + (index * 0.4),
        batt: 12.4 + (Math.random() * 0.8),
        afr: 14.1 + (index * 0.05),
        tps: 34 + index,
        status: 'DEMO',
        sync: 'SIMULATED'
    }));
}

async function fetchLatestSnapshotRows() {
    const deviceId = getReportDeviceId();
    const query = deviceId ? new URLSearchParams({ deviceId }).toString() : '';
    const response = await fetchFirstAvailable(buildApiCandidates('/api/engine-data/latest', query));
    if (!response.ok) {
        throw new Error(`Latest snapshot error: ${response.status}`);
    }

    const result = await response.json();
    const data = result?.data ? [result.data] : [];
    return {
        result,
        rows: normalizeReportRows(data)
    };
}

async function fetchPeriodAlertCount({ startDate, endDate, deviceId }) {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate.toISOString());
    if (endDate) params.set('endDate', endDate.toISOString());
    if (deviceId) params.set('deviceId', deviceId);

    const response = await fetchFirstAvailable(buildApiCandidates('/api/alerts/count', params.toString()));
    if (!response || !response.ok) return 0;
    const result = await response.json();
    return Number(result?.count) || 0;
}

function renderDataSourceNotice({ source, mode = 'info', message }) {
    const noticeEl = document.getElementById('dataSourceNotice');
    if (!noticeEl) return;

    const presets = {
        success: { icon: 'fa-circle-check', className: 'notice-success' },
        warning: { icon: 'fa-triangle-exclamation', className: 'notice-warning' },
        info: { icon: 'fa-circle-info', className: '' }
    };

    const preset = presets[mode] || presets.info;
    noticeEl.className = `data-source-notice ${preset.className}`.trim();
    noticeEl.innerHTML = `
        <i class="fas ${preset.icon}"></i>
        <div>
            <strong>${message}</strong>
            ${source ? `<div style="margin-top:4px; font-size:13px; opacity:0.9;">Mode tampilan: ${source}</div>` : ''}
        </div>
    `;
    noticeEl.style.display = 'flex';
}

function applyRowsToReports(rows, meta = {}) {
    currentData = normalizeReportRows(rows);
    reportStatsBySensor = meta?.stats?.bySensor || null;
    reportTotalMatched = Number(meta?.stats?.totalMatched) || 0;
    const deviceInfo = meta?.deviceIdUsed ? `device ${meta.deviceIdUsed}` : '';

    if (currentData.length > 0) {
        updateOverview(currentData);
        renderSensorCards(currentData);
        renderChart(currentData);

        // Only render FFT for sensors that support it; hide the panel otherwise.
        const analysisPanelEl = document.querySelector('.analysis-panel');
        const activeSensor = selectedSensors[0] || 'rpm';
        if (analysisPanelEl) {
            analysisPanelEl.style.display = FFT_SENSORS.includes(activeSensor) ? '' : 'none';
        }
        if (FFT_SENSORS.includes(activeSensor)) {
            renderFftAnalysis(currentData);
        }

        updateChartTitle(document.getElementById('dateFrom')?.value, document.getElementById('dateTo')?.value);

        if (meta.source === 'demo') {
            renderDataSourceNotice({
                source: 'preview',
                mode: 'info',
                message: 'Mode pratinjau aktif. Halaman tetap menampilkan contoh data lokal agar layout tetap rapi dan mudah dicek.'
            });
        } else if (meta.source === 'memory') {
            renderDataSourceNotice({
                source: ['snapshot', deviceInfo].filter(Boolean).join(' • '),
                mode: 'warning',
                message: 'Data historis belum tersedia. Halaman menampilkan snapshot terakhir yang masih bisa dibaca.'
            });
        } else {
            renderDataSourceNotice({
                source: [meta.source || 'live data', deviceInfo].filter(Boolean).join(' • '),
                mode: 'success',
                message: 'Data berhasil dimuat.'
            });
        }

        return true;
    }

    return false;
}

async function loadReportData() {
    console.log('Loading report data...');
    reportStatsBySensor = null;
    reportTotalMatched = 0;
    periodAlertCount = 0;
    const deviceId = getReportDeviceId();
    
    // Show loading state
    const loadingEl = document.getElementById('sensorsLoading');
    const containerEl = document.getElementById('sensorsContainer');
    
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading sensor data...';
    }
    
    if (containerEl) {
        containerEl.style.display = 'none';
    }
    
    try {
        // Get date values
        const dateFrom = document.getElementById('dateFrom');
        const dateTo = document.getElementById('dateTo');
        
        let requestLimit = 5000;
        let urls;
        let rangeStart = null;
        let rangeEnd = null;

        // Build URL with date parameters
        if (dateFrom && dateTo && dateFrom.value && dateTo.value) {
            // Input type="date" menghasilkan string "YYYY-MM-DD".
            // new Date("YYYY-MM-DD") diparsing browser sebagai UTC midnight.
            // setHours(0,0,0,0) lalu mengubahnya ke LOCAL midnight (WIB = UTC+7),
            // sehingga "2025-12-01" → 2025-11-30T17:00:00Z — persis sama dengan
            // query MongoDB Compass saat user memilih tanggal dalam WIB.
            // JANGAN ganti ke Date.UTC: itu akan mengunci ke UTC midnight dan
            // menggeser range 7 jam untuk user WIB.
            const startDate = new Date(dateFrom.value);
            startDate.setHours(0, 0, 0, 0);      // → local (WIB) midnight

            const endDate = new Date(dateTo.value);
            endDate.setHours(23, 59, 59, 999);    // → local (WIB) end-of-day

            // Validate date range
            if (endDate < startDate) {
                showError('End date must be after start date');
                return;
            }

            activeRange.start = startDate.getTime();
            activeRange.end = endDate.getTime();
            rangeStart = startDate;
            rangeEnd = endDate;

            const rangeDays = Math.max(1, Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000)));
            requestLimit = Math.min(100000, Math.max(5000, rangeDays * 2880));

            urls = buildReportUrls({ startDate, endDate, requestLimit, deviceId });
            console.log('Fetching with dates:', startDate.toISOString(), 'to', endDate.toISOString(), 'limit:', requestLimit);
        } else {
            // Default to last 24 hours
            requestLimit = 10000;
            urls = buildReportUrls({ requestLimit, deviceId });
            activeRange.start = null;
            activeRange.end = null;
            rangeStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
            rangeEnd = new Date();
            console.log('Fetching last 24 hours with limit:', requestLimit);
        }
        
        // ── Fetch row data AND MongoDB aggregation stats in parallel ──
        console.log('Fetching from:', urls.primaryUrls[0], 'fallback:', urls.fallbackUrls[0]);
        const [response, separateDbStats] = await Promise.all([
            fetchWithFallback(urls.primaryUrls, urls.fallbackUrls),
            fetchDbStats(rangeStart, rangeEnd, deviceId)
        ]);
        
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        
        const result = await response.json();
        const rows = Array.isArray(result) ? result : (result.data || []);
        periodAlertCount = await fetchPeriodAlertCount({ startDate: rangeStart, endDate: rangeEnd, deviceId });

        // Merge DB aggregation stats (separateDbStats) into the meta so
        // renderSensorCards always receives the true MongoDB min/max/avg.
        const metaWithStats = {
            ...result,
            stats: separateDbStats || result?.stats || null
        };

        if ((result.success !== false) && rows) {
            if (!applyRowsToReports(rows, metaWithStats)) {
                const snapshot = await fetchLatestSnapshotRows();
                if (!applyRowsToReports(snapshot.rows, { ...snapshot.result, source: 'memory' })) {
                    renderDataSourceNotice({
                        source: 'empty range',
                        mode: 'warning',
                        message: 'Belum ada data sensor yang tersimpan untuk rentang waktu ini.'
                    });
                    showNoDataMessage();
                }
            }
        } else {
            throw new Error(result.error || 'No data received');
        }
        
    } catch (error) {
        console.error('Error loading data:', error);
        try {
            const snapshot = await fetchLatestSnapshotRows();
            if (!applyRowsToReports(snapshot.rows, { ...snapshot.result, source: 'memory', warning: error.message })) {
                renderDataSourceNotice({
                    source: 'snapshot',
                    mode: 'warning',
                    message: 'Data histori belum bisa diambil, jadi halaman mencoba memakai snapshot terakhir.'
                });
                showNoDataMessage();
            }
        } catch (snapshotError) {
            applyRowsToReports(createDemoRows(), { source: 'demo' });
        }
    } finally {
        // Hide loading
        if (loadingEl) {
            loadingEl.style.display = 'none';
        }
        
        // Show container
        if (containerEl) {
            containerEl.style.display = 'grid';
        }
    }
}



function buildContinuousBuckets(aggregatedData, bucketMs, startMs, endMs) {
    if (!Array.isArray(aggregatedData) || !bucketMs || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return aggregatedData || [];

    const byTs = new Map();
    aggregatedData.forEach((row) => {
        const t = new Date(row.timestamp).getTime();
        if (Number.isFinite(t)) byTs.set(t, row);
    });

    const alignedStart = Math.floor(startMs / bucketMs) * bucketMs;
    const alignedEnd = Math.floor(endMs / bucketMs) * bucketMs;
    const rows = [];

    for (let t = alignedStart; t <= alignedEnd; t += bucketMs) {
        if (byTs.has(t)) {
            rows.push(byTs.get(t));
            continue;
        }
        const emptyRow = { timestamp: new Date(t).toISOString() };
        Object.keys(SENSORS).forEach((key) => {
            emptyRow[key] = null;
        });
        rows.push(emptyRow);
    }

    return rows;
}

function buildTrendInsights(displayData, sensorKey) {
    const values = displayData
        .map((row) => Number(row[sensorKey]))
        .filter((v) => Number.isFinite(v));

    if (!values.length) {
        return ['Data belum cukup untuk analisis tren sensor pada rentang ini.'];
    }

    const first = values[0];
    const last = values[values.length - 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
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
    const stamps = data
        .map((d) => new Date(d.timestamp).getTime())
        .filter((t) => Number.isFinite(t));
    if (stamps.length < 2) return 0;
    return Math.max(...stamps) - Math.min(...stamps);
}

function getBucketMsByRange(timeRange) {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    // Untuk range panjang (mingguan/bulanan), gunakan agregasi harian
    // agar sampel selaras dengan rentang tanggal (contoh Des 1-31 ~= 31 sampel).
    if (timeRange > 120 * day) return 3 * day;
    if (timeRange > 45 * day) return 2 * day;
    if (timeRange > 7 * day) return 1 * day;
    if (timeRange > 2 * day) return 6 * hour;
    if (timeRange > day) return 30 * 60 * 1000;
    return 5 * 60 * 1000;
}

function aggregateDataByTimeBuckets(data, bucketMs) {
    if (!Array.isArray(data) || !data.length || !bucketMs) return data || [];

    const sorted = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const buckets = new Map();

    sorted.forEach((row) => {
        const ts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(ts)) return;
        const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
        const key = String(bucketStart);

        if (!buckets.has(key)) {
            buckets.set(key, { timestamp: new Date(bucketStart).toISOString(), count: 0, sums: {} });
        }

        const b = buckets.get(key);
        b.count += 1;

        Object.keys(SENSORS).forEach((sensorKey) => {
            const v = Number(row[sensorKey]);
            if (Number.isFinite(v)) {
                b.sums[sensorKey] = (b.sums[sensorKey] || 0) + v;
            }
        });
    });

    const aggregated = [];
    buckets.forEach((b) => {
        const row = { timestamp: b.timestamp };
        Object.keys(SENSORS).forEach((sensorKey) => {
            if (b.sums[sensorKey] != null) {
                row[sensorKey] = b.sums[sensorKey] / b.count;
            }
        });
        aggregated.push(row);
    });

    return aggregated.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function movingAverage(values, windowSize) {
    if (!Array.isArray(values) || values.length === 0 || windowSize <= 1) return values;
    const out = [];
    for (let i = 0; i < values.length; i++) {
        const start = Math.max(0, i - windowSize + 1);
        let sum = 0;
        let count = 0;
        for (let j = start; j <= i; j++) {
            const v = Number(values[j]);
            if (Number.isFinite(v)) {
                sum += v;
                count += 1;
            }
        }
        out.push(count ? sum / count : 0);
    }
    return out;
}

function buildAnalysisRows(data, sensorKey) {
    const timeRange = computeTimeRange(data);
    const bucketMs = getBucketMsByRange(timeRange);
    let aggregated = aggregateDataByTimeBuckets(data, bucketMs);
    if (Number.isFinite(activeRange.start) && Number.isFinite(activeRange.end)) {
        aggregated = buildContinuousBuckets(aggregated, bucketMs, activeRange.start, activeRange.end);
    }
    aggregated = aggregated.filter((row) => Number.isFinite(Number(row[sensorKey])));

    const maxRows = 1200;
    const reduced = aggregated.length > maxRows
        ? aggregated.filter((_, i) => i % Math.ceil(aggregated.length / maxRows) === 0)
        : aggregated;

    return reduced.map((row) => ({
        timestamp: row.timestamp,
        [sensorKey]: row[sensorKey]
    }));
}

// --- 7. CHART FUNCTIONS (IMPROVED) ---
function renderChart(data) {
    console.log('Rendering chart with', data.length, 'data points');
    
    // Destroy old chart
    destroyChart();
    
    const canvas = document.getElementById('mainChart');
    if (!canvas) {
        console.error('Chart canvas not found');
        return;
    }
    
    if (!data || data.length === 0) {
        // Show placeholder
        const chartContainer = document.querySelector('#chartContainer .chart-content');
        if (chartContainer) {
            chartContainer.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center; height: 400px; color: #6b7280;">
                    <div style="text-align: center;">
                        <i class="fas fa-chart-line fa-2x" style="margin-bottom: 15px; opacity: 0.3;"></i>
                        <p>No chart data available for selected period</p>
                    </div>
                </div>
            `;
        }
        return;
    }
    
    try {
        // Prepare chart data
        const { labels, datasets, timeRange, bucketMs, yScale, displayData } = prepareChartData(data);
        
        // Create chart
        const ctx = canvas.getContext('2d');
        
        myChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: getChartOptions(timeRange, yScale)
        });

        const insightLines = buildTrendInsights(displayData, selectedSensors[0] || 'rpm');
        updateChartDescription(bucketMs, labels.length, insightLines);
        console.log('Chart rendered successfully');
        
    } catch (error) {
        console.error('Error creating chart:', error);
        // Show error but don't block the rest of the page
        const chartContainer = document.querySelector('#chartContainer .chart-content');
        if (chartContainer) {
            chartContainer.innerHTML += `
                <div style="color: #f97316; padding: 10px; background: #fffbeb; border-radius: 4px; margin-top: 10px; font-size: 12px;">
                    <i class="fas fa-exclamation-triangle"></i> Chart error: ${error.message}
                </div>
            `;
        }
    }
}




function destroyFftChart() {
    try {
        if (fftChart) {
            fftChart.destroy();
            fftChart = null;
        }
    } catch (error) {
        console.warn('Error destroying FFT chart:', error);
        fftChart = null;
    }
}

function calculateMedian(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function estimateSampleRate(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return 1;
    const sorted = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const deltas = [];
    for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1].timestamp).getTime();
        const curr = new Date(sorted[i].timestamp).getTime();
        const dtSec = (curr - prev) / 1000;
        if (Number.isFinite(dtSec) && dtSec > 0) deltas.push(dtSec);
    }
    const medianDt = calculateMedian(deltas);
    return medianDt > 0 ? 1 / medianDt : 1;
}

function detectFftPeaks(spectrum, maxPeaks = 3) {
    if (!Array.isArray(spectrum) || spectrum.length < 3) return [];
    const candidates = [];
    for (let i = 1; i < spectrum.length - 1; i++) {
        const left = spectrum[i - 1].amp;
        const mid = spectrum[i].amp;
        const right = spectrum[i + 1].amp;
        if (mid >= left && mid >= right) candidates.push(spectrum[i]);
    }
    return candidates
        .sort((a, b) => b.amp - a.amp)
        .slice(0, maxPeaks);
}

function calculateFftLocally(rows, sensorKey) {
    const prepared = buildAnalysisRows(rows || [], sensorKey);
    const values = prepared
        .map((row) => Number(row[sensorKey]))
        .filter((value) => Number.isFinite(value));

    if (values.length < 16) {
        return {
            summary: 'Data belum cukup untuk menghitung FFT (minimal 16 sampel valid).',
            stats: { count: values.length, mean: 0, trend: 'n/a' },
            spectrum: [],
            peaks: []
        };
    }

    const sampleRate = estimateSampleRate(prepared);
    const n = Math.min(values.length, 512);
    const signal = values.slice(-n);
    const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
    const centered = signal.map((v, i) => {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
        return (v - mean) * hann;
    });

    const half = Math.floor(centered.length / 2);
    const spectrum = [];

    for (let k = 0; k <= half; k++) {
        let real = 0;
        let imag = 0;
        for (let t = 0; t < centered.length; t++) {
            const angle = (2 * Math.PI * k * t) / centered.length;
            real += centered[t] * Math.cos(angle);
            imag -= centered[t] * Math.sin(angle);
        }
        const amp = Math.sqrt(real * real + imag * imag) / centered.length;
        const freq = (k * sampleRate) / centered.length;
        spectrum.push({ freq, amp });
    }

    const significantSpectrum = spectrum.slice(1).filter((p) => p.freq > 0);
    const peaks = detectFftPeaks(significantSpectrum, 3);
    const trend = signal[signal.length - 1] > signal[0]
        ? 'increasing'
        : signal[signal.length - 1] < signal[0]
            ? 'decreasing'
            : 'stable';

    const peakText = peaks.length
        ? peaks.map((p) => `${p.freq.toFixed(3)} Hz`).join(', ')
        : 'tidak ada frekuensi dominan';

    return {
        summary: `FFT lokal dihitung dari ${signal.length} sampel (fs ${sampleRate.toFixed(3)} Hz). Dominan: ${peakText}.`,
        stats: { count: signal.length, mean, trend },
        spectrum: significantSpectrum,
        peaks
    };
}

function drawFftResult(result, sensorKey) {
    const summaryEl = document.getElementById('fftSummary');
    const insightsEl = document.getElementById('fftInsights');
    const canvas = document.getElementById('fftChart');
    if (!canvas || !summaryEl || !insightsEl) return;

    const payload = result?.data || result || {};
    const stats = payload.stats || {};
    const peaks = payload.peaks || [];
    const spectrum = payload.spectrum || [];

    summaryEl.textContent = payload.summary || 'FFT summary unavailable.';
    insightsEl.innerHTML = '';

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
            labels: spectrum.map((p) => (p.freq || 0).toFixed(3)),
            datasets: [{
                label: `${sensor.name} FFT Amplitude`,
                data: spectrum.map((p) => p.amp || 0),
                borderColor: sensor.color || '#1745a5',
                backgroundColor: hexToRgba(sensor.color || '#1745a5', 0.12),
                fill: true,
                pointRadius: 1.5,
                tension: 0.2,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true } },
            scales: {
                x: { title: { display: true, text: 'Frequency (Hz)' } },
                y: { title: { display: true, text: 'Amplitude' } }
            }
        }
    });
}

async function renderFftAnalysis(data) {
    const summaryEl = document.getElementById('fftSummary');
    const insightsEl = document.getElementById('fftInsights');
    const canvas = document.getElementById('fftChart');
    if (!canvas || !summaryEl || !insightsEl) return;

    destroyFftChart();
    insightsEl.innerHTML = '';

    const sensorKey = selectedSensors[0] || 'rpm';

    try {
        const analysisRows = buildAnalysisRows(data || [], sensorKey);
        const response = await fetch('/api/reports/analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: analysisRows, sensor: sensorKey, maxPoints: 300 })
        });

        if (response.status === 404) {
            drawFftResult(calculateFftLocally(analysisRows, sensorKey), sensorKey);
            return;
        }

        if (!response.ok) {
            throw new Error(`FFT API error: ${response.status}`);
        }

        const result = await response.json();
        if (!result?.data?.spectrum?.length) {
            drawFftResult(calculateFftLocally(analysisRows, sensorKey), sensorKey);
            return;
        }
        drawFftResult(result, sensorKey);
    } catch (error) {
        console.error('FFT analysis error:', error);
        drawFftResult(calculateFftLocally(data || [], sensorKey), sensorKey);
    }
}

function formatTimestampLabel(timestamp, timeRange) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp || '');

    if (timeRange >= 2 * 24 * 60 * 60 * 1000) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function prepareChartData(data) {
    const sortedData = [...data].sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
    );

    const timeRange = computeTimeRange(sortedData);
    const bucketMs = getBucketMsByRange(timeRange);
    let displayData = aggregateDataByTimeBuckets(sortedData, bucketMs);

    if (Number.isFinite(activeRange.start) && Number.isFinite(activeRange.end)) {
        displayData = buildContinuousBuckets(displayData, bucketMs, activeRange.start, activeRange.end);
    }

    const maxPoints = 900;
    if (displayData.length > maxPoints) {
        const step = Math.ceil(displayData.length / maxPoints);
        displayData = displayData.filter((_, index) => index % step === 0);
    }
    
    // Prepare datasets based on selected sensors
    const datasets = selectedSensors
        .filter(sensorKey => SENSORS[sensorKey])
        .map((sensorKey, index) => {
            const config = SENSORS[sensorKey];
            const values = displayData.map(d => {
                const val = Number(d[sensorKey]);
                return Number.isFinite(val) ? val : null;
            });
            
            return {
                label: config.name,
                data: values,
                borderColor: config.color,
                backgroundColor: hexToRgba(config.color, 0.1),
                borderWidth: 2,
                pointRadius: 1.5,
                fill: index === 0, // Only fill first dataset
                tension: 0.2,
                yAxisID: `y${index === 0 ? '' : index + 1}`
            };
        });
    
    // If no sensors selected, show RPM by default
    if (datasets.length === 0) {
        const config = SENSORS.rpm;
        datasets.push({
            label: config.name,
            data: displayData.map(d => { const v = Number(d.rpm); return Number.isFinite(v) ? v : null; }),
            borderColor: config.color,
            backgroundColor: hexToRgba(config.color, 0.1),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
            yAxisID: 'y'
        });
    }
    
    const allValues = datasets.flatMap((ds) => ds.data).filter((v) => Number.isFinite(Number(v)));
    const minVal = allValues.length ? Math.min(...allValues) : 0;
    const maxVal = allValues.length ? Math.max(...allValues) : 1;
    const range = Math.max(1, maxVal - minVal);
    const pad = range * 0.15;

    return {
        labels: displayData.map((d) => formatTimestampLabel(d.timestamp, timeRange)),
        datasets: datasets,
        timeRange: timeRange,
        bucketMs,
        yScale: {
            min: minVal - pad,
            max: maxVal + pad,
            range
        },
        displayData
    };
}

function formatBucketLabel(bucketMs) {
    const minute = 60 * 1000;
    const hour = 60 * minute;
    if (!bucketMs || bucketMs <= 0) return '-';
    if (bucketMs % (24 * hour) === 0) return `${bucketMs / (24 * hour)} day`;
    if (bucketMs % hour === 0) return `${bucketMs / hour} hour`;
    return `${Math.round(bucketMs / minute)} min`;
}

function updateChartDescription(bucketMs, sampleCount, insights = []) {
    const desc = document.getElementById('chartDescription');
    if (!desc) return;
    const suffix = Number.isFinite(sampleCount) ? ` (samples: ${sampleCount})` : '';
    const insightText = Array.isArray(insights) && insights.length ? ` | Insight: ${insights.join(' ')}` : '';
    desc.textContent = `Tren menampilkan nilai rata-rata per ${formatBucketLabel(bucketMs)} sesuai rentang waktu yang di-apply${suffix}.${insightText}`;
}

function getChartOptions(timeRange, yScale) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false
        },
        plugins: {
            legend: {
                position: 'top',
                labels: {
                    usePointStyle: true,
                    padding: 20,
                    font: {
                        size: 12
                    }
                }
            },
            tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                    title: function(tooltipItems) {
                        if (tooltipItems.length > 0) {
                            return tooltipItems[0].label;
                        }
                        return '';
                    },
                    label: function(context) {
                        let label = context.dataset.label || '';
                        if (label) {
                            label += ': ';
                        }
                        const value = context.parsed.y;
                        const sensorKey = selectedSensors[context.datasetIndex] || 'rpm';
                        const unit = SENSORS[sensorKey]?.unit || '';
                        label += value.toFixed(1) + ' ' + unit;
                        return label;
                    }
                }
            }
        },
        scales: {
            x: {
                type: 'category',
                grid: {
                    display: false
                },
                ticks: {
                    maxRotation: 45,
                    minRotation: 45,
                    autoSkip: true,
                    maxTicksLimit: 12
                },
                title: {
                    display: true,
                    text: 'Time',
                    font: {
                        size: 12,
                        weight: 'bold'
                    }
                }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                title: {
                    display: true,
                    text: getYAxisTitle(0),
                    font: {
                        size: 12,
                        weight: 'bold'
                    }
                },
                beginAtZero: false, // Don't force zero for better scaling
                grid: {
                    color: 'rgba(0, 0, 0, 0.05)'
                },
                suggestedMin: yScale?.min,
                suggestedMax: yScale?.max,
                ticks: {
                    callback: function(value) {
                        const absValue = Math.abs(value);
                        if (absValue >= 1000) {
                            const decimals = (yScale?.range || 0) < 200 ? 1 : 0;
                            return (value / 1000).toFixed(decimals) + 'k';
                        }
                        const decimals = (yScale?.range || 0) < 20 ? 2 : ((yScale?.range || 0) < 200 ? 1 : 0);
                        return Number(value).toFixed(decimals);
                    }
                }
            }
        },
        animation: {
            duration: 750,
            easing: 'easeInOutQuart'
        }
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
    const chartTitle = document.getElementById('chartTitle') || document.querySelector('.chart-title');
    if (chartTitle) {
        if (startDate && endDate) {
            const start = new Date(startDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric'
            });
            const end = new Date(endDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
            const activeSensor = SENSORS[selectedSensors[0]]?.name || 'Sensor';
            chartTitle.textContent = `${activeSensor} Trend (${start} - ${end})`; 
        } else {
            const activeSensor = SENSORS[selectedSensors[0]]?.name || 'Sensor';
            chartTitle.textContent = `${activeSensor} Trend (Last 24 Hours)`;
        }
    }
}

// --- 8. HELPER FUNCTIONS ---
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
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; background: white; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.05);">
                <div style="color: #ef4444; font-size: 48px; margin-bottom: 20px;">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <h3 style="margin-bottom: 10px; color: #dc2626;">Error Loading Data</h3>
                <p style="margin-bottom: 20px; color: #6b7280;">${message}</p>
                <button onclick="loadReportData()" 
                        style="padding: 10px 24px; background: #1745a5; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
                    <i class="fas fa-redo"></i> Try Again
                </button>
            </div>
        `;
        containerEl.style.display = 'block';
    }
}

function showNoDataMessage() {
    const containerEl = document.getElementById('sensorsContainer');
    if (containerEl) {
        containerEl.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; background: white; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.05);">
                <div style="color: #9ca3af; font-size: 48px; margin-bottom: 20px;">
                    <i class="fas fa-database"></i>
                </div>
                <h3 style="margin-bottom: 10px; color: #4b5563;">No Data Available</h3>
                <p style="margin-bottom: 30px; color: #6b7280;">
                    No sensor data found for the selected time period.
                </p>
                <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
                    <button onclick="updateDateFromHours('24'); loadReportData();" 
                            class="time-btn active">
                        Last 24 Hours
                    </button>
                    <button onclick="updateDateFromHours('168'); loadReportData();" 
                            class="time-btn">
                        Last 7 Days
                    </button>
                </div>
            </div>
        `;
        containerEl.style.display = 'block';
    }
    
    // Reset overview
    setText('dailyAverage', '-- hrs');
    setText('totalHours', '-- hrs');
    setText('daysActive', '-- days');
    setText('longestSession', '-- hrs');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// --- 9. OVERVIEW CALCULATIONS ---
function updateOverview(data) {
    if (!data || data.length === 0) {
        setText('dailyAverage', '-- hrs');
        setText('totalHours', '-- hrs');
        setText('daysActive', '-- days');
        setText('longestSession', '-- hrs');
        return;
    }
    
    try {
        // Active records (RPM > 100)
        const activeRecords = data.filter(d => d.rpm > 100);
        const totalHours = (activeRecords.length * 2) / 3600;
        
        // Unique active days
        const daysSet = new Set();
        activeRecords.forEach(d => {
            const dateStr = new Date(d.timestamp).toDateString();
            daysSet.add(dateStr);
        });
        
        const avgDaily = daysSet.size > 0 ? (totalHours / daysSet.size) : 0;
        
        // Longest session
        let maxSession = 0, currSession = 0;
        const sorted = [...data].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].rpm > 100) {
                const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i-1].timestamp)) / 1000;
                if (diff < 300) {
                    currSession += diff;
                } else {
                    maxSession = Math.max(maxSession, currSession);
                    currSession = 0;
                }
            }
        }
        maxSession = Math.max(maxSession, currSession);
        
        setText('dailyAverage', `${avgDaily.toFixed(1)} hrs`);
        setText('totalHours', `${totalHours.toFixed(1)} hrs`);
        setText('daysActive', `${daysSet.size} days`);
        setText('longestSession', `${(maxSession/3600).toFixed(1)} hrs`);
        
    } catch (error) {
        console.error('Error in updateOverview:', error);
    }
}

// --- 10. RENDER SENSOR CARDS ---
function renderSensorCards(data) {
    const container = document.getElementById('sensorsContainer');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!data || data.length === 0) {
        showNoDataMessage();
        return;
    }
    
    const latest = data[data.length - 1] || {};
    
    Object.entries(SENSORS).forEach(([key, config]) => {
        // values from fetched rows are used ONLY for the chart and for "current" reading.
        // They must NOT be used for min/max/avg/count stats on the card because:
        //   • the fetch may be limited (< total documents)
        //   • cleanSensorValue / deduplication / spike removal alter the dataset
        const values = data.map(d => d[key]).filter(v => v != null && !isNaN(v));
        if (values.length === 0) return;
        
        const computedMin = Math.min(...values);
        const computedMax = Math.max(...values);
        const computedAvg = values.reduce((a, b) => a + b, 0) / values.length;
        const dbMin = reportStatsBySensor?.[key]?.min;
        const dbMax = reportStatsBySensor?.[key]?.max;
        const dbAvg = reportStatsBySensor?.[key]?.avg;
        const dbCount = reportStatsBySensor?.[key]?.count;
        const min = Number.isFinite(Number(dbMin)) ? Number(dbMin) : computedMin;
        const max = Number.isFinite(Number(dbMax)) ? Number(dbMax) : computedMax;
        const avg = Number.isFinite(Number(dbAvg)) ? Number(dbAvg) : computedAvg;
        const readingCount = Number.isFinite(Number(dbCount)) && Number(dbCount) > 0
            ? Number(dbCount)
            : (reportTotalMatched > 0 ? reportTotalMatched : values.length);
        const current = latest[key] != null ? latest[key] : avg;
        
        // Determine status
        let status = 'normal';
        let statusClass = 'status-normal';
        
        if (key === 'temp' && current > 90) {
            status = 'critical';
            statusClass = 'status-critical';
        } else if (key === 'volt' && (current < 11 || current > 15)) {
            status = 'warning';
            statusClass = 'status-warning';
        } else if (key === 'fuel' && current < 20) {
            status = 'warning';
            statusClass = 'status-warning';
        }
        
        // Use the primary brand colour for every card so all cards are uniform.
        const accentColor = '#1745a5';

        // Footer indicator: green check when stats come from DB, orange triangle when estimated
        const hasDbStats = !!(reportStatsBySensor && reportStatsBySensor[key]);
        const footerIcon  = hasDbStats ? 'check-circle'       : 'exclamation-triangle';
        const footerColor = hasDbStats ? 'color:#22c55e'      : 'color:#f97316';
        const footerLabel = hasDbStats
            ? `${readingCount.toLocaleString()} readings`
            : `${readingCount.toLocaleString()} readings <span style="font-size:11px;opacity:0.8">(est.)</span>`;

        const card = document.createElement('div');
        card.className = 'sensor-card';
        card.dataset.sensor = key;
        card.style.setProperty('--sensor-accent', accentColor);
        card.classList.toggle('active-sensor', selectedSensors.includes(key));
        
        card.innerHTML = `
            <div class="sensor-header">
                <div class="sensor-name">
                    <div class="sensor-icon" style="background: ${accentColor}20; color: ${accentColor}">
                        <i class="${config.icon}"></i>
                    </div>
                    <span class="sensor-title-text">${config.name}</span>
                </div>
                <div class="sensor-status ${statusClass}">${status.toUpperCase()}</div>
            </div>
            
            <div class="sensor-stats">
                <div class="stat-item">
                    <div class="stat-label">CURRENT</div>
                    <div class="stat-value current-value">
                        ${current.toFixed(1)}<small style="font-size: 12px;"> ${config.unit}</small>
                    </div>
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
                    <i class="fas fa-check-circle"></i>
                    ${readingCount.toLocaleString('en-US')} readings
                </div>
                <div class="alert-indicator">
                    <i class="fas fa-bell"></i>
                    ${periodAlertCount.toLocaleString('en-US')} alerts
                </div>
            </div>
        `;
        
        card.addEventListener('click', () => {
            selectSingleSensor(key);
        });

        container.appendChild(card);
    });
    
    container.style.display = 'grid';
}

// --- 11. EXPORT FUNCTIONS ---
function toggleExportOptions() {
    const exportOptions = document.getElementById('exportOptions');
    if (exportOptions) {
        exportOptions.style.display = exportOptions.style.display === 'block' ? 'none' : 'block';
    }
}

function printChart() {
    if (!myChart) {
        alert('No chart data available to print');
        return;
    }
    
    const printWindow = window.open('', '_blank');
    const chartImage = document.getElementById('mainChart').toDataURL('image/png');
    const dateFrom = document.getElementById('dateFrom')?.value || 'N/A';
    const dateTo = document.getElementById('dateTo')?.value || 'N/A';
    
    printWindow.document.write(`
        <html>
            <head>
                <title>Gen-Track - Engine Report</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 40px; }
                    .print-header { text-align: center; margin-bottom: 30px; }
                    .chart-container { max-width: 800px; margin: 0 auto; }
                    img { max-width: 100%; height: auto; }
                </style>
            </head>
            <body>
                <div class="print-header">
                    <h1>Engine Data Report</h1>
                    <p>Period: ${dateFrom} to ${dateTo}</p>
                    <p>Generated: ${new Date().toLocaleString()}</p>
                </div>
                <div class="chart-container">
                    <img src="${chartImage}" alt="Chart">
                </div>
                <script>
                    setTimeout(() => {
                        window.print();
                        window.close();
                    }, 500);
                </script>
            </body>
        </html>
    `);
    printWindow.document.close();
}

// --- 12. GLOBAL FUNCTIONS ---
window.loadReportData = loadReportData;
window.updateDateFromHours = updateDateFromHours;