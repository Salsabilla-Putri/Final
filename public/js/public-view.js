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

    // 2. HEALTH SCORE
    const healthScore = calculateHealthScore(temp, fuel, isRunning, volt);
    $('healthScoreTxt').innerText = `${healthScore}%`;
    const circle = $('healthCircle');
    circle.setAttribute('stroke-dasharray', `${healthScore}, 100`);
    
    let healthColor = '#10b981'; // Green
    let healthDesc = 'Sistem Prima';
    if (healthScore < 50) { healthColor = '#ef4444'; healthDesc = 'Perlu Perbaikan'; }
    else if (healthScore < 80) { healthColor = '#f59e0b'; healthDesc = 'Perhatian Khusus'; }
    
    circle.style.stroke = healthColor;
    $('healthScoreTxt').style.fill = healthColor;
    $('healthDescTxt').innerText = healthDesc;
    $('healthDescTxt').style.color = healthColor;

    // 3. FUEL & POWER
    $('fuelPct').innerText = fuel.toFixed(0);
    const fuelBar = $('fuelBar');
    fuelBar.style.width = `${fuel}%`;
    fuelBar.style.backgroundColor = fuel > 25 ? 'var(--emerald)' : 'var(--rose)';

    const estConsumption = powerKw > 0.9 ? AVG_CONSUMPTION_LPH * 1.3 : AVG_CONSUMPTION_LPH; 
    const litersLeft = (fuel / 100) * TANK_CAPACITY_L;
    const hoursLeft = estConsumption > 0 ? (litersLeft / estConsumption).toFixed(1) : 0;
    $('fuelEstText').innerText = isRunning ? `${hoursLeft} jam` : 'Siaga Penuh';

    $('powerKw').innerText = powerKw.toFixed(2);
    const powerPill = $('powerStatusText');
    if (powerKw > 15) {
        powerPill.innerText = 'Beban Kritis'; powerPill.style.background = '#fef2f2'; powerPill.style.color = '#ef4444';
    } else if (powerKw > 0) {
        powerPill.innerText = 'Beban Wajar'; powerPill.style.background = '#eff6ff'; powerPill.style.color = '#3b82f6';
    } else {
        powerPill.innerText = 'Tanpa Beban'; powerPill.style.background = '#f1f5f9'; powerPill.style.color = '#64748b';
    }

    // 4. MICRO METRICS (Bars & Text)
    const setMiniMetric = (id, val, strVal, maxVal, isErr) => {
        $(`val${id}`).innerText = strVal;
        const fill = $(`bar${id}`);
        let pct = Math.min((val / maxVal) * 100, 100);
        fill.style.width = `${pct}%`;
        fill.style.backgroundColor = isErr ? 'var(--rose)' : ''; // overrides default CSS color if error
    };

    setMiniMetric('Volt', volt, `${volt.toFixed(0)} V`, 250, volt > 0 && (volt < 200 || volt > 240));
    setMiniMetric('Freq', freq, `${freq.toFixed(1)} Hz`, 60, freq > 0 && (freq < 49 || freq > 51));
    setMiniMetric('Temp', temp, `${temp.toFixed(0)} °C`, 120, temp > 95);
    setMiniMetric('Rpm', rpm, `${rpm.toFixed(0)} RPM`, 2000, rpm > 1600);

    // 5. COST
    const costPerHour = isRunning ? estConsumption * FUEL_PRICE_PER_LITER : 0;
    $('costPerHour').innerText = formatRupiah(costPerHour);
    const todayActiveHours = (data.todayActiveHours) || (isRunning ? 0.5 : 0); 
    $('costDaily').innerText = formatRupiah(todayActiveHours * AVG_CONSUMPTION_LPH * FUEL_PRICE_PER_LITER);

    // 6. ALERTS
    renderAlerts(isRunning, fuel, temp, powerKw);

    // 7. CHART
    if(data.weeklyUptimeHistory && uptimeChart) {
        uptimeChart.data.datasets[0].data = data.weeklyUptimeHistory;
        uptimeChart.update();
    }
}

function renderAlerts(isRunning, fuel, temp, powerKw) {
    const container = $('publicAlerts');
    let alertsHtml = '';

    if (temp > 95) {
        alertsHtml += `<div class="alert-box danger"><i class="fas fa-fire"></i> <div><strong>Mesin Panas (Overheat):</strong> Operasi mungkin dihentikan sementara untuk pendinginan.</div></div>`;
    }
    if (fuel < 20) {
        alertsHtml += `<div class="alert-box warn"><i class="fas fa-gas-pump"></i> <div><strong>BBM Menipis:</strong> Persediaan solar di bawah 20%. Tim teknisi sedang menjadwalkan pengisian.</div></div>`;
    }
    if (powerKw > 15) {
        alertsHtml += `<div class="alert-box warn"><i class="fas fa-bolt"></i> <div><strong>Beban Listrik Tinggi:</strong> Dimohon mematikan AC atau alat elektronik berat agar listrik tidak anjlok.</div></div>`;
    }
    
    if (alertsHtml === '') {
        alertsHtml = `<div class="alert-box info"><i class="fas fa-shield-check"></i> <div><strong>Kondisi Ideal:</strong> Tidak ada anomali terdeteksi. Sistem berjalan lancar.</div></div>`;
        if (isRunning) alertsHtml += `<div class="alert-box info"><i class="fas fa-cog fa-spin"></i> <div><strong>Genset Aktif:</strong> Mengamankan pasokan listrik selama PLN padam.</div></div>`;
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
    const client = mqtt.connect('wss://broker.shiftr.io', { clientId: 'pub-bento-' + Math.random().toString(16).slice(2) });
    
    let liveData = {};
    client.on('connect', () => {
        client.subscribe(['genset/voltage','genset/current','genset/fuel','genset/temp','genset/rpm','genset/status']);
    });

    client.on('message', (topic, payload) => {
        let val = parseFloat(payload.toString());
        if (isNaN(val)) return;
        
        if (topic.includes('voltage')) liveData.volt = val;
        if (topic.includes('current')) liveData.current = val;
        if (topic.includes('fuel')) liveData.fuel = val;
        if (topic.includes('temp')) liveData.temp = val;
        if (topic.includes('rpm')) liveData.rpm = val;
        if (topic.includes('status')) liveData.status = payload.toString();

        updatePublicDashboard(liveData);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    initUptimeChart();
    fetchDashboardData(); 
    setupMQTT(); 
    setInterval(fetchDashboardData, 60000); // Sinkronisasi database
});