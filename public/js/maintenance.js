const API_URL = '/api/maintenance';
const SUGGESTION_API_URL = '/api/maintenance/suggestion';
const COST_SUMMARY_URL = '/api/maintenance/cost-summary';
let allTasks = [];
let currentFilter = 'all';
let pendingSuggestion = null;

function formatIDR(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '-';
    return `Rp ${num.toLocaleString('id-ID')}`;
}

// --- 1. LOAD DATA DARI SERVER (MONGODB) ---
function setMaintenanceLoading(isLoading) {
    const tbody = document.getElementById('maintenanceTableBody');
    const histBody = document.getElementById('historyTableBody');
    const timeline = document.getElementById('maintenanceTimeline');
    if (!isLoading) return;
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8;"><i class="fas fa-circle-notch fa-spin"></i> Loading data...</td></tr>';
    if (histBody) histBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8;"><i class="fas fa-circle-notch fa-spin"></i> Loading data...</td></tr>';
    if (timeline) timeline.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;"><i class="fas fa-circle-notch fa-spin"></i> Loading timeline...</div>';
}

async function fetchTasks() {
    setMaintenanceLoading(true);
    try {
        const res = await fetch(API_URL);
        const json = await res.json();
        if (json.success) {
            allTasks = json.data;
            render();
        }
    } catch (e) { console.error("Fetch error:", e); }
}

async function fetchMaintenanceSuggestion() {
    try {
        const res = await fetch(SUGGESTION_API_URL);
        const json = await res.json();
        const suggestion = json?.data?.suggestion || json?.suggestion;
        pendingSuggestion = suggestion && suggestion.status === 'pending' ? suggestion : null;
        renderSuggestionBanner();
    } catch (error) {
        console.error('Suggestion fetch error:', error);
    }
}

async function fetchCostSummary() {
    try {
        const res = await fetch(COST_SUMMARY_URL);
        const json = await res.json();
        if (json.success && json.data.length) {
            const total = json.data[0].totalCost || 0;
            document.getElementById('totalCostDisplay').innerText = formatIDR(total);
        }
    } catch (e) { /* silent */ }
}

function renderSuggestionBanner() {
    const banner = document.getElementById('systemSuggestionBanner');
    const text = document.getElementById('systemSuggestionText');
    const btn = document.getElementById('useSuggestionBtn');
    if (!banner || !text || !btn) return;

    if (!pendingSuggestion) {
        banner.style.display = 'none';
        btn.style.display = 'none';
        return;
    }

    banner.style.display = 'block';
    btn.style.display = 'inline-flex';
    text.innerHTML = `
      <div><b>Status:</b> ${pendingSuggestion.decisionStatus}</div>
      <div>${pendingSuggestion.message}</div>
      <div><b>Rekomendasi:</b> ${pendingSuggestion.recommendation}</div>
    `;
}

