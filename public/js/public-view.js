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
let currentEngineHours = 0;
const $ = id => document.getElementById(id);
const formatRupiah = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

// Jam realtime
function updateClock() {
    const el = $('realtimeClock');
    if (el) el.innerText = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
}
setInterval(updateClock, 1000);

// Inisialisasi chart kosong dulu
function initUptimeChart() {
    const ctx = $('uptimeChart');
    if (!ctx || uptimeChart) return;
    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(23, 69, 165, 0.8)');
    gradient.addColorStop(1, 'rgba(23, 69, 165, 0.1)');
    uptimeChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['H-6', 'H-5', 'H-4', 'H-3', 'H-2', 'Kemarin', 'Hari Ini'], datasets: [{ label: 'Jam Operasi', data: [0,0,0,0,0,0,0], backgroundColor: gradient, borderRadius: 6, barPercentage: 0.5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { borderDash: [4,4] } }, x: { grid: { display: false } } } }
    });
}

// Kesehatan sistem
function calculateHealth(temp, fuel, isRunning, volt) {
    let score = 100;
    if (temp > 95) score -= 30; else if (temp > 85) score -= 10;
    if (fuel < 15) score -= 30; else if (fuel < 25) score -= 15;
    if (!isRunning && volt > 0 && volt < 190) score -= 15;
    return Math.max(0, score);
}

// Tabel maintenance berdasarkan engineHours real
function updateMaintenanceTable(engineHours) {
    const tbody = $('maintenanceList');
    if (!tbody) return;
    let html = '';
    const parts = MAINTENANCE_PARTS.map(part => {
        const hoursUsed = engineHours % part.interval;
        const hoursLeft = part.interval - hoursUsed;
        const daysLeft = Math.ceil(hoursLeft / AVG_HOURS_PER_DAY);
        return { ...part, hoursLeft, daysLeft };
    }).sort((a,b) => a.hoursLeft - b.hoursLeft);

    parts.forEach(part => {
        let cClass = 'cond-good', cText = 'Bagus';
        if (part.hoursLeft < 50) { cClass = 'cond-bad'; cText = 'Segera Ganti'; }
        else if (part.hoursLeft < 100) { cClass = 'cond-warn'; cText = 'Mulai Aus'; }
        html += `<tr><td><strong>${part.name}</strong></td><td>${part.hoursLeft.toFixed(0)} Jam <small>(~${part.daysLeft} Hari)</small></td><td><span class="cond-badge ${cClass}">${cText}</span></td><td>${formatRupiah(part.cost)}</td></tr>`;
    });
    tbody.innerHTML = html;
}

// Notifikasi berdasarkan kondisi real
function renderAlerts(isRunning, fuel, temp, powerKw) {
    const box = $('publicAlerts');
    if (!box) return;
    let html = '';
    if (temp > 95) html += `<div class="feed-item danger"><strong><i class="fas fa-fire"></i> Mesin Overheat!</strong> Sistem didinginkan otomatis.</div>`;
    if (fuel < 20) html += `<div class="feed-item warn"><strong><i class="fas fa-gas-pump"></i> BBM Menipis (<20%).</strong> Teknisi siap mengisi.</div>`;
    if (powerKw > 15) html += `<div class="feed-item warn"><strong><i class="fas fa-bolt"></i> Beban Listrik Puncak.</strong> Warga diimbau mengurangi daya tinggi.</div>`;
    if (!html) {
        html += `<div class="feed-item info"><strong><i class="fas fa-shield-check"></i> Kondisi Ideal.</strong> Tidak ada anomali sistem.</div>`;
        if (isRunning) html += `<div class="feed-item info"><strong><i class="fas fa-cog fa-spin"></i> Genset Beroperasi.</strong> Mengamankan kelistrikan area.</div>`;
    }
    box.innerHTML = html;
}

// Ambil total jam operasi dari histori (real)
async function fetchTotalEngineHours() {
    try {
        const res = await fetch('/api/generator-active-time/stats?hours=8760'); // 1 tahun
        const json = await res.json();
        if (json.success && json.data?.totalDurationHours) {
            currentEngineHours = json.data.totalDurationHours;
        } else {
            currentEngineHours = 1200; // fallback tidak akan dipakai karena data real akan menggantikan
        }
    } catch(e) { console.warn('Gagal ambil engine hours:', e); currentEngineHours = 1200; }
}

// Ambil weekly uptime (7 hari terakhir) dari histori aktif
async function fetchWeeklyUptime() {
    try {
        const now = new Date();
        const endDate = now.toISOString().split('T')[0];
        const startDate = new Date(now.getTime() - 6*24*3600*1000).toISOString().split('T')[0];
        const res = await fetch(`/api/generator-active-time/history?startDate=${startDate}&endDate=${endDate}&limit=1000`);
        const json = await res.json();
        if (!json.success || !Array.isArray(json.data)) return null;
        
        const dailyMap = new Map(); // key: YYYY-MM-DD
        for (const row of json.data) {
            const started = new Date(row.startedAt);
            const ended = row.endedAt ? new Date(row.endedAt) : new Date();
            const durationHours = (ended - started) / 3600000;
            const dateKey = started.toISOString().split('T')[0];
            dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + durationHours);
        }
        const last7 = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i*24*3600*1000);
            const key = d.toISOString().split('T')[0];
            last7.push(dailyMap.get(key) || 0);
        }
        return last7;
    } catch(e) { console.warn('Gagal ambil weekly uptime:', e); return null; }
}

