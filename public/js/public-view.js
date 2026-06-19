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
let isDashboardFetching = false;
let lastHealthSnapshot = null;
let dashboardTotalActiveHours = 0;
let lastHeavyFetchAt = 0;
const DASHBOARD_REFRESH_MS = 1000;
const HEAVY_ENDPOINT_REFRESH_MS = 30000;
const DATA_LIVE_THRESHOLD_MS = 10000;
const LAST_PUBLIC_SENSOR_STORAGE_KEY = 'gensys:last-engine-sensor';


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
    const username = 'GENSYS';
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
function setConnectionStatus(online, label = null) {
    const badge = document.getElementById('connStatus');
    if (!badge) return;
    badge.className = 'conn-badge ' + (online ? 'conn-online' : 'conn-offline');
    badge.innerHTML = online
        ? `<i class="fas fa-circle"></i> ${label || 'Live'}`
        : `<i class="fas fa-circle"></i> ${label || 'Data terakhir'}`;
}

function setDataStatus({ live = false, timestamp = null } = {}) {
    setConnectionStatus(live, live ? 'Live' : 'Data terakhir');
    setLastUpdated(timestamp, !live);
}

function getDataAgeMs(timestamp) {
    const ts = timestamp ? new Date(timestamp).getTime() : NaN;
    return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}

function readLastPublicSensorSnapshot() {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_PUBLIC_SENSOR_STORAGE_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
}

function saveLastPublicSensorSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    try { localStorage.setItem(LAST_PUBLIC_SENSOR_STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* ignore quota */ }
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
    return rawSync || '--';
}

function getPowerSourceStatus(data = {}) {
    if (data.ecuConnected === false) return { label: 'OFF', detail: 'ECU disconnected', cls: 'st-err', ok: false };

    const rawSource = String(data.powerSource ?? data.power_source ?? data.supplySource ?? '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(rawSource)) return { label: 'GRID', detail: 'Grid/PLN tersambung', cls: 'st-ok', ok: true };
    if (['GENSET', 'GENERATOR', 'GEN'].includes(rawSource)) return { label: 'GENSET', detail: 'Genset tersambung', cls: 'st-warn', ok: true };
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(rawSource)) return { label: 'SYNC', detail: 'Grid dan genset tersinkron', cls: 'st-ok', ok: true };

    const syncStatus = normalizeSyncStatus(data);
    if (syncStatus === 'ON-GRID') return { label: 'SYNC', detail: 'Grid dan genset tersinkron', cls: 'st-ok', ok: true };
    if (syncStatus === 'OFF-GRID') return { label: 'GENSET', detail: 'Genset tersambung', cls: 'st-warn', ok: true };
    return { label: 'MENUNGGU', detail: 'Power source belum terdeteksi', cls: 'st-warn', ok: false };
}

function updatePowerSourceStatus(data = {}) {
    const supply = getPowerSourceStatus(data);
    const overviewEl = document.getElementById('val-supply');
    if (overviewEl) overviewEl.innerText = supply.label;
    const detailEl = document.getElementById('engSupply');
    if (detailEl) {
        detailEl.innerText = supply.detail;
        detailEl.className = supply.cls;
    }
}

// ── Last updated timestamp ───────────────────────────────────────────────────
function setLastUpdated(timestamp = null, visible = false) {
    const el = document.getElementById('lastUpdated');
    const dt = timestamp ? new Date(timestamp) : null;
    const safeDate = dt && Number.isFinite(dt.getTime()) ? dt : null;
    if (!el) return;
    el.style.display = visible ? '' : 'none';
    if (!visible) return;
    if (!safeDate) {
        el.innerText = 'Disconnected: --';
        return;
    }
    el.innerText = 'Disconnected: ' + safeDate.toLocaleString('id-ID', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }) + ' WIB';
}

