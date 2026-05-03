/**
 * Gen-Track Dashboard v4.0 - Modern UI + Fitur Maintenance, Cost, Alerts, Call Teknisi
 */
'use strict';

// Constants (sama seperti sebelumnya)
const RPM_MAX = 3600, TEMP_MAX = 120, ARC_LEN = 282.7;
const VOLT_LO = 198, VOLT_HI = 242, FREQ_LO = 49.5, FREQ_HI = 50.5;
const ENGINE_LIFE_H = 10000;
const AVG_CONSUMPTION_LPH = 2.5, FUEL_PRICE_PER_LITER = 12000, TANK_CAPACITY_L = 50;

let trending = { labels: [], volt: [], freq: [] };
let uptimeChart = null, donutChart = null;
let eventLog = [];
let mqttClient = null;
let dailyTotalCost = 0, lastRuntimeUpdate = Date.now(), dailyActiveMs = 0;
let currentFuel = 0, currentPowerKw = 0, currentRpm = 0, currentTemp = 0, currentVolt = 0;
let engineHours = 0;

// DOM utils
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Format tanggal
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});

// Event log
function addEvent(type, text, status = 'ok') {
    const timeStr = new Date().toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
    eventLog.unshift({ time: timeStr, type, text, status });
    if(eventLog.length > 25) eventLog.pop();
    renderRecentActivities();
    renderRecentAlerts();
}
function renderRecentActivities() {
    const container = $('#recentActivityList');
    if(!container) return;
    if(eventLog.length === 0) { container.innerHTML = '<div class="activity-item">Tidak ada aktivitas baru</div>'; return; }
    container.innerHTML = eventLog.slice(0,5).map(ev => `
        <div class="activity-item"><i class="fas fa-${ev.type === 'source' ? 'bolt' : 'circle-info'}"></i> <span>${ev.text}</span> <span style="margin-left:auto; font-size:0.65rem;">${ev.time}</span></div>
    `).join('');
}
function renderRecentAlerts() {
    const container = $('#recentAlertsList');
    if(!container) return;
    const alerts = eventLog.filter(ev => ev.status === 'warn' || ev.status === 'err').slice(0,4);
    if(alerts.length === 0) { container.innerHTML = '<div class="alert-item info"><i class="fas fa-check-circle"></i> Tidak ada alert aktif</div>'; return; }
    container.innerHTML = alerts.map(alert => `
        <div class="alert-item ${alert.status}"><i class="fas fa-exclamation-triangle"></i> ${alert.text} <span style="margin-left:auto; font-size:0.65rem;">${alert.time}</span></div>
    `).join('');
}

// Initial chart
function initCharts() {
    const ctx = $('#uptimeChart');
    if(ctx && !uptimeChart) {
        uptimeChart = new Chart(ctx, {
            type: 'bar',
            data: { labels: ['Min','Sen','Sel','Rab','Kam','Jum','Sab'], datasets: [{ label:'Jam Operasi', data:[0,0,0,0,0,0,0], backgroundColor:'#1f6392', borderRadius:8 }] },
            options: { responsive: true, maintainAspectRatio: true, scales: { y: { beginAtZero: true, max:24, title:{display:false} } }, plugins:{legend:{display:false}} }
        });
    }
    const dctx = $('#lifespanDonut');
    if(dctx && !donutChart) {
        donutChart = new Chart(dctx, { type:'doughnut', data:{ datasets:[{ data:[0,100], backgroundColor:['#1f6392','#e6f0f9'], borderWidth:0 }] }, options:{ cutout:'70%', responsive:false, maintainAspectRatio:true, plugins:{legend:{display:false}, tooltip:{enabled:false}} } });
    }
}

// Update donut & umur
function updateLifespan(engH) {
    const used = clamp(engH, 0, ENGINE_LIFE_H);
    const remain = ENGINE_LIFE_H - used;
    const pct = (remain/ENGINE_LIFE_H)*100;
    if(donutChart) donutChart.data.datasets[0].data = [used, remain], donutChart.update();
    $('#lifespanRemainText') && ($('#lifespanRemainText').innerText = remain.toFixed(0) + ' jam');
    return pct;
}

// Hitung active time hari ini (dummy dari engineHours? kita update dari data generator tiap hari)
let todayActiveSeconds = 0;
function updateTodayActive(isRunning) {
    // sederhana: jika engine running, tambah delta
    if(isRunning) {
        const now = Date.now();
        if(window._lastActiveTick) {
            const deltaSec = (now - window._lastActiveTick)/1000;
            if(deltaSec > 0 && deltaSec < 10) todayActiveSeconds += deltaSec;
        }
        window._lastActiveTick = now;
    } else {
        window._lastActiveTick = null;
    }
    const hours = Math.floor(todayActiveSeconds / 3600);
    const mins = Math.floor((todayActiveSeconds % 3600) / 60);
    $('#engToday') && ($('#engToday').innerText = `${hours}h ${mins}m`);
}
setInterval(() => { updateTodayActive(window._engineIsRunning || false); }, 2000);

