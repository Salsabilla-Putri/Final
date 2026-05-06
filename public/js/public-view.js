'use strict';

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
        const activeTimeRes = await fetch('/api/generator-active-time/history?limit=5');
        const activeTimeData = await activeTimeRes.json();
        
        if (activeTimeData.success) {
            updateRecentActivity(activeTimeData.data);
        }
        
        // Fetch maintenance data
        const maintenanceRes = await fetch('/api/maintenance/suggestion');
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
    
    container.innerHTML = alerts.slice(0, 5).map(alert => `
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
    
    container.innerHTML = activities.slice(0, 5).map(activity => `
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
        
        document.getElementById('perf-volt').innerText = (params.voltage?.value || '--') + ' V';
        document.getElementById('perf-fuel').innerText = (params.fuel?.percent || '--') + '%';
        document.getElementById('perf-temp').innerText = (params.temperature?.value || '--') + '°C';
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
    
    if (data && data.decisionStatus) {
        const statusClass = data.decisionStatus.toLowerCase();
        
        container.innerHTML = `
            <div class="maintenance-status ${statusClass}">
                Status: ${data.decisionStatus}
            </div>
            <div class="maintenance-message">
                ${data.message || ''}
            </div>
            <div class="maintenance-recommendation">
                <strong>Rekomendasi:</strong><br>
                ${data.recommendation || ''}
            </div>
        `;
    }
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