function setDashboardLoading(isLoading) {
    document.body.classList.toggle('is-loading-data', Boolean(isLoading));
    const statusText = isLoading ? 'Memuat data...' : 'Data terakhir';
    if (isLoading) setConnectionStatus(false, statusText);
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN FETCH ORCHESTRATOR
// ════════════════════════════════════════════════════════════════════════════
async function fetchDashboardData() {
    if (isDashboardFetching) return;
    isDashboardFetching = true;
    setDashboardLoading(true);
    if (!activeChart) setCanvasLoading('chartActive', true);
    if (!fuelWeeklyChart) setCanvasLoading('chartFuelWeekly', true);
    if (!maintenanceCostChart) setCanvasLoading('chartMaintCostMonthly', true);
    try {
        const nowTs = Date.now();
        const allowHeavyFetch = (nowTs - lastHeavyFetchAt) >= HEAVY_ENDPOINT_REFRESH_MS;
        // Fetch semua data, limit history ditambah ke 100 agar cukup untuk kalkulasi 7 hari
        const [engineRes, alertsRes, specsRes, historyRes, engineHistoryRes, maintenanceRes, dashRes, cbmRes] = await Promise.allSettled([
            fetch(`/api/engine-data/latest?_=${Date.now()}`, { cache: 'no-store' }),
            fetch('/api/alerts?limit=100'),
            fetch('/api/generator-specs'),
            fetch('/api/generator-active-time/history?limit=100'),
            fetch('/api/generator-active-time/daily?days=7'),
            fetch('/api/maintenance'),
            allowHeavyFetch ? fetch('/api/public/dashboard') : Promise.resolve(new Response('{"success":false}', { status: 200 })),
            allowHeavyFetch ? fetch('/api/cbm/analysis?hours=720') : Promise.resolve(new Response('{"success":false}', { status: 200 })) // Fetch data CBM untuk indikator kesehatan
        ]);
        if (allowHeavyFetch) lastHeavyFetchAt = nowTs;

        const engineData = engineRes.status === 'fulfilled' ? await engineRes.value.json().catch(() => null) : null;
        const cbmData = cbmRes.status === 'fulfilled' ? await cbmRes.value.json().catch(() => null) : null;



        const alertsData = alertsRes.status === 'fulfilled' ? await alertsRes.value.json().catch(() => null) : null;
        const alertRows = alertsData?.success && Array.isArray(alertsData.data) ? alertsData.data : [];
        let activeAlerts = 0;
        if (alertsData?.success) {
            activeAlerts = alertRows.filter(isAlertActive).length;
            const badge  = document.getElementById('val-alerts');
            if (badge) badge.innerText = activeAlerts;
            renderAlertList(alertRows);
        }

        const specsData = specsRes.status === 'fulfilled' ? await specsRes.value.json().catch(() => null) : null;
        if (specsData?.success) updateSpecificationsSection(specsData.data);

        const historyData = historyRes.status === 'fulfilled' ? await historyRes.value.json().catch(() => null) : null;
        const activeDailyData = engineHistoryRes.status === 'fulfilled' ? await engineHistoryRes.value.json().catch(() => null) : null;
        const maintenanceData = maintenanceRes.status === 'fulfilled' ? await maintenanceRes.value.json().catch(() => null) : null;

        if (historyData?.success) {
            dashboardHistoryCache = historyData.data || [];
            dashboardTotalActiveHours = Number(historyData.totalHours) || sumRuntimeHoursFromHistory(dashboardHistoryCache);
            // Gabungkan riwayat sesi DB dengan maintenance yang Completed
            renderRecentActivity(historyData.data, maintenanceData?.success ? maintenanceData.data : []);
        }

        // Render Active Time History dari summary harian collection activetimehistories (sesi ECU connected).
        if (activeDailyData?.success && Array.isArray(activeDailyData.data)) {
            updateActiveTimeChartFromDaily(activeDailyData.data);
            updateAverageRuntimeFromDaily(activeDailyData.data);
        } else if (historyData?.success) {
            updateActiveTimeChart(historyData.data, { mode: 'session' });
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
            saveLastPublicSensorSnapshot(engineData.data);
            updateOverviewCards(engineData.data, historyRows);
            if (activeDailyData?.success) updateAverageRuntimeFromDaily(activeDailyData.data);
            updateOperationsSection(engineData.data, cbmData?.data, alertRows);
            updatePerformanceSection(engineData.data);
        } else {
            const cachedSensor = readLastPublicSensorSnapshot();
            if (cachedSensor) {
                updateOverviewCards(cachedSensor, historyRows);
                if (activeDailyData?.success) updateAverageRuntimeFromDaily(activeDailyData.data);
                updateOperationsSection(cachedSensor, cbmData?.data, alertRows);
                updatePerformanceSection(cachedSensor);
            }
        }

        const dashData = dashRes.status === 'fulfilled' ? await dashRes.value.json().catch(() => null) : null;
        if (!engineData?.data && dashData?.success && dashData.data) updatePerformanceSection(dashData.data);

        const cachedSnapshot = readLastPublicSensorSnapshot();
        const latestTs = engineData?.data?.lastUpdated || engineData?.data?.serverReceivedAt || cachedSnapshot?.lastUpdated || cachedSnapshot?.serverReceivedAt || null;
        const live = engineData?.data?.ecuConnected === true;
        setDataStatus({ live, timestamp: latestTs });

    } catch (err) {
        console.error('fetchDashboardData error:', err);
        setConnectionStatus(false);
    } finally {
        setDashboardLoading(false);
        isDashboardFetching = false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW CARDS
// ════════════════════════════════════════════════════════════════════════════

function updateAverageRuntimeFromDaily(dailyRows = []) {
    const avgEl = document.getElementById('val-avg-runtime');
    if (!avgEl || !Array.isArray(dailyRows) || !dailyRows.length) return;
    const total = dailyRows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
    avgEl.innerText = formatHourMinute(total / dailyRows.length);
}

function updateOverviewCards(data, historyRows = []) {
    const power = Number(data.power ?? data.kw ?? 0) || 0;
    const avg7h = calculateAverageRuntime7Days(historyRows);

    const avgEl = document.getElementById('val-avg-runtime');
    const powerEl  = document.getElementById('val-power');

    updatePowerSourceStatus(data);
    if (avgEl) avgEl.innerText = formatHourMinute(avg7h);
    if (powerEl) powerEl.innerText  = power.toFixed(1) + ' kW';
}


// ════════════════════════════════════════════════════════════════════════════
//  OPERATIONS SECTION (Engine Status + Health)
// ════════════════════════════════════════════════════════════════════════════
function updateOperationsSection(data, cbmData, alertRows = []) {
    updatePowerSourceStatus(data);

    // Power Source (GRID / GENSET / SYNC)
    const sourceEl = document.getElementById('engSync');
    if (sourceEl) {
        const supply = getPowerSourceStatus(data);
        sourceEl.innerText = supply.label;
        sourceEl.className = supply.cls;
    }

    // Engine State mengikuti status koneksi ECU dari server.
    const statEl = document.getElementById('engStat');
    if (statEl) {
        statEl.innerText = data.ecuConnected === true ? 'ECU Connected' : 'ECU Disconnected';
        statEl.className = data.ecuConnected === true ? 'st-ok' : 'st-err';
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

    renderHealthScore(data, cbmData, alertRows);
}

function healthStatus(value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v)) return { text: '--', cls: 'st-err' };
    if (v >= min && v <= max) return { text: 'Normal', cls: 'st-ok' };
    return { text: v < min ? 'Low' : 'High', cls: 'st-err' };
}

function formatDateKeyForDisplay(dateKey) {
    if (!dateKey) return '-';
    const safeDate = new Date(`${dateKey}T00:00:00+07:00`);
    if (!Number.isFinite(safeDate.getTime())) return dateKey;
    return safeDate.toLocaleDateString('id-ID');
}


function toWibDateKey(inputDate) {
    const dt = inputDate instanceof Date ? inputDate : new Date(inputDate);
    if (!Number.isFinite(dt.getTime())) return null;
    const wib = new Date(dt.getTime() + (7 * 60 * 60 * 1000));
    return wib.toISOString().slice(0, 10);
}

function splitSessionByDayWIB(start, end, wibOffset = 7 * 60 * 60 * 1000) {
    const result = [];
    let cursor = new Date(start);
    const endDate = new Date(end);
    if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= cursor) return result;

    while (cursor < endDate) {
        const cursorWib = new Date(cursor.getTime() + wibOffset);
        const nextMidnightWib = new Date(Date.UTC(
            cursorWib.getUTCFullYear(), cursorWib.getUTCMonth(), cursorWib.getUTCDate() + 1
        ));
        const nextMidnightUtc = new Date(nextMidnightWib.getTime() - wibOffset);
        const sliceEnd = nextMidnightUtc < endDate ? nextMidnightUtc : endDate;
        const hours = Math.max(0, sliceEnd - cursor) / 3600000;
        const dateKey = toWibDateKey(cursor);
        if (dateKey && hours > 0) result.push({ dateKey, hours });
        cursor = sliceEnd;
    }

    return result;
}

function sumRuntimeHoursFromHistory(historyRows = []) {
    const now = new Date();
    let totalHours = 0;
    (historyRows || []).forEach((r) => {
        const start = new Date(r.startedAt);
        const end = r.effectiveEndedAt ? new Date(r.effectiveEndedAt) : (r.endedAt ? new Date(r.endedAt) : now);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;
        totalHours += (end - start) / 3600000;
    });
    return Math.max(0, totalHours);
}

function getLatestCompletedMaintenance(rows = []) {
    return (rows || [])
        .filter((m) => String(m.status || '').toLowerCase() === 'completed')
        .sort((a, b) => new Date(b.completedAt || b.updatedAt || b.createdAt) - new Date(a.completedAt || a.updatedAt || a.createdAt))[0] || null;
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

function getParameterIndicator(label, value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return { label, text: 'Warning', cls: 'warn', icon: 'fa-triangle-exclamation' };
    if (numeric >= min && numeric <= max) return { label, text: 'Healthy', cls: 'ok', icon: 'fa-check-circle' };
    const criticalLow = min !== 0 && numeric < min * 0.85;
    const criticalHigh = numeric > max * 1.15;
    if (criticalLow || criticalHigh) return { label, text: 'Critical', cls: 'danger', icon: 'fa-circle-exclamation' };
    return { label, text: 'Warning', cls: 'warn', icon: 'fa-triangle-exclamation' };
}

function getCbmIndicators(cbmData = {}) {
    const components = cbmData.components || cbmData.componentHealth || {};
    return Object.values(components).map((comp) => {
        const status = String(comp.status || '').toLowerCase();
        const label = comp.name || comp.parameter || 'System';
        if (status === 'critical' || status === 'bad') return { label, text: 'Critical', cls: 'danger', icon: 'fa-circle-exclamation' };
        if (status === 'warning' || status === 'degraded') return { label, text: 'Warning', cls: 'warn', icon: 'fa-triangle-exclamation' };
        if (status === 'good' || status === 'normal') return { label, text: 'Healthy', cls: 'ok', icon: 'fa-check-circle' };
        return null;
    }).filter(Boolean);
}


function isAlertActive(alert = {}) {
    const status = String(alert.status || '').toLowerCase();
    if (alert.resolved === true || alert.isResolved === true || status === 'resolved' || status === 'closed') return false;
    return true;
}

function getAlertTimestamp(alert = {}) {
    const raw = alert.timestamp || alert.createdAt || alert.updatedAt || alert.time;
    const dt = raw ? new Date(raw) : null;
    return dt && Number.isFinite(dt.getTime()) ? dt : null;
}

function countRecentActiveAlerts(alertRows = [], hours = 24) {
    const sinceMs = Date.now() - hours * 3600000;
    return (alertRows || []).filter((alert) => {
        if (!isAlertActive(alert)) return false;
        const ts = getAlertTimestamp(alert);
        return ts && ts.getTime() >= sinceMs;
    }).length;
}

function normalizeHealthIndicatorByAlertPolicy(item, recentActiveAlertCount) {
    if (recentActiveAlertCount > 3) return item;
    if (item.cls === 'danger') {
        return { ...item, text: 'Warning', cls: 'warn', icon: 'fa-triangle-exclamation' };
    }
    return item;
}

function formatLastSyncStatus(data = {}) {
    const raw = String(data.sync ?? data.syncStatus ?? data.powerSource ?? data.power_source ?? '').trim();
    if (!raw) return '--';

    const normalized = raw.toUpperCase().replace(/[\s_-]+/g, '-');
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(normalized)) return 'SYNC';
    if (['GENSET', 'GENERATOR', 'GEN', 'OFF-GRID', 'OFFGRID'].includes(normalized)) return 'GENSET';
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(normalized)) return 'GRID';
    if (['OFF', 'STOPPED', 'DISCONNECTED'].includes(normalized)) return 'OFF';
    return normalized;
}