// Cost & runtime
function updateCostAndRuntime(fuelPct, powerKw, isRunning) {
    const consumption = AVG_CONSUMPTION_LPH * (powerKw > 0.9 ? 1.3 : 1.0);
    const costPerHour = consumption * FUEL_PRICE_PER_LITER;
    $('#costPerHour') && ($('#costPerHour').innerText = 'Rp ' + costPerHour.toLocaleString('id-ID'));
    const now = Date.now();
    if(isRunning && lastRuntimeUpdate) {
        const elapsedMs = now - lastRuntimeUpdate;
        dailyTotalCost += costPerHour * (elapsedMs / 3600000);
        dailyActiveMs += elapsedMs;
    }
    lastRuntimeUpdate = now;
    $('#costDaily') && ($('#costDaily').innerText = 'Rp ' + Math.round(dailyTotalCost).toLocaleString('id-ID'));
    if(fuelPct > 0 && isRunning) {
        const liters = (fuelPct/100)*TANK_CAPACITY_L;
        const hoursLeft = liters / consumption;
        $('#nextServiceText') && ($('#nextServiceText').innerHTML = `${hoursLeft.toFixed(1)} jam (BBM)`);
    } else if(!isRunning) $('#nextServiceText') && ($('#nextServiceText').innerHTML = '--');
}

// Maintenance items & perhitungan jadwal
const MAINT_ITEMS = [
    { id:'oil', name:'Ganti Oli', interval:250 }, { id:'filter', name:'Filter Udara', interval:500 },
    { id:'spark', name:'Busi', interval:1000 }, { id:'coolant', name:'Coolant', interval:1000 },
    { id:'major', name:'Servis Besar', interval:2500 }
];
function renderMaintenance(engineHours) {
    let nextServiceHour = Infinity;
    const rows = MAINT_ITEMS.map(item => {
        const last = Math.max(0, engineHours - (engineHours % item.interval));
        const dueAt = last + item.interval;
        const hoursLeft = dueAt - engineHours;
        let status = 'ok', badge = 'OK';
        if(hoursLeft <= 0) { status = 'err'; badge = 'Terlambat'; }
        else if(hoursLeft <= 50) { status = 'warn'; badge = 'Segera'; }
        if(hoursLeft > 0 && hoursLeft < nextServiceHour) nextServiceHour = hoursLeft;
        return `<div class="mi-compact"><span class="mi-name">${item.name}</span><span class="mi-status ${status}">${badge}</span><span style="font-size:0.7rem;">${hoursLeft>0?hoursLeft.toFixed(0)+' jam':'segera'}</span></div>`;
    }).join('');
    $('#maintList') && ($('#maintList').innerHTML = rows);
    if(nextServiceHour !== Infinity && $('#nextServiceText')) $('#nextServiceText').innerHTML = nextServiceHour <= 0 ? 'Segera servis!' : `${Math.round(nextServiceHour)} jam lagi`;
    return nextServiceHour;
}

// Diagnostik (health check)
function renderDiagnostik(elecOk, engineOk, fuelOk, maintOk, syncOk, source) {
    const container = $('#healthCheckContainer');
    if(!container) return;
    const items = [
        { label:'Jaringan PLN', status: elecOk ? 'ok' : (currentVolt>0?'warn':'err'), desc: elecOk ? 'Stabil' : (currentVolt>0?'Fluktuasi':'Padam') },
        { label:'Generator', status: engineOk && source !== 'OFF' ? 'ok' : (source==='GEN'?'warn':'ok'), desc: source==='GEN'?'Menyuplai':(source==='OFF'?'Tidak aktif':'Siaga') },
        { label:'Sinkronisasi', status: syncOk ? 'ok' : (source==='HYBRID'?'warn':'ok'), desc: syncOk ? 'Tersinkron' : 'Tidak sync' },
        { label:'Bahan Bakar', status: fuelOk ? 'ok' : (currentFuel<25?'warn':'err'), desc: currentFuel>0?`${currentFuel}%`:'Kosong' },
        { label:'Perawatan', status: maintOk ? 'ok' : 'warn', desc: maintOk ? 'Terjadwal' : 'Perlu perhatian' }
    ];
    container.innerHTML = items.map(i => `<div class="health-check-item"><span>${i.label}</span><span class="health-badge ${i.status}">${i.desc}</span></div>`).join('');
}

