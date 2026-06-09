// === CONFIGURATION ===
const API_URL = '/api/engine-data/history';

// State Management
let rawApiData = [];
let processedRows = [];
let filteredRows = [];
let currentPage = 1;
const itemsPerPage = 20;
let myChart = null;
const MIN_CHART_SAMPLES = 30;

// Parameter Config (Satuan & Warna untuk Grafik)
const PARAMS = {
    rpm: { unit: 'RPM', max: 4000, warn: 3500, color: '#1745a5' }, // Biru
    volt: { unit: 'V', max: 250, warn: 240, min: 180, color: '#f97316' }, // Oranye
    amp: { unit: 'A', color: '#ec4899' }, // Pink
    power: { unit: 'kW', color: '#14b8a6' }, // Teal
    freq: { unit: 'Hz', color: '#8b5cf6' }, // Ungu
    coolant: { unit: '°C', max: 105, warn: 90, color: '#06b6d4', label: 'Coolant Temp' },
    fuel: { unit: '%', min: 20, warn: 30, color: '#10b981' }, // Hijau
    phase: { unit: '°', max: 15, warn: 10, min: -15, color: '#0ea5e9', label: 'Phase Difference' }, // Sky
    iat: { unit: '°C', color: '#f59e0b' }, // Amber
    map: { unit: 'kPa', color: '#0f766e' }, // Teal
    batt: { unit: 'Volt', max: 24, warn: 22, min: 10, color: '#6366f1' }, // Indigo
    afr: { unit: 'R', color: '#3b82f6' }, // Blue
    tps: { unit: '%', color: '#a855f7' } // Purple
};

const USER_DATETIME_FORMAT = new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});

const HISTORY_TABLE_COLUMNS = [
    { key: 'timestamp', header: 'Timestamp', getter: (row) => formatReadableTimestamp(row.rawDate || row.timestamp) },
    { key: 'generator', header: 'Generator', getter: (row) => row.generator || 'Gen-01' },
    { key: 'rpm', header: 'RPM', getter: (row) => formatHistoryValue(row.rpm) },
    { key: 'volt', header: 'Voltage (V)', getter: (row) => formatHistoryValue(row.volt) },
    { key: 'amp', header: 'Current (A)', getter: (row) => formatHistoryValue(row.amp) },
    { key: 'power', header: 'Power (kW)', getter: (row) => formatHistoryValue(row.power) },
    { key: 'freq', header: 'Frequency (Hz)', getter: (row) => formatHistoryValue(row.freq) },
    { key: 'coolant', header: 'Coolant (°C)', getter: (row) => formatHistoryValue(row.coolant) },
    { key: 'fuel', header: 'Fuel (%)', getter: (row) => formatHistoryValue(row.fuel) },
    { key: 'phase', header: 'Phase (°)', getter: (row) => formatHistoryValue(row.phase) },
    { key: 'iat', header: 'IAT (°C)', getter: (row) => formatHistoryValue(row.iat) },
    { key: 'map', header: 'MAP (kPa)', getter: (row) => formatHistoryValue(row.map) },
    { key: 'batt', header: 'Battery (V)', getter: (row) => formatHistoryValue(row.batt) },
    { key: 'afr', header: 'AFR', getter: (row) => formatHistoryValue(row.afr) },
    { key: 'tps', header: 'TPS (%)', getter: (row) => formatHistoryValue(row.tps) },
    { key: 'status', header: 'Status', getter: (row) => row.status || 'normal' }
];

const HISTORY_EXPORT_COLUMNS = HISTORY_TABLE_COLUMNS;


// --- 1. FILTER & DATE INPUT LOGIC ---

function getPhaseDifferenceValue(row = {}) {
    return row.phase ?? row.phaseAngle ?? row.phase_angle ?? row.phaseDiff ?? row.phase_diff;
}

