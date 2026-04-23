// === CONFIGURATION ===
const API_URL = '/api';
const PARAMS = ['volt','amp','power','freq','rpm','batt','coolant','iat','fuel','afr','tps'];
const ESP_FRESHNESS_MS = 15000;



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
            updateDashboard(json.data);
            const ts = Date.parse(json.data?.timestamp || '');
            const isFresh = Number.isFinite(ts) && (Date.now() - ts <= ESP_FRESHNESS_MS);
            setEspConnectionStatus(isFresh);
        } else {
            setEspConnectionStatus(false);
        }
    } catch (err) {
        setEspConnectionStatus(false);
    }
}

async function fetchAlerts() {
    try {
        const res = await fetch(`${API_URL}/alerts?limit=5`);
        const json = await res.json();
        if (json.success) renderAlerts(json.data);
    } catch (e) { console.error(e); }
}

// === UI UPDATE LOGIC ===
function updateDashboard(data) {
    const syncEl = document.getElementById('syncIndicator');
    syncEl.innerText = data.sync || 'UNKNOWN';
    syncEl.className = data.sync === 'ON-GRID' ? 'indicator ind-on' : 'indicator ind-off';

    const setVal = (id, val, fixed=0) => {
        const el = document.getElementById(id + 'Val');
        if(el) el.innerText = Number(val).toFixed(fixed);
    };

    setVal('volt', data.volt, 1);
    setVal('amp', data.amp, 1);
    setVal('freq', data.freq, 2);
    setVal('power', data.power, 0);
    setVal('coolant', data.coolant || data.temp, 0);
    setVal('iat', data.iat, 0);
    setVal('fuel', data.fuel, 0);
    setVal('rpm', data.rpm, 0);
    setVal('batt', data.batt ?? data.battery ?? data.battVolt, 1);
    setVal('afr', data.afr, 1);
    setVal('tps', data.tps, 0);

    applyVisual('rpm', data.rpm, { type: 'gauge', max: 4500 });
    applyVisual('afr', data.afr, { type: 'gauge', max: 20 });
    applyVisual('tps', data.tps, { type: 'gauge', max: 100 });
    applyVisual('coolant', data.coolant || data.temp, { type: 'bar', max: 120 });
    applyVisual('iat', data.iat, { type: 'bar', max: 100 });
    applyVisual('fuel', data.fuel, { type: 'bar', max: 100 });
    applyVisual('volt', data.volt, { type: 'text' });
    applyVisual('amp', data.amp, { type: 'text' });
    applyVisual('freq', data.freq, { type: 'text' });
    applyVisual('batt', data.batt ?? data.battery ?? data.battVolt, { type: 'text' });

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

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
    fetch('sidebar.html').then(r=>r.text()).then(h=>document.getElementById('sidebar-container').innerHTML=h);
    document.getElementById('userarea').querySelector('span').innerText = localStorage.getItem('username') || 'Pengguna';
    setEspConnectionStatus(false);
    loadThresholds();
    fetchData();
    fetchAlerts();
    setInterval(fetchData, 800); 
    setInterval(fetchAlerts, 1000); 
});