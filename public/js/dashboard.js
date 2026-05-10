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

    try {
        // ── 1. Ambil data 7 hari dari DailyActiveTime (DB) ──────────────────
        const [histRes, todayRes] = await Promise.all([
            fetch(`${API_URL}/daily-active-time?days=7`),
            fetch(`${API_URL}/daily-active-time/today`)
        ]);

        // Siapkan map 7 hari terakhir dalam WIB (hari ini s.d. 6 hari lalu)
        const dayMap = {};
        for (let i = 6; i >= 0; i--) {
            const d   = new Date(Date.now() + 7 * 60 * 60 * 1000 - i * 86400000);
            const key = d.toISOString().slice(0, 10);
            dayMap[key] = 0;
        }

        if (histRes.ok) {
            const histJson = await histRes.json();
            if (histJson.success && histJson.data) {
                histJson.data.forEach(r => {
                    if (dayMap.hasOwnProperty(r.date)) dayMap[r.date] = r.activeHours;
                });
            }
        }

        // Hari ini: gunakan data real-time (sesi berjalan belum tersimpan)
        const todayWib = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (todayRes.ok) {
            const todayJson = await todayRes.json();
            if (todayJson.success) {
                dayMap[todayWib] = todayJson.activeHours;

                // Update widget "Aktif Hari Ini"
                const tEl = document.getElementById('engToday');
                if (tEl) tEl.innerText = fmtHours(todayJson.activeHours);
            }
        }

        const labels     = Object.keys(dayMap).map(dayLabel);
        const dataPoints = Object.values(dayMap);
        const weeklySum  = dataPoints.reduce((a, b) => a + b, 0);

        // Update total mingguan jika ada elemennya
        const wkEl = document.getElementById('weeklyActiveTotal');
        if (wkEl) wkEl.innerText = fmtHours(weeklySum);

        // ── 2. Render chart ──────────────────────────────────────────────────
        if (activeChart) activeChart.destroy();

        const colors = dataPoints.map((_, i) =>
            Object.keys(dayMap)[i] === todayWib ? '#f97316' : '#1745a5'
        );

        activeChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Jam Aktif',
                    data: dataPoints,
                    backgroundColor: colors,
                    borderRadius: 6,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` ${fmtHours(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 24,
                        title: { display: true, text: 'Jam' },
                        ticks: { callback: v => v + 'h' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });

    } catch (e) {
        console.error('initChart error:', e);

        // Fallback: hitung dari raw history jika API baru belum ada
        try {
            const res  = await fetch(`${API_URL}/engine-data/history?hours=168`);
            const json = await res.json();
            let labels = [], dataPoints = [];

            if (json.success && json.data.length) {
                const days  = {};
                const today = new Date();
                for (let i = 6; i >= 0; i--) {
                    const d = new Date(); d.setDate(today.getDate() - i);
                    days[d.toDateString()] = 0;
                }
                const sorted = json.data.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                for (let i = 1; i < sorted.length; i++) {
                    if (sorted[i].rpm > 0) {
                        const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;
                        if (diff > 0 && diff < 300)
                            days[new Date(sorted[i].timestamp).toDateString()] += (diff / 3600);
                    }
                }
                labels     = Object.keys(days).map(k => new Date(k).toLocaleDateString('id-ID', { weekday: 'short' }));
                dataPoints = Object.values(days);

                const tVal = days[today.toDateString()] || 0;
                const tEl  = document.getElementById('engToday');
                if (tEl) tEl.innerText = fmtHours(tVal);
            }

            if (activeChart) activeChart.destroy();
            activeChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels.length ? labels : ['Min','Sen','Sel','Rab','Kam','Jum','Sab'],
                    datasets: [{ label: 'Jam Aktif', data: dataPoints.length ? dataPoints : Array(7).fill(0), backgroundColor: '#1745a5', borderRadius: 6, barPercentage: 0.6 }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 24 }, x: { grid: { display: false } } } }
            });
        } catch (fe) { console.error('Fallback chart error:', fe); }
    }
}

// ... (Sisa kode init dll tetap sama) ...

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    // HAPUS FETCH SIDEBAR DARI SINI, BIARKAN sidebar.js YANG MENANGANI

    const renderClock = () => {
        const el = document.getElementById('clock');
        if(!el) return;

        const now = new Date();
        let hour = now.getHours();
        const minute = String(now.getMinutes()).padStart(2, '0');
        const ampm = hour >= 12 ? 'PM' : 'AM';

        hour = hour % 12 || 12;
        el.innerText = `${String(hour).padStart(2, '0')}:${minute} ${ampm}`;
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