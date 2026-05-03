'use strict';

const AVG_CONSUMPTION_LPH = 2.5; 
const TANK_CAPACITY_L = 50;      
const FUEL_PRICE_PER_LITER = 12000;

let uptimeChart = null;
const $ = id => document.getElementById(id);

// Format Rupiah
const formatRupiah = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

function initUptimeChart() {
    const ctx = $('uptimeChart');
    if (ctx && !uptimeChart) {
        // Efek gradient untuk chart
        let gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.5)'); // Blue
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

        uptimeChart = new Chart(ctx, {
            type: 'bar',
            data: { 
                labels: ['H-6', 'H-5', 'H-4', 'H-3', 'H-2', 'Kemarin', 'Hari Ini'], 
                datasets: [{ 
                    label: 'Jam Aktif', 
                    data: [0, 0, 0, 0, 0, 0, 0], 
                    backgroundColor: gradient,
                    borderColor: '#3b82f6',
                    borderWidth: 2,
                    borderRadius: {topLeft: 8, topRight: 8},
                    barPercentage: 0.6
                }] 
            },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: { 
                    y: { beginAtZero: true, suggestedMax: 10, grid: { borderDash: [5, 5] } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// Menghitung Kesehatan Sistem (Skala 0 - 100%)
function calculateHealthScore(temp, fuel, isRunning, volt) {
    let score = 100;
    
    // Penalti Suhu
    if (temp > 95) score -= 40;
    else if (temp > 85) score -= 15;
    
    // Penalti Bahan Bakar
    if (fuel < 10) score -= 30;
    else if (fuel < 25) score -= 15;
    
    // Penalti Listrik (Jika PLN tapi voltase ngedrop ekstrim)
    if (!isRunning && volt > 0 && volt < 180) score -= 20;

    return Math.max(0, score);
}

function updatePublicDashboard(data) {
    const rpm = Number(data.rpm) || 0;
    const volt = Number(data.volt) || 0;
    const freq = Number(data.freq) || 0;
    const current = Number(data.current || data.amp) || 0;
    const fuel = Number(data.fuel) || 0;
    const temp = Number(data.coolant_temp || data.temp || data.coolant) || 0;
    
    const powerKw = (volt * current) / 1000;
    
    const isRunning = String(data.status || '').toLowerCase() === 'on' || rpm > 50;
    const syncText = String(data.sync || '').toUpperCase();
    const isPLN = syncText.includes('ON-GRID') || syncText.includes('PLN') || (volt > 200 && !isRunning);

    // 1. HERO CARD
    const heroCard = $('heroCard');
    const heroIcon = $('heroIcon');
    const powerSourceText = $('powerSourceText');
    const powerDescText = $('powerDescText');

    heroCard.classList.remove('pln', 'genset', 'off', 'loading');
    if (isRunning) {
        heroCard.classList.add('genset');
        heroIcon.className = 'fas fa-industry';
        powerSourceText.innerText = 'Pasokan GENSET';
        powerDescText.innerText = 'Genset beroperasi menyuplai daya area.';
    } else if (isPLN) {
        heroCard.classList.add('pln');
        heroIcon.className = 'fas fa-plug-circle-check';
        powerSourceText.innerText = 'Pasokan PLN';
        powerDescText.innerText = 'Jaringan utama beroperasi normal.';
    } else {
        heroCard.classList.add('off');
        heroIcon.className = 'fas fa-power-off';
        powerSourceText.innerText = 'PEMADAMAN';
        powerDescText.innerText = 'Aliran listrik terputus total.';
    }
    lastRuntimeUpdate = now;
    $('#costDaily').innerText = formatRupiah(dailyTotalCost);
    
    if (fuelPct > 0 && isRunning) {
        const liters = (fuelPct / 100) * TANK_CAPACITY_L;
        const hoursLeft = liters / consumption;
        $('#nextServiceText').innerHTML = `${hoursLeft.toFixed(1)} jam (BBM)`;
    } else if (!isRunning) {
        $('#nextServiceText').innerHTML = '--';
    }
}

// ---------- Maintenance ----------
function renderMaintenance(engineHours) {
    let nextServiceHour = Infinity;
    const rows = MAINT_ITEMS.map(item => {
        const last = Math.floor(engineHours / item.interval) * item.interval;
        const dueAt = last + item.interval;
        const hoursLeft = dueAt - engineHours;
        let status = 'ok', badge = 'OK';
        if (hoursLeft <= 0) { status = 'err'; badge = 'Terlambat'; }
        else if (hoursLeft <= 50) { status = 'warn'; badge = 'Segera'; }
        if (hoursLeft > 0 && hoursLeft < nextServiceHour) nextServiceHour = hoursLeft;
        return `<div class="mi-compact">
                    <span class="mi-name">${item.name}</span>
                    <span class="mi-status ${status}">${badge}</span>
                    <span style="font-size:0.7rem;">${hoursLeft > 0 ? hoursLeft.toFixed(0)+' jam' : 'segera'}</span>
                </div>`;
    }).join('');
    $('#maintList').innerHTML = rows;
    if (nextServiceHour !== Infinity) {
        $('#nextServiceText').innerHTML = nextServiceHour <= 0 ? 'Segera servis!' : `${Math.round(nextServiceHour)} jam lagi`;
    }
    return nextServiceHour;
}

// ---------- System Health (Voltage, Current, Freq, Fuel, AFR) ----------
function updateSystemHealth(volt, freq, current, fuel, afr) {
    const container = $('#sysHealthList');
    if (!container) return;
    const voltStatus = (volt >= VOLT_LO && volt <= VOLT_HI) ? 'ok' : (volt > 0 ? 'warn' : 'err');
    const freqStatus = (freq >= FREQ_LO && freq <= FREQ_HI) ? 'ok' : (freq > 0 ? 'warn' : 'err');
    const fuelStatus = fuel >= 25 ? 'ok' : (fuel > 0 ? 'warn' : 'err');
    const afrStatus = (afr > 13 && afr < 16) ? 'ok' : 'warn';
    container.innerHTML = `
        <div class="health-row"><span class="health-label">Voltage</span><span class="health-badge ${voltStatus}">${volt > 0 ? volt.toFixed(0)+'V' : 'N/A'}</span></div>
        <div class="health-row"><span class="health-label">Current</span><span class="health-badge ${current>0?'ok':''}">${current>0 ? current.toFixed(1)+'A' : '0A'}</span></div>
        <div class="health-row"><span class="health-label">Frequency</span><span class="health-badge ${freqStatus}">${freq>0 ? freq.toFixed(1)+'Hz' : '--'}</span></div>
        <div class="health-row"><span class="health-label">Fuel Level</span><span class="health-badge ${fuelStatus}">${fuel.toFixed(0)}%</span></div>
        <div class="health-row"><span class="health-label">AFR</span><span class="health-badge ${afrStatus}">${afr.toFixed(1)}</span></div>
    `;
}

// ---------- Diagnostik ----------
function renderDiagnostik(elecOk, engineOk, fuelOk, maintOk, syncOk, source) {
    const container = $('#healthCheckContainer');
    if (!container) return;
    const items = [
        { label: 'Jaringan PLN', status: elecOk ? 'ok' : (currentData.volt>0 ? 'warn' : 'err'), desc: elecOk ? 'Stabil' : (currentData.volt>0 ? 'Fluktuasi' : 'Padam') },
        { label: 'Generator', status: (engineOk && source !== 'OFF') ? 'ok' : (source==='GEN' ? 'warn' : 'ok'), desc: source==='GEN' ? 'Menyuplai' : (source==='OFF' ? 'Tidak aktif' : 'Siaga') },
        { label: 'Sinkronisasi', status: syncOk ? 'ok' : (source==='HYBRID' ? 'warn' : 'ok'), desc: syncOk ? 'Tersinkron' : 'Tidak sync' },
        { label: 'Bahan Bakar', status: fuelOk ? 'ok' : (currentData.fuel<25 ? 'warn' : 'err'), desc: currentData.fuel>0 ? `${currentData.fuel}%` : 'Kosong' },
        { label: 'Perawatan', status: maintOk ? 'ok' : 'warn', desc: maintOk ? 'Terjadwal' : 'Perlu perhatian' }
    ];
    container.innerHTML = items.map(i => `<div class="health-check-item"><span>${i.label}</span><span class="health-badge ${i.status}">${i.desc}</span></div>`).join('');
}

// ---------- Info & Tips dinamis ----------
function updateInfoTips(elecOk, fuelOk, source, maintNear) {
    let msg = 'Semua sistem normal.';
    const tips = [];
    if (source === 'GEN') msg = 'Generator aktif, listrik dari genset.';
    if (source === 'OFF') msg = 'Gangguan listrik total.';
    if (!elecOk && source !== 'OFF') msg = 'Kualitas listrik kurang stabil.';
    if (!fuelOk) msg = 'Bahan bakar rendah, segera isi ulang.';
    
    if (!elecOk) tips.push('Cek kestabilan tegangan PLN');
    if (!fuelOk) tips.push('Hubungi teknisi untuk pengisian BBM');
    if (maintNear) tips.push('Jadwal servis rutin sudah dekat');
    if (tips.length === 0) {
        tips.push('Pantau level BBM setiap hari');
        tips.push('Matikan peralatan tidak penting saat genset menyala');
    }
    $('#publicMessage').innerHTML = msg;
    $('#publicTips').innerHTML = tips.map(t => `<li><i class="fas fa-circle-check"></i> ${t}</li>`).join('');
}

// ---------- UPDATE UTAMA (dipanggil dari API / MQTT) ----------
function updateDashboard(data) {
    // Update nilai dari data (API atau MQTT)
    currentData.volt = Number(data.volt) || currentData.volt;
    currentData.freq = Number(data.freq) || currentData.freq;
    currentData.current = Number(data.current || data.amp) || currentData.current;
    currentData.rpm = Number(data.rpm) || currentData.rpm;
    currentData.coolant = Number(data.coolant_temp || data.temp) || currentData.coolant;
    currentData.fuel = Number(data.fuel) || currentData.fuel;
    currentData.iat = Number(data.iat ?? data.intake_temp ?? 0);
    currentData.afr = Number(data.afr ?? 0);
    currentData.throttle = Number(data.throttle ?? data.tps ?? 0);
    currentData.engineHours = Number(data.engineHours) || currentData.engineHours;
    currentData.isRunning = String(data.status || '').toLowerCase() === 'on' || currentData.rpm > 50;
    const sync = String(data.sync || '').toUpperCase();
    currentData.syncOk = sync.includes('ON-GRID') || sync.includes('SYNC') || sync.includes('PLN');
    currentData.source = (!currentData.isRunning && !currentData.syncOk) ? 'OFF' :
                          (currentData.isRunning && currentData.syncOk ? 'HYBRID' :
                          (currentData.isRunning ? 'GEN' : 'PLN'));
    
    // Hitung daya (kW)
    currentData.power = (currentData.volt * currentData.current) / 1000;
    
    // Update UI elemen
    $('#ovRPM').innerText = currentData.rpm.toFixed(0);
    $('#ovTemp').innerText = currentData.coolant.toFixed(1);
    $('#ovVoltage').innerText = currentData.volt.toFixed(0);
    
    // Parameter kelistrikan
    $('#genVolt').innerText = currentData.volt.toFixed(0) + ' V';
    $('#genFreq').innerText = currentData.freq.toFixed(1) + ' Hz';
    $('#genCurr').innerText = currentData.current.toFixed(1) + ' A';
    $('#genPow').innerText = currentData.power.toFixed(2) + ' kW';
    
    // Parameter motor bakar
    $('#motorRpm').innerText = currentData.rpm.toFixed(0);
    $('#motorIat').innerText = currentData.iat.toFixed(1) + ' °C';
    $('#motorCoolant').innerText = currentData.coolant.toFixed(1) + ' °C';
    $('#motorFuel').innerText = currentData.fuel.toFixed(0) + ' %';
    $('#motorAfr').innerText = currentData.afr.toFixed(1);
    $('#motorThrottle').innerText = currentData.throttle.toFixed(0) + ' %';
    
    // Engine status
    $('#engSync').innerText = currentData.syncOk ? 'Sync' : 'Not Sync';
    $('#engState').innerText = currentData.isRunning ? (currentData.source==='GEN' ? 'Running (Gen)' : 'Running (Hybrid)') : 'Stopped';
    $('#engFuel').innerText = currentData.fuel.toFixed(0) + '%';
    
    // System Health
    updateSystemHealth(currentData.volt, currentData.freq, currentData.current, currentData.fuel, currentData.afr);
    
    // Active time chart (weekly uptime)
    if (uptimeChart && data.weeklyUptimeHistory && data.weeklyUptimeHistory.length === 7) {
        uptimeChart.data.datasets[0].data = data.weeklyUptimeHistory;
        uptimeChart.update();
        const total = data.weeklyUptimeHistory.reduce((a,b)=>a+b,0);
        $('#weeklyTotal').innerText = total.toFixed(1) + ' jam';
    }
    
    // Maintenance & lifespan
    const elecOk = (currentData.volt >= VOLT_LO && currentData.volt <= VOLT_HI && currentData.volt > 0);
    const engineOk = (currentData.coolant <= 95 || currentData.coolant === 0);
    const fuelOk = currentData.fuel >= 25;
    const nextMaint = renderMaintenance(currentData.engineHours);
    updateLifespan(currentData.engineHours);
    updateCostAndRuntime(currentData.fuel, currentData.power, currentData.isRunning);
    updateTodayActive(currentData.isRunning);
    const maintOk = (nextMaint === Infinity || nextMaint > 50);
    renderDiagnostik(elecOk, engineOk, fuelOk, maintOk, currentData.syncOk, currentData.source);
    updateInfoTips(elecOk, fuelOk, currentData.source, !maintOk);
    
    // Update jumlah alert di overview
    const activeAlertCount = eventLog.filter(e => e.status !== 'ok').length;
    $('#ovAlerts').innerText = activeAlertCount;
    
    // System status dot
    const allGood = elecOk && engineOk && fuelOk && maintOk;
    const sysDot = $('#sbSysDot');
    if (sysDot) sysDot.className = `ssb-dot ${allGood ? 'ok' : (currentData.fuel < 10 ? 'err' : 'warn')}`;
    const sysLabel = $('#sbSysLabel');
    if (sysLabel) sysLabel.innerText = allGood ? 'Semua Sistem Normal' : 'Ada yang perlu diperiksa';
    
    // Last update time
    $('#lastUpdate').innerHTML = `<i class="fas fa-clock"></i> Diperbarui: ${new Date().toLocaleString('id-ID')}`;
    
    // Trigger event jika sumber berubah (opsional)
    // ...
}


function enforcePublicAccess() {
    const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
    const role = (localStorage.getItem('userRole') || '').toLowerCase();
    if (!isLoggedIn) {
        window.location.replace('login.html');
        return false;
    }
    if (role !== 'masyarakat') {
        window.location.replace('index.html');
        return false;
    }
    return true;
}

function markRealtimeStatus(isLive) {
    const badge = $('#liveBadge');
    if (!badge) return;
    badge.classList.toggle('offline', !isLive);
    badge.innerHTML = isLive
        ? '<i class="fas fa-circle"></i> Live'
        : '<i class="fas fa-triangle-exclamation"></i> Reconnecting';
}

// ---------- Data Fetching (API & MQTT) ----------
function buildWeeklyUptimeFromSessions(sessions) {
    const labels = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const totals = [0,0,0,0,0,0,0];
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    start.setHours(0,0,0,0);

    (sessions || []).forEach((row) => {
        const started = new Date(row.startedAt);
        const ended = row.endedAt ? new Date(row.endedAt) : new Date();
        if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime())) return;
        const cursor = new Date(Math.max(started.getTime(), start.getTime()));
        while (cursor < ended) {
            const dayEnd = new Date(cursor);
            dayEnd.setHours(23,59,59,999);
            const segEnd = new Date(Math.min(dayEnd.getTime(), ended.getTime()));
            const durH = Math.max(0, (segEnd - cursor) / 3600000);
            const dayIndex = cursor.getDay();
            totals[dayIndex] += durH;
            cursor.setTime(segEnd.getTime() + 1);
        }
    });

    return { labels, data: totals.map(v => +v.toFixed(2)) };
}

function renderAlertsFromDb(alertRows) {
    const container = $('#recentAlertsList');
    if (!container) return;
    const rows = (alertRows || []).slice(0, 5);
    if (!rows.length) {
        container.innerHTML = '<div class="alert-item info"><i class="fas fa-check-circle"></i> Tidak ada alert dari database</div>';
        return;
    }
    container.innerHTML = rows.map((a) => {
        const sev = String(a.severity || '').toLowerCase();
        const cls = sev === 'critical' || sev === 'high' ? 'err' : (sev === 'medium' ? 'warn' : 'info');
        const label = a.message || `${String(a.parameter || 'sys').toUpperCase()} : ${a.value ?? '-'}`;
        const tm = a.timestamp ? new Date(a.timestamp).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}) : '--:--';
        return `<div class="alert-item ${cls}"><i class="fas fa-triangle-exclamation"></i> ${label}<span style="margin-left:auto; font-size:0.65rem;">${tm}</span></div>`;
    }).join('');
}

function updateDataSourceBadge(enginePayload) {
    const badge = $('#dataSourceBadge');
    if (!badge) return;
    const ts = new Date(enginePayload?.timestamp || 0);
    const ageMs = Date.now() - ts.getTime();
    if (!Number.isFinite(ageMs) || ageMs > 60000) {
        badge.className = 'data-source err';
        badge.textContent = 'DB: stale data';
        return;
    }
    if (ageMs > 15000) {
        badge.className = 'data-source warn';
        badge.textContent = 'DB: delayed';
        return;
    }
    badge.className = 'data-source';
    badge.textContent = 'DB: realtime';
}

async function loadData() {
    try {
        const [engineRes, activeRes, alertsRes] = await Promise.all([
            fetch('/api/engine-data/latest'),
            fetch('/api/generator-active-time/history?limit=60'),
            fetch('/api/alerts?limit=5')
        ]);
        const [engineJson, activeJson, alertsJson] = await Promise.all([
            engineRes.json(), activeRes.json(), alertsRes.json()
        ]);

        const weekly = buildWeeklyUptimeFromSessions(activeJson?.data || []);
        const merged = { ...(engineJson?.data || {}), weeklyUptimeHistory: weekly.data };
        if (uptimeChart) uptimeChart.data.labels = weekly.labels;

        updateDashboard(merged);
        renderAlertsFromDb(alertsJson?.data || []);
        updateDataSourceBadge(engineJson?.data || {});
        markRealtimeStatus(true);
    } catch (e) {
        markRealtimeStatus(false);
        const badge = $('#dataSourceBadge');
        if (badge) {
            badge.className = 'data-source err';
            badge.textContent = 'DB: offline';
        }
        console.warn('Fetch error:', e);
    }
}

function setupMQTT() {
    if (typeof mqtt === 'undefined') return;
    const client = mqtt.connect('wss://broker.shiftr.io', { clientId: 'pub-bento-' + Math.random().toString(16).slice(2) });
    
    let liveData = {};
    client.on('connect', () => {
        client.subscribe(['genset/voltage','genset/current','genset/fuel','genset/temp','genset/rpm','genset/status']);
    });

    client.on('message', (topic, payload) => {
        let val = parseFloat(payload.toString());
        if (isNaN(val)) return;
        if (topic.includes('voltage')) updateDashboard({ volt: val });
        if (topic.includes('current')) updateDashboard({ current: val });
        if (topic.includes('fuel')) updateDashboard({ fuel: val });
        if (topic.includes('temp')) updateDashboard({ temp: val });
        if (topic.includes('rpm')) updateDashboard({ rpm: val });
        if (topic.includes('status')) updateDashboard({ status: payload.toString() });
    });
}

// ---------- Call teknisi ----------
function callTechnician() {
    const phone = '08123456789';
    if (confirm(`Hubungi teknisi di nomor ${phone}?`)) {
        window.location.href = `tel:${phone}`;
        addEvent('call', 'Pengguna memanggil teknisi', 'info');
    }
}

// ---------- Sidebar & Logout (mobile toggle) ----------
function initSidebar() {
    const name = localStorage.getItem('username') || 'Pengguna';
    const userEl = document.querySelector('#user-btn span');
    if (userEl) userEl.innerText = name;

    fetch('sidebar.html')
        .then(r => r.text())
        .then(h => {
            const container = document.getElementById('sidebar-container');
            if (container) container.innerHTML = h;
        })
        .catch(err => console.warn('Sidebar load failed:', err));

    $('#callTechnicianBtn')?.addEventListener('click', callTechnician);
    $('#refreshPublic')?.addEventListener('click', loadData);
}

// ---------- RUN ----------
window.addEventListener('DOMContentLoaded', () => {
    if (!enforcePublicAccess()) return;
    initSidebar();
    initCharts();
    loadData();
    connectMQTT();
    setInterval(loadData, 800);
    // Event dummy awal
    setTimeout(() => {
        addEvent('system', 'Sistem siap dipantau', 'ok');
        addEvent('info', 'Generator dalam mode siaga', 'ok');
    }, 500);
});