// System Health (voltage, current, frequency, fuel, AFR)
function updateSystemHealth(volt, freq, current, fuel, afrDummy) {
    const container = $('#sysHealthList');
    if(!container) return;
    const voltStatus = (volt >= VOLT_LO && volt <= VOLT_HI) ? 'ok' : (volt>0?'warn':'err');
    const freqStatus = (freq >= FREQ_LO && freq <= FREQ_HI) ? 'ok' : (freq>0?'warn':'err');
    const fuelStatus = fuel >= 25 ? 'ok' : (fuel>0?'warn':'err');
    const afrStatus = (afrDummy > 13 && afrDummy < 16) ? 'ok' : 'warn';
    const rows = `
        <div class="health-row"><span class="health-label">Voltage</span><span class="health-badge ${voltStatus}">${volt>0?volt.toFixed(0)+'V':'N/A'}</span></div>
        <div class="health-row"><span class="health-label">Current</span><span class="health-badge ${current>0?'ok':''}">${current>0?current.toFixed(1)+'A':'0A'}</span></div>
        <div class="health-row"><span class="health-label">Frequency</span><span class="health-badge ${freqStatus}">${freq>0?freq.toFixed(1)+'Hz':'--'}</span></div>
        <div class="health-row"><span class="health-label">Fuel Level</span><span class="health-badge ${fuelStatus}">${fuel.toFixed(0)}%</span></div>
        <div class="health-row"><span class="health-label">AFR</span><span class="health-badge ${afrStatus}">${afrDummy.toFixed(1)}</span></div>
    `;
    container.innerHTML = rows;
}

// MAIN UPDATE FUNCTION (dipanggil dari fetch & MQTT)
function updateDashboard(data) {
    const volt = Number(data.volt || 0);
    const freq = Number(data.freq || 0);
    const current = Number(data.current || data.amp || 0);
    const fuel = Number(data.fuel || 0);
    const temp = Number(data.temp || 0);
    const rpm = Number(data.rpm || 0);
    const engineHoursNow = Number(data.engineHours || 0);
    const isRunning = String(data.status || '').toLowerCase() === 'on' || rpm > 50;
    const sync = String(data.sync || '').toUpperCase();
    const syncOk = sync.includes('ON-GRID') || sync.includes('SYNC') || sync.includes('PLN');
    const source = (!isRunning && !syncOk) ? 'OFF' : (isRunning && syncOk ? 'HYBRID' : (isRunning ? 'GEN' : 'PLN'));

    currentFuel = fuel; currentPowerKw = volt*current/1000 || (isRunning?0.6:0);
    currentRpm = rpm; currentTemp = temp; currentVolt = volt;
    engineHours = engineHoursNow;
    window._engineIsRunning = isRunning;

    // overview cards
    $('#ovRPM') && ($('#ovRPM').innerText = rpm.toFixed(0));
    $('#ovTemp') && ($('#ovTemp').innerText = temp.toFixed(1));
    const activeAlertCount = eventLog.filter(e => e.status !== 'ok').length;
    $('#ovAlerts') && ($('#ovAlerts').innerText = activeAlertCount);
    $('#ovVoltage') && ($('#ovVoltage').innerText = volt.toFixed(0));

    // engine status card
    $('#engSync') && ($('#engSync').innerText = syncOk ? 'Sync' : 'Not Sync');
    $('#engState') && ($('#engState').innerText = isRunning ? (source==='GEN'?'Running (Gen)':'Running (Hybrid)') : 'Stopped');
    $('#engFuel') && ($('#engFuel').innerText = fuel.toFixed(0)+'%');

    // System health
    const afr = (rpm>0 ? 14.2 + (Math.random()*1-0.5) : 0); // dummy realistic
    updateSystemHealth(volt, freq, current, fuel, afr);

    // active time chart (weeklyUptime)
    if(uptimeChart && data.weeklyUptimeHistory && data.weeklyUptimeHistory.length===7) {
        uptimeChart.data.datasets[0].data = data.weeklyUptimeHistory;
        uptimeChart.update();
        const total = data.weeklyUptimeHistory.reduce((a,b)=>a+b,0);
        $('#weeklyTotal') && ($('#weeklyTotal').innerText = total.toFixed(1)+' jam');
    }

    // maintenance & lifespan
    const elecOk = (volt>=VOLT_LO && volt<=VOLT_HI && (volt>0));
    const engineOk = (temp<=95 || temp===0) && (rpm>=0);
    const fuelOk = fuel >= 25;
    const nextMaint = renderMaintenance(engineHours);
    updateLifespan(engineHours);
    updateCostAndRuntime(fuel, currentPowerKw, isRunning);
    updateTodayActive(isRunning);
    const maintOk = (nextMaint === Infinity || nextMaint > 50);
    renderDiagnostik(elecOk, engineOk, fuelOk, maintOk, syncOk, source);

    // Pesan info/tips dinamis
    let msg = 'Semua sistem normal.';
    if(source==='GEN') msg = 'Generator aktif, listrik dari genset.';
    if(source==='OFF') msg = 'Gangguan listrik total.';
    if(fuel<25) msg = 'Bahan bakar rendah, segera isi ulang.';
    $('#publicMessage') && ($('#publicMessage').innerHTML = msg);
    const tips = [
        fuel<25 ? 'Segera hubungi teknisi untuk pengisian BBM' : 'Pantau level BBM setiap hari',
        !elecOk ? 'Cek kestabilan tegangan PLN' : 'Tegangan listrik dalam batas normal',
        'Matikan peralatan listrik tidak penting saat genset menyala'
    ];
    $('#publicTips') && ($('#publicTips').innerHTML = tips.map(t => `<li><i class="fas fa-circle-check"></i> ${t}</li>`).join(''));
    $('#lastUpdate') && ($('#lastUpdate').innerHTML = `<i class="fas fa-clock"></i> Diperbarui: ${new Date().toLocaleString('id-ID')}`);

    // system status dot
    const allGood = elecOk && engineOk && fuelOk && maintOk;
    const sysDot = $('#sbSysDot');
    if(sysDot) sysDot.className = `ssb-dot ${allGood ? 'ok' : (fuel<10 ? 'err' : 'warn')}`;
    $('#sbSysLabel') && ($('#sbSysLabel').innerText = allGood ? 'Semua Sistem Normal' : 'Ada yang perlu diperiksa');
}

