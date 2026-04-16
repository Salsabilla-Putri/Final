// --- CONFIGURATION ---
const API_URL = '/api/alerts';
let currentFilter = 'all';
let allAlarms = [];

// --- SETUP FUNCTIONS ---
fetch('sidebar.html')
  .then(r => r.text())
  .then(h => document.getElementById('sidebar-container').innerHTML = h)
  .catch(() => console.error('Sidebar not found'));

function updateDateInputs(val) {
  const end = new Date();
  let start = new Date();

  if (val === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (val === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (val === 'custom') {
    return;
  } else {
    const days = parseInt(val, 10);
    if (!Number.isFinite(days)) return;
    start.setDate(start.getDate() - days);
  }

  const toISODate = (d) => {
    const offset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offset).toISOString().split('T')[0];
  };

  document.getElementById('dateFrom').value = toISODate(start);
  document.getElementById('dateTo').value = toISODate(end);
}

window.applyDateFilters = function() {
  fetchAlarms();
};

window.resetDateFilters = function() {
  document.getElementById('timeRange').value = '30';
  updateDateInputs('30');
  fetchAlarms();
};

// --- ALARM LOGIC & API ---
async function fetchAlarms() {
  try {
    const dFrom = document.getElementById('dateFrom')?.value;
    const dTo = document.getElementById('dateTo')?.value;

    let url = `${API_URL}?limit=500`;
    if (dFrom && dTo) {
      url += `&startDate=${dFrom}&endDate=${dTo}`;
    }

    const res = await fetch(url);
    const json = await res.json();
    if (json.success) {
      allAlarms = json.data;
      updateStats();
      renderTable();
    }
  } catch (error) {
    console.error('Error fetching alarms:', error);
  }
}

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

window.filterAlarms = function(filterType, btnEl) {
  document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  currentFilter = filterType;
  renderTable();
}

function getFilteredAlarms() {
  switch (currentFilter) {
    case 'active': return allAlarms.filter(a => !a.resolved);
    case 'critical': return allAlarms.filter(a => a.severity === 'critical');
    case 'warning': return allAlarms.filter(a => a.severity !== 'critical');
    default: return [...allAlarms];
  }
}

function mapSeverityToStatus(severity, isResolved) {
  if (isResolved) return { cls: 'status-normal', label: 'confirmed' };
  if (severity === 'critical') return { cls: 'status-critical', label: 'critical active' };
  return { cls: 'status-warning', label: 'warning active' };
}

function getSeverityUnit(parameter) {
  const unitMap = {
    rpm: 'RPM',
    volt: 'V',
    amp: 'A',
    power: 'kW',
    freq: 'Hz',
    fuel: '%',
    coolant: '°C',
    iat: '°C',
    map: 'kPa',
    afr: 'R',
    tps: '%'
  };
  return unitMap[String(parameter || '').toLowerCase()] || '-';
}

function renderTable() {
  const tbody = document.getElementById('alarmTableBody');
  const filteredAlarms = getFilteredAlarms();

  tbody.innerHTML = '';

  if (filteredAlarms.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:30px; color:#94a3b8; font-style:italic;">
          <i class="fas fa-check-circle" style="font-size:24px; margin-bottom:10px; color:#10b981;"></i><br>
          No alarms found in this category
        </td>
      </tr>`;
    return;
  }

  filteredAlarms.forEach(alarm => {
    const date = new Date(alarm.timestamp);
    const ts = date.toLocaleString('id-ID');
    const value = Number.isFinite(Number(alarm.value)) ? Number(alarm.value).toFixed(1) : (alarm.value ?? '-');
    const mappedStatus = mapSeverityToStatus(alarm.severity, alarm.resolved);

    let actionButtons;
    if (alarm.resolved) {
      actionButtons = `
        <button class="btn btn-del" onclick="removeAlarm('${alarm._id}')">
          <i class="fas fa-trash"></i> Remove
        </button>`;
    } else {
      actionButtons = `
        <button class="btn btn-ack" onclick="acknowledgeAlarm('${alarm._id}')">
          <i class="fas fa-check"></i> Confirm
        </button>`;
    }

    const row = `
      <tr>
        <td>${ts}</td>
        <td>${alarm.deviceId || 'Gen-01'}</td>
        <td>${(alarm.parameter || 'SYS').toUpperCase()}</td>
        <td class="value-cell ${alarm.severity === 'critical' ? 'value-critical' : (alarm.resolved ? 'value-normal' : 'value-warning')}">${value}</td>
        <td>${getSeverityUnit(alarm.parameter)}</td>
        <td><span class="status-badge ${mappedStatus.cls}">${mappedStatus.label}</span></td>
        <td style="text-align:center;">${actionButtons}</td>
      </tr>
    `;
    tbody.innerHTML += row;
  });
}

window.acknowledgeAlarm = async function(id) {
  try {
    const res = await fetch(`${API_URL}/${id}/ack`, { method: 'PUT' });
    const json = await res.json();

    if (json.success) {
      showNotification('Alarm acknowledged', 'success');
      fetchAlarms();
    }
  } catch (e) {
    showNotification('Failed to acknowledge', 'error');
  }
}

window.removeAlarm = async function(id) {
  if (!confirm('Permanently delete this alarm log?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    const json = await res.json();

    if (json.success) {
      showNotification('Alarm log deleted', 'success');
      fetchAlarms();
    }
  } catch (e) {
    showNotification('Failed to delete', 'error');
  }
}

function showNotification(message, type) {
  const div = document.createElement('div');
  div.style.cssText = `
    position: fixed; top: 20px; right: 20px; padding: 12px 24px;
    background: ${type === 'success' ? '#10b981' : '#ef4444'};
    color: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1000; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 10px;
    animation: slideIn 0.3s ease;
  `;
  div.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check' : 'fa-times'}"></i> ${message}`;
  document.body.appendChild(div);

  if (!document.getElementById('notif-style')) {
    const style = document.createElement('style');
    style.id = 'notif-style';
    style.innerHTML = '@keyframes slideIn { from { transform: translateX(100%); opacity:0; } to { transform: translateX(0); opacity:1; } }';
    document.head.appendChild(style);
  }

  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(100%)';
    div.style.transition = 'all 0.3s';
    setTimeout(() => div.remove(), 300);
  }, 3000);
}

window.fetchAlarms = fetchAlarms;
window.updateDateInputs = updateDateInputs;

document.addEventListener('DOMContentLoaded', () => {
  updateDateInputs('30');
  fetchAlarms();
  setInterval(fetchAlarms, 10000);
});
