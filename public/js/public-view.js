'use strict';

const AVG_CONSUMPTION_LPH = 2.5; 
const TANK_CAPACITY_L = 50;      
const FUEL_PRICE_PER_LITER = 12000;
const AVG_HOURS_PER_DAY = 2; // Asumsi genset rata-rata menyala 2 jam/hari

// Database Komponen Maintenance
const MAINTENANCE_PARTS = [
    { name: 'Oli Mesin', interval: 250, cost: 450000 },
    { name: 'Filter Udara', interval: 500, cost: 150000 },
    { name: 'Filter Solar', interval: 500, cost: 200000 },
    { name: 'Air Radiator (Coolant)', interval: 1000, cost: 300000 }
];

let uptimeChart = null;
const $ = id => document.getElementById(id);
const formatRupiah = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

// --- REALTIME CLOCK WIB ---
function updateClock() {
    const now = new Date();
    // Konversi waktu lokal browser ke string, ini akan otomatis mencerminkan WIB jika client di Indonesia
    const timeString = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if($('realtimeClock')) $('realtimeClock').innerText = `${timeString} WIB`;
}
setInterval(updateClock, 1000);

// --- INIT CHART ---
function initUptimeChart() {
    const ctx = $('uptimeChart');
    if (ctx && !uptimeChart) {
        uptimeChart = new Chart(ctx, {
            type: 'bar',
            data: { 
                labels: ['H-6', 'H-5', 'H-4', 'H-3', 'H-2', 'Kemarin', 'Hari Ini'], 
                datasets: [{ 
                    label: 'Jam Aktif', 
                    data: [0, 0, 0, 0, 0, 0, 0], 
                    backgroundColor: '#1745a5', // Gen-Track Primary Blue
                    borderRadius: 6
                }] 
            },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: { 
                    y: { beginAtZero: true, suggestedMax: 10, title: { display: true, text: 'Jam' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

// --- UPDATE MAINTENANCE PREDICTION ---
function updateMaintenanceTable(currentEngineHours) {
    const tbody = $('maintenanceList');
    let html = '';
    
    // Sort agar komponen yang paling dekat jadwal gantinya ada di atas
    const partsWithStatus = MAINTENANCE_PARTS.map(part => {
        const hoursUsed = currentEngineHours % part.interval;
        const hoursLeft = part.interval - hoursUsed;
        const daysLeft = Math.ceil(hoursLeft / AVG_HOURS_PER_DAY);
        return { ...part, hoursLeft, daysLeft };
    }).sort((a, b) => a.hoursLeft - b.hoursLeft);

    partsWithStatus.forEach(part => {
        let conditionClass = 'cond-good';
        let conditionText = 'Bagus';
        
        if (part.hoursLeft < 50) {
            conditionClass = 'cond-bad';
            conditionText = 'Segera Ganti';
        } else if (part.hoursLeft < 100) {
            conditionClass = 'cond-warn';
            conditionText = 'Mulai Aus';
        }

        html += `
            <tr>
                <td style="font-weight: 600; color: var(--dark);">${part.name}</td>
                <td>${part.hoursLeft.toFixed(0)} Jam <br><span style="font-size: 11px; color: var(--muted);">~${part.daysLeft} Hari</span></td>
                <td><span class="cond-badge ${conditionClass}">${conditionText}</span></td>
                <td>${formatRupiah(part.cost)}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

// --- UPDATE MAIN DASHBOARD ---
function updatePublicDashboard(data) {
    const rpm = Number(data.rpm) || 0;
    const volt = Number(data.volt) || 0;
    const current = Number(data.current || data.amp) || 0;
    const fuel = Number(data.fuel) || 0;
    const temp = Number(data.coolant_temp || data.temp || data.coolant) || 0;
    const engineHours = Number(data.engineHours) || 1250; // Fallback untuk testing prediksi maintenance
    const powerKw = (volt * current) / 1000;
    
    const isRunning = String(data.status || '').toLowerCase() === 'on' || rpm > 50;
    const syncText = String(data.sync || '').toUpperCase();
    const isPLN = syncText.includes('ON-GRID') || syncText.includes('PLN') || (volt > 200 && !isRunning);

    // 1. ECU & SYNC BADGES
    const ecuBadge = $('badgeEcu');
    const syncBadge = $('badgeSync');
    
    const ts = Date.parse(data.timestamp || new Date().toISOString());
    const isFresh = (Date.now() - ts <= 20000); // 20 detik
    
    if (isFresh || isRunning) {
        ecuBadge.className = 'badge-item badge-online';
        $('ecuStatusText').innerText = 'Online';
    } else {
        ecuBadge.className = 'badge-item badge-offline';
        $('ecuStatusText').innerText = 'Terputus';
    }

    if (isPLN) {
        syncBadge.className = 'badge-item badge-online';
        $('syncStatusText').innerText = 'Tersinkron (ON-GRID)';
    } else {
        syncBadge.className = 'badge-item badge-offline';
        $('syncStatusText').innerText = 'Terputus dari PLN';
    }

    // 2. HERO CARD
    const heroCard = $('heroCard');
    const heroIcon = $('heroIcon');
    const powerSourceText = $('powerSourceText');
    const powerDescText = $('powerDescText');

    heroCard.classList.remove('pln', 'genset', 'off', 'loading');
    if (isRunning) {
        heroCard.classList.add('genset');
        heroIcon.className = 'fas fa-industry hero-bg-icon';
        powerSourceText.innerText = 'Pasokan Listrik GENSET';
        powerDescText.innerText = 'Genset beroperasi menyuplai daya ke infrastruktur publik.';
    } else if (isPLN) {
        heroCard.classList.add('pln');
        heroIcon.className = 'fas fa-plug-circle-check hero-bg-icon';
        powerSourceText.innerText = 'Pasokan Listrik PLN';
        powerDescText.innerText = 'Jaringan utama kelistrikan beroperasi normal.';
    } else {
        heroCard.classList.add('off');
        heroIcon.className = 'fas fa-power-off hero-bg-icon';
        powerSourceText.innerText = 'PEMADAMAN LISTRIK';
        powerDescText.innerText = 'Listrik padam. Menunggu sistem otomatis menyalakan genset.';
    }

    // 3. FUEL & POWER
    $('fuelPct').innerText = fuel.toFixed(0);
    const fuelBar = $('fuelBar');
    fuelBar.style.width = `${fuel}%`;
    fuelBar.style.backgroundColor = fuel > 25 ? 'var(--secondary)' : 'var(--danger)';

    const estConsumption = powerKw > 0.9 ? AVG_CONSUMPTION_LPH * 1.3 : AVG_CONSUMPTION_LPH; 
    const litersLeft = (fuel / 100) * TANK_CAPACITY_L;
    const hoursLeft = estConsumption > 0 ? (litersLeft / estConsumption).toFixed(1) : 0;
    $('fuelEstText').innerText = isRunning ? `${hoursLeft} jam` : 'Siaga Penuh';

    $('powerKw').innerText = powerKw.toFixed(1);
    const powerPill = $('powerStatusText');
    if (powerKw > 15) {
        powerPill.innerText = 'Beban Kritis (Kurangi Pemakaian)'; 
        powerPill.style.background = '#fef2f2'; powerPill.style.color = '#ef4444';
    } else if (powerKw > 0) {
        powerPill.innerText = 'Beban Wajar'; 
        powerPill.style.background = '#eff6ff'; powerPill.style.color = '#1e40af';
    } else {
        powerPill.innerText = 'Sistem Standby'; 
        powerPill.style.background = 'var(--bg-light)'; powerPill.style.color = 'var(--muted)';
    }

    // 4. MAINTENANCE & COST
    updateMaintenanceTable(engineHours);
    const todayActiveHours = (data.todayActiveHours) || (isRunning ? 0.5 : 0); 
    $('dailyCost').innerText = formatRupiah(todayActiveHours * AVG_CONSUMPTION_LPH * FUEL_PRICE_PER_LITER);

    // 5. ALERTS
    renderAlerts(isRunning, fuel, temp, powerKw);

    // 6. CHART
    if(data.weeklyUptimeHistory && uptimeChart) {
        uptimeChart.data.datasets[0].data = data.weeklyUptimeHistory;
        uptimeChart.update();
    }
}

function renderAlerts(isRunning, fuel, temp, powerKw) {
    const container = $('publicAlerts');
    let alertsHtml = '';

    if (temp > 95) {
        alertsHtml += `<div class="alert-box danger"><i class="fas fa-fire"></i> <div><strong>Mesin Overheat:</strong> Suhu sangat panas (${temp.toFixed(0)}°C). Sistem mungkin dihentikan otomatis.</div></div>`;
    }
    if (fuel < 20) {
        alertsHtml += `<div class="alert-box warn"><i class="fas fa-gas-pump"></i> <div><strong>BBM Menipis:</strong> Solar di bawah 20%. Teknisi harap segera mengisi ulang tangki.</div></div>`;
    }
    if (powerKw > 15) {
        alertsHtml += `<div class="alert-box warn"><i class="fas fa-bolt"></i> <div><strong>Beban Puncak:</strong> Pemakaian tinggi. Warga diimbau mematikan AC / alat berat jika tidak perlu.</div></div>`;
    }
    
    if (alertsHtml === '') {
        alertsHtml = `<div class="alert-box info"><i class="fas fa-check-circle"></i> <div><strong>Kondisi Aman:</strong> Tidak terdeteksi masalah pada komponen mesin dan kelistrikan.</div></div>`;
        if (isRunning) alertsHtml += `<div class="alert-box info"><i class="fas fa-cog fa-spin"></i> <div><strong>Genset Berjalan:</strong> Menyuplai listrik area selama gangguan PLN.</div></div>`;
    }

    container.innerHTML = alertsHtml;
}

// --- FETCH DATA & MQTT ---
async function fetchDashboardData() {
    try {
        const resObj = await fetch('/api/engine-data/latest');
        const jsonObj = await resObj.json();
        
        const activeRes = await fetch('/api/generator-active-time/history?limit=7');
        let weeklyData = [0,0,0,0,0,0,0];
        if(activeRes.ok) {
            const activeJson = await activeRes.json();
            if(activeJson.data) weeklyData = activeJson.data;
        }

        if(jsonObj.data) {
            jsonObj.data.weeklyUptimeHistory = weeklyData;
            updatePublicDashboard(jsonObj.data);
        }
    } catch (e) {
        console.warn('API Fetch error:', e);
    }
}

function setupMQTT() {
    if (typeof mqtt === 'undefined') return;
    const client = mqtt.connect('wss://broker.shiftr.io', { clientId: 'pub-' + Math.random().toString(16).slice(2) });
    
    let liveData = {};
    client.on('connect', () => {
        client.subscribe(['genset/voltage','genset/current','genset/fuel','genset/temp','genset/rpm','genset/status', 'genset/sync']);
    });

    client.on('message', (topic, payload) => {
        let val = parseFloat(payload.toString());
        if (topic.includes('status') || topic.includes('sync')) {
            if(topic.includes('status')) liveData.status = payload.toString();
            if(topic.includes('sync')) liveData.sync = payload.toString();
        } else {
            if (isNaN(val)) return;
            if (topic.includes('voltage')) liveData.volt = val;
            if (topic.includes('current')) liveData.current = val;
            if (topic.includes('fuel')) liveData.fuel = val;
            if (topic.includes('temp')) liveData.temp = val;
            if (topic.includes('rpm')) liveData.rpm = val;
        }
        liveData.timestamp = new Date().toISOString();
        updatePublicDashboard(liveData);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    updateClock();
    initUptimeChart();
    fetchDashboardData(); 
    setupMQTT(); 
    setInterval(fetchDashboardData, 30000); 
});