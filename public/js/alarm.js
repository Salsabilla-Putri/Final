// --- CONFIGURATION ---
const API_URL = '/api/alerts';
let currentFilter = 'all';
let allAlarms = [];

// --- SETUP FUNCTIONS ---
// Load Sidebar (Using standard fetch approach)
fetch('sidebar.html')
  .then(r => r.text())
  .then(h => document.getElementById('sidebar-container').innerHTML = h)
  .catch(() => console.error('Sidebar not found'));

// JAM DIGITAL DIHAPUS DARI SINI

// --- ALARM LOGIC & API ---

// 1. FETCH DATA DARI DATABASE
async function fetchAlarms() {
  try {
    const res = await fetch(`${API_URL}?limit=100`);
    const json = await res.json();
    if (json.success) {
      allAlarms = json.data; // Simpan data asli
      updateStats();
      renderTable();
    }
  } catch (error) {
    console.error('Error fetching alarms:', error);
  }
}

// 2. UPDATE KARTU STATISTIK
function updateStats() {
  const critical = allAlarms.filter(a => a.severity === 'critical').length;
  const warning = allAlarms.filter(a => a.severity === 'medium' || a.severity === 'low').length;
  const active = allAlarms.filter(a => !a.resolved).length;
  const total = allAlarms.length;

  document.getElementById('criticalCount').textContent = critical;
  document.getElementById('warningCount').textContent = warning;
  document.getElementById('activeCount').textContent = active;
  document.getElementById('totalCount').textContent = total;
}

// 3. FILTER LOGIC
window.filterAlarms = function(filterType) {
  // Update UI Tab
  document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.remove('active'));
  // Find button that triggered this or use event
  if (event && event.target) event.target.classList.add('active');
  
  currentFilter = filterType;
  renderTable();
}

function getFilteredAlarms() {
  switch(currentFilter) {
    case 'active': return allAlarms.filter(a => !a.resolved);
    case 'critical': return allAlarms.filter(a => a.severity === 'critical');
    case 'warning': return allAlarms.filter(a => a.severity !== 'critical');
    default: return [...allAlarms];
  }
}

// 4. RENDER TABLE
function renderTable() {
  const tbody = document.getElementById('alarmTableBody');
  const filteredAlarms = getFilteredAlarms();
  
  tbody.innerHTML = '';

  if (filteredAlarms.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:40px; color:#94a3b8; font-style:italic;">
          <i class="fas fa-check-circle" style="font-size:24px; margin-bottom:10px; color:#10b981;"></i><br>
          No alarms found in this category
        </td>
      </tr>`;
    return;
  }

  filteredAlarms.forEach(alarm => {
    // Format Time
    const date = new Date(alarm.timestamp);
    const dateStr = date.toLocaleDateString('id-ID', { day:'2-digit', month:'short' });
    const timeStr = date.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    // Severity Badge Style
    let sevClass = 'sev-low';
    let sevIcon = 'fa-info-circle';
    if (alarm.severity === 'critical') { sevClass = 'sev-critical'; sevIcon = 'fa-exclamation-triangle'; }
    else if (alarm.severity === 'medium') { sevClass = 'sev-warning'; sevIcon = 'fa-bell'; }
    
    // Status Logic & Buttons
    let statusHtml, actionButtons;

    if (alarm.resolved) {
      // Jika sudah di-ack (Resolved)
      statusHtml = `<span class="st-confirmed"><i class="fas fa-check-circle"></i> CONFIRMED</span>`;
      // Tampilkan tombol Hapus
      actionButtons = `
        <button class="btn btn-del" onclick="removeAlarm('${alarm._id}')">
          <i class="fas fa-trash"></i> Remove
        </button>
      `;
    } else {
      // Jika masih aktif (Belum di-ack)
      statusHtml = `<span class="st-active"><i class="fas fa-exclamation-circle"></i> ACTIVE</span>`;
      // Tampilkan HANYA tombol Acknowledge
      actionButtons = `
        <button class="btn btn-ack" onclick="acknowledgeAlarm('${alarm._id}')">
          <i class="fas fa-check"></i> Confirm
        </button>
      `;
    }

    const row = `
      <tr>
        <td class="time-cell">${timeStr} <span style="font-size:11px; color:#94a3b8; margin-left:5px;">${dateStr}</span></td>
        <td class="parameter-cell">${alarm.parameter || 'SYS'}</td>
        <td class="value-cell">${alarm.value}</td>
        <td>
          <span class="badge ${sevClass}">
            <i class="fas ${sevIcon}"></i> ${alarm.severity}
          </span>
        </td>
        <td>${statusHtml}</td>
        <td style="text-align:center;">${actionButtons}</td>
      </tr>
    `;
    tbody.innerHTML += row;
  });
}

// --- ACTIONS ---

// Acknowledge: Ubah status di DB jadi resolved=true
window.acknowledgeAlarm = async function(id) {
  try {
    const res = await fetch(`${API_URL}/${id}/ack`, { method: 'PUT' });
    const json = await res.json();
    
    if (json.success) {
      showNotification('Alarm acknowledged', 'success');
      fetchAlarms(); // Refresh otomatis agar tombol berubah jadi Remove
    }
  } catch(e) {
    showNotification('Failed to acknowledge', 'error');
  }
}

// Remove: Hapus dari DB
window.removeAlarm = async function(id) {
  if (!confirm("Permanently delete this alarm log?")) return;
  
  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    const json = await res.json();
    
    if (json.success) {
      showNotification('Alarm log deleted', 'success');
      fetchAlarms();
    }
  } catch(e) {
    showNotification('Failed to delete', 'error');
  }
}

// Custom Notification
function showNotification(message, type) {
  const div = document.createElement('div');
  div.style.cssText = `
    position: fixed; top: 20px; right: 20px; padding: 12px 24px;
    background: ${type === 'success' ? '#10b981' : '#ef4444'};
    color: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1000; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 10px;
    animation: slideIn 0.3s ease;
  `;
  div.innerHTML = `<i class="fas ${type==='success'?'fa-check':'fa-times'}"></i> ${message}`;
  document.body.appendChild(div);
  
  // CSS Animation insert (if needed, but usually handled by global CSS)
  if (!document.getElementById('notif-style')) {
      const style = document.createElement('style');
      style.id = 'notif-style';
      style.innerHTML = `@keyframes slideIn { from { transform: translateX(100%); opacity:0; } to { transform: translateX(0); opacity:1; } }`;
      document.head.appendChild(style);
  }

  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(100%)';
    div.style.transition = 'all 0.3s';
    setTimeout(() => div.remove(), 300);
  }, 3000);
}

// Make fetchAlarms global for the refresh button
window.fetchAlarms = fetchAlarms;

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    fetchAlarms();
    // Auto refresh setiap 10 detik
    setInterval(fetchAlarms, 10000);
});