function updateDateInputs(val) {
    const end = new Date();
    let start = new Date();

    if (val === 'today') {
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
    } else if (val === 'yesterday') {
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
        start.setHours(0,0,0,0);
        end.setHours(23,59,59,999);
    } else if (val === 'custom') {
        return; // User set manual
    } else {
        const days = parseInt(val, 10);
        if (!Number.isFinite(days)) return;
        start.setDate(start.getDate() - days);
    }

    // Set value ke input type="date" (Format YYYY-MM-DD)
    // Perlu penyesuaian timezone offset agar tidak meleset
    const toISODate = (d) => {
        const offset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };

    document.getElementById('dateFrom').value = toISODate(start);
    document.getElementById('dateTo').value = toISODate(end);
}

// Trigger saat tombol Apply diklik
async function applyFilters() {
    loadDataFromAPI();
}

// Load Data dari API
async function loadDataFromAPI() {
    const loader = document.getElementById('loading');
    const tbody = document.getElementById('historyTableBody');
    const dFrom = document.getElementById('dateFrom').value;
    const dTo = document.getElementById('dateTo').value;
    
    loader.style.display = 'block';
    tbody.innerHTML = ''; 

    // Update Text Summary
    updateSummaryTimeRange(dFrom, dTo);

    // Build URL Query
    let url = `${API_URL}?limit=5000`; // Ambil banyak data untuk grafik yang akurat
    if (dFrom && dTo) {
        url += `&startDate=${dFrom}&endDate=${dTo}`;
    } else {
        url += `&hours=720`; // Default 30 hari
    }

    try {
        const res = await fetch(url);
        const json = await res.json();

        if (json.success) {
            rawApiData = json.data;
            processDataAndRender();
        } else {
            tbody.innerHTML = `<tr><td colspan="${HISTORY_TABLE_COLUMNS.length}" style="text-align:center; color:red">Error: ${json.error}</td></tr>`;
        }
    } catch (err) {
        console.error(err);
        tbody.innerHTML = `<tr><td colspan="${HISTORY_TABLE_COLUMNS.length}" style="text-align:center; color:red">Connection Failed</td></tr>`;
    } finally {
        loader.style.display = 'none';
    }
}

function updateSummaryTimeRange(startStr, endStr) {
    const el = document.getElementById('dataPeriod');
    if (!startStr || !endStr) {
        el.innerText = 'All Time';
        return;
    }

    const start = new Date(startStr);
    const end = new Date(endStr);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    const diffMs = Math.max(0, end.getTime() - start.getTime());
    const diffHours = Math.max(1, Math.round(diffMs / (1000 * 60 * 60)));

    el.innerText = diffHours < 48 ? `${diffHours} Hours` : `${Math.ceil(diffHours / 24)} Days`;
}

// --- 2. DATA PROCESSING ---

function readHistoryParamValue(item, key) {
    if (key === 'phase') return getPhaseDifferenceValue(item);
    if (key === 'volt') return item.volt ?? item.voltage;
    if (key === 'coolant') return item.coolant ?? item.clt ?? item.temp;
    if (key === 'batt') return item.batt ?? item.battery ?? item.battVolt;
    return item[key];
}

function buildTimestampRow(item) {
    const row = {
        timestamp: item.timestamp,
        rawDate: new Date(item.timestamp),
        generator: item.deviceId || 'Gen-01'
    };

    Object.keys(PARAMS).forEach((key) => {
        const val = readHistoryParamValue(item, key);
        if (val !== undefined && val !== null) row[key] = val;
    });

    row.status = getRowOverallStatus(row);
    return row;
}

function rowMatchesParameter(row, paramKey) {
    if (paramKey === 'all') return true;
    return row[paramKey] !== undefined && row[paramKey] !== null;
}

function rowMatchesSearch(row, query) {
    if (!query) return true;
    const haystack = [
        row.generator,
        row.status,
        formatReadableTimestamp(row.rawDate),
        ...Object.keys(PARAMS).flatMap((key) => [key, PARAMS[key].label || key.toUpperCase(), row[key]])
    ].join(' ').toLowerCase();
    return haystack.includes(query);
}

