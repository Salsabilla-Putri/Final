'use strict';

// --- CONFIGURATION ---
const API_BASE = '/api';
const TANK_CAPACITY_L = 50;
const AVG_CONSUMPTION_LPH = 2.5;

let uptimeChart = null;

// --- UTILITIES ---
const $ = id => document.getElementById(id);
const formatRupiah = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);
const formatDate = (dateString) => new Date(dateString).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const formatTime = (dateString) => new Date(dateString).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

// --- CLOCK CONTROLLER ---
function updateClock() {
    const el = $('realtimeClock');
    if (el) el.innerText = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
}

// --- DOM UPDATERS ---
function updateSystemMetrics(data) {
    const rpm = Number(data.rpm) || 0;
    const volt = Number(data.volt) || 0;
    const current = Number(data.amp) || 0;
    const fuel = Number(data.fuel) || 0;
    const temp = Number(data.temp || data.coolant) || 0;
    const powerKw = Number(data.power) || ((volt * current) / 1000) || 0;

    const isRunning = String(data.status).toUpperCase() === 'RUNNING' || rpm > 0;
    const isGrid = String(data.sync).toUpperCase() === 'ON-GRID' || String(data.sync).toUpperCase() === 'SYNCHRONIZED';

    // 1. Update Hero Card
    const hero = $('heroCard');
    hero.className = 'b-card hero-card'; // reset
    if (isRunning) {
        hero.classList.add('genset');
        $('powerSourceText').innerText = 'Pasokan GENSET';
        $('powerDescText').innerText = 'Sistem kelistrikan area saat ini disuplai penuh oleh Generator.';
        $('syncStatusText').innerHTML = '<i class="fas fa-plug"></i> Beroperasi Mandiri';
    } else if (isGrid) {
        hero.classList.add('pln');
        $('powerSourceText').innerText = 'Pasokan PLN (Utama)';
        $('powerDescText').innerText = 'Jaringan kelistrikan utama beroperasi normal tanpa kendala.';
        $('syncStatusText').innerHTML = '<i class="fas fa-link"></i> Tersinkron (ON-GRID)';
    } else {
        hero.classList.add('off');
        $('powerSourceText').innerText = 'PEMADAMAN';
        $('powerDescText').innerText = 'Menunggu prosedur penyalaan genset otomatis.';
        $('syncStatusText').innerHTML = '<i class="fas fa-unlink"></i> Terputus';
    }

    // 2. Update Fuel
    $('fuelPct').innerText = fuel.toFixed(0);
    $('fuelBar').style.width = `${Math.min(100, Math.max(0, fuel))}%`;
    $('fuelBar').style.background = fuel > 20 ? 'var(--secondary)' : 'var(--danger)';
    
    const estHours = isRunning && fuel > 0 ? (fuel / 100 * TANK_CAPACITY_L) / AVG_CONSUMPTION_LPH : 0;
    $('fuelEstText').innerText = isRunning ? `${estHours.toFixed(1)} Jam` : 'Standby';

    // 3. Update Power & Load
    $('powerKw').innerText = powerKw.toFixed(1);
    const pPill = $('powerStatusText');
    if (powerKw > 15) {
        pPill.innerText = 'Beban Kritis'; pPill.className = 'status-pill danger';
    } else if (powerKw > 0) {
        pPill.innerText = 'Beban Wajar'; pPill.className = 'status-pill info';
    } else {
        pPill.innerText = 'Sistem Idle'; pPill.className = 'status-pill neutral';
    }

    // 4. Update Health
    let score = 100;
    if (temp > 95) score -= 30; else if (temp > 85) score -= 10;
    if (fuel < 15) score -= 30; else if (fuel < 25) score -= 15;
    if (!isRunning && volt > 0 && volt < 190) score -= 15;
    score = Math.max(0, score);

    $('healthScoreTxt').innerText = `${score}%`;
    const hBox = $('healthCircleBox');
    if (score < 50) {
        hBox.style.borderTopColor = 'var(--danger)';
        $('healthScoreTxt').style.color = 'var(--danger)';
        $('healthDescTxt').innerText = 'Perlu Pemeriksaan';
    } else if (score < 80) {
        hBox.style.borderTopColor = 'var(--warning)';
        $('healthScoreTxt').style.color = 'var(--warning)';
        $('healthDescTxt').innerText = 'Perhatian Khusus';
    } else {
        hBox.style.borderTopColor = 'var(--secondary)';
        $('healthScoreTxt').style.color = 'var(--secondary)';
        $('healthDescTxt').innerText = 'Sistem Prima';
    }
}

function updateAlertsFeed(alerts) {
    const box = $('publicAlerts');
    if (!alerts || alerts.length === 0) {
        box.innerHTML = `<div class="feed-item info"><i class="fas fa-shield-check"></i> <strong>Sistem Stabil.</strong> Tidak ada peringatan aktif.</div>`;
        return;
    }

    let html = '';
    alerts.filter(a => !a.resolved).slice(0, 5).forEach(alert => {
        let styleClass = 'info', icon = 'fa-info-circle';
        if (alert.severity === 'critical') { styleClass = 'danger'; icon = 'fa-exclamation-triangle'; }
        else if (alert.severity === 'high' || alert.severity === 'medium') { styleClass = 'warn'; icon = 'fa-bell'; }
        
        html += `
            <div class="feed-item ${styleClass}">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <strong><i class="fas ${icon}"></i> ${alert.parameter ? alert.parameter.toUpperCase() : 'SISTEM'}</strong>
                    <small style="opacity:0.7">${formatTime(alert.timestamp)}</small>
                </div>
                <div>${alert.message}</div>
            </div>`;
    });
    
    if(!html) html = `<div class="feed-item info"><i class="fas fa-shield-check"></i> <strong>Sistem Stabil.</strong> Tidak ada peringatan aktif.</div>`;
    box.innerHTML = html;
}