// Fetch dari API
async function loadData() {
    try {
        const res = await fetch('/api/engine-data/latest');
        const json = await res.json();
        const activeRes = await fetch('/api/generator-active-time/history?limit=7');
        const activeJson = await activeRes.json();
        const merged = { ...(json?.data || {}), weeklyUptimeHistory: activeJson?.data || [] };
        updateDashboard(merged);
    } catch(e) { console.warn(e); }
}

// MQTT
function connectMQTT() {
    if(typeof mqtt === 'undefined') return;
    const client = mqtt.connect('wss://broker.shiftr.io', { clientId: 'pub-'+Math.random().toString(16).slice(2) });
    client.on('connect', () => client.subscribe(['genset/voltage','genset/current','genset/fuel','genset/temp','genset/rpm','genset/status']));
    client.on('message', (topic, payload) => {
        let val = parseFloat(payload.toString());
        if(isNaN(val)) return;
        if(topic.includes('voltage')) updateDashboard({ volt: val });
        if(topic.includes('current')) updateDashboard({ current: val });
        if(topic.includes('fuel')) updateDashboard({ fuel: val });
        if(topic.includes('temp')) updateDashboard({ temp: val });
        if(topic.includes('rpm')) updateDashboard({ rpm: val });
        if(topic.includes('status')) updateDashboard({ status: payload.toString() });
    });
}

// Call teknisi
function callTechnician() {
    const phone = '08123456789'; // ganti dengan nomor teknisi sebenarnya
    if(confirm(`Hubungi teknisi di nomor ${phone}?`)) {
        window.location.href = `tel:${phone}`;
        addEvent('call', 'Pengguna memanggil teknisi', 'info');
    }
}

// Sidebar & logout
function initSidebar() {
    const btn = $('#menuBtn'), overlay = $('#sbOverlay');
    btn?.addEventListener('click', () => document.body.classList.add('sb-open'));
    overlay?.addEventListener('click', () => document.body.classList.remove('sb-open'));
    document.querySelectorAll('.sb-link').forEach(link => link.addEventListener('click', () => document.body.classList.remove('sb-open')));
    const name = localStorage.getItem('username') || 'Pengguna';
    $('#sbUsername') && ($('#sbUsername').innerText = name);
    $('#welcomeText') && ($('#welcomeText').innerHTML = `👋 Welcome, ${name.split(' ')[0]}!`);
    $('#sbAvatar') && ($('#sbAvatar').innerText = name.charAt(0).toUpperCase());
    $('#logoutPublic')?.addEventListener('click', () => { localStorage.clear(); window.location.href='login.html'; });
    $('#callTechnicianBtn')?.addEventListener('click', callTechnician);
    $('#refreshPublic')?.addEventListener('click', loadData);
}

// RUN
window.addEventListener('DOMContentLoaded', () => {
    initSidebar();
    initCharts();
    loadData();
    connectMQTT();
    setInterval(loadData, 30000);
    // event dummy untuk testing maintenance
    setTimeout(() => {
        addEvent('system', 'Sistem siap dipantau', 'ok');
        addEvent('info', 'Generator dalam mode siaga', 'ok');
    }, 500);
});