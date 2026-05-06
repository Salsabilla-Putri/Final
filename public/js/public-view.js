'use strict';

// Check authentication
function checkAuth() {
    const userData = sessionStorage.getItem('userData');
    if (!userData) {
        window.location.href = '/login.html';
        return null;
    }
    
    try {
        const user = JSON.parse(userData);
        if (user.role !== 'warg' && user.role !== 'masyarakat') {
            window.location.href = '/login.html';
            return null;
        }
        return user;
    } catch (e) {
        window.location.href = '/login.html';
        return null;
    }
}

function logout() {
    sessionStorage.removeItem('userData');
    window.location.href = '/login.html';
}

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

// Navigation
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = item.getAttribute('data-section');
            const section = document.getElementById(sectionId);
            
            if (section) {
                section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            
            // Update active state
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
        });
    });
    
    // Highlight active section on scroll
    window.addEventListener('scroll', () => {
        const sections = document.querySelectorAll('section[id], header[id]');
        let current = '';
        
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            if (window.scrollY >= sectionTop - 100) {
                current = section.getAttribute('id');
            }
        });
        
        navItems.forEach(item => {
            item.classList.remove('active');
            if (item.getAttribute('data-section') === current) {
                item.classList.add('active');
            }
        });
    });
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
    
    document.getElementById('engineSpeed').innerText = rpm + ' RPM';
    document.getElementById('coolantTemp').innerText = temp + '°C';
    document.getElementById('systemVoltage').innerText = volt + ' V';
    
    // Update active alerts count
    fetch('/api/alerts?limit=100')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const activeCount = data.data.filter(a => !a.resolved).length;
                document.getElementById('activeAlerts').innerText = activeCount;
            }
        });
}

function updateOperationsSection(data) {
    document.getElementById('syncStatus').innerText = data.sync || '--';
    document.getElementById('engineState').innerText = data.status || '--';
    document.getElementById('fuelLevel').innerText = (data.fuel || 0) + '%';
    
    // Calculate today's active time
    fetch('/api/generator-active-time/stats?hours=24')
        .then(res => res.json())
        .then(statsData => {
            if (statsData.success && statsData.data) {
                const hours = Math.floor(statsData.data.totalDurationHours || 0);
                const minutes = Math.floor(((statsData.data.totalDurationHours || 0) - hours) * 60);
                document.getElementById('todayActive').innerText = `${hours}h ${minutes}m`;
            }
        });
    
    // System health
    const health = calculateHealth(data);
    document.getElementById('systemHealth').innerText = health + '%';
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
    // Update health info
    if (data.health) {
        const healthScore = document.getElementById('systemHealth');
        if (healthScore) {
            healthScore.innerText = data.health.score + '%';
        }
    }
}

function updateAlertsSection(alerts) {
    const container = document.getElementById('recentAlertsContent');
    if (!container) return;
    
    if (!alerts || alerts.length === 0) {
        container.innerHTML = '<p class="text-wrapper-21">No recent alerts</p>';
        return;
    }
    
    container.innerHTML = alerts.slice(0, 5).map(alert => `
        <div class="alert-item ${alert.severity === 'critical' ? '' : (alert.severity === 'high' ? 'warning' : 'info')}">
            <div style="font-size: 12px; color: #64748b;">
                ${new Date(alert.timestamp).toLocaleString('id-ID')}
            </div>
            <div style="font-weight: 500; margin-top: 5px;">
                ${alert.message}
            </div>
            <div style="font-size: 12px; margin-top: 3px; color: ${alert.resolved ? '#10b981' : '#ef4444'}">
                ${alert.resolved ? '✓ Resolved' : '⚠ Active'}
            </div>
        </div>
    `).join('');
}

function updateRecentActivity(activities) {
    const container = document.getElementById('recentActivityContent');
    if (!container) return;
    
    if (!activities || activities.length === 0) {
        container.innerHTML = '<p class="loading-data">No recent activity</p>';
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
        
        const voltageEl = document.getElementById('voltageValue');
        const currentEl = document.getElementById('currentValue');
        const frequencyEl = document.getElementById('frequencyValue');
        const fuelLevelEl = document.getElementById('fuelLevelValue');
        const tempEl = document.getElementById('tempValue');
        
        if (voltageEl && params.voltage) voltageEl.innerText = params.voltage.value + ' V';
        if (fuelLevelEl && params.fuel) fuelLevelEl.innerText = params.fuel.percent + '%';
        if (tempEl && params.temperature) tempEl.innerText = params.temperature.value + '°C';
    }
}

function updateSpecificationsSection(specs) {
    const genContainer = document.getElementById('generatorSpecContent');
    if (genContainer && specs) {
        genContainer.innerHTML = `
            <ul>
                <li><span>Merk</span><span>${specs.merk}</span></li>
                <li><span>Tipe</span><span>${specs.tipe}</span></li>
                <li><span>Daya Maks</span><span>${specs.dayaMaks} kW</span></li>
                <li><span>Tegangan</span><span>${specs.tegangan} V</span></li>
                <li><span>Frekuensi</span><span>${specs.frekuensi} Hz</span></li>
                <li><span>Tipe Mesin</span><span>${specs.tipeMesin}</span></li>
                <li><span>Kapasitas Mesin</span><span>${specs.kapasitasMesin}</span></li>
                <li><span>Kapasitas Tangki</span><span>${specs.kapasitasTangki} L</span></li>
                <li><span>Konsumsi BBM</span><span>${specs.konsumsiBbm} L/jam</span></li>
                <li><span>Sistem Start</span><span>${specs.sistemStart}</span></li>
                <li><span>Oli Mesin</span><span>${specs.oliMesin}</span></li>
            </ul>
        `;
    }
    
    // Engine specs (hardcoded)
    const engineContainer = document.getElementById('engineSpecContent');
    if (engineContainer) {
        engineContainer.innerHTML = `
            <ul>
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
    const container = document.getElementById('upcomingMaintenanceContent');
    if (!container) return;
    
    if (data && data.decisionStatus) {
        const statusColors = {
            'AMAN': '#10b981',
            'WASPADA': '#f59e0b',
            'BAHAYA': '#ef4444'
        };
        
        container.innerHTML = `
            <div style="padding: 15px;">
                <div style="font-weight: bold; color: ${statusColors[data.decisionStatus] || '#0f172a'}; margin-bottom: 10px;">
                    Status: ${data.decisionStatus}
                </div>
                <div style="font-size: 13px; color: #64748b; margin-bottom: 10px;">
                    ${data.message}
                </div>
                <div style="font-size: 13px; color: #0f172a;">
                    <strong>Rekomendasi:</strong><br>
                    ${data.recommendation}
                </div>
            </div>
        `;
    }
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication
    const user = checkAuth();
    if (!user) return;
    
    // Update user info
    document.getElementById('userName').innerText = user.name || 'Pengguna';
    document.getElementById('userRole').innerText = user.role || 'Warga';
    document.getElementById('welcomeMessage').innerText = `Welcome, ${user.name || 'Pengguna'}!`;
    
    // Initialize components
    updateClock();
    setInterval(updateClock, 1000);
    initNavigation();
    
    // Fetch initial data
    await fetchDashboardData();
    
    // Real-time updates
    setInterval(fetchDashboardData, 5000);
});