// --- 2. RENDER UI (TABEL & STATUS) ---
function render() {
    const tbody = document.getElementById('maintenanceTableBody');
    const histBody = document.getElementById('historyTableBody');
    const timeline = document.getElementById('maintenanceTimeline');
    const now = new Date();

    // Hitung Statistik
    const overdue = allTasks.filter(t => t.status !== 'completed' && new Date(t.dueDate) < now).length;
    const completed = allTasks.filter(t => t.status === 'completed').length;
    const scheduled = allTasks.filter(t => t.status === 'scheduled').length;
    const upcoming = allTasks.filter(t => {
            const d = new Date(t.dueDate);
            return t.status !== 'completed' && d > now && (d - now) < (7 * 86400000);
    }).length;

    document.getElementById('overdueCount').innerText = overdue;
    document.getElementById('completedCount').innerText = completed;
    document.getElementById('scheduledCount').innerText = scheduled;
    document.getElementById('upcomingCount').innerText = upcoming;

    // Render Tabel Utama
    tbody.innerHTML = '';
    let filtered = allTasks;

    if(currentFilter !== 'all') {
        if(currentFilter === 'overdue') filtered = allTasks.filter(t => t.status !== 'completed' && new Date(t.dueDate) < now);
        else filtered = allTasks.filter(t => t.status === currentFilter);
    } else {
        // Default: Sembunyikan yang sudah selesai di tabel utama
        filtered = allTasks.filter(t => t.status !== 'completed');
    }

    filtered.forEach(t => {
        const suggestionBadge = t.source === 'system'
            ? '<div style="margin-top:4px;"><span class="status-badge status-scheduled">Saran dari Sistem</span></div>'
            : '';
        let displayStatus = t.status;
        if(t.status === 'scheduled' && new Date(t.dueDate) < now) displayStatus = 'overdue';

        const row = `
        <tr>
            <td><b>${t.task}</b>${suggestionBadge}</td>
            <td style="text-transform:capitalize">${t.type || '-'}</td>
            <td class="priority-${t.priority}" style="text-transform:capitalize">${t.priority || '-'}</td>
            <td>${formatIDR(t.cost)}</td>
            <td>${new Date(t.dueDate).toLocaleDateString()}</td>
            <td><span class="status-badge status-${displayStatus}">${displayStatus}</span></td>
            <td>${t.assignedTo || '-'}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn btn-secondary" onclick="completeTask('${t._id}')"><i class="fas fa-check"></i></button>
                    <button class="btn btn-danger" onclick="deleteTask('${t._id}')"><i class="fas fa-trash"></i></button>
                </div>
            </td>
        </tr>`;
        tbody.innerHTML += row;
    });

    // Render History (Completed)
    if(histBody) {
        histBody.innerHTML = '';
        allTasks.filter(t => t.status === 'completed').slice(0, 10).forEach(t => {
            histBody.innerHTML += `
            <tr>
                <td>${t.task}</td>
                <td>${t.type}</td>
                <td>${formatIDR(t.cost)}</td>
                <td>${t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '-'}</td>
                <td>${t.assignedTo}</td>
                <td><span class="status-badge status-completed">Completed</span></td>
            </tr>`;
        });
    }

    // Render Timeline
    if(timeline) {
        timeline.innerHTML = '';
        const recentTasks = [...allTasks].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
        
        recentTasks.forEach(t => {
            const isOverdue = t.status !== 'completed' && new Date(t.dueDate) < now;
            const itemClass = t.status === 'completed' ? 'completed' : (isOverdue ? 'overdue' : '');
            
            timeline.innerHTML += `
            <div class="timeline-item ${itemClass}">
                <div class="timeline-date">${new Date(t.createdAt).toLocaleDateString()}</div>
                <div class="timeline-content">
                    <strong>${t.task}</strong> <small>(${t.status})</small><br>
                    <span style="font-size:12px;color:grey">Assigned to: ${t.assignedTo}</span>
                </div>
            </div>`;
        });
    }
}

// --- 3. FUNGSI CRUD KE SERVER ---

// SIMPAN DATA
async function saveMaintenance() {
    const payload = {
        task: document.getElementById('taskName').value,
        type: document.getElementById('taskType').value,
        priority: document.getElementById('priority').value,
        cost: Number(document.getElementById('cost').value || 0),
        dueDate: document.getElementById('dueDate').value,
        assignedTo: document.getElementById('assignedTo').value,
        source: 'manual',
        suggestionId: null
    };

    const modal = document.getElementById('addMaintenanceModal');
    const suggestionId = modal?.dataset?.suggestionId;
    if (suggestionId) {
        payload.source = 'system';
        payload.suggestionId = suggestionId;
    }

    if(!payload.task || !payload.dueDate) return showNotif('Please fill required fields', 'error');

    // POST ke Server
    await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (suggestionId) {
        // Update status saran menjadi scheduled
        await fetch(`/api/maintenance/suggestion/${suggestionId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled' })
        });
        // Hapus atribut saran dari modal
        delete modal.dataset.suggestionId;
        // Refresh banner
        fetchMaintenanceSuggestion();
    }

    closeAddModal();
    fetchTasks();
    showNotif('Task scheduled successfully', 'success');
}

// UPDATE STATUS (COMPLETE)
async function completeTask(id) {
    if(!confirm("Mark task as completed?")) return;
    await fetch(`${API_URL}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', completedAt: new Date() })
    });
    fetchTasks();
    showNotif('Task completed', 'success');
}

