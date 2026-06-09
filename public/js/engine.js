// === CONFIGURATION ===
const API_URL = '/api';
const PARAMS = ['volt','amp','power','freq','rpm','batt','coolant','iat','map','fuel','afr','tps','phase'];
const ESP_FRESHNESS_MS = 3000;
const SYNC_THRESHOLDS = {
    voltDeltaMax: 10,
    freqDeltaMax: 0.5,
    phaseDeltaMax: 15
};


let serverThresholds = {}; 
let activeModalParam = null;

function setEspConnectionStatus(isConnected) {
    const el = document.getElementById('espConnection');
    if (!el) return;

    if (isConnected) {
        el.className = 'indicator ind-on';
        el.innerHTML = 'Connected';
    } else {
        el.className = 'indicator ind-off';
        el.innerHTML = 'Disconnected';
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

function getPhaseDifference(data = {}) {
    const rawPhase = data?.phaseAngle ?? data?.phase_angle ?? data?.phaseDiff ?? data?.phase_diff;
    const phaseAngle = Number(rawPhase);

    if (!Number.isFinite(phaseAngle)) return undefined;

    // Phase Difference di UI adalah beda fasa terkecil dari phaseAngle.
    // Contoh: 350° berarti -10°, bukan 350°, karena melewati titik 0°.
    return ((phaseAngle + 180) % 360 + 360) % 360 - 180;
}

function getSyncByThreshold(data) {
    const espSyncStatus = normalizeSyncStatus(data);
    if (espSyncStatus !== 'UNKNOWN') return espSyncStatus;

    const vGen = Number(data?.volt);
    const vGrid = Number(data?.volt_grid ?? data?.voltGrid);
    const fGen = Number(data?.freq);
    const fGrid = Number(data?.freq_grid ?? data?.freqGrid);
    const phaseDiff = getPhaseDifference(data);

    const hasVolt = Number.isFinite(vGen) && Number.isFinite(vGrid);
    const hasFreq = Number.isFinite(fGen) && Number.isFinite(fGrid);
    const hasPhase = Number.isFinite(phaseDiff);

    if (!hasVolt || !hasFreq || !hasPhase) return 'UNKNOWN';

    const voltOk = Math.abs(vGen - vGrid) <= SYNC_THRESHOLDS.voltDeltaMax;
    const freqOk = Math.abs(fGen - fGrid) <= SYNC_THRESHOLDS.freqDeltaMax;
    const phaseOk = Math.abs(phaseDiff) <= SYNC_THRESHOLDS.phaseDeltaMax;

    return (voltOk && freqOk && phaseOk) ? 'ON-GRID' : 'OFF-GRID';
}



function getPowerSourceStatus(data = {}) {
    const rawSource = String(data.powerSource ?? data.power_source ?? data.supplySource ?? '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
    if (['OFF', 'DISCONNECTED', 'OFFLINE', 'NO-MQTT', 'NO-MQTT-CONNECTION'].includes(rawSource) || data.ecuConnected === false) return { label: 'OFF', cls: 'indicator ind-off' };
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(rawSource)) return { label: 'GRID', cls: 'indicator ind-on' };
    if (['GENSET', 'GENERATOR', 'GEN'].includes(rawSource)) return { label: 'GENSET', cls: 'indicator ind-warn' };
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(rawSource)) return { label: 'SYNC', cls: 'indicator ind-on' };

    const syncStatus = getSyncByThreshold(data);
    if (syncStatus === 'ON-GRID') return { label: 'SYNC', cls: 'indicator ind-on' };
    if (syncStatus === 'OFF-GRID') return { label: 'GENSET', cls: 'indicator ind-warn' };
    return { label: 'UNKNOWN', cls: 'indicator ind-neutral' };
}

function formatLastUpdatedTimestamp(input) {
    const dateObj = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(dateObj.getTime())) return '--';
    return dateObj.toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function updateLastUpdatedInfo(data = {}, isFresh = false) {
    const el = document.getElementById('lastUpdatedInfo');
    if (!el) return;
    const ts = data.lastUpdated || data.lastMqttUpdate || data.realtimeReceivedAt || data.serverReceivedAt || data.timestamp;
    const formatted = formatLastUpdatedTimestamp(ts);
    el.innerText = isFresh ? `Realtime • ${formatted}` : `Disconnected • ${formatted}`;
}

function handleEngineData(data = {}, explicitFresh = null) {
    const lastTs = data?.lastUpdated || data?.lastMqttUpdate || data?.realtimeReceivedAt || data?.timestamp;
    const ts = Date.parse(lastTs || '');
    const isFresh = explicitFresh !== null
        ? explicitFresh
        : data?.ecuConnected !== false && Number.isFinite(ts) && (Date.now() - ts <= ESP_FRESHNESS_MS);

    updateDashboard(data, isFresh);
    setEspConnectionStatus(isFresh);
    updateLastUpdatedInfo(data, isFresh);
}

// === DATA FETCHING ===
async function loadThresholds() {
    try {
        const res = await fetch(`${API_URL}/thresholds`);
        const json = await res.json();
        if (json.success) {
            serverThresholds = json.data;
            updateThresholdBadges();
        }
    } catch (e) { console.error("Load config error:", e); }
}

async function fetchData() {
    try {
        const res = await fetch(`${API_URL}/engine-data/latest`);
        const json = await res.json();
        
        if (json.success) {
            handleEngineData(json.data);
        } else {
            setEspConnectionStatus(false);
            updateLastUpdatedInfo({}, false);
        }
    } catch (err) {
        setEspConnectionStatus(false);
        updateLastUpdatedInfo({}, false);
    }
}

function setEngineAlertsLoading(isLoading) {
    const body = document.getElementById('alertTable');
    if (isLoading && body && !body.dataset.loaded) {
        body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999; padding:20px;"><i class="fas fa-circle-notch fa-spin"></i> Loading alerts...</td></tr>';
    }
}

async function fetchAlerts() {
    setEngineAlertsLoading(true);
    try {
        const res = await fetch(`${API_URL}/alerts?limit=5`);
        const json = await res.json();
        if (json.success) { renderAlerts(json.data); const body = document.getElementById('alertTable'); if (body) body.dataset.loaded = 'true'; }
    } catch (e) { console.error(e); }
}

// === UI UPDATE LOGIC ===
function updateDashboard(data, isEspConnected = true) {
    const sourceEl = document.getElementById('powerSourceIndicator');
    const sourceStatus = getPowerSourceStatus(data);
    if (sourceEl) {
        sourceEl.innerText = sourceStatus.label;
        sourceEl.className = sourceStatus.cls;
    }

    const setVal = (id, val, fixed=0, fallback='--') => {
        const el = document.getElementById(id + 'Val');
        if (!el) return;
        const num = Number(val);
        el.innerText = Number.isFinite(num) ? num.toFixed(fixed) : fallback;
    };

    setVal('volt', data.volt, 1);
    setVal('amp', data.amp, 1);
    setVal('freq', data.freq, 2);
    setVal('power', data.power, 2);
    const phaseDiff = getPhaseDifference(data);
    setVal('phase', phaseDiff, 1, '0.0');
    setVal('coolant', data.coolant || data.temp, 0);
    setVal('iat', data.iat, 0);
    setVal('map', data.map, 0);
    setVal('fuel', data.fuel, 0);
    setVal('rpm', data.rpm, 0);
    setVal('batt', data.batt ?? data.battery ?? data.battVolt, 1);
    setVal('afr', data.afr, 1);
    setVal('tps', data.tps, 0);

    applyVisual('rpm', data.rpm, { type: 'gauge', max: 6000 });
    applyVisual('afr', data.afr, { type: 'gauge', max: 20 });
    applyVisual('tps', data.tps, { type: 'gauge', max: 100 });
    applyVisual('coolant', data.coolant || data.temp, { type: 'bar', max: 120 });
    applyVisual('iat', data.iat, { type: 'bar', max: 100 });
    applyVisual('map', data.map, { type: 'bar', max: 250 });
    applyVisual('fuel', data.fuel, { type: 'bar', max: 100 });
    applyVisual('volt', data.volt, { type: 'text' });
    applyVisual('amp', data.amp, { type: 'text' });
    applyVisual('freq', data.freq, { type: 'text' });
    applyVisual('batt', data.batt ?? data.battery ?? data.battVolt, { type: 'text' });
    applyVisual('phase', phaseDiff, { type: 'text' });

    if (data._realtime) {
        const realtimeBadge = document.getElementById('realtimeBadge');
        if (realtimeBadge) {
            realtimeBadge.style.display = 'inline-block';
            realtimeBadge.title = `Last MQTT update: ${data.lastMqttUpdate}`;
        }
    }
}

function applyVisual(param, value, opts) {
    const val = Number(value);
    const th = serverThresholds[param] || {};
    let status = 'normal';

    // Cek Threshold (Warna Box & Text)
    if (th.max && val > th.max) status = 'alert';
    else if (th.min && val < th.min) status = 'alert';
    
    const box = document.getElementById('box_' + param);
    if (box) box.className = `param-box ${status === 'alert' ? 'box-alert' : 'box-ok'}`;
    
    const text = document.getElementById(param + 'Val');
    if(text) text.className = `param-val ${opts.type==='text'?'numeric':''} ${status}`;

    // Tentukan Warna Fill (Merah jika alert, Hijau jika normal)
    const color = status === 'alert' ? '#ef4444' : '#10b981'; 
    const gradient = status === 'alert' 
        ? 'linear-gradient(180deg, #ef4444, #b91c1c)' 
        : 'linear-gradient(180deg, #34d399, #10b981)';

    if (opts.type === 'gauge') {
        const el = document.getElementById('gauge-' + param);
        if(el) {
            // Rumus Rotasi: -180 (kosong) s/d 0 (penuh)
            let ratio = Math.min(Math.max(val / opts.max, 0), 1);
            let deg = -180 + (ratio * 180);
            
            el.style.transform = `rotate(${deg}deg)`;
            el.style.background = gradient;
        }
    } else if (opts.type === 'bar') {
        const el = document.getElementById(param + 'Bar');
        if(el) {
            let pct = Math.min(Math.max(val / opts.max * 100, 0), 100);
            el.style.width = `${pct}%`;
            el.style.background = color;
        }
    }
}

function renderAlerts(alerts) {
    const tbody = document.getElementById('alertTable');
    if (alerts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:10px;">No recent alerts</td></tr>';
        return;
    }
    tbody.innerHTML = alerts.map(a => `
        <tr>
            <td>${new Date(a.timestamp).toLocaleTimeString()}</td>
            <td><b>${a.parameter ? a.parameter.toUpperCase() : 'SYS'}</b></td>
            <td>${a.value}</td>
            <td style="color:${a.severity==='critical'?'red':'orange'}; font-weight:bold">${a.message}</td>
        </tr>
    `).join('');
}

// === THRESHOLD LOGIC ===
function updateThresholdBadges() {
    PARAMS.forEach(p => {
        const el = document.getElementById('thr_' + p);
        if(!el) return;
        const t = serverThresholds[p];
        if(t && (t.min || t.max)) {
            let txt = [];
            if(t.min) txt.push(`Min: ${t.min}`);
            if(t.max) txt.push(`Max: ${t.max}`);
            el.innerText = txt.join(' | ');
        } else {
            el.innerText = 'No Limit';
        }
    });
}

window.openThresholdModal = (param) => {
    activeModalParam = param;
    document.getElementById('modalParamName').innerText = param.toUpperCase();
    const t = serverThresholds[param] || {};
    document.getElementById('thrMin').value = t.min || '';
    document.getElementById('thrMax').value = t.max || '';
    document.getElementById('thresholdModal').style.display = 'flex';
};

window.closeModal = () => document.getElementById('thresholdModal').style.display = 'none';

window.saveThreshold = async () => {
    const minVal = document.getElementById('thrMin').value;
    const maxVal = document.getElementById('thrMax').value;
    const payload = {};
    payload[activeModalParam] = {};
    if(minVal) payload[activeModalParam].min = Number(minVal);
    if(maxVal) payload[activeModalParam].max = Number(maxVal);

    try {
        await fetch(`${API_URL}/thresholds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        await loadThresholds();
        closeModal();
    } catch (e) { console.error(e); }
};

window.removeThreshold = async () => {
    const payload = {};
    payload[activeModalParam] = {};
    await fetch(`${API_URL}/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    await loadThresholds();
    closeModal();
};


function startRealtimeEngineStream() {
    if (!('EventSource' in window)) return false;

    try {
        const source = new EventSource(`${API_URL}/engine-data/stream`);
        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.success && payload.data) handleEngineData(payload.data);
            } catch (error) {
                console.error('Engine stream parse error:', error);
            }
        };
        source.onerror = () => {
            // Keep EventSource auto-reconnect enabled, and let polling remain as fallback.
            setEspConnectionStatus(false);
        };
        window.addEventListener('beforeunload', () => source.close());
        return true;
    } catch (error) {
        console.error('Engine stream error:', error);
        return false;
    }
}

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
    // Sidebar dimuat dan dikontrol oleh public/js/sidebar.js agar konsisten
    // dengan halaman lain. Jangan memuat ulang sidebar di sini karena bisa
    // menimpa tombol mobile, overlay, active state, dan event logout.
    const userLabel = document.querySelector('#userarea span');
    if (userLabel) userLabel.innerText = localStorage.getItem('username') || 'Pengguna';

    setEspConnectionStatus(false);
    loadThresholds();
    const streamStarted = startRealtimeEngineStream();
    fetchData();
    fetchAlerts();
    setInterval(fetchData, 1000);
    setInterval(fetchAlerts, 1000); 
});
