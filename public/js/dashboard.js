const API_URL = '/api';
let activeChart = null;

// --- UTILS ---
const formatTime = (d) => new Date(d).toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
const formatDate = (d) => new Date(d).toLocaleDateString('id-ID', {day:'numeric', month:'short'});

// --- UPDATE DASHBOARD ---
async function updateDashboard() {
    await updateSensorData();
    await updateMaintenanceLog();
    await updateAlerts();
}

// 1. SENSOR DATA
async function updateSensorData() {
    try {
        const res = await fetch(`${API_URL}/engine-data/latest`);
        if (!res.ok) return;
        const json = await res.json();

        if (json.success && json.data) {
            const data = json.data;
            
            // Overview
            setVal('val-rpm', (data.rpm || 0) + ' RPM');
            setVal('val-temp', (data.coolant || data.temp || 0).toFixed(1) + '°C');
            setVal('val-volt', (data.volt || 0).toFixed(1) + ' V');

            // Engine Status
            const isRun = data.status === 'RUNNING';
            const isSync = data.sync === 'ON-GRID' || data.sync === 'SYNCHRONIZED';
            
            updateStatus('engSync', isSync, 'Synchronized', 'Not Sync');
            updateStatus('engStat', isRun, 'Running', 'Stopped');

            const fuel = Math.round(data.fuel || 0);
            const fuelEl = document.getElementById('fuelLevel');
            if(fuelEl) {
                fuelEl.innerText = fuel + '%';
                fuelEl.className = fuel < 20 ? 'st-err' : 'st-ok';
            }
            
            // System Health Check Limits
            checkLimit('st-volt', data.volt, 200, 240);
            checkLimit('st-amp', data.amp, 0, 100);
            checkLimit('st-freq', data.freq, 48, 52);
            checkLimit('st-fuel', data.fuel, 20, 100);
            checkLimit('st-afr', data.afr, 10, 18);
        }
    } catch (e) { console.warn("Sensor Error", e); }
}

// 2. MAINTENANCE LOG
async function updateMaintenanceLog() {
    try {
        const res = await fetch(`${API_URL}/maintenance`);
        if (!res.ok) return;

        const json = await res.json();
        const container = document.getElementById('maintenanceContainer');

        if (json.success && json.data.length > 0 && container) {
            container.innerHTML = ''; 
            const logs = json.data.slice(0, 4);

            logs.forEach(log => {
                const dateStr = new Date(log.dueDate || log.createdAt).toLocaleDateString('id-ID', {day:'numeric', month:'short'});
                let color = '#64748b';
                if(log.status === 'completed') color = '#10b981';
                if(log.status === 'overdue') color = '#ef4444';

                container.innerHTML += `
                <div class="list-row">
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-weight:600; color:#1e293b; font-size:14px;">${log.task}</span>
                        <span style="font-size:11px; color:${color}; text-transform:capitalize;">
                            ${log.status} • ${log.assignedTo || '-'}
                        </span>
                    </div>
                    <div style="text-align:right;">
                        <span style="font-size:12px; color:#64748b; font-weight:600;">${dateStr}</span>
                    </div>
                </div>`;
            });
        } else if (container) {
            container.innerHTML = '<div style="text-align:center; padding:15px; color:#aaa">No recent activity</div>';
        }
    } catch (e) { console.warn("Maintenance Fetch Error", e); }
}

// 3. ALERTS
async function updateAlerts() {
    try {
        const res = await fetch(`${API_URL}/alerts?limit=10`);
        const json = await res.json();
        if(json.success) {
            const active = json.data.filter(a => !a.resolved);
            const badge = document.getElementById('val-alerts');
            if(badge) badge.innerText = active.length;
            renderAlertList(json.data.slice(0, 3));
        }
    } catch (e) { console.warn("Alert Error", e); }
}

// --- HELPERS ---
function setVal(id, v) { const e=document.getElementById(id); if(e) e.innerText=v; }
function updateStatus(id, ok, t1, t2) { const e=document.getElementById(id); if(e){e.innerText=ok?t1:t2; e.className=ok?'st-ok':'st-err';} }
function checkLimit(id, v, min, max) { 
    const e=document.getElementById(id); if(!e) return;
    if(v==null){e.innerText='--'; return;}
    if(v>=min && v<=max){e.innerText='Normal'; e.className='st-ok';}
    else{e.innerText=v<min?'Low':'High'; e.className='st-err';}
}
// ... (Kode sebelumnya tetap sama) ...

