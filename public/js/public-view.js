'use strict';
let activeChart = null;

// Update clock
function updateClock() {
    const el = document.getElementById('liveClock');
    if (el) {
        const now = new Date();
        el.innerText = now.toLocaleTimeString('id-ID', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        }) + ' WIB';
    }
}

// Update user info from localStorage
function updateUserInfo() {
    const username = localStorage.getItem('username') || 'Pengguna';
    
    const topbarSpan = document.querySelector('#user-btn span');
    const heroSpan = document.getElementById('welcome-user');
    
    if (topbarSpan) topbarSpan.innerText = username;
    if (heroSpan) heroSpan.innerText = username;
}

// Fungsi logout
function logout() {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userRole');
    localStorage.removeItem('hasLoginSession');
    localStorage.removeItem('username');
    window.location.href = 'login.html';
}

// Fetch data from API
async function fetchDashboardData() {
    try {
        // Fetch latest engine data
        const engineRes = await fetch('/api/engine-data/latest');
        const engineData = await engineRes.json();
        
        if (engineData.success && engineData.data) {
            updateOverviewCards(engineData.data);
            updateOperationsSection(engineData.data);
        }
        
        // Fetch public dashboard data
        const dashRes = await fetch('/api/public/dashboard');
        const dashData = await dashRes.json();
        
        if (dashData.success && dashData.data) {
            updateAnalyticsSection(dashData.data);
            updatePerformanceSection(dashData.data);
        }
        
        // Fetch alerts
        const alertsRes = await fetch('/api/alerts?limit=10');
        const alertsData = await alertsRes.json();
        
        if (alertsData.success) {
            updateAlertsSection(alertsData.data);
        }
        
        // Fetch specifications
        const specsRes = await fetch('/api/generator-specs');
        const specsData = await specsRes.json();
        
        if (specsData.success) {
            updateSpecificationsSection(specsData.data);
        }
        
        // Fetch active time history
        const activeTimeRes = await fetch('/api/generator-active-time/history?limit=30');
        const activeTimeData = await activeTimeRes.json();
        
        if (activeTimeData.success) {
            updateRecentActivity(activeTimeData.data);
            updateActiveTimeChart(activeTimeData.data);
        }
        
        // Fetch maintenance data
        const maintenanceRes = await fetch('/api/maintenance');
        const maintenanceData = await maintenanceRes.json();
        
        if (maintenanceData.success) {
            updateMaintenanceSection(maintenanceData.data);
        }
        
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

function updateOverviewCards(data) {
    const rpm = data.rpm || 0;
    const temp = data.coolant || data.temp || 0;
    const volt = data.volt || 0;
    
    document.getElementById('val-rpm').innerText = rpm + ' RPM';
    document.getElementById('val-temp').innerText = temp + '°C';
    document.getElementById('val-volt').innerText = volt + ' V';
    
    // Update active alerts count
    fetch('/api/alerts?limit=100')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const activeCount = data.data.filter(a => !a.resolved).length;
                document.getElementById('val-alerts').innerText = activeCount;
            }
        });
}

function updateOperationsSection(data) {
    document.getElementById('engSync').innerText = data.sync || '--';
    document.getElementById('engStat').innerText = data.status || '--';
    document.getElementById('fuelLevel').innerText = (data.fuel || 0) + '%';
    
    // Update System Health data
    document.getElementById('st-volt').innerText = (data.volt || '--') + ' V';
    document.getElementById('st-fuel').innerText = (data.fuel || '--') + '%';
    
    // Calculate today's active time
    fetch('/api/generator-active-time/stats?hours=24')
        .then(res => res.json())
        .then(statsData => {
            if (statsData.success && statsData.data) {
                const hours = Math.floor(statsData.data.totalDurationHours || 0);
                const minutes = Math.floor(((statsData.data.totalDurationHours || 0) - hours) * 60);
                document.getElementById('engToday').innerText = `${hours}h ${minutes}m`;
            }
        });
    
    // System health score
    const health = calculateHealth(data);
    const healthScore = document.getElementById('healthScore');
    if (healthScore) {
        healthScore.innerText = health + '%';
        healthScore.style.color = health > 80 ? '#10b981' : health > 50 ? '#f59e0b' : '#ef4444';
    }
    const warningItems = [];
    const temp = data.coolant || data.temp || 0;
    if (temp > 95) warningItems.push({ name: 'Coolant Temperature', level: 'danger' });
    else if (temp > 85) warningItems.push({ name: 'Coolant Temperature', level: 'warn' });
    if ((data.fuel || 0) < 20) warningItems.push({ name: 'Fuel Level', level: 'warn' });
    if ((data.volt || 0) < 190 || (data.volt || 0) > 250) warningItems.push({ name: 'Voltage', level: 'danger' });

    const healthContainer = document.getElementById('systemHealthContainer');
    if (healthContainer) {
        const warningHTML = warningItems.length
            ? warningItems.map((item) => `<span class="status-pill ${item.level}">${item.name}</span>`).join('')
            : '<span class="status-pill ok">Semua komponen aman</span>';
        healthContainer.innerHTML = `
            <div style="font-size: 3rem; font-weight: 700; color: ${health > 80 ? '#10b981' : health > 50 ? '#f59e0b' : '#ef4444'};" id="healthScore">${health}%</div>
            <div style="color: #6b7280; font-size: 0.9rem;">Health Score</div>
            <div class="health-warning-wrap">${warningHTML}</div>
        `;
    }
}