function processDataAndRender() {
    processedRows = rawApiData
        .map(buildTimestampRow)
        .filter((row) => !Number.isNaN(row.rawDate.getTime()))
        .sort((a, b) => b.rawDate - a.rawDate);

    const alertCount = processedRows.filter((row) => row.status !== 'normal').length;

    const pFilter = document.getElementById('paramFilter').value;
    const sFilter = document.getElementById('statusFilter').value;
    const qSearch = document.getElementById('searchQuery').value.toLowerCase().trim();

    filteredRows = processedRows.filter(row => {
        if (!rowMatchesParameter(row, pFilter)) return false;
        if (sFilter !== 'all' && row.status !== sFilter) return false;
        if (!rowMatchesSearch(row, qSearch)) return false;
        return true;
    });

    document.getElementById('totalRecords').innerText = processedRows.length.toLocaleString();
    document.getElementById('alertCount').innerText = alertCount;

    currentPage = 1;
    renderTable();
}

// --- 3. RENDER TABLE ---

function renderTable() {
    const tbody = document.getElementById('historyTableBody');
    const thead = document.getElementById('historyTableHead');
    tbody.innerHTML = '';

    if (thead) {
        thead.innerHTML = `<tr>${HISTORY_TABLE_COLUMNS.map((column) => `<th>${column.header}</th>`).join('')}</tr>`;
    }

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageData = filteredRows.slice(start, end);

    if (pageData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${HISTORY_TABLE_COLUMNS.length}" style="text-align:center; padding:20px;">No data match filters</td></tr>`;
        document.getElementById('pageStart').innerText = 0;
        document.getElementById('pageEnd').innerText = 0;
        document.getElementById('totalItems').innerText = 0;
        document.getElementById('pageNum').innerText = 1;
        document.getElementById('btnPrev').disabled = true;
        document.getElementById('btnNext').disabled = true;
        return;
    }

    pageData.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = HISTORY_TABLE_COLUMNS.map((column) => {
            if (column.key === 'status') {
                return `<td><span class="status-badge status-${row.status}">${row.status}</span></td>`;
            }
            const value = column.getter(row);
            const cellClass = column.key !== 'timestamp' && column.key !== 'generator' ? ` class="value-cell value-${getParamStatus(column.key, row[column.key])}"` : '';
            return `<td${cellClass}>${value === '' ? '-' : value}</td>`;
        }).join('');
        tbody.appendChild(tr);
    });

    document.getElementById('pageStart').innerText = start + 1;
    document.getElementById('pageEnd').innerText = Math.min(end, filteredRows.length);
    document.getElementById('totalItems').innerText = filteredRows.length;
    document.getElementById('pageNum').innerText = currentPage;

    document.getElementById('btnPrev').disabled = (currentPage === 1);
    document.getElementById('btnNext').disabled = (end >= filteredRows.length);
}

function changePage(dir) {
    currentPage += dir;
    renderTable();
}

function resetFilters() {
    updateDateInputs('30');
    document.getElementById('timeRange').value = '30';
    document.getElementById('paramFilter').value = 'all';
    document.getElementById('statusFilter').value = 'all';
    document.getElementById('searchQuery').value = '';
    applyFilters();
}

function formatReadableTimestamp(input) {
    const dateObj = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(dateObj.getTime())) return '-';
    return USER_DATETIME_FORMAT.format(dateObj);
}

function escapeCsvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function escapeHtmlCell(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
}

function normalizeExportCell(value) {
    if (value === undefined || value === null || Number.isNaN(value)) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    return value;
}

function formatHistoryValue(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(1) : normalizeExportCell(value);
}

function slugifyExportPart(value, fallback = 'all') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function getParamStatus(paramKey, value) {
    const conf = PARAMS[paramKey];
    const numericValue = Number(value);
    if (!conf || !Number.isFinite(numericValue)) return 'normal';
    if (paramKey === 'phase') {
        if (conf.max !== undefined && Math.abs(numericValue) > conf.max) return 'critical';
        if (conf.warn !== undefined && Math.abs(numericValue) > conf.warn) return 'warning';
        return 'normal';
    }
    if ((conf.max !== undefined && numericValue > conf.max) || (conf.min !== undefined && numericValue < conf.min)) return 'critical';
    if (conf.warn !== undefined && numericValue > conf.warn) return 'warning';
    return 'normal';
}