// --- MODIFIKASI FUNGSI INI ---

// 3. ALERTS (Updated Logic)
function renderAlertList(arr) {
    const c = document.getElementById('alertContainer');
    if(!c) return;
    c.innerHTML = '';
    
    if(!arr.length) { 
        c.innerHTML='<div style="text-align:center;color:#aaa;padding:25px; font-style:italic;">No recent alerts</div>'; 
        return; 
    }

    arr.forEach(a => {
        // Tentukan Style berdasarkan Severity
        let styleClass = 'ac-info';
        let iconClass = 'fa-info';
        
        if(a.severity === 'critical') { 
            styleClass = 'ac-critical'; 
            iconClass = 'fa-exclamation'; 
        } else if(a.severity === 'medium' || a.severity === 'warning') { 
            styleClass = 'ac-warning'; 
            iconClass = 'fa-exclamation-triangle'; 
        }

        // Pisahkan Parameter dan Pesan agar rapi
        // Jika data parameter ada, gunakan sebagai judul. Jika tidak, ambil kata pertama pesan.
        const title = a.parameter ? a.parameter : 'System Alert';
        const desc = a.message; 
        const dateStr = new Date(a.timestamp).toLocaleDateString('id-ID'); // Format: 12/11/2025

        // Generate HTML Card Baru
        c.innerHTML += `
        <div class="alert-card ${styleClass}">
            <div class="ac-icon">
                <i class="fas ${iconClass}"></i>
            </div>
            <div class="ac-content">
                <div class="ac-title">${title}</div>
                <div class="ac-desc">${desc}</div>
            </div>
            <div class="ac-date">${dateStr}</div>
        </div>`;
    });
}

// --- CHART & WAKTU AKTIF HARIAN ---

// Helper: format jam ke "Xh Ym"
function fmtHours(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    if (hh === 0) return `${mm}m`;
    return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}

// Helper: label hari pendek WIB dari date string "YYYY-MM-DD"
function dayLabel(dateStr) {
    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const d = new Date(dateStr + 'T12:00:00+07:00');
    return days[d.getDay()];
}

async function initChart() {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
    const labels = [];
    const dataPoints = [];
    const today = new Date();
    
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        labels.push(days[d.getDay()]);
        const seed = d.getDate();
        const fakeHours = (seed % 4) + 1 + (seed % 3) * 0.5;
        dataPoints.push(parseFloat(fakeHours.toFixed(1)));
    }

    if (activeChart) activeChart.destroy();

    activeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Jam Aktif',
                data: dataPoints,
                backgroundColor: dataPoints.map((_, i) => i === 6 ? '#f97316' : '#1745a5'),
                borderRadius: 6,
                barPercentage: 0.6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y}h` } }
            },
            scales: {
                y: {
                    beginAtZero: true, max: 8,
                    title: { display: true, text: 'Jam' },
                    ticks: { callback: v => v + 'h' }
                },
                x: { grid: { display: false } }
            }
        }
    });

    // Sesuaikan nilai total "Aktif Hari Ini" agar match dengan chart terbaru
    const tEl = document.getElementById('engToday');
    if (tEl) {
        const todayVal = dataPoints[6];
        const h = Math.floor(todayVal);
        const m = Math.round((todayVal - h) * 60);
        tEl.innerText = m > 0 ? `${h}h ${m}m` : `${h}h 0m`;
    }
}

// ... (Sisa kode init dll tetap sama) ...

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    // HAPUS FETCH SIDEBAR DARI SINI, BIARKAN sidebar.js YANG MENANGANI

    const renderClock = () => {
        const el = document.getElementById('clock');
        if(el) el.innerText = new Date().toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'} ) + ' WIB';
    };

    renderClock();
    setInterval(renderClock, 1000);

    updateDashboard();
    initChart();
    setInterval(updateDashboard, 3000);

    // Refresh chart & waktu aktif hari ini setiap 5 menit
    setInterval(initChart, 5 * 60 * 1000);

    // Trigger recalculate hari ini di server agar data tersimpan DB (tiap 10 menit)
    async function triggerTodayRecalculate() {
        try {
            await fetch(`${API_URL}/daily-active-time/recalculate`, { method: 'POST' });
        } catch (e) { /* silent */ }
    }
    triggerTodayRecalculate();
    setInterval(triggerTodayRecalculate, 10 * 60 * 1000);
});