function renderHealthScore(engineData, cbmData, alertRows = []) {
    const container = document.getElementById('systemHealthContainer');
    if (!container) return;

    const runtimeHours = Number(engineData.engineHours) || dashboardTotalActiveHours || sumRuntimeHoursFromHistory(dashboardHistoryCache);
    const latestMaintenance = getLatestCompletedMaintenance(dashboardMaintenanceCache);
    const indicators = [
        getParameterIndicator('Generator Voltage', engineData.volt ?? engineData.voltage, 200, 240),
        getParameterIndicator('Generator Frequency', engineData.freq ?? engineData.frequency, 48, 52),
        getParameterIndicator('Fuel Level', engineData.fuel, 20, 100),
        getParameterIndicator('Engine Temperature', engineData.coolant ?? engineData.temp ?? engineData.temperature, 40, 90),
        getParameterIndicator('Battery Voltage', engineData.batt ?? engineData.battery ?? engineData.battVolt, 11.5, 14.8),
        ...getCbmIndicators(cbmData || {})
    ];

    const recentActiveAlertCount = countRecentActiveAlerts(alertRows, 24);
    const policyIndicators = indicators;

    const uniqueIndicators = [];
    const seen = new Set();
    policyIndicators.forEach((item) => {
        const key = `${item.label}:${item.cls}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueIndicators.push(item);
        }
    });

    const order = { danger: 0, warn: 1, ok: 2 };
    uniqueIndicators.sort((a, b) => (order[a.cls] ?? 9) - (order[b.cls] ?? 9));

    const counts = uniqueIndicators.reduce((acc, item) => {
        acc[item.cls] = (acc[item.cls] || 0) + 1;
        return acc;
    }, {});
    const overallCls = counts.danger ? 'danger' : counts.warn ? 'warn' : 'ok';
    const overallText = overallCls === 'danger' ? 'Critical' : overallCls === 'warn' ? 'Needs Attention' : 'Normal';
    const healthHtml = `
        <div class="health-panel ${overallCls}">
            <div class="health-summary">
                <div class="health-summary-icon"><i class="fas ${overallCls === 'ok' ? 'fa-shield-halved' : overallCls === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-exclamation'}"></i></div>
                <div>
                    <span>System Status</span>
                    <strong>${overallText}</strong>
                    <small>${uniqueIndicators.length} monitored parameters • ${recentActiveAlertCount} active alerts/24h</small>
                </div>
            </div>
            <div class="health-indicator-list">
                ${uniqueIndicators.map((item) => `
                    <div class="health-indicator-item ${item.cls}">
                        <i class="fas ${item.icon}"></i>
                        <span>${item.label}</span>
                        <strong>${item.text}</strong>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    container.innerHTML = healthHtml;
    lastHealthSnapshot = { html: healthHtml, updatedAt: Date.now() };

    const ageEl = document.getElementById('st-age');
    const runtimeEl = document.getElementById('st-runtime');
    const lastMaintEl = document.getElementById('st-last-maint');
    if (ageEl) ageEl.textContent = formatLastSyncStatus(engineData);
    if (runtimeEl) runtimeEl.textContent = `${runtimeHours.toFixed(2).replace('.', ',')} jam`;
    if (lastMaintEl) lastMaintEl.textContent = latestMaintenance
        ? new Date(latestMaintenance.completedAt || latestMaintenance.updatedAt || latestMaintenance.createdAt).toLocaleDateString('id-ID')
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

    container.innerHTML = combined.slice(0, 5).map(item => {
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
        const key = toWibDateKey(dt);
        if (!key) return;
        (byDate[key] ||= []).push(m);
    });

    const cells = [];
    for (let i=0;i<firstWeekday;i++) cells.push('<div class="calendar-day muted"></div>');
    for (let day=1;day<=totalDays;day++) {
        const d = new Date(calendarViewYear, calendarViewMonth, day);
        const key = toWibDateKey(d);
        const weekend = [0,6].includes(d.getDay());
        cells.push(`<button class="calendar-day ${weekend ? 'red-day' : ''} ${byDate[key] ? 'has-event' : ''}" data-date="${key}">${day}${byDate[key] ? '<span class="dot"></span>' : ''}</button>`);
    }

    container.innerHTML = `<div class="maintenance-calendar-wrap">
        <div class="calendar-header">
            <button class="cal-nav" data-nav="-1"><i class="fas fa-chevron-left"></i></button>
            <span>${monthStart.toLocaleDateString('id-ID', { month:'long', year:'numeric' })}</span>
            <button class="cal-nav" data-nav="1"><i class="fas fa-chevron-right"></i></button>
        </div>
        <div class="calendar-weekdays"><span>Sen</span><span>Sel</span><span>Rab</span><span>Kam</span><span>Jum</span><span>Sab</span><span>Min</span></div>
        <div class="calendar-grid">${cells.join('')}</div>
        <div id="maintenanceDetailPanel" class="maintenance-detail-panel">Click to view maintenance details.</div>
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
                return;
            }
            selectedMaintenanceDateKey = key;
            const list = byDate[key] || [];
            panel.innerHTML = `<div class="maint-detail-head"><h4>Detail ${formatDateKeyForDisplay(key)}</h4><button type="button" class="maint-hide-btn" id="maintHideBtn">Hide</button></div><div class="maint-detail-grid">${list.map(renderMaintenanceDetailCard).join('')}</div>`;
            const hideBtn = document.getElementById('maintHideBtn');
            if (hideBtn) {
                hideBtn.addEventListener('click', () => {
                    selectedMaintenanceDateKey = null;
                    panel.innerHTML = 'Detail disembunyikan. Klik tanggal untuk melihat lagi.';
                });
            }
        });
    });
}
function renderMaintenanceDetailCard(m) {
    return `<div class="maint-detail-item"><div class="maint-visual-top"><span class="status-pill ${(m.priority || '').toLowerCase() === 'high' ? 'danger' : 'ok'}">${m.priority || 'Normal'}</span><strong>${m.task || '-'}</strong></div><div><strong>Type:</strong> ${m.type || m.category || '-'}</div><div><strong>Status:</strong> ${(m.status || '-').toUpperCase()}</div><div><strong>PIC:</strong> ${m.assignedTo || '-'}</div><div><strong>Cost:</strong> Rp ${(Number(m.cost || m.estimatedCost || 0) || 0).toLocaleString('id-ID')}</div><div><strong>Catatan:</strong> ${m.notes || m.description || '-'}</div></div>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  ANALYTICS — Active Time Bar Chart (Real Data from History)
// ════════════════════════════════════════════════════════════════════════════
function calculateDailyEcuConnectedHours(engineRows = []) {
    const dayMap = {};
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    const now = new Date();
    const maxGapMs = 5 * 60 * 1000;

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = toWibDateKey(d);
        dayMap[key] = 0;
    }

    const stamps = (engineRows || [])
        .map((row) => new Date(row.timestamp || row.createdAt || row.date).getTime())
        .filter((ts) => Number.isFinite(ts))
        .sort((a, b) => a - b);

    for (let i = 1; i < stamps.length; i++) {
        const prev = stamps[i - 1];
        const curr = stamps[i];
        const gap = curr - prev;
        if (gap <= 0 || gap > maxGapMs) continue;

        splitSessionByDayWIB(new Date(prev), new Date(curr), WIB_OFFSET).forEach(({ dateKey, hours }) => {
            if (Object.prototype.hasOwnProperty.call(dayMap, dateKey)) {
                dayMap[dateKey] += hours;
            }
        });
    }

    return dayMap;
}

function calculateDailySessionHours(historyRows = []) {
    const dayMap = {};
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = toWibDateKey(d);
        dayMap[key] = 0;
    }

    (historyRows || []).forEach((r) => {
        const start = new Date(r.startedAt);
        const end = r.effectiveEndedAt ? new Date(r.effectiveEndedAt) : (r.endedAt ? new Date(r.endedAt) : now);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;

        splitSessionByDayWIB(start, end, WIB_OFFSET).forEach(({ dateKey, hours }) => {
            if (Object.prototype.hasOwnProperty.call(dayMap, dateKey)) {
                dayMap[dateKey] += hours;
            }
        });
    });

    return dayMap;
}


function updateActiveTimeChartFromDaily(dailyRows = []) {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const dayMap = {};
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
        const key = toWibDateKey(new Date(now.getTime() - i * 86400000));
        dayMap[key] = 0;
    }

    (dailyRows || []).forEach((row) => {
        const key = row.date || row.dateKey;
        if (Object.prototype.hasOwnProperty.call(dayMap, key)) {
            dayMap[key] = Number(row.hours) || 0;
        }
    });

    const labels = [];
    const dataPoints = [];
    const todayKey = toWibDateKey(now);
    let todayHours = 0;

    Object.keys(dayMap).sort().forEach((key) => {
        const d = new Date(`${key}T12:00:00+07:00`);
        labels.push(days[d.getDay()] || key);
        const val = parseFloat(Math.min(24, dayMap[key]).toFixed(2));
        dataPoints.push(val);
        if (key === todayKey) todayHours = val;
    });

    if (activeChart) activeChart.destroy();
    setCanvasLoading('chartActive', false);
    activeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'ECU Connected',
                data: dataPoints,
                backgroundColor: dataPoints.map((_, i) => i === dataPoints.length - 1 ? '#f97316' : 'rgba(23,69,165,0.8)'),
                borderRadius: 8,
                barPercentage: 0.55
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ECU connected ${ctx.parsed.y} jam` } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: 8,
                    title: { display: true, text: 'Hours' },
                    ticks: { callback: v => `${v}h` },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    const todayEl = document.getElementById('engToday');
    if (todayEl) todayEl.innerText = formatHourMinute(todayHours);
}

