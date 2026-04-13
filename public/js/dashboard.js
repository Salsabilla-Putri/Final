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

// --- MODIFIKASI CHART INI ---
async function initChart() {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if(!ctx) return;
    
    try {
        const res = await fetch(`${API_URL}/engine-data/history?hours=168`);
        const json = await res.json();
        let labels=[], dataPoints=[];

        if(json.success && json.data.length) {
            const days = {}; const today = new Date();
            // Siapkan 7 hari terakhir
            for(let i=6; i>=0; i--) { 
                const d=new Date(); d.setDate(today.getDate()-i); 
                days[d.toDateString()]=0; 
            }
            
            const sorted = json.data.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
            for(let i=1; i<sorted.length; i++) {
                if(sorted[i].rpm > 0) {
                    const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i-1].timestamp))/1000;
                    // Filter noise data (gap < 5 menit dianggap continuous)
                    if(diff>0 && diff<300) {
                         days[new Date(sorted[i].timestamp).toDateString()] += (diff/3600);
                    }
                }
            }
            
            labels = Object.keys(days).map(k=>new Date(k).toLocaleDateString('id-ID',{weekday:'short'})); // Sen, Sel, Rab...
            dataPoints = Object.values(days);
            
            // Update Text "Today's Active"
            const tVal = days[today.toDateString()]||0;
            const h=Math.floor(tVal); const m=Math.round((tVal-h)*60);
            const tEl = document.getElementById('engToday');
            if(tEl) tEl.innerText = `${h}h ${m}m`;
        }

        if(activeChart) activeChart.destroy();
        
        activeChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels.length ? labels : ['Min','Sen','Sel','Rab','Kam','Jum','Sab'],
                datasets: [{ 
                    label: 'Active Hours', 
                    data: dataPoints.length ? dataPoints : [0,0,0,0,0,0,0], 
                    backgroundColor: '#1745a5', 
                    borderRadius: 6, // Sedikit lebih bulat
                    barPercentage: 0.6 // Agar batang tidak terlalu gemuk
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                plugins: {
                    legend: { display: false }
                }, 
                scales: {
                    y: { 
                        beginAtZero: true,
                        max: 24, // --- FIX: MAX 24 JAM ---
                        title: {
                            display: true,
                            text: 'Hours'
                        }
                    }, 
                    x: { 
                        grid: { display: false }
                    }
                } 
            }
        });
    } catch(e) { console.error(e); }
}

// ... (Sisa kode init dll tetap sama) ...

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    // HAPUS FETCH SIDEBAR DARI SINI, BIARKAN sidebar.js YANG MENANGANI
    
    setInterval(() => {
        const el = document.getElementById('clock');
        if(el) el.innerText = new Date().toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
    }, 1000);

    updateDashboard();
    initChart();
    setInterval(updateDashboard, 3000);
});