function updateMaintenanceTable(tasks) {
    const tbody = $('maintenanceList');
    if (!tasks || tasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Belum ada data jadwal perawatan.</td></tr>';
        return;
    }

    const pendingTasks = tasks.filter(t => t.status !== 'completed').sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate)).slice(0, 5);
    if (pendingTasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted"><i class="fas fa-check-circle text-green"></i> Semua perawatan telah selesai.</td></tr>';
        return;
    }

    let html = '';
    let totalCost = 0;
    const now = new Date();
    now.setHours(0,0,0,0);

    pendingTasks.forEach(task => {
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0,0,0,0);
        
        const daysLeft = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
        let cClass = 'cond-good', cText = 'Terjadwal';
        
        if (daysLeft < 0) { cClass = 'cond-bad'; cText = 'Terlambat'; }
        else if (daysLeft <= 7) { cClass = 'cond-warn'; cText = 'Segera'; }

        totalCost += (task.cost || 0);

        html += `
            <tr>
                <td><strong>${task.task}</strong><br><small class="text-muted" style="text-transform:capitalize;">${task.type || 'Preventive'}</small></td>
                <td>${formatDate(task.dueDate)} <br><small class="text-muted">(${daysLeft < 0 ? 'Overdue' : daysLeft + ' Hari Lagi'})</small></td>
                <td><span class="cond-badge ${cClass}">${cText}</span></td>
                <td>${formatRupiah(task.cost || 0)}</td>
            </tr>`;
    });

    tbody.innerHTML = html;
    $('totalCost').innerText = formatRupiah(totalCost);
}

function processAndRenderChart(historyRows) {
    const dailyUptime = Array(7).fill(0); // [H-6, H-5, ..., Today]
    const today = new Date();
    today.setHours(0,0,0,0);

    if (historyRows && historyRows.length > 0) {
        historyRows.forEach(row => {
            const start = new Date(row.startedAt);
            const end = row.endedAt ? new Date(row.endedAt) : new Date();
            const startDay = new Date(start);
            startDay.setHours(0,0,0,0);
            
            const diffDays = Math.floor((today - startDay) / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays < 7) {
                const index = 6 - diffDays;
                const durationHours = (end - start) / (1000 * 60 * 60);
                dailyUptime[index] += durationHours;
            }
        });
    }

    const dataPoints = dailyUptime.map(h => Number(h.toFixed(2)));

    const ctx = $('uptimeChart');
    if (!ctx) return;

    if (!uptimeChart) {
        let gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.8)'); 
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0.1)');

        uptimeChart = new Chart(ctx, {
            type: 'bar',
            data: { 
                 labels: ['H-6', 'H-5', 'H-4', 'H-3', 'H-2', 'Kemarin', 'Hari Ini'],
                 datasets: [{
                     label: 'Jam Operasi (h)',
                     data: dataPoints,
                     backgroundColor: gradient,
                     borderRadius: 6,
                     barPercentage: 0.5
                 }] 
             },
            options: { 
                 responsive: true, maintainAspectRatio: false,
                 plugins: { legend: { display: false } },
                 scales: { 
                     y: { beginAtZero: true, suggestedMax: 6, grid: { borderDash: [4, 4] } },
                     x: { grid: { display: false } }
                 }
            }
        });
    } else {
        uptimeChart.data.datasets[0].data = dataPoints;
        uptimeChart.update();
    }
}

// --- DATA FETCHING & ORCHESTRATION ---
async function fetchDashboardData() {
    try {
        const [latestRes, alertsRes, maintRes, historyRes] = await Promise.all([
            fetch(`${API_BASE}/engine-data/latest`).then(r => r.ok ? r.json() : {}),
            fetch(`${API_BASE}/alerts?limit=10`).then(r => r.ok ? r.json() : {}),
            fetch(`${API_BASE}/maintenance`).then(r => r.ok ? r.json() : {}),
            fetch(`${API_BASE}/generator-active-time/history?limit=100`).then(r => r.ok ? r.json() : {})
        ]);

        if (latestRes.success && latestRes.data) updateSystemMetrics(latestRes.data);
        if (alertsRes.success) updateAlertsFeed(alertsRes.data);
        if (maintRes.success) updateMaintenanceTable(maintRes.data);
        if (historyRes.success) processAndRenderChart(historyRes.data);
        
        // Update Timestamp
        $('lastUpdated').innerText = 'Diperbarui: ' + new Date().toLocaleTimeString('id-ID');

    } catch (error) {
        console.error("Dashboard fetch error:", error);
    }
}

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
    updateClock();
    setInterval(updateClock, 1000);
    
    // Initial fetch
    fetchDashboardData();
    
    // Poll DB data regularly for public view
    setInterval(fetchDashboardData, 15000);
});