// Update dashboard utama dengan data realtime dari server
async function updateDashboard(data) {
    const rpm = Number(data.rpm) || 0;
    const volt = Number(data.volt) || 0;
    const current = Number(data.current || data.amp) || 0;
    const fuel = Number(data.fuel) || 0;
    const temp = Number(data.coolant || data.temp || data.coolant_temp) || 0;
    const powerKw = (volt * current) / 1000;
    const isRunning = String(data.status || '').toLowerCase() === 'running' || rpm > 50;
    const syncText = String(data.sync || '').toUpperCase();
    const isPLN = syncText.includes('ON-GRID') || syncText.includes('PLN') || (volt > 200 && !isRunning);
    
    // Hero card styling
    const hero = $('heroCard');
    if (hero) {
        hero.className = 'b-card hero-card';
        if (isRunning) hero.classList.add('genset');
        else if (isPLN) hero.classList.add('pln');
        else hero.classList.add('off');
    }
    $('powerSourceText').innerText = isRunning ? 'Pasokan GENSET' : (isPLN ? 'Pasokan PLN' : 'PEMADAMAN');
    $('powerDescText').innerText = isRunning ? 'PLN Padam. Genset beroperasi penuh.' : (isPLN ? 'Jaringan utama normal.' : 'Menunggu penyalaan genset otomatis.');
    $('syncStatusText').innerHTML = isRunning ? '<i class="fas fa-plug"></i> Beroperasi Mandiri' : (isPLN ? '<i class="fas fa-link"></i> Tersinkron (ON-GRID)' : '<i class="fas fa-unlink"></i> Terputus');
    
    // Fuel
    $('fuelPct').innerText = fuel.toFixed(0);
    $('fuelBar').style.width = `${fuel}%`;
    $('fuelBar').style.background = fuel > 25 ? 'var(--secondary)' : 'var(--danger)';
    const cRate = powerKw > 0.9 ? AVG_CONSUMPTION_LPH * 1.3 : AVG_CONSUMPTION_LPH;
    $('fuelEstText').innerText = isRunning ? ((fuel/100*TANK_CAPACITY_L)/cRate).toFixed(1) + ' Jam' : 'Standby';
    
    // Power
    $('powerKw').innerText = powerKw.toFixed(1);
    const pPill = $('powerStatusText');
    if (powerKw > 15) { pPill.innerText='Beban Kritis'; pPill.style.background='#fef2f2'; pPill.style.color='#ef4444'; }
    else if (powerKw > 0) { pPill.innerText='Beban Wajar'; pPill.style.background='#eff6ff'; pPill.style.color='#1745a5'; }
    else { pPill.innerText='Sistem Idle'; pPill.style.background='var(--bg-page)'; pPill.style.color='var(--muted)'; }
    
    // Health
    const health = calculateHealth(temp, fuel, isRunning, volt);
    $('healthScoreTxt').innerText = `${health}%`;
    const hBox = $('healthCircleBox');
    let hColor = 'var(--secondary)', hDesc = 'Sistem Prima';
    if (health < 50) { hColor = 'var(--danger)'; hDesc = 'Perlu Cek'; }
    else if (health < 80) { hColor = 'var(--warning)'; hDesc = 'Perhatian'; }
    if (hBox) hBox.style.borderTopColor = hColor;
    $('healthScoreTxt').style.color = hColor;
    $('healthDescTxt').innerText = hDesc;
    
    // Maintenance (pakai engineHours yang sudah diambil)
    updateMaintenanceTable(currentEngineHours);
    renderAlerts(isRunning, fuel, temp, powerKw);
    
    // Biaya operasional harian estimasi
    const dailyCost = (data.todayActiveHours || (isRunning ? 0.5 : 0)) * AVG_CONSUMPTION_LPH * FUEL_PRICE_PER_LITER;
    $('dailyCost').innerText = formatRupiah(dailyCost);
    
    // Chart uptime (update setiap kali data terbaru)
    if (uptimeChart) {
        const weekly = await fetchWeeklyUptime();
        if (weekly) uptimeChart.data.datasets[0].data = weekly;
        uptimeChart.update();
    }
}

// Polling data terbaru dari server
async function fetchData() {
    try {
        const [latestRes, statsRes] = await Promise.all([
            fetch('/api/engine-data/latest'),
            fetch('/api/generator-active-time/stats?hours=8760')
        ]);
        const latestJson = await latestRes.json();
        const statsJson = await statsRes.json();
        
        if (statsJson.success && statsJson.data?.totalDurationHours) {
            currentEngineHours = statsJson.data.totalDurationHours;
        }
        if (latestJson.success && latestJson.data) {
            await updateDashboard(latestJson.data);
        }
    } catch(e) { console.warn('Fetch error:', e); }
}

// Inisialisasi
window.addEventListener('DOMContentLoaded', async () => {
    updateClock();
    initUptimeChart();
    await fetchTotalEngineHours();    // ambil total jam operasi
    await fetchData();                // langsung tampilkan data pertama
    setInterval(fetchData, 5000);     // polling tiap 5 detik (realtime)
    setInterval(() => fetchTotalEngineHours(), 60000); // update jam operasi tiap menit
});