function calculateHealth(data) {
    let health = 100;
    const temp = data.coolant || data.temp || 0;
    const fuel = data.fuel || 0;
    const volt = data.volt || 0;
    
    if (temp > 95) health -= 30;
    else if (temp > 85) health -= 15;
    if (fuel < 20) health -= 20;
    if (volt < 190 || volt > 250) health -= 15;
    
    return Math.max(0, Math.min(100, health));
}

function updateAnalyticsSection(data) {
    // Update chart if exists
    if (data.activeTimeHistory && window.activeChart) {
        // Update chart data
    }
}

function updateAlertsSection(alerts) {
    const container = document.getElementById('alertContainer');
    if (!container) return;
    
    if (!alerts || alerts.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa">No recent alerts</div>';
        return;
    }
    
    container.innerHTML = alerts.slice(0, 3).map(alert => `
        <div class="alert-item ${alert.severity === 'critical' ? '' : (alert.severity === 'high' ? 'warning' : 'info')}">
            <div class="alert-time">
                ${new Date(alert.timestamp).toLocaleString('id-ID')}
            </div>
            <div class="alert-message">
                ${alert.message}
            </div>
            <div class="alert-status ${alert.resolved ? 'resolved' : 'active'}">
                ${alert.resolved ? '✓ Resolved' : '⚠ Active'}
            </div>
        </div>
    `).join('');
}

function updateRecentActivity(activities) {
    const container = document.getElementById('recentActivityContainer');
    if (!container) return;
    
    if (!activities || activities.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa">No recent activity</div>';
        return;
    }
    
    container.innerHTML = activities.slice(0, 4).map(activity => `
        <div class="activity-item">
            <div class="activity-time">
                ${new Date(activity.startedAt).toLocaleString('id-ID')}
            </div>
            <div class="activity-desc">
                Engine ${activity.endedAt ? 'was active' : 'currently running'} 
                ${activity.durationMs ? `for ${Math.floor(activity.durationMs / 3600000)}h ${Math.floor((activity.durationMs % 3600000) / 60000)}m` : ''}
            </div>
        </div>
    `).join('');
}

function updatePerformanceSection(data) {
    if (data.parameters) {
        const params = data.parameters;
        const status = (value, low, high) => {
            if (value == null) return { text: 'Tidak ada data', cls: 'muted' };
            if (value < low) return { text: 'Rendah', cls: 'warn' };
            if (value > high) return { text: 'Tinggi', cls: 'danger' };
            return { text: 'Aman/Normal', cls: 'ok' };
        };
        const setStatus = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.className = `status-pill ${val.cls}`;
            el.innerText = val.text;
        };

        setStatus('perf-volt', status(params.voltage?.value, 200, 240));
        setStatus('perf-fuel', status(params.fuel?.percent, 20, 100));
        setStatus('perf-temp', status(params.temperature?.value, 40, 90));
        setStatus('perf-amp', status(params.current?.value, 0, 100));
        setStatus('perf-freq', status(params.frequency?.value, 48, 52));
    }
}


function updateSpecificationsSection(specs) {
    const genContainer = document.getElementById('generatorSpecContainer');
    if (genContainer && specs) {
        genContainer.innerHTML = `
            <ul class="spec-list">
                <li><span>Merk</span><span>${specs.merk || '--'}</span></li>
                <li><span>Tipe</span><span>${specs.tipe || '--'}</span></li>
                <li><span>Daya Maks</span><span>${specs.dayaMaks || '--'} kW</span></li>
                <li><span>Tegangan</span><span>${specs.tegangan || '--'} V</span></li>
                <li><span>Frekuensi</span><span>${specs.frekuensi || '--'} Hz</span></li>
                <li><span>Tipe Mesin</span><span>${specs.tipeMesin || '--'}</span></li>
                <li><span>Kapasitas Mesin</span><span>${specs.kapasitasMesin || '--'}</span></li>
                <li><span>Kapasitas Tangki</span><span>${specs.kapasitasTangki || '--'} L</span></li>
                <li><span>Konsumsi BBM</span><span>${specs.konsumsiBbm || '--'} L/jam</span></li>
                <li><span>Sistem Start</span><span>${specs.sistemStart || '--'}</span></li>
                <li><span>Oli Mesin</span><span>${specs.oliMesin || '--'}</span></li>
            </ul>
        `;
    }
    
    const engineContainer = document.getElementById('engineSpecContainer');
    if (engineContainer) {
        engineContainer.innerHTML = `
            <ul class="spec-list">
                <li><span>Jenis</span><span>Diesel 4-tak</span></li>
                <li><span>Silinder</span><span>4 Inline</span></li>
                <li><span>Kapasitas</span><span>2500 cc</span></li>
                <li><span>Max RPM</span><span>3000 RPM</span></li>
                <li><span>Bahan Bakar</span><span>Solar</span></li>
            </ul>
        `;
    }
}