function getRowOverallStatus(row) {
    let hasWarning = false;
    for (const key of Object.keys(PARAMS)) {
        const status = getParamStatus(key, row[key]);
        if (status === 'critical') return 'critical';
        if (status === 'warning') hasWarning = true;
    }
    return hasWarning ? 'warning' : 'normal';
}

function getHistoryExportRows() {
    return [...filteredRows]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .map((row) => {
            const exportRow = {};
            HISTORY_EXPORT_COLUMNS.forEach((column) => {
                exportRow[column.header] = normalizeExportCell(column.getter(row));
            });
            return exportRow;
        });
}

function getHistoryExportFilename(extension) {
    const dateFrom = document.getElementById('dateFrom')?.value || 'all';
    const dateTo = document.getElementById('dateTo')?.value || dateFrom;
    const param = slugifyExportPart(document.getElementById('paramFilter')?.value, 'all-param');
    const status = slugifyExportPart(document.getElementById('statusFilter')?.value, 'all-status');
    const search = slugifyExportPart(document.getElementById('searchQuery')?.value, 'no-search');
    return `history_${dateFrom}_to_${dateTo}_${param}_${status}_${search}.${extension}`;
}

function exportCSV() {
    const rows = getHistoryExportRows();
    if (rows.length === 0) return alert('No data to export');

    const headers = HISTORY_EXPORT_COLUMNS.map((column) => column.header);
    const csv = [
        headers.map(escapeCsvCell).join(','),
        ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(','))
    ].join('\n');

    downloadBlob(csv, 'text/csv;charset=utf-8;', getHistoryExportFilename('csv'));
}

function exportExcel() {
    const rows = getHistoryExportRows();
    if (rows.length === 0) return alert('No data to export');

    const headers = HISTORY_EXPORT_COLUMNS.map((column) => column.header);
    const tableHead = headers.map((header) => `<th>${escapeHtmlCell(header)}</th>`).join('');
    const tableRows = rows.map((row) => `
        <tr>${headers.map((header) => `<td>${escapeHtmlCell(row[header])}</td>`).join('')}</tr>
    `).join('');

    const dateFrom = document.getElementById('dateFrom')?.value || 'all';
    const dateTo = document.getElementById('dateTo')?.value || dateFrom;
    const param = document.getElementById('paramFilter')?.value || 'all';
    const status = document.getElementById('statusFilter')?.value || 'all';
    const search = document.getElementById('searchQuery')?.value || '-';

    const htmlTable = `
        <table border="1">
            <thead><tr><th colspan="2">Applied Filters</th></tr></thead>
            <tbody>
                <tr><td>Date From</td><td>${escapeHtmlCell(dateFrom)}</td></tr>
                <tr><td>Date To</td><td>${escapeHtmlCell(dateTo)}</td></tr>
                <tr><td>Parameter</td><td>${escapeHtmlCell(param)}</td></tr>
                <tr><td>Status</td><td>${escapeHtmlCell(status)}</td></tr>
                <tr><td>Search</td><td>${escapeHtmlCell(search)}</td></tr>
                <tr><td>Total Exported Rows</td><td>${rows.length}</td></tr>
            </tbody>
        </table>
        <br>
        <table border="1">
            <thead><tr>${tableHead}</tr></thead>
            <tbody>${tableRows}</tbody>
        </table>
    `;

    downloadBlob(
        `\ufeff${htmlTable}`,
        'application/vnd.ms-excel;charset=utf-8;',
        getHistoryExportFilename('xls')
    );
}



// --- 4. HISTORY EXPORT ONLY (NO TREND CHART) ---

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    fetch('sidebar.html').then(r=>r.text()).then(h=>document.getElementById('sidebar-container').innerHTML=h);
    document.getElementById('userarea').querySelector('span').innerText = localStorage.getItem('username') || 'Pengguna';

    updateDateInputs('30');
    applyFilters(); // Load awal
});
