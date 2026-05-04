'use strict';

const AVG_CONSUMPTION_LPH = 2.5; 
const TANK_CAPACITY_L = 50;      
const FUEL_PRICE_PER_LITER = 12000;
const AVG_HOURS_PER_DAY = 2;

const MAINTENANCE_PARTS = [
    { name: 'Oli Mesin', interval: 250, cost: 450000 },
    { name: 'Filter Udara & Solar', interval: 500, cost: 350000 },
    { name: 'Air Radiator (Coolant)', interval: 1000, cost: 300000 }
];

let uptimeChart = null;
const $ = id => document.getElementById(id);
const formatRupiah = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

// 1. JAM REAL-TIME
function updateClock() {
    const el = $('realtimeClock');
    if(el) el.innerText = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
}
setInterval(updateClock, 1000);

// 2. INIT CHART
function initUptimeChart() {
    const ctx = $('uptimeChart');
    if (ctx && !uptimeChart) {
        let gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(23, 69, 165, 0.8)'); // Primary Gen-Track
        gradient.addColorStop(1, 'rgba(23, 69, 165, 0.1)');

        uptimeChart = new Chart(ctx, {
            type: 'bar',
            data: { 
                labels: ['H-6', 'H-5', 'H-4', 'H-3', 'H-2', 'Kemarin', 'Hari Ini'], 
                datasets: [{ 
                    label: 'Jam Operasi', 
                    data: [0,0,0,0,0,0,0], 
                    backgroundColor: gradient,
                    borderRadius: {topLeft: 6, topRight: 6},
                    barPercentage: 0.5
                }] 
            },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: { 
                    y: { beginAtZero: true, suggestedMax: 8, grid: { borderDash: [4, 4] } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// 3. LOGIKA KESEHATAN SISTEM
function calculateHealth(temp, fuel, isRunning, volt) {
    let score = 100;
    if (temp > 95) score -= 30; else if (temp > 85) score -= 10;
    if (fuel < 15) score -= 30; else if (fuel < 25) score -= 15;
    if (!isRunning && volt > 0 && volt < 190) score -= 15;
    return Math.max(0, score);
}

// 4. UPDATE MAINTENANCE TABLE
function updateMaintenanceTable(engineHours) {
    const tbody = $('maintenanceList');
    let html = '';
    
    let parts = MAINTENANCE_PARTS.map(part => {
        const hoursUsed = engineHours % part.interval;
        const hoursLeft = part.interval - hoursUsed;
        const daysLeft = Math.ceil(hoursLeft / AVG_HOURS_PER_DAY);
        return { ...part, hoursLeft, daysLeft };
    }).sort((a, b) => a.hoursLeft - b.hoursLeft);

    parts.forEach(part => {
        let cClass = 'cond-good', cText = 'Bagus';
        if (part.hoursLeft < 50) { cClass = 'cond-bad'; cText = 'Segera Ganti'; } 
        else if (part.hoursLeft < 100) { cClass = 'cond-warn'; cText = 'Mulai Aus'; }

        html += `
            <tr>
                <td><strong>${part.name}</strong></td>
                <td>${part.hoursLeft.toFixed(0)} Jam <small class="text-muted">(~${part.daysLeft} Hari)</small></td>
                <td><span class="cond-badge ${cClass}">${cText}</span></td>
                <td>${formatRupiah(part.cost)}</td>
            </tr>`;
    });
    tbody.innerHTML = html;
}

// 5. RENDER ALERTS
function renderAlerts(isRunning, fuel, temp, powerKw) {
    const box = $('publicAlerts');
    let html = '';

    if (temp > 95) html += `<div class="feed-item danger"><strong><i class="fas fa-fire"></i> Mesin Overheat!</strong> Sistem sedang didinginkan otomatis.</div>`;
    if (fuel < 20) html += `<div class="feed-item warn"><strong><i class="fas fa-gas-pump"></i> BBM Menipis (<20%).</strong> Teknisi siap melakukan pengisian.</div>`;
    if (powerKw > 15) html += `<div class="feed-item warn"><strong><i class="fas fa-bolt"></i> Beban Listrik Puncak.</strong> Warga diimbau mengurangi pemakaian daya tinggi.</div>`;
    
    if (!html) {
        html += `<div class="feed-item info"><strong><i class="fas fa-shield-check"></i> Kondisi Ideal.</strong> Tidak terdeteksi anomali sistem.</div>`;
        if (isRunning) html += `<div class="feed-item info"><strong><i class="fas fa-cog fa-spin"></i> Genset Beroperasi.</strong> Mengamankan kelistrikan area.</div>`;
    }
    box.innerHTML = html;
}

// 6. MAIN UPDATE FUNCTION
function updateDashboard(data) {
    const rpm = Number(data.rpm) || 0;
    const volt = Number(data.volt) || 0;
    const current = Number(data.current || data.amp) || 0;
    const fuel = Number(data.fuel) || 0;
    const temp = Number(data.coolant_temp || data.temp || data.coolant) || 0;
    const engHours = Number(data.engineHours) || 1200; 
    
    const powerKw = (volt * current) / 1000;
    const isRunning = String(data.status || '').toLowerCase() === 'on' || rpm > 50;
    const syncText = String(data.sync || '').toUpperCase();
    const isPLN = syncText.includes('ON-GRID') || syncText.includes('PLN') || (volt > 200 && !isRunning);

    // HERO CARD
    const hero = $('heroCard');
    hero.className = 'b-card hero-card'; // reset classes
    if (isRunning) {
        hero.classList.add('genset');
        $('powerSourceText').innerText = 'Pasokan GENSET';
        $('powerDescText').innerText = 'PLN Padam. Genset beroperasi penuh menyuplai daya area.';
        $('syncStatusText').innerHTML = '<i class="fas fa-plug"></i> Beroperasi Mandiri';
    } else if (isPLN) {
        hero.classList.add('pln');
        $('powerSourceText').innerText = 'Pasokan PLN';
        $('powerDescText').innerText = 'Jaringan kelistrikan utama beroperasi normal.';
        $('syncStatusText').innerHTML = '<i class="fas fa-link"></i> Tersinkron (ON-GRID)';
    } else {
        hero.classList.add('off');
        $('powerSourceText').innerText = 'PEMADAMAN';
        $('powerDescText').innerText = 'Menunggu prosedur penyalaan genset otomatis.';
        $('syncStatusText').innerHTML = '<i class="fas fa-unlink"></i> Terputus';
    }

    // FUEL
    $('fuelPct').innerText = fuel.toFixed(0);
    $('fuelBar').style.width = `${fuel}%`;
    $('fuelBar').style.background = fuel > 25 ? 'var(--secondary)' : 'var(--danger)';
    const cRate = powerKw > 0.9 ? AVG_CONSUMPTION_LPH * 1.3 : AVG_CONSUMPTION_LPH; 
    $('fuelEstText').innerText = isRunning ? ((fuel/100*TANK_CAPACITY_L)/cRate).toFixed(1) + ' Jam' : 'Standby';

    // POWER
    $('powerKw').innerText = powerKw.toFixed(1);
    const pPill = $('powerStatusText');
    if(powerKw > 15) { pPill.innerText='Beban Kritis'; pPill.style.background='#fef2f2'; pPill.style.color='#ef4444'; }
    else if(powerKw > 0) { pPill.innerText='Beban Wajar'; pPill.style.background='#eff6ff'; pPill.style.color='#1745a5'; }
    else { pPill.innerText='Sistem Idle'; pPill.style.background='var(--bg-page)'; pPill.style.color='var(--muted)'; }

    // HEALTH SCORE
    const health = calculateHealth(temp, fuel, isRunning, volt);
    $('healthScoreTxt').innerText = `${health}%`;
    const hBox = $('healthCircleBox');
    let hColor = 'var(--secondary)'; let hDesc = 'Sistem Prima';
    if(health < 50) { hColor = 'var(--danger)'; hDesc = 'Perlu Cek'; }
    else if (health < 80) { hColor = 'var(--warning)'; hDesc = 'Perhatian'; }
    hBox.style.borderTopColor = hColor;
    $('healthScoreTxt').style.color = hColor;
    $('healthDescTxt').innerText = hDesc;

    // MAINT & ALERTS
    updateMaintenanceTable(engHours);
    renderAlerts(isRunning, fuel, temp, powerKw);
    $('dailyCost').innerText = formatRupiah((data.todayActiveHours || (isRunning ? 0.5 : 0)) * AVG_CONSUMPTION_LPH * FUEL_PRICE_PER_LITER);

    // CHART
    if(data.weeklyUptimeHistory && uptimeChart) {
        uptimeChart.data.datasets[0].data = data.weeklyUptimeHistory;
        uptimeChart.update();
    }
}

// 7. FETCH & MQTT
async function fetchData() {
    try {
        const res = await fetch('/api/engine-data/latest');
        const json = await res.json();
        const activeRes = await fetch('/api/generator-active-time/history?limit=7');
        let wData = [0,0,0,0,0,0,0];
        if(activeRes.ok) {
            const aJson = await activeRes.json();
            if(aJson.data) wData = aJson.data;
        }
        if(json.data) {
            json.data.weeklyUptimeHistory = wData;
            updateDashboard(json.data);
        }
    } catch(e) { console.warn('Fetch Err:', e); }
}

function initMQTT() {
    if (typeof mqtt === 'undefined') return;
    const client = mqtt.connect('wss://broker.shiftr.io', { clientId: 'pub-' + Math.random().toString(16).slice(2) });
    let lData = {};
    client.on('connect', () => { client.subscribe(['genset/voltage','genset/current','genset/fuel','genset/temp','genset/rpm','genset/status']); });
    client.on('message', (topic, msg) => {
        let val = parseFloat(msg.toString());
        if(topic.includes('status')) lData.status = msg.toString();
        else {
            if(isNaN(val)) return;
            if(topic.includes('voltage')) lData.volt = val;
            if(topic.includes('current')) lData.current = val;
            if(topic.includes('fuel')) lData.fuel = val;
            if(topic.includes('temp')) lData.temp = val;
            if(topic.includes('rpm')) lData.rpm = val;
        }
        updateDashboard(lData);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    updateClock();
    initUptimeChart();
    fetchData();
    initMQTT();
    setInterval(fetchData, 30000);
});.