function updateMaintenanceSection(data) {
    const container = document.getElementById('maintenanceContainer');
    if (!container) return;
    
    if (Array.isArray(data) && data.length) {
        const upcoming = data
            .filter((m) => String(m.status || '').toLowerCase() !== 'completed')
            .sort((a, b) => new Date(a.dueDate || a.createdAt) - new Date(b.dueDate || b.createdAt))
            .slice(0, 4);

        if (!upcoming.length) {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:#aaa">No upcoming maintenance</div>';
            return;
        }

        container.innerHTML = upcoming.map((m) => {
            const due = new Date(m.dueDate || m.createdAt).toLocaleDateString('id-ID');
            const estCost = m.cost != null ? `Rp ${Number(m.cost).toLocaleString('id-ID')}` : 'Biaya belum tersedia';
            return `
                <div class="maintenance-item" style="border:1px solid #e2e8f0;">
                    <div style="font-weight:700; color:#0f172a;">${m.task || 'Maintenance Task'}</div>
                    <div style="font-size:.85rem; color:#64748b; margin-top:4px;">
                        Due: ${due} • Status: ${(m.status || 'scheduled')}
                    </div>
                    <div style="font-size:.85rem; color:#1745a5; margin-top:6px;">Estimasi Cost: ${estCost}</div>
                </div>
            `;
        }).join('');
    }
}

function updateActiveTimeChart(rows) {
    const ctx = document.getElementById('chartActive')?.getContext('2d');
    if (!ctx) return;

    const renderChart = (labels, dataPoints, highlightIndex = -1) => {
        if (activeChart) activeChart.destroy();
        activeChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Jam Aktif',
                    data: dataPoints,
                    backgroundColor: dataPoints.map((_, idx) => idx === highlightIndex ? '#f97316' : '#1745a5'),
                    borderRadius: 6,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, max: 24, ticks: { callback: (v) => `${v}h` } },
                    x: { grid: { display: false } }
                }
            }
        });
    };

    Promise.all([
        fetch('/api/daily-active-time?days=7').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/daily-active-time/today').then(r => r.ok ? r.json() : null).catch(() => null)
    ]).then(([histJson, todayJson]) => {
        if (histJson?.success && Array.isArray(histJson.data)) {
            const dayMap = {};
            for (let i = 6; i >= 0; i--) {
                const d = new Date(Date.now() + 7 * 60 * 60 * 1000 - i * 86400000);
                dayMap[d.toISOString().slice(0, 10)] = 0;
            }
            histJson.data.forEach((r) => {
                if (dayMap.hasOwnProperty(r.date)) dayMap[r.date] = r.activeHours || 0;
            });
            const todayWib = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
            if (todayJson?.success) dayMap[todayWib] = todayJson.activeHours || dayMap[todayWib];
            const keys = Object.keys(dayMap);
            renderChart(keys.map((k) => new Date(k).toLocaleDateString('id-ID', { weekday: 'short' })), keys.map((k) => Number((dayMap[k] || 0).toFixed(2))), keys.findIndex((k) => k === todayWib));
            return;
        }

        const dayLabels = [];
        const map = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            dayLabels.push(key);
            map[key] = 0;
        }
        (rows || []).forEach((r) => {
            const start = new Date(r.startedAt);
            const end = r.endedAt ? new Date(r.endedAt) : new Date();
            const key = start.toISOString().slice(0, 10);
            if (map[key] !== undefined) map[key] += Math.max(0, (end - start) / 3600000);
        });
        renderChart(dayLabels.map((k) => new Date(k).toLocaleDateString('id-ID', { weekday: 'short' })), dayLabels.map((k) => Number(map[k].toFixed(2))), 6);
    });
}


// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
    // Update user info from localStorage
    updateUserInfo();
    
    // Initialize components
    updateClock();
    setInterval(updateClock, 1000);
    
    // Fetch initial data
    await fetchDashboardData();
    
    // Real-time updates
    setInterval(fetchDashboardData, 5000);
});