function updateActiveTimeChart(historyRows, options = {}) {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const now = new Date();
    const dayMap = options.mode === 'session'
        ? calculateDailySessionHours(historyRows)
        : calculateDailyEcuConnectedHours(historyRows);

    const labels = [];
    const dataPoints = [];
    const todayKey = toWibDateKey(now);
    let todayHours = 0;

    Object.keys(dayMap).sort().forEach(key => {
        const d = new Date(`${key}T12:00:00+07:00`);
        labels.push(days[d.getDay()]);

        const val = parseFloat(Math.min(24, dayMap[key]).toFixed(2));
        dataPoints.push(val);

        if (key === todayKey) todayHours = val;
    });

    if (activeChart) activeChart.destroy();
    setCanvasLoading('chartActive', false);

    activeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'ECU Connected',
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
                tooltip: { callbacks: { label: ctx => ` ECU connected ${ctx.parsed.y} jam` } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: 8,
                    title: { display: true, text: 'Hours' },
                    ticks: { callback: v => `${v}h` },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    const todayEl = document.getElementById('engToday');
    if (todayEl) todayEl.innerText = formatHourMinute(todayHours);
}


function calculateDailyRuntimeFromHistory(historyRows = []) {
    const dayMap = calculateDailySessionHours(historyRows);
    return Object.keys(dayMap).sort().map((dateKey) => {
        const d = new Date(`${dateKey}T12:00:00+07:00`);
        return {
            dateKey,
            dayIndex: d.getDay(),
            hours: Math.min(24, Number(dayMap[dateKey]) || 0)
        };
    });
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
    const runtimeByDay = calculateDailyRuntimeFromHistory(historyRows);

    runtimeByDay.forEach(({ dayIndex, hours }) => {
        const used = hours * 1.25;
        weeklyFuel[dayIndex] += used;
    });
    for (let i = 0; i < weeklyFuel.length; i++) weeklyFuel[i] = Number(weeklyFuel[i].toFixed(2));

    if (fuelWeeklyChart) fuelWeeklyChart.destroy();
    setCanvasLoading('chartFuelWeekly', false);
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

    const detailBox = document.getElementById('maintenanceCostDetail');
    if (detailBox) detailBox.classList.remove('expanded');
    setCanvasLoading('chartMaintCostMonthly', false);
    maintenanceCostChart = new Chart(costCtx, {
        type: 'bar',
        data: { labels: monthNames, datasets: [{ label: 'Biaya (Rp)', data: monthlyCost, backgroundColor: 'rgba(23,69,165,0.82)', borderRadius: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, onClick: (_, elements) => {
            const target = document.getElementById('maintenanceCostDetail');
            if (!target || !elements.length) return;
            const idx = elements[0].index;
            if (selectedCostMonthIndex === idx) {
                selectedCostMonthIndex = null;
                target.classList.remove('expanded');
                target.innerHTML = 'Klik batang bulan untuk lihat detail biaya.';
                return;
            }
            selectedCostMonthIndex = idx;
            target.classList.add('expanded');
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


function getPerformanceClass(value, min, max, warnMin = min, warnMax = max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'muted';
    if (numeric < min || numeric > max) return 'danger';
    if (numeric < warnMin || numeric > warnMax) return 'warn';
    return 'ok';
}

function updatePerformanceSection(dashboardData = {}) {
    const container = document.getElementById('perfSimpleCards');
    if (!container) return;

    const params = dashboardData.parameters || null;
    const rpm = Number(dashboardData.rpm ?? 0);
    const volt = Number(dashboardData.volt ?? dashboardData.voltage ?? params?.voltage?.value ?? 0);
    const freq = Number(dashboardData.freq ?? dashboardData.frequency ?? 0);
    const amp = Number(dashboardData.amp ?? dashboardData.current ?? 0);
    const power = Number(dashboardData.power ?? dashboardData.kw ?? params?.power?.kw ?? ((volt * amp) / 1000));
    const coolant = Number(dashboardData.coolant ?? dashboardData.temp ?? dashboardData.temperature ?? params?.temperature?.value ?? 0);
    const fuel = Number(dashboardData.fuel ?? params?.fuel?.percent ?? 0);

    const rows = [
        { label: 'RPM Mesin', value: `${Math.round(rpm).toLocaleString('id-ID')} RPM`, desc: rpm > 0 ? 'ECU mengirim data putaran' : 'Belum ada putaran terdeteksi', cls: getPerformanceClass(rpm, 0, 3800, 600, 3200), icon: 'fa-gauge-high' },
        { label: 'Daya Output', value: `${power.toFixed(1)} kW`, desc: amp > 0 ? `${amp.toFixed(1)} A beban terukur` : 'Berdasarkan tegangan/arus realtime', cls: getPerformanceClass(power, 0, 100, 0, 80), icon: 'fa-bolt' },
        { label: 'Tegangan', value: `${volt.toFixed(1)} V`, desc: 'Rentang normal 200–240 V', cls: getPerformanceClass(volt, 180, 250, 200, 240), icon: 'fa-plug-circle-bolt' },
        { label: 'Frekuensi', value: `${freq.toFixed(1)} Hz`, desc: 'Rentang normal 48–52 Hz', cls: getPerformanceClass(freq, 45, 55, 48, 52), icon: 'fa-wave-square' },
        { label: 'Suhu Coolant', value: `${coolant.toFixed(1)} °C`, desc: 'Normal di bawah 90 °C', cls: getPerformanceClass(coolant, 0, 98, 40, 90), icon: 'fa-temperature-half' },
        { label: 'Bahan Bakar', value: `${fuel.toFixed(0)}%`, desc: fuel > 30 ? 'Cadangan aman' : fuel > 15 ? 'Mulai menipis' : 'Segera isi ulang', cls: getPerformanceClass(fuel, 10, 100, 30, 100), icon: 'fa-gas-pump' }
    ];

    container.innerHTML = rows.map((row) => `
        <div class="perf-card ${row.cls}">
            <div class="perf-card-icon"><i class="fas ${row.icon}"></i></div>
            <div class="perf-card-body">
                <span>${row.label}</span>
                <strong>${row.value}</strong>
                <small>${row.desc}</small>
            </div>
        </div>
    `).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  SPECIFICATIONS
// ════════════════════════════════════════════════════════════════════════════
function updateSpecificationsSection(specs) {
    const genEl = document.getElementById('generatorSpecContainer');
    if (genEl && specs) {
        genEl.innerHTML = buildSpecList([
            ['Tipe Generator', specs.generatorType || 'Silent Diesel Genset'],
            ['Kapasitas Daya', specs.powerCapacity || specs.ratedPower || '100 kVA / 80 kW'],
            ['Frekuensi & Tegangan', specs.frequencyVoltage || '50 Hz • 400/230V'],
            ['Pengatur Tegangan (AVR)', specs.avrType || 'AVR digital'],
            ['Pelindung Arus (MCB)', specs.mcbType || 'MCB 3P 63A'],
            ['Sistem Starter', specs.sistemStart || 'Starter elektrik']
        ]);
    }

    const engEl = document.getElementById('engineSpecContainer');
    if (engEl && specs) {
        engEl.innerHTML = buildSpecList([
            ['Tipe Mesin', specs.engineType || 'Diesel 4-stroke, turbocharged'],
            ['Jumlah Silinder', specs.cylinderCount || '4 Silinder'],
            ['Sistem Injeksi Bahan Bakar', specs.injectorType || 'Common rail'],
            ['Sistem Pendingin', specs.coolantType || 'Coolant long life'],
            ['Saringan Oli Mesin', specs.oilFilterType || 'Filter tipe spin-on'],
            ['Saringan Udara', specs.airFilterType || 'Filter kering']
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
        const e = new Date(r.effectiveEndedAt || r.endedAt || now);
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

    const userBtn = document.getElementById('user-btn');
    if (userBtn) {
        userBtn.addEventListener('click', () => {
            window.location.href = 'public-user.html';
        });
    }

    await fetchDashboardData();
    setInterval(fetchDashboardData, DASHBOARD_REFRESH_MS);  // refresh periodik agar tidak membebani resource browser/server
});