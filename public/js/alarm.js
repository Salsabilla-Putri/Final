// --- CONFIGURATION ---
const API_URL = '/api/alerts';
let currentFilter = 'all';
let allAlarms = [];
let currentPage = 1;
const PAGE_SIZE = 20;
const USER_DATETIME_FORMAT = new Intl.DateTimeFormat('id-ID', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

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
function setAlarmLoading(isLoading) {
  const body = document.getElementById('alarmTableBody');
  if (isLoading && body) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:#94a3b8;"><i class="fas fa-circle-notch fa-spin"></i> Loading data...</td></tr>';
  }
}

async function fetchAlarms() {
  setAlarmLoading(true);
  try {
    const dFrom = document.getElementById('dateFrom')?.value;
    const dTo = document.getElementById('dateTo')?.value;

    let url = `${API_URL}?limit=500`;
    if (dFrom && dTo) {
      url += `&startDate=${dFrom}&endDate=${dTo}`;
    }

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      throw new Error(`Alert API returned ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    if (json.success) {
      allAlarms = json.data;
      updateStats();
      renderTable();
    }
  } catch (error) {
    console.error('Error fetching alarms:', error);
    showNotification('Failed to fetch alerts. Please check API health.', 'error');
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
  currentPage = 1;
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

function mapSeverityToStatus(severity, isResolved, isAcknowledged = false) {
  if (isResolved) return { cls: 'status-normal', label: 'confirmed' };
  if (isAcknowledged) return { cls: 'status-warning', label: 'acknowledged' };
  if (severity === 'critical') return { cls: 'status-critical', label: 'critical active' };
  return { cls: 'status-warning', label: 'warning active' };
}

function getSeverityUnit(parameter) {
  const unitMap = {
    rpm: 'RPM',
    volt: 'Volt',
    batt: 'Volt',
    battery: 'Volt',
    batteryvoltage: 'Volt',
    battery_voltage: 'Volt',
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
  const totalPages = Math.max(1, Math.ceil(filteredAlarms.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredAlarms.slice(startIdx, startIdx + PAGE_SIZE);

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

  pageRows.forEach(alarm => {
    const ts = formatReadableTimestamp(alarm.timestamp);
    const value = Number.isFinite(Number(alarm.value)) ? Number(alarm.value).toFixed(1) : (alarm.value ?? '-');
    const mappedStatus = mapSeverityToStatus(alarm.severity, alarm.resolved, alarm.acknowledged);

    let actionButtons;
    if (alarm.resolved) {
      actionButtons = `
        <button class="btn btn-del" onclick="removeAlarm('${alarm._id}')">
          <i class="fas fa-trash"></i> Remove
        </button>`;
    } else {
      actionButtons = `
        <button class="btn btn-primary" onclick="confirmAlarm('${alarm._id}')">
          <i class="fas fa-clipboard-check"></i> Confirm
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

  renderPagination(filteredAlarms.length, totalPages);
}

function renderPagination(totalItems, totalPages) {
  const info = document.getElementById('alarmPageInfo');
  const prevBtn = document.getElementById('alarmPrevPage');
  const nextBtn = document.getElementById('alarmNextPage');
  if (!info || !prevBtn || !nextBtn) return;

  info.textContent = `Page ${currentPage} / ${totalPages} • ${totalItems} data`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

window.prevAlarmPage = function() {
  if (currentPage > 1) {
    currentPage -= 1;
    renderTable();
  }
};

window.nextAlarmPage = function() {
  const totalPages = Math.max(1, Math.ceil(getFilteredAlarms().length / PAGE_SIZE));
  if (currentPage < totalPages) {
    currentPage += 1;
    renderTable();
  }
};

function formatReadableTimestamp(input) {
  const dateObj = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dateObj.getTime())) return '-';
  return USER_DATETIME_FORMAT.format(dateObj);
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

window.exportAlarmCSV = function() {
  const rows = getFilteredAlarms();
  if (rows.length === 0) return alert('No alarms to export');

  let csv = 'Timestamp,Generator,Parameter,Value,Unit,Status\n';
  rows.forEach((alarm) => {
    const mappedStatus = mapSeverityToStatus(alarm.severity, alarm.resolved, alarm.acknowledged);
    const value = Number.isFinite(Number(alarm.value)) ? Number(alarm.value).toFixed(1) : (alarm.value ?? '-');
    csv += [
      escapeCsvCell(formatReadableTimestamp(alarm.timestamp)),
      escapeCsvCell(alarm.deviceId || 'Gen-01'),
      escapeCsvCell((alarm.parameter || 'SYS').toUpperCase()),
      escapeCsvCell(value),
      escapeCsvCell(getSeverityUnit(alarm.parameter)),
      escapeCsvCell(mappedStatus.label)
    ].join(',') + '\n';
  });

  downloadBlob(csv, 'text/csv;charset=utf-8;', `alarms_${currentFilter}_${document.getElementById('dateFrom')?.value || 'all'}_to_${document.getElementById('dateTo')?.value || 'all'}.csv`);
}

window.exportAlarmExcel = function() {
  const rows = getFilteredAlarms();
  if (rows.length === 0) return alert('No alarms to export');

  const tableRows = rows.map((alarm) => {
    const mappedStatus = mapSeverityToStatus(alarm.severity, alarm.resolved, alarm.acknowledged);
    const value = Number.isFinite(Number(alarm.value)) ? Number(alarm.value).toFixed(1) : (alarm.value ?? '-');
    return `
      <tr>
        <td>${formatReadableTimestamp(alarm.timestamp)}</td>
        <td>${alarm.deviceId || 'Gen-01'}</td>
        <td>${(alarm.parameter || 'SYS').toUpperCase()}</td>
        <td>${value}</td>
        <td>${getSeverityUnit(alarm.parameter)}</td>
        <td>${mappedStatus.label}</td>
      </tr>
    `;
  }).join('');

  const htmlTable = `
    <table border="1">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Generator</th>
          <th>Parameter</th>
          <th>Value</th>
          <th>Unit</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;

  downloadBlob(
    `\ufeff${htmlTable}`,
    'application/vnd.ms-excel;charset=utf-8;',
    `alarms_${currentFilter}_${document.getElementById('dateFrom')?.value || 'all'}_to_${document.getElementById('dateTo')?.value || 'all'}.xls`
  );
}

async function putAlertAction(path, successMessage, errorMessage, body = null) {
  try {
    const options = { method: 'PUT', headers: { 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${API_URL}${path}`, options);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || json.message || res.statusText);
    showNotification(successMessage, 'success');
    fetchAlarms();
  } catch (e) {
    showNotification(errorMessage, 'error');
  }
}

