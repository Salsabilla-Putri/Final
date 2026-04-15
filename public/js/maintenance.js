const API_URL = '/api/maintenance';
let allTasks = [];
let currentFilter = 'all';
let pendingSuggestion = null;

// --- 1. LOAD DATA DARI SERVER (MONGODB) ---
async function fetchTasks() {
    try {
        const res = await fetch(API_URL);
        const json = await res.json();
        if (json.success) {
            allTasks = json.data; // Simpan data dari DB
            render();
        }
    } catch (e) { console.error("Fetch error:", e); }
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
                <td>${t.completedAt ? new Date(t.completedAt).toLocaleDateString() : '-'}</td>
                <td>${t.assignedTo}</td>
                <td><span class="status-badge status-completed">Completed</span></td>
            </tr>`;
        });
    }

    // Render Timeline
    if(timeline) {
        timeline.innerHTML = '';
        // Sort by createdAt descending
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
        dueDate: document.getElementById('dueDate').value,
        assignedTo: document.getElementById('assignedTo').value,
        source: pendingSuggestion ? 'system' : 'manual',
        suggestionId: pendingSuggestion?._id || null
    };

    if(!payload.task || !payload.dueDate) return showNotif('Please fill required fields', 'error');

    // POST ke Server
    await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (pendingSuggestion?._id) {
        await fetch(`/api/maintenance/suggestion/${pendingSuggestion._id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled' })
        });
        pendingSuggestion = null;
    }

    closeAddModal();
    fetchTasks(); // Refresh data
    showNotif('Task scheduled successfully', 'success');
}

// UPDATE STATUS (COMPLETE)
async function completeTask(id) {
    if(!confirm("Mark task as completed?")) return;
    // PUT ke Server
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
    // DELETE ke Server
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

async function loadPendingSuggestion() {
    try {
        const res = await fetch('/api/maintenance/suggestion');
        const json = await res.json();
        pendingSuggestion = json?.data?.suggestion && json.data.suggestion.status === 'pending'
            ? json.data.suggestion
            : null;

        if (!pendingSuggestion) return;
        document.getElementById('taskName').value = pendingSuggestion.recommendation || '';
        document.getElementById('taskType').value = 'preventive';
        document.getElementById('priority').value = pendingSuggestion.decisionStatus === 'BAHAYA' ? 'high' : 'medium';
        if (pendingSuggestion.suggestedDate) {
            const due = new Date(pendingSuggestion.suggestedDate);
            document.getElementById('dueDate').value = due.toISOString().slice(0, 10);
        }
        showNotif('Form diprefill dari Saran Maintenance sistem', 'success');
    } catch (error) {
        console.warn('loadPendingSuggestion error:', error);
    }
}

const originalOpenAddModal = openAddModal;
openAddModal = function() {
    originalOpenAddModal();
    loadPendingSuggestion();
};

function showNotif(msg, type) {
    const el = document.getElementById('notification');
    if(el) {
        el.innerText = msg;
        el.className = `notification show notif-${type}`;
        setTimeout(() => el.className = 'notification', 3000);
    }
}

function exportCSV() {
    let csv = "Task,Type,Priority,DueDate,Status,Technician\n";
    allTasks.forEach(t => {
      csv += `"${t.task}",${t.type},${t.priority},${t.dueDate},${t.status},"${t.assignedTo}"\n`;
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
    document.getElementById('userarea').querySelector('span').innerText = localStorage.getItem('username') || 'Pengguna';
    
    // User Info
    const user = localStorage.getItem('username') || 'Pengguna';
    document.getElementById('userarea').querySelector('span').innerText = user;

    // Load Data Pertama Kali
    fetchTasks();
});