// HAPUS DATA
async function deleteTask(id) {
    if(!confirm("Delete this task?")) return;
    await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    fetchTasks();
    showNotif('Task deleted', 'success');
}

// Helpers
function setFilter(f, btn) { 
    currentFilter = f; 
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active')); 
    if(btn) btn.classList.add('active'); 
    render(); 
}

function openAddModal() { document.getElementById('addMaintenanceModal').style.display = 'flex'; }
function closeAddModal() { document.getElementById('addMaintenanceModal').style.display = 'none'; }

function openAddModalFromSuggestion() {
    // Gunakan saran dari banner sistem, bukan dari CBM
    if (!pendingSuggestion) return openAddModal();
    openAddModal();
    // Isi form dari saran yang ada
    document.getElementById('taskName').value = pendingSuggestion.recommendation || '';
    document.getElementById('taskType').value = 'preventive';
    document.getElementById('priority').value = pendingSuggestion.priority || 'medium';
    document.getElementById('cost').value = pendingSuggestion.estimatedCost || 0;
    if (pendingSuggestion.suggestedDate) {
        const due = new Date(pendingSuggestion.suggestedDate);
        if (!isNaN(due.getTime())) {
            document.getElementById('dueDate').value = due.toISOString().slice(0, 10);
        }
    }
}

// Auto-fill from CBM suggestion (dipanggil saat redirect)
function autoFillFromSuggestion(suggestion) {
    openAddModal();

    document.getElementById('taskName').value = suggestion.recommendation || '';
    document.getElementById('taskType').value = suggestion.priority === 'high' ? 'corrective' : 'preventive';
    document.getElementById('priority').value = suggestion.priority || 'medium';
    document.getElementById('cost').value = suggestion.estimatedCost || 0;

    if (suggestion.suggestedDate) {
        const due = new Date(suggestion.suggestedDate);
        if (!isNaN(due.getTime())) {
            document.getElementById('dueDate').value = due.toISOString().slice(0, 10);
        }
    }

    // Simpan suggestion ID di dataset modal untuk digunakan saat save
    const modal = document.getElementById('addMaintenanceModal');
    modal.dataset.suggestionId = suggestion._id || '';
}

function showNotif(msg, type) {
    const el = document.getElementById('notification');
    if(el) {
        el.innerText = msg;
        el.className = `notification show notif-${type}`;
        setTimeout(() => el.className = 'notification', 3000);
    }
}

function exportCSV() {
    let csv = "Task,Type,Priority,Cost,DueDate,Status,Technician\n";
    allTasks.forEach(t => {
      csv += `"${t.task}",${t.type},${t.priority},${t.cost || 0},${t.dueDate},${t.status},"${t.assignedTo}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'maintenance_schedule.csv';
    a.click();
}

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    // Load Sidebar
    fetch('sidebar.html').then(r=>r.text()).then(h =>document.getElementById('sidebar-container').innerHTML = h);
    const user = localStorage.getItem('username') || 'Pengguna';
    document.getElementById('userarea').querySelector('span').innerText = user;

    // Load Data Pertama Kali
    fetchTasks();
    fetchMaintenanceSuggestion();
    fetchCostSummary();

    // Cek apakah ada saran dari CBM (redirect dari reports)
    const pendingCbm = sessionStorage.getItem('pendingCbmSuggestion');
    if (pendingCbm) {
        try {
            const suggestion = JSON.parse(pendingCbm);
            autoFillFromSuggestion(suggestion);
            sessionStorage.removeItem('pendingCbmSuggestion');
        } catch (e) {
            console.warn('Invalid CBM suggestion in sessionStorage');
            sessionStorage.removeItem('pendingCbmSuggestion');
        }
    }
});