window.acknowledgeAlarm = async function(id) {
  return putAlertAction(`/${id}/ack`, 'Alarm acknowledged', 'Failed to acknowledge');
}

window.confirmAlarm = async function(id) {
  return putAlertAction(`/${id}/confirm`, 'Alarm confirmed', 'Failed to confirm');
}

window.confirmAllAlarms = async function() {
  const ids = getFilteredAlarms().filter(a => !a.resolved).map(a => a._id).filter(Boolean);
  if (ids.length === 0) return showNotification('No active alerts in the current filter to confirm', 'error');
  if (!confirm(`Confirm and resolve ${ids.length} active alert(s) from the current filter?`)) return;
  return putAlertAction('/confirm-all', 'Selected active alerts confirmed', 'Failed to confirm selected alerts', { ids });
}

window.removeAlarm = async function(id) {
  const alarm = allAlarms.find(a => a._id === id);
  if (alarm && !alarm.resolved) return showNotification('Confirm this alarm before deleting it', 'error');
  if (!confirm('Permanently delete this confirmed alarm log?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    const json = await res.json();

    if (!res.ok || !json.success) throw new Error(json.message || json.error || 'Delete failed');
    showNotification('Alarm log deleted', 'success');
    fetchAlarms();
  } catch (e) {
    showNotification(e.message || 'Failed to delete', 'error');
  }
}

window.removeAllConfirmedAlarms = async function() {
  const ids = getFilteredAlarms().filter(a => a.resolved).map(a => a._id).filter(Boolean);
  if (ids.length === 0) return showNotification('No confirmed alerts in the current filter to remove', 'error');
  if (!confirm(`Permanently delete ${ids.length} confirmed alarm log(s) from the current filter?`)) return;

  try {
    const res = await fetch(`${API_URL}/confirmed`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.message || json.error || 'Delete failed');
    showNotification(`${json.deletedCount || 0} confirmed alarm log(s) deleted`, 'success');
    fetchAlarms();
  } catch (e) {
    showNotification(e.message || 'Failed to remove confirmed alerts', 'error');
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
